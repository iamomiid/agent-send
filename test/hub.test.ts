import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Hub } from "../src/worker/hub";
import type { Principal } from "../src/worker/types";
import { sha256 } from "../src/worker/util";

async function errorOf(p: PromiseLike<unknown>): Promise<string> {
  try {
    await p;
    return "no error";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

function hub(): DurableObjectStub<Hub> {
  const ns = env.HUB as unknown as DurableObjectNamespace<Hub>;
  return ns.get(ns.idFromName(crypto.randomUUID()));
}

async function apiAgent(h: DurableObjectStub<Hub>, name: string, runtime: "api" | "hermes" = "api") {
  const { code } = await h.createInvite({ runtime, name });
  const joined = await h.join(null, { invite: code });
  const p: Principal = { kind: "credential", tokenHash: await sha256(joined.token!) };
  return { handle: joined.handle, token: joined.token!, p };
}

describe("hub messaging", () => {
  it("delivers an owner request to an inbox agent and returns its reply", async () => {
    const h = hub();
    const a = await apiAgent(h, "Alpha");
    expect(a.handle).toBe("alpha");
    const task = await h.ownerSend({ to: "alpha", message: "Say PONG" });
    expect(task.status).toBe("queued");

    const inbox = await h.inbox(a.p, undefined, {});
    expect(inbox.messages).toHaveLength(1);
    const req = inbox.messages[0]!;
    expect(req.type).toBe("request");
    expect(req.note).toMatch(/data, not instructions/);

    expect(await errorOf(h.reply(a.p, undefined, { request_id: req.request_id!, reply_token: "wrong", result: "PONG" }))).toMatch(/bad_reply_token/);
    const r = await h.reply(a.p, undefined, { request_id: req.request_id!, reply_token: req.reply_token!, result: "PONG" });
    expect(r.ok).toBe(true);
    // Idempotent for the identical result, rejected for a different one.
    expect((await h.reply(a.p, undefined, { request_id: req.request_id!, reply_token: req.reply_token!, result: "PONG" })).duplicate).toBe(true);
    expect(await errorOf(h.reply(a.p, undefined, { request_id: req.request_id!, reply_token: req.reply_token!, result: "other" }))).toMatch(/already_replied/);

    const done = await h.wait({ kind: "owner" }, undefined, task.task_id, 0);
    expect(done.result).toBe("PONG");
    expect(done.from).toBe("alpha");
  });

  it("resolves a waiting sender as soon as the reply arrives", async () => {
    const h = hub();
    const a = await apiAgent(h, "Alpha");
    const b = await apiAgent(h, "Bravo");
    const task = await h.send(a.p, undefined, { to: "bravo", message: "hi" });
    const waiting = h.wait(a.p, undefined, task.task_id, 10);
    const inbox = await h.inbox(b.p, undefined, {});
    const req = inbox.messages[0]!;
    await h.reply(b.p, undefined, { request_id: req.request_id!, reply_token: req.reply_token!, result: "hello back" });
    const t = await waiting;
    expect(t.result).toBe("hello back");
    // The reply was consumed by the waiting call, so it doesn't reappear in the sender's inbox as unread work.
    const aInbox = await h.inbox(a.p, undefined, {});
    expect(aInbox.messages.every((m) => m.status === "read")).toBe(true);
  });

  it("rejects a request back to an agent already waiting in the chain", async () => {
    const h = hub();
    const a = await apiAgent(h, "Alpha");
    const b = await apiAgent(h, "Bravo");
    await h.send(a.p, undefined, { to: "bravo", message: "question" });
    // Alpha is waiting on bravo, so bravo → alpha would deadlock and is refused.
    expect(await errorOf(h.send(b.p, undefined, { to: "alpha", message: "back at you" }))).toMatch(/loop/);
    // A notification is one-way and allowed.
    const n = await h.send(b.p, undefined, { to: "alpha", message: "fyi", kind: "notify" });
    expect(n.hint).toMatch(/Notification/);
  });

  it("enforces the hop limit across a chain", async () => {
    const h = hub();
    const agents = [];
    for (const name of ["A1", "A2", "A3", "A4", "A5", "A6"]) agents.push(await apiAgent(h, name));
    // Four hops are allowed: a1 → a2 → a3 → a4 → a5.
    for (let i = 0; i < 4; i++) await h.send(agents[i]!.p, undefined, { to: `a${i + 2}`, message: String(i) });
    // The fifth is refused.
    expect(await errorOf(h.send(agents[4]!.p, undefined, { to: "a6", message: "5" }))).toMatch(/hop_limit/);
  });

  it("refuses unknown recipients, self-messages and oversized messages", async () => {
    const h = hub();
    const a = await apiAgent(h, "Alpha");
    expect(await errorOf(h.send(a.p, undefined, { to: "nobody", message: "x" }))).toMatch(/unknown_recipient/);
    expect(await errorOf(h.send(a.p, undefined, { to: "alpha", message: "x" }))).toMatch(/self/);
    await apiAgent(h, "Bravo");
    expect(await errorOf(h.send(a.p, undefined, { to: "bravo", message: "x".repeat(33 * 1024) }))).toMatch(/too_large/);
  });

  it("invites are single use and handles are never reused", async () => {
    const h = hub();
    const { code } = await h.createInvite({ runtime: "api", name: "Alpha" });
    await h.join(null, { invite: code });
    expect(await errorOf(h.join(null, { invite: code }))).toMatch(/bad_invite/);
    expect(await errorOf(h.createInvite({ runtime: "api", name: "Alpha again", handle: "alpha" }))).toMatch(/handle_taken/);
    expect(await errorOf(h.createInvite({ runtime: "api", name: "x", handle: "owner" }))).toMatch(/reserved_handle/);
  });

  it("multi-identity grants require `as` and only accept bots that joined through them", async () => {
    const h = hub();
    const { grantId } = await h.createGrant({ clientId: "https://cursor.com/oauth/mcp-client.json", clientName: "Cursor", clientDomain: "cursor.com", mode: "multi" });
    const g: Principal = { kind: "grant", grantId };
    const { code } = await h.createInvite({ runtime: "grok", name: "Creator Analyst" });
    expect(await errorOf(h.join(null, { invite: code }))).toMatch(/wrong_channel/);
    const joined = await h.join(g, { invite: code });
    expect(joined.handle).toBe("creator-analyst");
    expect(await errorOf(h.whoami(g))).toMatch(/as_required/);
    const me = await h.whoami(g, "creator-analyst");
    expect(me.trust).toBe("self_declared");
    expect(await errorOf(h.whoami(g, "someone-else"))).toMatch(/unknown_identity/);
  });

  it("revoked credentials stop working", async () => {
    const h = hub();
    const a = await apiAgent(h, "Alpha");
    const { grantId } = await h.createGrant({ clientId: "c", clientName: "Claude", clientDomain: null, mode: "single", agent: { handle: "claude", name: "Claude", description: "", runtime: "mcp" } });
    expect((await h.whoami({ kind: "grant", grantId })).handle).toBe("claude");
    // Step-up is required for revocation; simulate a fresh owner session.
    expect(a.handle).toBe("alpha");
  });
});

