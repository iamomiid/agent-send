// The Worker's HTTP surface (everything the OAuth provider doesn't own):
// owner sign-in and UI API, the OAuth consent step, the REST API for agents,
// and the WebSocket endpoints for the live UI feed and agent connectors.

import { AuthorizationError, CimdFetchError, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Hub } from "./hub";
import { apiPrompt, grokPrompt, grokRoutineInstruction, hermesPrompt, mcpPrompt } from "./prompts";
import type { Principal, Runtime } from "./types";
import { describeError, sha256 } from "./util";

type AppEnv = { Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } };
type C = Context<AppEnv>;

const SESSION_COOKIE = "__Host-as_session";
// Grok Bot connectors sign in through Cursor's infrastructure (client "Cursor", redirect www.cursor.com).
const GROK_CLIENT_HINTS = ["cursor", "x.ai", "grok"];

export function hubStub(env: Env): DurableObjectStub<Hub> {
  const ns = env.HUB as unknown as DurableObjectNamespace<Hub>;
  return ns.get(ns.idFromName("hub"));
}

function errorResponse(e: unknown): Response {
  const { code, status, message } = describeError(e);
  if (code === "internal") console.error("hub error", e);
  return Response.json({ error: code, message }, { status });
}

async function guard<T>(fn: () => Promise<T>): Promise<Response> {
  try {
    const value = await fn();
    return value instanceof Response ? value : Response.json(value);
  } catch (e) {
    return errorResponse(e);
  }
}

function clientIp(c: C): string {
  return c.req.header("cf-connecting-ip") ?? "local";
}

async function publicLimit(c: C, bucket: string): Promise<Response | null> {
  const { success } = await c.env.RL_PUBLIC.limit({ key: `${bucket}:${clientIp(c)}` });
  return success ? null : Response.json({ error: "rate_limited", message: "Too many attempts. Wait a minute and try again." }, { status: 429 });
}

function rpId(c: C) {
  return new URL(c.req.url).hostname;
}
function origin(c: C) {
  return new URL(c.req.url).origin;
}

function setSession(c: C, token: string) {
  setCookie(c, SESSION_COOKIE, token, { path: "/", httpOnly: true, secure: true, sameSite: "Strict", maxAge: 7 * 24 * 3600 });
}

async function ownerSession(c: C): Promise<{ token: string; ok: boolean; stepUp: boolean }> {
  const token = getCookie(c, SESSION_COOKIE) ?? "";
  if (!token) return { token, ok: false, stepUp: false };
  const s = await hubStub(c.env).validateSession(token);
  return { token, ...s };
}

/** Same-origin check for state-changing owner requests (cookie is SameSite=Strict too). */
function sameOrigin(c: C): boolean {
  const o = c.req.header("origin");
  return c.req.header("x-agent-send") === "1" && (!o || o === origin(c));
}

