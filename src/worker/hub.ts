// The Hub Durable Object: the single source of truth for agents, credentials,
// invites, messages and deliveries. It owns delivery retries and deadlines via
// alarms, and the hibernatable WebSockets for the owner's live UI feed and for
// agent connectors.

import { DurableObject } from "cloudflare:workers";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { buildEnvelope, newAgentToken, newInviteCode, standardWebhookHeaders } from "./envelope";
import { DEFAULT_SETTINGS, MAX_MESSAGE_BYTES, MIGRATIONS, type Settings } from "./schema";
import type {
  AgentRow,
  DeliveryMethod,
  DirectoryEntry,
  InviteView,
  LiveEvent,
  MessageKind,
  MessageRow,
  MessageView,
  OwnerAgentView,
  Principal,
  Runtime,
  TaskResult,
} from "./types";
import {
  HANDLE_RE,
  HubError,
  RESERVED_HANDLES,
  base64url,
  clampInt,
  isHttpsUrl,
  randomId,
  randomToken,
  safeEqual,
  sha256,
  slugifyHandle,
} from "./util";

const SESSION_TTL = 7 * 24 * 3600 * 1000;
const STEPUP_TTL = 5 * 60 * 1000;
const INVITE_TTL = 60 * 60 * 1000;
const REPLY_WAKE_GRACE = 15 * 1000;
const ACK_TIMEOUT = 30 * 1000;
const NOTIFY_GIVE_UP = 24 * 3600 * 1000;
const BACKOFF = [10_000, 30_000, 120_000, 600_000];
const BACKOFF_TAIL = 1_800_000;
const MAX_WAIT_MS = 25_000;
const SETUP_MAX_FAILURES = 5;
const SETUP_LOCK_MS = 15 * 60 * 1000;
export const HUB_VERSION = "0.1.0";

type Waiter = (task: TaskResult) => void;
type ReplyResult = { ok: boolean; duplicate?: boolean; late?: boolean };

interface ConnAttachment {
  kind: "owner" | "agent";
  handle?: string;
}

