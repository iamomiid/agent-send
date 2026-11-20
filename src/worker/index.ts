// Worker entry: the OAuth provider wraps everything. `/mcp` is the protected
// API route; all other paths go to the Hono app (UI API, consent, REST,
// WebSockets). The provider is built per origin, so the hub works on its
// workers.dev URL and any custom domain without configuration.

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { buildApp, hubStub } from "./app";
import { mcpHandler, type McpCallContext } from "./mcp";
import type { Principal } from "./types";
import { sha256 } from "./util";

export { Hub } from "./hub";

const MAX_BODY = 64 * 1024;
const app = buildApp();
const providers = new Map<string, OAuthProvider<Env>>();

const mcpApi = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext & { props?: unknown }): Promise<Response> {
    const props = (ctx.props ?? {}) as { grantId?: string; tokenHash?: string };
    let principal: Principal;
    if (props.tokenHash) principal = { kind: "credential", tokenHash: props.tokenHash };
    else if (props.grantId) principal = { kind: "grant", grantId: props.grantId };
    else return new Response("unauthorized", { status: 401 });
    const key = props.tokenHash ?? props.grantId!;
    const { success } = await env.RL_AGENT.limit({ key });
    if (!success) return Response.json({ error: "rate_limited" }, { status: 429 });
    const extra: McpCallContext = { principal, hub: hubStub(env), multi: principal.kind === "grant" };
    return mcpHandler.fetch(request, { authInfo: { token: "redacted", clientId: key, scopes: ["agent-send"], extra: extra as unknown as Record<string, unknown> } });
  },
};

function provider(origin: string): OAuthProvider<Env> {
  let p = providers.get(origin);
  if (p) return p;
  p = new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: mcpApi as never,
    defaultHandler: { fetch: (req: Request, env: Env, ctx: ExecutionContext) => app.fetch(req, env, ctx) } as never,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/register",
    scopesSupported: ["agent-send", "offline_access"],
    resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin], resource_name: "agent-send" } as never,
    clientIdMetadataDocumentEnabled: true,
    accessTokenTTL: 3600,
    refreshTokenTTL: 90 * 24 * 3600,
    refreshTokenIdleTTL: 30 * 24 * 3600,
    clientRegistrationTTL: 24 * 3600,
    // Agents that can't do OAuth (scripts, Claude Code with a header) may use their hub token.
    resolveExternalToken: async ({ token, env }) => {
      if (!token.startsWith("ast_")) return null;
      const hash = await sha256(token);
      if (!(await env.OAUTH_KV.get(`agentsend:cred:${hash}`))) return null;
      return { props: { tokenHash: hash }, audience: `${origin}/mcp` };
    },
  });
  providers.set(origin, p);
  return p;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const length = Number(request.headers.get("content-length") ?? "0");
    if (length > MAX_BODY) return Response.json({ error: "too_large", message: "Request bodies are limited to 64 KB." }, { status: 413 });
    // Unauthenticated OAuth endpoints are rate-limited per IP before any work.
    if (url.pathname === "/register" || url.pathname === "/oauth/token") {
      const ip = request.headers.get("cf-connecting-ip") ?? "local";
      const { success } = await env.RL_PUBLIC.limit({ key: `${url.pathname}:${ip}` });
      if (!success) return Response.json({ error: "rate_limited" }, { status: 429 });
    }
    const response = await provider(url.origin).fetch(request, env, ctx);
    if (response.status === 101) return response;
    const headers = new Headers(response.headers);
    headers.set("x-content-type-options", "nosniff");
    headers.set("referrer-policy", "no-referrer");
    if (!headers.has("cache-control") && url.pathname.startsWith("/api/")) headers.set("cache-control", "no-store");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
} satisfies ExportedHandler<Env>;