async function agentPrincipal(c: C): Promise<Principal | null> {
  const auth = c.req.header("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token.startsWith("ast_")) return null;
  const hash = await sha256(token);
  // Gate on the KV cache so unauthenticated floods never reach the Durable Object.
  if (!(await c.env.OAUTH_KV.get(`agentsend:cred:${hash}`))) return null;
  return { kind: "credential", tokenHash: hash };
}

export function buildApp() {
  const app = new Hono<AppEnv>();

  // ------------------------------------------------------- owner: auth
  app.get("/api/owner/status", async (c) =>
    guard(async () => {
      const status = await hubStub(c.env).ownerStatus(rpId(c));
      const s = await ownerSession(c);
      return { ...status, signedIn: s.ok, rpId: rpId(c) };
    }),
  );

  app.post("/api/owner/setup/begin", async (c) => {
    const limited = await publicLimit(c, "setup");
    if (limited) return limited;
    if (!sameOrigin(c)) return Response.json({ error: "forbidden" }, { status: 403 });
    const { code } = await c.req.json<{ code: string }>();
    return guard(() => hubStub(c.env).setupBegin(String(code ?? ""), rpId(c)));
  });

  app.post("/api/owner/setup/finish", async (c) => {
    const limited = await publicLimit(c, "setup");
    if (limited) return limited;
    if (!sameOrigin(c)) return Response.json({ error: "forbidden" }, { status: 403 });
    const body = await c.req.json<{ challengeId: string; response: never; label?: string }>();
    return guard(async () => {
      const r = await hubStub(c.env).setupFinish(body.challengeId, body.response, rpId(c), origin(c), body.label ?? "Passkey");
      setSession(c, r.token!);
      return c.json({ ok: true });
    });
  });

  app.post("/api/owner/login/begin", async (c) => {
    const limited = await publicLimit(c, "login");
    if (limited) return limited;
    if (!sameOrigin(c)) return Response.json({ error: "forbidden" }, { status: 403 });
    return guard(() => hubStub(c.env).loginBegin(rpId(c), "login"));
  });

  app.post("/api/owner/login/finish", async (c) => {
    const limited = await publicLimit(c, "login");
    if (limited) return limited;
    if (!sameOrigin(c)) return Response.json({ error: "forbidden" }, { status: 403 });
    const body = await c.req.json<{ challengeId: string; response: never }>();
    return guard(async () => {
      const r = await hubStub(c.env).loginFinish(body.challengeId, body.response, rpId(c), origin(c), "login");
      setSession(c, r.token!);
      return c.json({ ok: true });
    });
  });

  app.post("/api/owner/logout", async (c) => {
    if (!sameOrigin(c)) return Response.json({ error: "forbidden" }, { status: 403 });
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await hubStub(c.env).logout(token);
    deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
    return c.json({ ok: true });
  });

  // Local development: sign in without a passkey. Refused unless DEV_MODE=1 and the
  // request is for localhost, so it can never work on a deployed hub.
  app.post("/api/dev/session", async (c) => {
    const host = rpId(c);
    if ((c.env as unknown as { DEV_MODE?: string }).DEV_MODE !== "1" || (host !== "localhost" && host !== "127.0.0.1")) return c.json({ error: "not_found" }, 404);
    const r = await hubStub(c.env).devSession();
    setSession(c, r.token);
    return c.json({ ok: true, token: r.token });
  });

  // Everything below needs a signed-in owner.
  app.use("/api/owner/*", async (c, next) => {
    const s = await ownerSession(c);
    if (!s.ok) return Response.json({ error: "no_session", message: "Sign in first." }, { status: 401 });
    if (c.req.method !== "GET" && !sameOrigin(c)) return Response.json({ error: "forbidden" }, { status: 403 });
    c.set("session" as never, s as never);
    await next();
  });
  const sess = (c: C) => c.get("session" as never) as unknown as { token: string; stepUp: boolean };

  app.post("/api/owner/stepup/begin", async (c) => guard(() => hubStub(c.env).loginBegin(rpId(c), "stepup")));
  app.post("/api/owner/stepup/finish", async (c) => {
    const body = await c.req.json<{ challengeId: string; response: never }>();
    return guard(() => hubStub(c.env).loginFinish(body.challengeId, body.response, rpId(c), origin(c), "stepup", sess(c).token));
  });

  app.get("/api/owner/passkeys", (c) => guard(() => hubStub(c.env).listPasskeys()));
  app.post("/api/owner/passkeys/begin", (c) => guard(() => hubStub(c.env).addPasskeyBegin(sess(c).token, rpId(c))));
  app.post("/api/owner/passkeys/finish", async (c) => {
    const body = await c.req.json<{ challengeId: string; response: never; label?: string }>();
    return guard(() => hubStub(c.env).addPasskeyFinish(sess(c).token, body.challengeId, body.response, rpId(c), origin(c), body.label ?? "Passkey"));
  });
  app.delete("/api/owner/passkeys/:id", (c) => guard(() => hubStub(c.env).deletePasskey(sess(c).token, c.req.param("id"))));

  // ------------------------------------------------------- owner: agents
  app.get("/api/owner/agents", (c) => guard(() => hubStub(c.env).listAgentsForOwner()));
  app.patch("/api/owner/agents/:handle", async (c) => {
    const patch = await c.req.json();
    return guard(() => hubStub(c.env).updateAgent(c.req.param("handle"), patch));
  });
  app.post("/api/owner/agents/:handle/delivery", async (c) => {
    const body = await c.req.json();
    return guard(() => hubStub(c.env).setDelivery(sess(c).token, c.req.param("handle"), body));
  });
  app.post("/api/owner/agents/:handle/revoke", (c) => guard(() => hubStub(c.env).revokeAgent(sess(c).token, c.req.param("handle"))));
  app.post("/api/owner/agents/:handle/rotate", (c) => guard(() => hubStub(c.env).rotateCredential(sess(c).token, c.req.param("handle"))));
  app.post("/api/owner/agents/:handle/ping", (c) => guard(() => hubStub(c.env).ping(c.req.param("handle"))));
  app.get("/api/owner/agents/:handle/routine", (c) => guard(async () => ({ instruction: grokRoutineInstruction(c.req.param("handle")) })));

  app.post("/api/owner/invites", async (c) => {
    const body = await c.req.json<{ runtime: Runtime; name: string; handle?: string; description?: string }>();
    return guard(async () => {
      const hub = hubStub(c.env);
      const handle = body.handle?.trim() || undefined;
      const { code, invite } = await hub.createInvite({ runtime: body.runtime, name: body.name, handle, description: body.description });
      const input = { hubUrl: origin(c), invite: code, name: invite.name, handle: invite.handle, description: body.description ?? "" };
      let prompt: string;
      if (body.runtime === "grok") prompt = grokPrompt(input);
      else if (body.runtime === "hermes") {
        const settings = (await hub.settings()) as unknown as { hermes_plugin_source?: string };
        prompt = hermesPrompt({ ...input, pluginSource: settings.hermes_plugin_source || "iamomiid/agent-send-hermes" });
      } else prompt = apiPrompt(input);
      return { invite, prompt };
    });
  });
  app.get("/api/owner/invites", (c) => guard(() => hubStub(c.env).listInvites()));
  app.get("/api/owner/mcp-prompt", (c) => guard(async () => ({ prompt: mcpPrompt(origin(c)) })));

  // ------------------------------------------------------- owner: messages
  app.get("/api/owner/threads", (c) => {
    const q = c.req.query();
    return guard(() => hubStub(c.env).listThreads({ limit: Number(q.limit) || undefined, before: Number(q.before) || undefined, agent: q.agent || undefined, q: q.q || undefined, view: q.view || undefined }));
  });
  app.get("/api/owner/pairs", (c) => {
    const q = c.req.query();
    return guard(() => hubStub(c.env).listPairs({ limit: Number(q.limit) || undefined, before: Number(q.before) || undefined, agent: q.agent || undefined, q: q.q || undefined, view: q.view || undefined }));
  });
  app.get("/api/owner/pairs/:a/:b", (c) => {
    const q = c.req.query();
    return guard(() => hubStub(c.env).getPair(c.req.param("a"), c.req.param("b"), { before: Number(q.before) || undefined, limit: Number(q.limit) || undefined }));
  });
  app.get("/api/owner/threads/:thread", (c) => guard(() => hubStub(c.env).getThread(c.req.param("thread"))));
  app.post("/api/owner/send", async (c) => {
    const body = await c.req.json();
    return guard(() => hubStub(c.env).ownerSend(body));
  });
  app.post("/api/owner/reply", async (c) => {
    const body = await c.req.json<{ request_id: string; result: string }>();
    return guard(() => hubStub(c.env).ownerReply(body.request_id, body.result));
  });
  app.post("/api/owner/messages/:id/retry", (c) => guard(() => hubStub(c.env).retryMessage(c.req.param("id"))));

  // ------------------------------------------------------- owner: settings
  app.get("/api/owner/settings", (c) => guard(() => hubStub(c.env).settings()));
  app.patch("/api/owner/settings", async (c) => {
    const body = await c.req.json();
    return guard(() => hubStub(c.env).updateSettings(body));
  });
  app.get("/api/owner/stats", (c) => guard(() => hubStub(c.env).stats()));
  app.get("/api/owner/audit", (c) => guard(() => hubStub(c.env).listAudit()));
  app.get("/api/owner/grants", (c) => guard(() => hubStub(c.env).listGrants()));
  app.post("/api/owner/grants/:id/revoke", async (c) =>
    guard(async () => {
      const id = c.req.param("id");
      const result = await hubStub(c.env).revokeGrant(sess(c).token, id);
      // Also revoke the OAuth tokens so the client must sign in again.
      const grants = await c.env.OAUTH_PROVIDER.listUserGrants("owner");
      for (const g of grants.items) if (g.metadata?.grantId === id) await c.env.OAUTH_PROVIDER.revokeGrant(g.id, "owner");
      return result;
    }),
  );

  // ------------------------------------------------------- OAuth consent
  app.get("/authorize", async (c) => {
    const limited = await publicLimit(c, "authorize");
    if (limited) return limited;
    const s = await ownerSession(c);
    const url = new URL(c.req.url);
    if (!s.ok) return c.redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`, 302);
    try {
      const oauth = c.env.OAUTH_PROVIDER;
      const req = await oauth.parseAuthRequest(c.req.raw);
      const details = await oauth.describeConsent(req);
      const consent = await oauth.beginConsent(req);
      const haystack = `${details.clientId} ${details.clientName} ${details.clientDomain ?? ""} ${details.redirectHost}`.toLowerCase();
      const suggestedMode = GROK_CLIENT_HINTS.some((h) => haystack.includes(h)) ? "multi" : "single";
      await c.env.OAUTH_KV.put(`agentsend:consent:${consent.handle}`, JSON.stringify({ details, suggestedMode }), { expirationTtl: 600 });
      consent.headers.set("Location", `/consent?h=${encodeURIComponent(consent.handle)}`);
      return new Response(null, { status: 302, headers: consent.headers });
    } catch (e) {
      if (e instanceof AuthorizationError && e.redirectTo) return Response.redirect(e.redirectTo, 302);
      if (e instanceof AuthorizationError || e instanceof CimdFetchError) {
        const message = e instanceof AuthorizationError ? e.description : "This app could not be verified.";
        return new Response(`Sign-in request rejected: ${message}`, { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      throw e;
    }
  });

  app.get("/api/owner/consent/:handle", async (c) =>
    guard(async () => {
      const stash = await c.env.OAUTH_KV.get(`agentsend:consent:${c.req.param("handle")}`, "json");
      if (!stash) return Response.json({ error: "expired", message: "This sign-in request expired. Start again from the app." }, { status: 404 });
      const grants = (await hubStub(c.env).listGrants()).filter((g) => g.mode === "multi" && g.status === "active");
      return { ...(stash as object), sharedConnections: grants.map((g) => ({ id: g.id, client_name: g.client_name, agents: g.agents })) };
    }),
  );

  app.post("/api/owner/consent", async (c) => {
    const body = await c.req.json<{
      handle: string;
      decision: "approve" | "deny";
      mode: "single" | "multi";
      reuseGrant?: string;
      agent?: { handle: string; name: string; description: string };
    }>();
    const oauth = c.env.OAUTH_PROVIDER;
    try {
      if (body.decision !== "approve") {
        const denied = await oauth.denyConsent(c.req.raw, body.handle);
        return Response.json({ redirectTo: denied.headers.get("Location") }, { headers: withoutLocation(denied.headers) });
      }
      if (!sess(c).stepUp) return Response.json({ error: "step_up_required", message: "Confirm with your passkey to continue." }, { status: 403 });
      const stash = (await c.env.OAUTH_KV.get(`agentsend:consent:${body.handle}`, "json")) as { details: { clientId: string; clientName: string; clientDomain?: string } } | null;
      if (!stash) return Response.json({ error: "expired", message: "This sign-in request expired. Start again from the app." }, { status: 404 });
      const hub = hubStub(c.env);
      let grantId: string;
      if (body.mode === "multi" && body.reuseGrant) {
        const g = (await hub.listGrants()).find((x) => x.id === body.reuseGrant && x.status === "active" && x.mode === "multi");
        if (!g) return Response.json({ error: "not_found", message: "That shared connection no longer exists." }, { status: 404 });
        grantId = g.id;
      } else {
        const created = await hub.createGrant({
          clientId: stash.details.clientId,
          clientName: stash.details.clientName,
          clientDomain: stash.details.clientDomain ?? null,
          mode: body.mode,
          agent: body.mode === "single" && body.agent ? { ...body.agent, runtime: "mcp" } : undefined,
        });
        grantId = created.grantId;
      }
      const approved = await oauth.approveConsent(c.req.raw, body.handle);
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        userId: "owner",
        metadata: { grantId },
        scope: approved.request.scope,
        props: { grantId },
        revokeExistingGrants: false,
      });
      await c.env.OAUTH_KV.delete(`agentsend:consent:${body.handle}`);
      return Response.json({ redirectTo }, { headers: withoutLocation(approved.headers) });
    } catch (e) {
      if (e instanceof AuthorizationError) return Response.json({ error: "expired", message: e.description }, { status: 400 });
      return errorResponse(e);
    }
  });

  // ------------------------------------------------------- REST API for agents
  app.post("/api/v1/join", async (c) => {
    const limited = await publicLimit(c, "join");
    if (limited) return limited;
    const body = await c.req.json<{ invite: string; handle?: string; name?: string; description?: string }>();
    return guard(async () => {
      const r = await hubStub(c.env).join(null, body);
      return { handle: r.handle, name: r.name, runtime: r.runtime, token: r.token, hub_url: origin(c) };
    });
  });

  app.use("/api/v1/*", async (c, next) => {
    if (c.req.path === "/api/v1/join") return next();
    const p = await agentPrincipal(c);
    if (!p) return Response.json({ error: "unauthorized", message: "Send your agent token as: Authorization: Bearer ast_..." }, { status: 401 });
    const { success } = await c.env.RL_AGENT.limit({ key: p.kind === "credential" ? p.tokenHash : "x" });
    if (!success) return Response.json({ error: "rate_limited", message: "Slow down." }, { status: 429 });
    c.set("principal" as never, p as never);
    await next();
  });
  const principal = (c: C) => c.get("principal" as never) as unknown as Principal;

  app.get("/api/v1/whoami", (c) => guard(() => hubStub(c.env).whoami(principal(c))));
  app.get("/api/v1/agents", (c) => guard(() => hubStub(c.env).directory(principal(c))));
  app.post("/api/v1/send", async (c) => {
    const body = await c.req.json<{ to: string; message: string; kind?: "request" | "notify"; thread?: string; wait_seconds?: number; deadline_seconds?: number }>();
    return guard(async () => {
      const hub = hubStub(c.env);
      const task = await hub.send(principal(c), undefined, body);
      if (body.kind === "notify") return task;
      return hub.wait(principal(c), undefined, task.task_id, body.wait_seconds ?? 25);
    });
  });
  app.post("/api/v1/check", async (c) => {
    const body = await c.req.json<{ task_id: string; wait_seconds?: number }>();
    return guard(() => hubStub(c.env).wait(principal(c), undefined, body.task_id, body.wait_seconds ?? 0));
  });
  app.post("/api/v1/reply", async (c) => {
    const body = await c.req.json<{ request_id: string; reply_token: string; result: string }>();
    return guard(() => hubStub(c.env).reply(principal(c), undefined, body));
  });
  app.get("/api/v1/inbox", (c) => {
    const since = c.req.query("since");
    return guard(() => hubStub(c.env).inbox(principal(c), undefined, { since: since ? Number(since) : undefined }));
  });

  // ------------------------------------------------------- WebSockets
  app.get("/api/live", async (c) => {
    const s = await ownerSession(c);
    if (!s.ok) return new Response("unauthorized", { status: 401 });
    const o = c.req.header("origin");
    if (o && o !== origin(c)) return new Response("forbidden", { status: 403 });
    const headers = new Headers(c.req.raw.headers);
    headers.set("x-owner-session", s.token);
    return hubStub(c.env).fetch(new Request("https://hub/live", { headers }));
  });

  app.get("/connect", async (c) => {
    const p = await agentPrincipal(c);
    if (!p || p.kind !== "credential") return new Response("unauthorized", { status: 401 });
    const headers = new Headers(c.req.raw.headers);
    headers.set("x-token-hash", p.tokenHash);
    return hubStub(c.env).fetch(new Request("https://hub/connect", { headers }));
  });

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  return app;
}

function withoutLocation(h: Headers): Headers {
  const out = new Headers(h);
  out.delete("Location");
  out.delete("Content-Type");
  return out;
}