export class Hub extends DurableObject<Env> {
  private sql: SqlStorage;
  private waiters = new Map<string, Set<Waiter>>();
  private rate = new Map<string, { window: number; count: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => this.migrate());
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
  }

  // ---------------------------------------------------------------- storage

  private migrate() {
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const done = Number(this.meta("schema_version") ?? "0");
    for (let i = done; i < MIGRATIONS.length; i++) {
      this.sql.exec(MIGRATIONS[i]!);
      this.setMeta("schema_version", String(i + 1));
    }
    if (!this.one<AgentRow>("SELECT * FROM agents WHERE handle = 'owner'")) {
      this.sql.exec(
        `INSERT INTO agents (handle, name, description, runtime, status, trust, delivery_method, created_at)
         VALUES ('owner', 'Owner', 'The person who runs this hub.', 'owner', 'active', 'verified', 'ui', ?)`,
        Date.now(),
      );
    }
  }

  private one<T>(query: string, ...args: unknown[]): T | null {
    const rows = this.sql.exec(query, ...args).toArray();
    return (rows[0] as T | undefined) ?? null;
  }

  private all<T>(query: string, ...args: unknown[]): T[] {
    return this.sql.exec(query, ...args).toArray() as T[];
  }

  private meta(key: string): string | null {
    return this.one<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)?.value ?? null;
  }

  private setMeta(key: string, value: string) {
    this.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  settings(): Settings {
    const rows = this.all<{ key: string; value: string }>("SELECT key, value FROM settings");
    const s: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    for (const r of rows) {
      if (r.key in DEFAULT_SETTINGS) s[r.key] = JSON.parse(r.value);
    }
    return s as unknown as Settings;
  }

  private audit(actor: string, action: string, detail: Record<string, unknown> = {}) {
    this.sql.exec("INSERT INTO audit (at, actor, action, detail) VALUES (?, ?, ?, ?)", Date.now(), actor, action, JSON.stringify(detail));
  }

  // ------------------------------------------------------------ owner auth

  private async setupCodeState(): Promise<{ configured: boolean; hash: string | null }> {
    const code = this.env.SETUP_CODE;
    if (!code || code.length < 24) return { configured: false, hash: null };
    return { configured: true, hash: await sha256(code) };
  }

  async ownerStatus(rpId: string) {
    const { configured, hash } = await this.setupCodeState();
    const total = this.one<{ n: number }>("SELECT COUNT(*) AS n FROM passkeys")!.n;
    const here = this.one<{ n: number }>("SELECT COUNT(*) AS n FROM passkeys WHERE rp_id = ?", rpId)!.n;
    const enrolledWith = this.meta("enrolled_code_hash");
    // The setup code enrols exactly once. A new device or address (passkeys are bound to the
    // hostname) needs a rotated SETUP_CODE, so a leaked code can't enrol on a second hostname.
    const enrolOpen = configured && (total === 0 || (hash !== null && enrolledWith !== hash));
    return {
      setupCodeConfigured: configured,
      hasPasskeys: here > 0,
      otherHostPasskeys: total - here,
      enrolOpen,
      version: HUB_VERSION,
    };
  }

  private checkSetupLock() {
    const raw = this.meta("setup_failures");
    const st = raw ? (JSON.parse(raw) as { count: number; until: number }) : { count: 0, until: 0 };
    if (st.until > Date.now()) throw new HubError("locked", "Too many wrong setup codes. Try again in 15 minutes.", 429);
    return st;
  }

  async setupBegin(code: string, rpId: string) {
    const status = await this.ownerStatus(rpId);
    if (!status.setupCodeConfigured) throw new HubError("setup_code_missing", "The SETUP_CODE secret is missing or shorter than 24 characters. Set it in the Cloudflare dashboard.", 500);
    if (!status.enrolOpen) throw new HubError("enrolment_closed", "A passkey is already registered. Sign in instead.", 403);
    const st = this.checkSetupLock();
    if (!(await safeEqual(code, this.env.SETUP_CODE!))) {
      const count = st.count + 1;
      this.setMeta("setup_failures", JSON.stringify({ count: count >= SETUP_MAX_FAILURES ? 0 : count, until: count >= SETUP_MAX_FAILURES ? Date.now() + SETUP_LOCK_MS : 0 }));
      this.audit("anonymous", "setup.failed");
      throw new HubError("bad_setup_code", "That setup code is not correct.", 401);
    }
    this.setMeta("setup_failures", JSON.stringify({ count: 0, until: 0 }));
    return this.passkeyRegistrationOptions(rpId, "setup");
  }

  private async passkeyRegistrationOptions(rpId: string, kind: "setup" | "add") {
    const existing = this.all<{ id: string; transports: string | null }>("SELECT id, transports FROM passkeys WHERE rp_id = ?", rpId);
    const options = await generateRegistrationOptions({
      rpName: "agent-send",
      rpID: rpId,
      userName: "owner",
      userDisplayName: "Hub owner",
      userID: new TextEncoder().encode("agent-send-owner"),
      attestationType: "none",
      excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports ? JSON.parse(p.transports) : undefined })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    const challengeId = randomId("ch");
    this.sql.exec("INSERT INTO challenges (id, challenge, kind, expires_at) VALUES (?, ?, ?, ?)", challengeId, options.challenge, kind, Date.now() + 5 * 60_000);
    return { challengeId, options };
  }

  private takeChallenge(id: string, kinds: string[]): string {
    const row = this.one<{ challenge: string; kind: string; expires_at: number }>("SELECT challenge, kind, expires_at FROM challenges WHERE id = ?", id);
    this.sql.exec("DELETE FROM challenges WHERE id = ?", id);
    if (!row || row.expires_at < Date.now() || !kinds.includes(row.kind)) throw new HubError("challenge_expired", "This sign-in attempt expired. Start again.", 400);
    return row.challenge;
  }

  async setupFinish(challengeId: string, response: RegistrationResponseJSON, rpId: string, origin: string, label: string) {
    const challenge = this.takeChallenge(challengeId, ["setup"]);
    const status = await this.ownerStatus(rpId);
    if (!status.enrolOpen) throw new HubError("enrolment_closed", "Enrolment is closed.", 403);
    await this.storePasskey(challenge, response, rpId, origin, label);
    const { hash } = await this.setupCodeState();
    this.setMeta("enrolled_code_hash", hash!);
    this.audit("owner", "passkey.enrolled", { rp_id: rpId, via: "setup" });
    return this.createSession();
  }

  async addPasskeyBegin(sessionToken: string, rpId: string) {
    await this.requireStepUp(sessionToken);
    return this.passkeyRegistrationOptions(rpId, "add");
  }

  async addPasskeyFinish(sessionToken: string, challengeId: string, response: RegistrationResponseJSON, rpId: string, origin: string, label: string) {
    await this.requireStepUp(sessionToken);
    const challenge = this.takeChallenge(challengeId, ["add"]);
    await this.storePasskey(challenge, response, rpId, origin, label);
    this.audit("owner", "passkey.added", { rp_id: rpId });
    return { ok: true };
  }

  private async storePasskey(challenge: string, response: RegistrationResponseJSON, rpId: string, origin: string, label: string) {
    const v = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpId, requireUserVerification: true });
    if (!v.verified || !v.registrationInfo) throw new HubError("passkey_failed", "The passkey could not be verified.", 400);
    const cred = v.registrationInfo.credential;
    this.sql.exec(
      "INSERT INTO passkeys (id, public_key, counter, transports, rp_id, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      cred.id,
      base64url(cred.publicKey),
      cred.counter,
      cred.transports ? JSON.stringify(cred.transports) : null,
      rpId,
      label.slice(0, 60) || "Passkey",
      Date.now(),
    );
  }

  async loginBegin(rpId: string, purpose: "login" | "stepup") {
    const keys = this.all<{ id: string; transports: string | null }>("SELECT id, transports FROM passkeys WHERE rp_id = ?", rpId);
    if (keys.length === 0) throw new HubError("no_passkeys", "No passkey is registered for this address yet.", 404);
    const options = await generateAuthenticationOptions({
      rpID: rpId,
      userVerification: "required",
      allowCredentials: keys.map((k) => ({ id: k.id, transports: k.transports ? JSON.parse(k.transports) : undefined })),
    });
    const challengeId = randomId("ch");
    this.sql.exec("INSERT INTO challenges (id, challenge, kind, expires_at) VALUES (?, ?, ?, ?)", challengeId, options.challenge, purpose, Date.now() + 5 * 60_000);
    return { challengeId, options };
  }

  async loginFinish(challengeId: string, response: AuthenticationResponseJSON, rpId: string, origin: string, purpose: "login" | "stepup", sessionToken?: string): Promise<{ ok: boolean; token: string | null }> {
    const challenge = this.takeChallenge(challengeId, [purpose]);
    const key = this.one<{ id: string; public_key: string; counter: number; transports: string | null }>("SELECT * FROM passkeys WHERE id = ? AND rp_id = ?", response.id, rpId);
    if (!key) throw new HubError("unknown_passkey", "That passkey is not registered here.", 401);
    const publicKey = Uint8Array.from(atob(key.public_key.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((key.public_key.length + 3) % 4)), (c) => c.charCodeAt(0));
    const v = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
      requireUserVerification: true,
      credential: { id: key.id, publicKey, counter: key.counter, transports: key.transports ? JSON.parse(key.transports) : undefined },
    });
    if (!v.verified) throw new HubError("passkey_failed", "The passkey could not be verified.", 401);
    this.sql.exec("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?", v.authenticationInfo.newCounter, Date.now(), key.id);
    if (purpose === "stepup") {
      const hash = await sha256(sessionToken ?? "");
      const updated = this.sql.exec("UPDATE sessions SET stepup_until = ? WHERE token_hash = ? AND expires_at > ?", Date.now() + STEPUP_TTL, hash, Date.now()).rowsWritten;
      if (!updated) throw new HubError("no_session", "Sign in first.", 401);
      return { ok: true, token: null };
    }
    this.audit("owner", "owner.signed_in");
    return this.createSession();
  }

  private async createSession() {
    const token = randomToken(32);
    this.sql.exec("INSERT INTO sessions (token_hash, created_at, expires_at, stepup_until) VALUES (?, ?, ?, ?)", await sha256(token), Date.now(), Date.now() + SESSION_TTL, Date.now() + STEPUP_TTL);
    return { ok: true, token };
  }

  async validateSession(token: string): Promise<{ ok: boolean; stepUp: boolean }> {
    if (!token) return { ok: false, stepUp: false };
    const row = this.one<{ expires_at: number; stepup_until: number }>("SELECT expires_at, stepup_until FROM sessions WHERE token_hash = ?", await sha256(token));
    if (!row || row.expires_at < Date.now()) return { ok: false, stepUp: false };
    return { ok: true, stepUp: row.stepup_until > Date.now() };
  }

  private async requireStepUp(token: string) {
    const s = await this.validateSession(token);
    if (!s.ok) throw new HubError("no_session", "Sign in first.", 401);
    if (!s.stepUp) throw new HubError("step_up_required", "Confirm with your passkey to continue.", 403);
  }

  /** Local development only (the Worker refuses to call this unless DEV_MODE=1 on localhost). */
  async devSession() {
    return this.createSession();
  }

  async logout(token: string) {
    this.sql.exec("DELETE FROM sessions WHERE token_hash = ?", await sha256(token));
    return { ok: true };
  }

  listPasskeys() {
    return this.all<{ id: string; label: string; rp_id: string; created_at: number; last_used_at: number | null }>(
      "SELECT id, label, rp_id, created_at, last_used_at FROM passkeys ORDER BY created_at",
    );
  }

  async deletePasskey(sessionToken: string, id: string) {
    await this.requireStepUp(sessionToken);
    const n = this.one<{ n: number }>("SELECT COUNT(*) AS n FROM passkeys")!.n;
    if (n <= 1) throw new HubError("last_passkey", "You can't remove your only passkey.", 400);
    this.sql.exec("DELETE FROM passkeys WHERE id = ?", id);
    this.audit("owner", "passkey.removed", { id });
    return { ok: true };
  }

  // ------------------------------------------------------------- identity

  private agent(handle: string): AgentRow | null {
    return this.one<AgentRow>("SELECT * FROM agents WHERE handle = ?", handle);
  }

  /** Resolve the calling agent from a Worker-established principal. */
  private async caller(p: Principal, as?: string): Promise<AgentRow> {
    let agent: AgentRow | null = null;
    if (p.kind === "owner") agent = this.agent("owner");
    else if (p.kind === "credential") {
      const cred = this.one<{ handle: string }>("SELECT handle FROM credentials WHERE hash = ? AND revoked_at IS NULL", p.tokenHash);
      if (!cred) throw new HubError("unauthorized", "This credential is not valid.", 401);
      agent = this.agent(cred.handle);
      if (as && agent && as !== agent.handle) throw new HubError("forbidden", `This credential belongs to "${agent.handle}", not "${as}".`, 403);
    } else {
      const grant = this.one<{ mode: string; status: string }>("SELECT mode, status FROM grants WHERE id = ?", p.grantId);
      if (!grant || grant.status !== "active") throw new HubError("unauthorized", "This connection was revoked. Reconnect it from the hub.", 401);
      if (grant.mode === "multi") {
        if (!as) throw new HubError("as_required", 'This connection is shared by several agents. Pass as="<your handle>". If you have no handle yet, ask your owner for an invite and call join.', 400);
        agent = this.one<AgentRow>("SELECT * FROM agents WHERE handle = ? AND grant_id = ?", as, p.grantId);
        if (!agent) throw new HubError("unknown_identity", `No agent "${as}" joined through this connection. Use join(invite) first.`, 403);
      } else {
        agent = this.one<AgentRow>("SELECT * FROM agents WHERE grant_id = ? AND status != 'revoked' LIMIT 1", p.grantId);
        if (as && agent && as !== agent.handle) throw new HubError("forbidden", `This connection belongs to "${agent.handle}", not "${as}".`, 403);
      }
    }
    if (!agent) throw new HubError("unauthorized", "Unknown agent.", 401);
    if (agent.status === "revoked") throw new HubError("revoked", "This agent was revoked by the owner.", 403);
    if (agent.status === "pending") throw new HubError("pending", "This agent is waiting for the owner's approval.", 403);
    this.touch(agent);
    return agent;
  }

  private touch(agent: AgentRow) {
    const t = Date.now();
    if (!agent.last_seen_at || t - agent.last_seen_at > 30_000) {
      this.sql.exec("UPDATE agents SET last_seen_at = ? WHERE handle = ?", t, agent.handle);
      agent.last_seen_at = t;
    }
  }

  private rateLimit(agent: AgentRow) {
    if (agent.handle === "owner") return;
    const limit = this.settings().tool_calls_per_minute;
    const minute = Math.floor(Date.now() / 60_000);
    const r = this.rate.get(agent.handle);
    if (!r || r.window !== minute) this.rate.set(agent.handle, { window: minute, count: 1 });
    else if (++r.count > limit) throw new HubError("rate_limited", `Rate limit reached (${limit} calls per minute). Slow down.`, 429);
  }

  async whoami(p: Principal, as?: string) {
    const a = await this.caller(p, as);
    return {
      handle: a.handle,
      name: a.name,
      description: a.description,
      runtime: a.runtime,
      trust: a.trust,
      can_send: a.can_send === 1,
      can_receive: a.can_receive === 1,
      hub_version: HUB_VERSION,
    };
  }

  async directory(p: Principal, as?: string): Promise<{ self: string; agents: DirectoryEntry[] }> {
    const me = await this.caller(p, as);
    const rows = this.all<AgentRow>("SELECT * FROM agents WHERE status = 'active' AND hidden = 0 AND handle != ? ORDER BY handle", me.handle);
    return { self: me.handle, agents: rows.map((r) => this.directoryEntry(r)) };
  }

  private directoryEntry(r: AgentRow): DirectoryEntry {
    return { handle: r.handle, name: r.name, description: r.description, runtime: r.runtime, trust: r.trust, can_receive: r.can_receive === 1 && r.status === "active" };
  }

  private ownerView(r: AgentRow): OwnerAgentView {
    return {
      ...this.directoryEntry(r),
      status: r.status,
      grant_id: r.grant_id,
      delivery: {
        method: r.delivery_method,
        preset: r.delivery_preset,
        url: r.delivery_url,
        has_secret: !!r.delivery_secret,
        connected: r.delivery_method === "connector" ? this.ctx.getWebSockets(`agent:${r.handle}`).length > 0 : false,
        pending: r.pending_delivery ? JSON.parse(r.pending_delivery) : null,
      },
      can_send: r.can_send === 1,
      hidden: r.hidden === 1,
      created_at: r.created_at,
      last_seen_at: r.last_seen_at,
    };
  }

  // -------------------------------------------------------- invites & join

  private validateNewHandle(handle: string) {
    if (!HANDLE_RE.test(handle)) throw new HubError("bad_handle", "Handles use lowercase letters, digits and hyphens (1–32 characters).", 400);
    if (RESERVED_HANDLES.has(handle)) throw new HubError("reserved_handle", `"${handle}" is reserved.`, 400);
    if (this.agent(handle)) throw new HubError("handle_taken", `The handle "${handle}" is already used (handles are never reused).`, 409);
  }

  async createInvite(input: { runtime: Runtime; name: string; handle?: string; description?: string }) {
    const name = (input.name ?? "").trim().slice(0, 80);
    if (!name) throw new HubError("bad_name", "Give the agent a name.", 400);
    if (!["grok", "hermes", "api"].includes(input.runtime)) throw new HubError("bad_runtime", "Unsupported runtime for invites.", 400);
    // Fix the handle at invite time so prompts can name it up front (Grok must save its skill first).
    const handle = input.handle?.trim() ? input.handle.trim() : slugifyHandle(name);
    this.validateNewHandle(handle);
    const code = newInviteCode();
    const id = randomId("iv", 6);
    this.sql.exec(
      "INSERT INTO invites (code_hash, id, runtime, handle, name, description, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      await sha256(code),
      id,
      input.runtime,
      handle,
      name,
      (input.description ?? "").slice(0, 500),
      Date.now(),
      Date.now() + INVITE_TTL,
    );
    this.audit("owner", "invite.created", { id, runtime: input.runtime, name });
    const invite = this.inviteView(id)!;
    this.broadcast({ type: "invite", invite });
    return { code, invite };
  }

  private inviteView(id: string): InviteView | null {
    return this.one<InviteView>("SELECT id, runtime, handle, name, expires_at, used_at, used_by FROM invites WHERE id = ?", id);
  }

  listInvites(): InviteView[] {
    return this.all<InviteView>("SELECT id, runtime, handle, name, expires_at, used_at, used_by FROM invites ORDER BY created_at DESC LIMIT 50");
  }

  /**
   * Redeem an invite. For Grok Bots the caller is a multi-identity OAuth grant;
   * for connector/API agents there is no principal yet and a token is issued.
   */
  async join(p: Principal | null, input: { invite: string; handle?: string; name?: string; description?: string }) {
    const inv = this.one<{ id: string; runtime: Runtime; handle: string | null; name: string; description: string; expires_at: number; used_at: number | null }>(
      "SELECT * FROM invites WHERE code_hash = ?",
      await sha256(input.invite ?? ""),
    );
    if (!inv || inv.used_at || inv.expires_at < Date.now()) throw new HubError("bad_invite", "This invite is invalid, expired or already used. Ask your owner for a new one.", 400);
    const handle = inv.handle ?? (input.handle?.trim() || slugifyHandle(input.name || inv.name));
    this.validateNewHandle(handle);
    const name = inv.name || input.name || handle;
    const description = (inv.description || input.description || "").slice(0, 500);
    let token: string | null = null;
    if (inv.runtime === "grok") {
      if (!p || p.kind !== "grant") throw new HubError("wrong_channel", "Grok invites are redeemed through the agent-send MCP connector's join tool.", 400);
      const grant = this.one<{ mode: string; status: string }>("SELECT mode, status FROM grants WHERE id = ?", p.grantId);
      if (!grant || grant.status !== "active") throw new HubError("unauthorized", "This connection was revoked.", 401);
      if (grant.mode !== "multi") throw new HubError("single_identity", "This connection already belongs to one agent.", 400);
      this.sql.exec(
        `INSERT INTO agents (handle, name, description, runtime, status, trust, grant_id, delivery_method, delivery_preset, created_at)
         VALUES (?, ?, ?, 'grok', 'active', 'self_declared', ?, 'none', 'grok', ?)`,
        handle, name, description, p.grantId, Date.now(),
      );
    } else {
      token = newAgentToken();
      const method: DeliveryMethod = inv.runtime === "hermes" ? "connector" : "none";
      this.sql.exec(
        `INSERT INTO agents (handle, name, description, runtime, status, trust, delivery_method, created_at)
         VALUES (?, ?, ?, ?, 'active', 'verified', ?, ?)`,
        handle, name, description, inv.runtime, method, Date.now(),
      );
      await this.storeCredential(handle, token, inv.runtime === "hermes" ? "connector" : "api_key");
    }
    this.sql.exec("UPDATE invites SET used_at = ?, used_by = ? WHERE id = ?", Date.now(), handle, inv.id);
    this.audit(handle, "agent.joined", { invite: inv.id, runtime: inv.runtime });
    this.broadcast({ type: "agent", agent: this.ownerView(this.agent(handle)!) });
    this.broadcast({ type: "invite", invite: this.inviteView(inv.id)! });
    return { handle, name, runtime: inv.runtime, token };
  }

  private async storeCredential(handle: string, token: string, kind: string) {
    const hash = await sha256(token);
    this.sql.exec("INSERT INTO credentials (hash, handle, kind, created_at) VALUES (?, ?, ?, ?)", hash, handle, kind, Date.now());
    await this.env.OAUTH_KV.put(`agentsend:cred:${hash}`, handle);
  }

  async rotateCredential(sessionToken: string, handle: string) {
    await this.requireStepUp(sessionToken);
    const a = this.agent(handle);
    if (!a || a.grant_id || a.runtime === "owner") throw new HubError("not_found", "This agent has no token to rotate.", 404);
    await this.revokeCredentials(handle);
    const token = newAgentToken();
    await this.storeCredential(handle, token, a.delivery_method === "connector" ? "connector" : "api_key");
    this.audit("owner", "credential.rotated", { handle });
    return { token };
  }

  private async revokeCredentials(handle: string) {
    const creds = this.all<{ hash: string }>("SELECT hash FROM credentials WHERE handle = ? AND revoked_at IS NULL", handle);
    for (const c of creds) await this.env.OAUTH_KV.delete(`agentsend:cred:${c.hash}`);
    this.sql.exec("UPDATE credentials SET revoked_at = ? WHERE handle = ? AND revoked_at IS NULL", Date.now(), handle);
    for (const ws of this.ctx.getWebSockets(`agent:${handle}`)) ws.close(4001, "credential revoked");
  }

  // ------------------------------------------------------------- OAuth grants

  async createGrant(input: { clientId: string; clientName: string; clientDomain: string | null; mode: "single" | "multi"; agent?: { handle: string; name: string; description: string; runtime: Runtime } }) {
    const id = randomId("g", 10);
    if (input.mode === "single") {
      if (!input.agent) throw new HubError("agent_required", "Choose a handle for this agent.", 400);
      this.validateNewHandle(input.agent.handle);
    }
    this.sql.exec(
      "INSERT INTO grants (id, client_id, client_name, client_domain, mode, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)",
      id, input.clientId, input.clientName.slice(0, 120), input.clientDomain, input.mode, Date.now(),
    );
    if (input.mode === "single" && input.agent) {
      this.sql.exec(
        `INSERT INTO agents (handle, name, description, runtime, status, trust, grant_id, delivery_method, created_at)
         VALUES (?, ?, ?, ?, 'active', 'verified', ?, 'none', ?)`,
        input.agent.handle, input.agent.name.slice(0, 80) || input.agent.handle, input.agent.description.slice(0, 500), input.agent.runtime, id, Date.now(),
      );
      this.broadcast({ type: "agent", agent: this.ownerView(this.agent(input.agent.handle)!) });
    }
    this.audit("owner", "grant.approved", { id, client: input.clientName, mode: input.mode });
    return { grantId: id };
  }

  listGrants() {
    const grants = this.all<{ id: string; client_id: string; client_name: string; client_domain: string | null; mode: string; status: string; created_at: number }>(
      "SELECT * FROM grants ORDER BY created_at DESC",
    );
    return grants.map((g) => ({ ...g, agents: this.all<{ handle: string }>("SELECT handle FROM agents WHERE grant_id = ?", g.id).map((a) => a.handle) }));
  }

  async revokeGrant(sessionToken: string, grantId: string) {
    await this.requireStepUp(sessionToken);
    this.sql.exec("UPDATE grants SET status = 'revoked' WHERE id = ?", grantId);
    const agents = this.all<{ handle: string }>("SELECT handle FROM agents WHERE grant_id = ?", grantId);
    for (const a of agents) this.sql.exec("UPDATE agents SET status = 'revoked' WHERE handle = ?", a.handle);
    this.audit("owner", "grant.revoked", { id: grantId });
    for (const a of agents) this.broadcast({ type: "agent", agent: this.ownerView(this.agent(a.handle)!) });
    return { ok: true, handles: agents.map((a) => a.handle) };
  }

  // ------------------------------------------------------- owner: agents

  listAgentsForOwner(): OwnerAgentView[] {
    return this.all<AgentRow>("SELECT * FROM agents ORDER BY CASE WHEN handle = 'owner' THEN 0 ELSE 1 END, created_at").map((r) => this.ownerView(r));
  }

  async updateAgent(handle: string, patch: { name?: string; description?: string; can_send?: boolean; can_receive?: boolean; hidden?: boolean; status?: "active" | "paused" }) {
    const a = this.agent(handle);
    if (!a || a.runtime === "owner") throw new HubError("not_found", "Unknown agent.", 404);
    if (a.status === "revoked") throw new HubError("revoked", "Revoked agents can't be changed.", 400);
    if (patch.name !== undefined) this.sql.exec("UPDATE agents SET name = ? WHERE handle = ?", patch.name.slice(0, 80) || a.name, handle);
    if (patch.description !== undefined) this.sql.exec("UPDATE agents SET description = ? WHERE handle = ?", patch.description.slice(0, 500), handle);
    if (patch.can_send !== undefined) this.sql.exec("UPDATE agents SET can_send = ? WHERE handle = ?", patch.can_send ? 1 : 0, handle);
    if (patch.can_receive !== undefined) this.sql.exec("UPDATE agents SET can_receive = ? WHERE handle = ?", patch.can_receive ? 1 : 0, handle);
    if (patch.hidden !== undefined) this.sql.exec("UPDATE agents SET hidden = ? WHERE handle = ?", patch.hidden ? 1 : 0, handle);
    if (patch.status === "active" || patch.status === "paused") this.sql.exec("UPDATE agents SET status = ? WHERE handle = ?", patch.status, handle);
    this.audit("owner", "agent.updated", { handle, ...patch });
    const view = this.ownerView(this.agent(handle)!);
    this.broadcast({ type: "agent", agent: view });
    if (patch.status === "active") this.kick();
    return view;
  }

  /** Set where an agent's mail goes. Only the owner can, with a fresh passkey. */
  async setDelivery(sessionToken: string, handle: string, input: { method: DeliveryMethod; preset?: string; url?: string; secret?: string }) {
    await this.requireStepUp(sessionToken);
    const a = this.agent(handle);
    if (!a || a.runtime === "owner") throw new HubError("not_found", "Unknown agent.", 404);
    if (input.method === "webhook") {
      if (!input.url || !isHttpsUrl(input.url)) throw new HubError("bad_url", "Webhook URLs must be https.", 400);
      const secret = input.secret?.trim() || a.delivery_secret;
      if (!secret) throw new HubError("secret_required", input.preset === "grok" ? "Paste the routine's webhook key." : "A signing secret is required.", 400);
      this.sql.exec(
        "UPDATE agents SET delivery_method = 'webhook', delivery_preset = ?, delivery_url = ?, delivery_secret = ?, pending_delivery = NULL WHERE handle = ?",
        input.preset ?? "generic", input.url, secret, handle,
      );
    } else if (input.method === "connector" || input.method === "none") {
      this.sql.exec("UPDATE agents SET delivery_method = ?, delivery_url = NULL, delivery_secret = NULL, pending_delivery = NULL WHERE handle = ?", input.method, handle);
    } else throw new HubError("bad_method", "Unsupported delivery method.", 400);
    this.audit("owner", "agent.delivery_changed", { handle, method: input.method, preset: input.preset ?? null });
    const view = this.ownerView(this.agent(handle)!);
    this.broadcast({ type: "agent", agent: view });
    this.kick();
    return view;
  }

  async revokeAgent(sessionToken: string, handle: string) {
    await this.requireStepUp(sessionToken);
    const a = this.agent(handle);
    if (!a || a.runtime === "owner") throw new HubError("not_found", "Unknown agent.", 404);
    await this.revokeCredentials(handle);
    this.sql.exec("UPDATE agents SET status = 'revoked', delivery_secret = NULL WHERE handle = ?", handle);
    this.audit("owner", "agent.revoked", { handle });
    this.broadcast({ type: "agent", agent: this.ownerView(this.agent(handle)!) });
    return { ok: true };
  }

  // ------------------------------------------------------------- messaging

  private messageView(m: MessageRow): MessageView {
    return {
      seq: m.seq,
      id: m.id,
      kind: m.kind,
      thread: m.thread,
      from: m.from_handle,
      to: m.to_handle,
      message: m.body,
      reply_to: m.reply_to,
      status: m.status,
      deadline_at: m.deadline_at ? new Date(m.deadline_at).toISOString() : null,
      created_at: new Date(m.created_at).toISOString(),
      completed_at: m.completed_at ? new Date(m.completed_at).toISOString() : null,
      late: m.late === 1,
      error: m.error,
    };
  }

  private msg(id: string): MessageRow | null {
    return this.one<MessageRow>("SELECT * FROM messages WHERE id = ?", id);
  }

  private emitMessage(id: string) {
    const m = this.msg(id);
    if (m) this.broadcast({ type: "message", message: this.messageView(m) });
  }

  async send(p: Principal, as: string | undefined, input: { to: string; message: string; kind?: MessageKind; thread?: string; deadline_seconds?: number }): Promise<TaskResult> {
    const me = await this.caller(p, as);
    this.rateLimit(me);
    const s = this.settings();
    if (s.paused) throw new HubError("paused", "The hub is paused by its owner. Try again later.", 503);
    if (me.can_send !== 1) throw new HubError("forbidden", "Your owner has turned off sending for you.", 403);
    const kind: MessageKind = input.kind === "notify" ? "notify" : "request";
    const to = (input.to ?? "").trim().replace(/^@/, "");
    if (to === me.handle) throw new HubError("self", "You can't message yourself.", 400);
    const target = this.agent(to);
    if (!target || target.status === "revoked" || (target.hidden === 1 && me.handle !== "owner")) throw new HubError("unknown_recipient", `No agent called "${to}". Call agents to see who you can reach.`, 404);
    if (target.status !== "active" || target.can_receive !== 1) throw new HubError("unavailable", `"${to}" is not accepting messages right now.`, 409);
    const body = typeof input.message === "string" ? input.message : JSON.stringify(input.message);
    if (!body.trim()) throw new HubError("empty", "The message is empty.", 400);
    if (new TextEncoder().encode(body).length > MAX_MESSAGE_BYTES) throw new HubError("too_large", "Messages are limited to 32 KB.", 413);

    if (me.handle !== "owner") {
      const day = this.one<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE from_handle = ? AND created_at > ?", me.handle, Date.now() - 86_400_000)!.n;
      if (day >= s.max_messages_per_day) throw new HubError("rate_limited", "Daily message limit reached.", 429);
      if (kind === "request") {
        const open = this.one<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE from_handle = ? AND kind = 'request' AND status IN ('queued','delivered')", me.handle)!.n;
        if (open >= s.max_open_requests) throw new HubError("rate_limited", "Too many open requests. Wait for some to finish.", 429);
      }
    }

    // Thread: continue an existing one only if the caller is part of it.
    let thread = input.thread?.trim() || "";
    if (thread) {
      const part = this.one<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE thread = ? AND (from_handle = ? OR to_handle = ?)", thread, me.handle, me.handle)!.n;
      if (!part && me.handle !== "owner") throw new HubError("unknown_thread", "You are not part of that thread.", 404);
    } else thread = randomId("t", 8);

    // Loop protection: the chain of agents already waiting on the caller.
    const inbound = this.all<{ chain: string }>("SELECT chain FROM messages WHERE to_handle = ? AND kind = 'request' AND status IN ('queued','delivered')", me.handle);
    const parent = new Set<string>();
    for (const r of inbound) for (const h of JSON.parse(r.chain) as string[]) parent.add(h);
    const chain = [...parent, me.handle].filter((h, i, arr) => arr.indexOf(h) === i);
    if (kind === "request") {
      if (parent.has(to)) throw new HubError("loop", `"${to}" is already waiting on you in this chain, so a request back would deadlock. Reply to its request instead.`, 409);
      if (chain.length > s.hop_limit) throw new HubError("hop_limit", `This chain already spans ${chain.length} agents (limit ${s.hop_limit}).`, 409);
    }

    const id = randomId(kind === "request" ? "r" : "n");
    const deadline = kind === "request" ? Date.now() + clampInt(input.deadline_seconds, 10, s.max_deadline_seconds, s.default_deadline_seconds) * 1000 : null;
    const replyToken = kind === "request" ? randomToken(18) : null;
    this.sql.exec(
      `INSERT INTO messages (id, kind, thread, from_handle, to_handle, body, chain, status, reply_token, deadline_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
      id, kind, thread, me.handle, to, body, JSON.stringify(chain), replyToken, deadline, Date.now(),
    );
    this.enqueueDelivery(id, target, Date.now(), kind === "notify" ? Date.now() + NOTIFY_GIVE_UP : deadline!);
    this.emitMessage(id);
    this.kick();
    return this.taskResult(this.msg(id)!);
  }

  /** Queue delivery of a message to its recipient according to their delivery method. */
  private enqueueDelivery(messageId: string, target: AgentRow, at: number, giveUpAt: number) {
    if (target.delivery_method === "ui") {
      this.sql.exec("UPDATE messages SET status = CASE WHEN kind = 'reply' THEN 'read' ELSE 'delivered' END WHERE id = ?", messageId);
      return;
    }
    if (target.delivery_method === "none") return; // waits in the inbox
    this.sql.exec(
      "INSERT INTO deliveries (id, message_id, target, status, next_at, give_up_at, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)",
      randomId("d"), messageId, target.handle, at, giveUpAt, Date.now(), Date.now(),
    );
  }

  private taskResult(m: MessageRow): TaskResult {
    const base: TaskResult = { task_id: m.id, thread: m.thread, status: m.status, to: m.to_handle, deadline_at: m.deadline_at ? new Date(m.deadline_at).toISOString() : null };
    if (m.kind === "notify") return { ...base, hint: "Notification sent; no reply expected." };
    const reply = this.one<MessageRow>("SELECT * FROM messages WHERE reply_to = ? AND kind = 'reply' ORDER BY seq DESC LIMIT 1", m.id);
    if (reply) return { ...base, status: m.status === "expired" ? "expired" : "completed", result: reply.body, from: reply.from_handle, late: reply.late === 1 };
    if (m.status === "failed" || m.status === "expired") return { ...base, error: m.error ?? m.status };
    return { ...base, poll_interval_seconds: 20, hint: `Still working. Call check(task_id="${m.id}") later; do not send the request again.` };
  }

  private isDone(t: TaskResult) {
    return t.result !== undefined || t.status === "failed" || t.status === "expired" || t.hint?.startsWith("Notification") === true;
  }

  /** Wait (in software, no model turns) for a request to finish. */
  async wait(p: Principal, as: string | undefined, taskId: string, waitSeconds?: number): Promise<TaskResult> {
    const me = await this.caller(p, as);
    const m = this.msg(taskId);
    if (!m || m.from_handle !== me.handle) throw new HubError("not_found", "No such task of yours.", 404);
    const current = this.taskResult(m);
    const ms = clampInt((waitSeconds ?? 0) * 1000, 0, MAX_WAIT_MS, 0);
    if (this.isDone(current) || ms === 0) return this.markRead(current);
    const result = await new Promise<TaskResult>((resolve) => {
      const set = this.waiters.get(taskId) ?? new Set<Waiter>();
      const done = (t: TaskResult) => {
        clearTimeout(timer);
        set.delete(done);
        resolve(t);
      };
      const timer = setTimeout(() => {
        set.delete(done);
        resolve(this.taskResult(this.msg(taskId)!));
      }, ms);
      set.add(done);
      this.waiters.set(taskId, set);
    });
    return this.markRead(result);
  }

  /** A reply the caller has now seen is not re-delivered as a wake-up. */
  private markRead(t: TaskResult): TaskResult {
    if (t.result !== undefined) {
      const reply = this.one<{ id: string; status: string }>("SELECT id, status FROM messages WHERE reply_to = ? AND kind = 'reply' ORDER BY seq DESC LIMIT 1", t.task_id);
      if (reply && reply.status !== "read") {
        this.sql.exec("UPDATE messages SET status = 'read', read_at = ? WHERE id = ?", Date.now(), reply.id);
        this.sql.exec("UPDATE deliveries SET status = 'cancelled', updated_at = ? WHERE message_id = ? AND status IN ('pending','sent')", Date.now(), reply.id);
        this.emitMessage(reply.id);
      }
    }
    return t;
  }

  private resolveWaiters(requestId: string) {
    const set = this.waiters.get(requestId);
    if (!set || set.size === 0) return false;
    const t = this.taskResult(this.msg(requestId)!);
    for (const w of [...set]) w(t);
    this.waiters.delete(requestId);
    return true;
  }

  async reply(p: Principal, as: string | undefined, input: { request_id: string; reply_token?: string; result: string }, opts: { trustedChannel?: boolean } = {}): Promise<ReplyResult> {
    const me = await this.caller(p, as);
    return this.replyAs(me, input, opts);
  }

  private async replyAs(me: AgentRow, input: { request_id: string; reply_token?: string; result: string }, opts: { trustedChannel?: boolean }): Promise<ReplyResult> {
    const req = this.msg(input.request_id ?? "");
    if (!req || req.kind !== "request" || req.to_handle !== me.handle) throw new HubError("not_found", "No such request addressed to you.", 404);
    if (!opts.trustedChannel && !(await safeEqual(input.reply_token ?? "", req.reply_token ?? "\u0000"))) {
      throw new HubError("bad_reply_token", "The reply_token does not match this request. Use the exact reply_token you received with it.", 403);
    }
    const result = typeof input.result === "string" ? input.result : JSON.stringify(input.result);
    if (!result.trim()) throw new HubError("empty", "The result is empty.", 400);
    if (new TextEncoder().encode(result).length > MAX_MESSAGE_BYTES) throw new HubError("too_large", "Replies are limited to 32 KB.", 413);
    const existing = this.one<MessageRow>("SELECT * FROM messages WHERE reply_to = ? AND kind = 'reply' LIMIT 1", req.id);
    if (existing) {
      if (existing.body === result) return { ok: true, duplicate: true };
      throw new HubError("already_replied", "This request already has a different reply.", 409);
    }
    if (req.status === "failed") throw new HubError("closed", "This request already failed.", 409);
    const late = req.status === "expired";
    const id = randomId("a");
    this.sql.exec(
      `INSERT INTO messages (id, kind, thread, from_handle, to_handle, body, reply_to, chain, status, created_at, late)
       VALUES (?, 'reply', ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      id, req.thread, me.handle, req.from_handle, result, req.id, req.chain, Date.now(), late ? 1 : 0,
    );
    this.sql.exec("UPDATE messages SET status = CASE WHEN status = 'expired' THEN 'expired' ELSE 'completed' END, completed_at = ? WHERE id = ?", Date.now(), req.id);
    this.sql.exec("UPDATE deliveries SET status = 'done', updated_at = ? WHERE message_id = ? AND status IN ('pending','sent')", Date.now(), req.id);
    const caller = this.agent(req.from_handle)!;
    if (this.resolveWaiters(req.id)) {
      this.sql.exec("UPDATE messages SET status = 'read', read_at = ? WHERE id = ?", Date.now(), id);
    } else {
      this.enqueueDelivery(id, caller, Date.now() + REPLY_WAKE_GRACE, Date.now() + NOTIFY_GIVE_UP);
    }
    this.emitMessage(req.id);
    this.emitMessage(id);
    this.kick();
    return { ok: true, late };
  }

  private failRequest(me: AgentRow, requestId: string, error: string) {
    const req = this.msg(requestId);
    if (!req || req.kind !== "request" || req.to_handle !== me.handle || !["queued", "delivered"].includes(req.status)) return;
    this.sql.exec("UPDATE messages SET status = 'failed', error = ?, completed_at = ? WHERE id = ?", error.slice(0, 2000), Date.now(), requestId);
    this.sql.exec("UPDATE deliveries SET status = 'done', updated_at = ? WHERE message_id = ? AND status IN ('pending','sent')", Date.now(), requestId);
    this.resolveWaiters(requestId);
    this.emitMessage(requestId);
  }

  async inbox(p: Principal, as: string | undefined, input: { since?: number; limit?: number }) {
    const me = await this.caller(p, as);
    this.rateLimit(me);
    const reread = typeof input.since === "number";
    const from = reread ? input.since! : me.inbox_cursor;
    const limit = clampInt(input.limit, 1, 50, 20);
    const rows = this.all<MessageRow>("SELECT * FROM messages WHERE to_handle = ? AND seq > ? ORDER BY seq LIMIT ?", me.handle, from, limit);
    const items = rows.map((m) => {
      const sender = this.agent(m.from_handle)!;
      const original = m.reply_to ? this.msg(m.reply_to) : null;
      return { seq: m.seq, status: m.status, ...buildEnvelope(m, sender, me, { replyToken: m.reply_token ?? undefined, original }) };
    });
    if (rows.length && !reread) {
      const last = rows[rows.length - 1]!.seq;
      this.sql.exec("UPDATE agents SET inbox_cursor = ? WHERE handle = ?", last, me.handle);
      for (const m of rows) {
        if (m.status === "queued") {
          this.sql.exec("UPDATE messages SET status = ? WHERE id = ?", m.kind === "reply" ? "read" : "delivered", m.id);
          this.emitMessage(m.id);
        }
      }
    }
    const more = rows.length === limit;
    return { messages: items, cursor: rows.length ? rows[rows.length - 1]!.seq : from, more };
  }

  // ------------------------------------------------------- owner: messages

  listThreads(limit = 100) {
    const rows = this.all<MessageRow & { n: number; last_at: number }>(
      `SELECT m.*, t.n, t.last_at FROM messages m
       JOIN (SELECT thread, MAX(seq) AS last_seq, COUNT(*) AS n, MAX(created_at) AS last_at FROM messages GROUP BY thread) t
       ON m.seq = t.last_seq ORDER BY m.seq DESC LIMIT ?`,
      limit,
    );
    return rows.map((r) => {
      const parts = this.all<{ h: string }>("SELECT DISTINCT from_handle AS h FROM messages WHERE thread = ? UNION SELECT DISTINCT to_handle FROM messages WHERE thread = ?", r.thread, r.thread).map((x) => x.h);
      return { thread: r.thread, participants: parts, count: r.n, last: this.messageView(r) };
    });
  }

  getThread(thread: string) {
    return this.all<MessageRow>("SELECT * FROM messages WHERE thread = ? ORDER BY seq", thread).map((m) => this.messageView(m));
  }

  ownerSend(input: { to: string; message: string; kind?: MessageKind; thread?: string; deadline_seconds?: number }) {
    return this.send({ kind: "owner" }, undefined, input);
  }

  async ownerReply(requestId: string, result: string): Promise<ReplyResult> {
    return this.replyAs(this.agent("owner")!, { request_id: requestId, result }, { trustedChannel: true });
  }

  async ping(handle: string) {
    return this.ownerSend({ to: handle, message: "agent-send connection test. Reply with exactly: PONG", kind: "request", deadline_seconds: 300 });
  }

  async retryMessage(id: string) {
    const m = this.msg(id);
    if (!m || m.status !== "failed") throw new HubError("not_failed", "Only failed deliveries can be retried.", 400);
    const target = this.agent(m.to_handle);
    if (!target) throw new HubError("not_found", "Recipient no longer exists.", 404);
    const giveUp = m.kind === "request" ? Math.max(m.deadline_at ?? 0, Date.now() + 300_000) : Date.now() + NOTIFY_GIVE_UP;
    this.sql.exec("UPDATE messages SET status = 'queued', error = NULL, deadline_at = CASE WHEN kind = 'request' THEN ? ELSE deadline_at END WHERE id = ?", giveUp, id);
    this.enqueueDelivery(id, target, Date.now(), giveUp);
    this.audit("owner", "message.retried", { id });
    this.emitMessage(id);
    this.kick();
    return { ok: true };
  }

  listAudit(limit = 200) {
    return this.all<{ seq: number; at: number; actor: string; action: string; detail: string }>("SELECT * FROM audit ORDER BY seq DESC LIMIT ?", limit).map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
  }

  updateSettings(patch: Partial<Settings>) {
    const current = this.settings();
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in DEFAULT_SETTINGS)) continue;
      const def = (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[key];
      if (typeof def !== typeof value) throw new HubError("bad_setting", `Invalid value for ${key}.`, 400);
      if (typeof value === "number" && (value < 0 || !Number.isFinite(value))) throw new HubError("bad_setting", `Invalid value for ${key}.`, 400);
      this.sql.exec("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, JSON.stringify(value));
    }
    this.audit("owner", "settings.updated", patch as Record<string, unknown>);
    this.broadcast({ type: "settings" });
    if (current.paused && patch.paused === false) this.kick();
    return this.settings();
  }

  stats() {
    return {
      database_bytes: this.ctx.storage.sql.databaseSize,
      messages: this.one<{ n: number }>("SELECT COUNT(*) AS n FROM messages")!.n,
      agents: this.one<{ n: number }>("SELECT COUNT(*) AS n FROM agents WHERE status != 'revoked' AND handle != 'owner'")!.n,
      failed: this.one<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE status = 'failed'")!.n,
      version: HUB_VERSION,
      latest_version: this.meta("latest_version"),
    };
  }

  setLatestVersion(v: string) {
    this.setMeta("latest_version", v);
  }

  // ------------------------------------------------------------ delivery

  /** Ask for an alarm as soon as possible. */
  private kick() {
    void this.ctx.storage.setAlarm(Date.now() + 50);
  }

  async alarm() {
    const t = Date.now();
    // 1. Expire requests whose deadline passed.
    const expired = this.all<{ id: string }>("SELECT id FROM messages WHERE kind = 'request' AND status IN ('queued','delivered') AND deadline_at <= ?", t);
    for (const e of expired) {
      this.sql.exec("UPDATE messages SET status = 'expired', error = 'The deadline passed before a reply arrived.' WHERE id = ?", e.id);
      this.sql.exec("UPDATE deliveries SET status = 'expired', updated_at = ? WHERE message_id = ? AND status IN ('pending','sent')", t, e.id);
      this.resolveWaiters(e.id);
      this.emitMessage(e.id);
    }
    // 2. Attempt due deliveries (bounded per alarm to stay inside subrequest limits).
    const s = this.settings();
    if (!s.paused) {
      const due = this.all<{ id: string }>("SELECT id FROM deliveries WHERE status IN ('pending','sent') AND next_at <= ? ORDER BY next_at LIMIT 25", t);
      for (const d of due) await this.attempt(d.id);
    }
    // 3. Daily maintenance.
    const lastMaint = Number(this.meta("last_maintenance") ?? "0");
    if (t - lastMaint > 86_400_000) {
      this.setMeta("last_maintenance", String(t));
      this.sql.exec("DELETE FROM challenges WHERE expires_at < ?", t);
      this.sql.exec("DELETE FROM sessions WHERE expires_at < ?", t);
      if (s.retention_days > 0) {
        const cutoff = t - s.retention_days * 86_400_000;
        this.sql.exec("DELETE FROM deliveries WHERE message_id IN (SELECT id FROM messages WHERE created_at < ? AND status IN ('completed','read','expired','failed','delivered'))", cutoff);
        this.sql.exec("DELETE FROM messages WHERE created_at < ? AND status IN ('completed','read','expired','failed','delivered')", cutoff);
        this.sql.exec("DELETE FROM audit WHERE at < ?", cutoff);
      }
      if (s.update_check) await this.checkForUpdate();
    }
    // 4. Schedule the next wake-up.
    const nextDelivery = this.one<{ t: number | null }>("SELECT MIN(next_at) AS t FROM deliveries WHERE status IN ('pending','sent') AND next_at IS NOT NULL")?.t;
    const nextDeadline = this.one<{ t: number | null }>("SELECT MIN(deadline_at) AS t FROM messages WHERE kind = 'request' AND status IN ('queued','delivered')")?.t;
    const candidates = [nextDelivery, nextDeadline, Number(this.meta("last_maintenance")) + 86_400_000].filter((x): x is number => typeof x === "number" && x > 0);
    const next = Math.max(Date.now() + 50, Math.min(...candidates));
    await this.ctx.storage.setAlarm(s.paused && nextDelivery && next === nextDelivery ? Date.now() + 60_000 : next);
  }

  private async checkForUpdate() {
    try {
      const res = await fetch(`https://api.github.com/repos/${this.env.UPSTREAM_REPO}/releases/latest`, { headers: { "user-agent": "agent-send-update-check", accept: "application/vnd.github+json" } });
      if (res.ok) {
        const body = (await res.json()) as { tag_name?: string };
        if (body.tag_name) this.setMeta("latest_version", body.tag_name.replace(/^v/, ""));
      }
    } catch {
      // Update checks are best effort.
    }
  }

  private recipientRateOk(handle: string): boolean {
    const limit = this.settings().deliveries_per_minute;
    const key = `deliver:${handle}`;
    const minute = Math.floor(Date.now() / 60_000);
    const r = this.rate.get(key);
    if (!r || r.window !== minute) {
      this.rate.set(key, { window: minute, count: 1 });
      return true;
    }
    if (r.count >= limit) return false;
    r.count++;
    return true;
  }

  private async attempt(deliveryId: string) {
    const d = this.one<{ id: string; message_id: string; target: string; status: string; attempts: number; give_up_at: number | null }>("SELECT * FROM deliveries WHERE id = ?", deliveryId);
    if (!d) return;
    const m = this.msg(d.message_id);
    const target = this.agent(d.target);
    const t = Date.now();
    if (!m || !target || target.status === "revoked") {
      this.sql.exec("UPDATE deliveries SET status = 'failed', last_error = 'recipient removed', updated_at = ? WHERE id = ?", t, d.id);
      if (m) this.failMessage(m, "The recipient was removed.");
      return;
    }
    if (d.give_up_at && d.give_up_at <= t) {
      this.sql.exec("UPDATE deliveries SET status = 'failed', updated_at = ? WHERE id = ?", t, d.id);
      this.failMessage(m, "Delivery kept failing until the deadline.");
      return;
    }
    if (target.status === "paused" || !this.recipientRateOk(target.handle)) {
      this.sql.exec("UPDATE deliveries SET next_at = ?, updated_at = ? WHERE id = ?", t + (target.status === "paused" ? 60_000 : 10_000), t, d.id);
      return;
    }
    const sender = this.agent(m.from_handle)!;
    const original = m.reply_to ? this.msg(m.reply_to) : null;
    const envelope = buildEnvelope(m, sender, target, { replyToken: m.reply_token ?? undefined, original });

    if (target.delivery_method === "connector") {
      const sockets = this.ctx.getWebSockets(`agent:${target.handle}`);
      if (sockets.length === 0) {
        // Offline: wait for the connector to reconnect (or the deadline).
        this.sql.exec("UPDATE deliveries SET status = 'pending', next_at = NULL, last_error = 'connector offline', updated_at = ? WHERE id = ?", t, d.id);
        return;
      }
      const frame = JSON.stringify({ type: "deliver", delivery_id: d.id, envelope });
      sockets[sockets.length - 1]!.send(frame);
      this.sql.exec("UPDATE deliveries SET status = 'sent', attempts = attempts + 1, next_at = ?, updated_at = ? WHERE id = ?", t + ACK_TIMEOUT, t, d.id);
      return;
    }

    if (target.delivery_method === "webhook" && target.delivery_url && target.delivery_secret) {
      const body = JSON.stringify(envelope);
      const headers: Record<string, string> = { "content-type": "application/json", "user-agent": `agent-send/${HUB_VERSION}` };
      if (target.delivery_preset === "grok") headers.authorization = `Bearer ${target.delivery_secret}`;
      else Object.assign(headers, await standardWebhookHeaders(target.delivery_secret, d.id, body));
      let status = 0;
      let error = "";
      try {
        const res = await fetch(target.delivery_url, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(15_000) });
        status = res.status;
        if (!res.ok) error = `HTTP ${res.status}`;
      } catch (e) {
        error = e instanceof Error ? e.message : "network error";
      }
      if (status >= 200 && status < 300) {
        this.sql.exec("UPDATE deliveries SET status = 'done', attempts = attempts + 1, last_error = NULL, updated_at = ? WHERE id = ?", t, d.id);
        this.markDelivered(m);
        return;
      }
      const permanent = status >= 400 && status < 500 && status !== 408 && status !== 429;
      if (permanent) {
        this.sql.exec("UPDATE deliveries SET status = 'failed', attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?", error, t, d.id);
        this.failMessage(m, `The recipient's webhook refused the delivery (${error}).`);
        return;
      }
      this.scheduleRetry(d.id, d.attempts + 1, error);
      return;
    }
    // No usable delivery route yet (e.g. a Grok Bot without its routine URL): keep it in the inbox.
    this.sql.exec("UPDATE deliveries SET status = 'pending', next_at = NULL, last_error = 'no delivery route configured', updated_at = ? WHERE id = ?", t, d.id);
  }

  private scheduleRetry(deliveryId: string, attempts: number, error: string) {
    const delay = BACKOFF[attempts - 1] ?? BACKOFF_TAIL;
    this.sql.exec("UPDATE deliveries SET status = 'pending', attempts = ?, next_at = ?, last_error = ?, updated_at = ? WHERE id = ?", attempts, Date.now() + delay, error, Date.now(), deliveryId);
  }

  private markDelivered(m: MessageRow) {
    if (m.status === "queued") {
      this.sql.exec("UPDATE messages SET status = 'delivered' WHERE id = ? AND status = 'queued'", m.id);
      this.emitMessage(m.id);
    }
  }

  private failMessage(m: MessageRow, error: string) {
    if (m.kind === "request" && !["queued", "delivered"].includes(m.status)) return;
    if (m.kind !== "request" && m.status !== "queued") return;
    this.sql.exec("UPDATE messages SET status = 'failed', error = ? WHERE id = ?", error, m.id);
    if (m.kind === "request") this.resolveWaiters(m.id);
    this.emitMessage(m.id);
  }

  // ------------------------------------------------------------ WebSockets

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    if (url.pathname === "/live") {
      const ok = await this.validateSession(request.headers.get("x-owner-session") ?? "");
      if (!ok.ok) return new Response("unauthorized", { status: 401 });
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], ["owner"]);
      pair[1].serializeAttachment({ kind: "owner" } satisfies ConnAttachment);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (url.pathname === "/connect") {
      let agent: AgentRow;
      try {
        agent = await this.caller({ kind: "credential", tokenHash: request.headers.get("x-token-hash") ?? "" });
      } catch (e) {
        return new Response(e instanceof HubError ? e.message : "unauthorized", { status: 401 });
      }
      if (agent.delivery_method !== "connector") return new Response("this agent is not set up for a connector", { status: 409 });
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], [`agent:${agent.handle}`]);
      pair[1].serializeAttachment({ kind: "agent", handle: agent.handle } satisfies ConnAttachment);
      pair[1].send(JSON.stringify({ type: "welcome", handle: agent.handle, name: agent.name, hub_version: HUB_VERSION }));
      this.sql.exec("UPDATE agents SET connected_at = ?, last_seen_at = ? WHERE handle = ?", Date.now(), Date.now(), agent.handle);
      // Deliver everything that waited while it was offline.
      this.sql.exec("UPDATE deliveries SET next_at = ?, status = 'pending' WHERE target = ? AND status IN ('pending','sent')", Date.now(), agent.handle);
      this.kick();
      this.broadcast({ type: "agent", agent: this.ownerView(this.agent(agent.handle)!) });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response("not found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const att = ws.deserializeAttachment() as ConnAttachment | null;
    if (!att || att.kind !== "agent" || !att.handle) return;
    const agent = this.agent(att.handle);
    if (!agent || agent.status === "revoked") {
      ws.close(4001, "revoked");
      return;
    }
    this.touch(agent);
    let frame: { type?: string; delivery_id?: string; request_id?: string; result?: string; error?: string };
    try {
      frame = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "frames must be JSON" }));
      return;
    }
    try {
      if (frame.type === "ack" && frame.delivery_id) {
        const d = this.one<{ message_id: string; target: string }>("SELECT message_id, target FROM deliveries WHERE id = ?", frame.delivery_id);
        if (!d || d.target !== agent.handle) return;
        this.sql.exec("UPDATE deliveries SET status = 'done', updated_at = ? WHERE id = ? AND status IN ('pending','sent')", Date.now(), frame.delivery_id);
        const m = this.msg(d.message_id);
        if (m) {
          if (m.kind === "reply") {
            this.sql.exec("UPDATE messages SET status = 'read', read_at = ? WHERE id = ? AND status = 'queued'", Date.now(), m.id);
            this.emitMessage(m.id);
          } else this.markDelivered(m);
        }
      } else if (frame.type === "reply" && frame.request_id) {
        await this.replyAs(agent, { request_id: frame.request_id, result: frame.result ?? "" }, { trustedChannel: true });
        ws.send(JSON.stringify({ type: "replied", request_id: frame.request_id }));
      } else if (frame.type === "fail" && frame.request_id) {
        this.failRequest(agent, frame.request_id, frame.error ?? "The agent could not complete the request.");
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: "error", request_id: frame.request_id, message: e instanceof Error ? e.message : "error" }));
    }
  }

  async webSocketClose(ws: WebSocket) {
    const att = ws.deserializeAttachment() as ConnAttachment | null;
    if (att?.kind === "agent" && att.handle) {
      const a = this.agent(att.handle);
      if (a) this.broadcast({ type: "agent", agent: this.ownerView(a) });
    }
  }

  private broadcast(event: LiveEvent) {
    const data = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets("owner")) {
      try {
        ws.send(data);
      } catch {
        // A closing socket; ignore.
      }
    }
  }
}
