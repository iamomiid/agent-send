# agent-send — Cloudflare-native agent hub: plan of record

Status: approved 2026-11-20. This file records every decision from the design
rounds. Change it when a decision changes.

## Goal

A personal, self-hosted hub that lets any AI agent (Grok Bots, Hermes profiles,
OpenClaw agents, Claude, ChatGPT, Cursor, coding agents, scripts) register with
its own identity and message any other agent. Deployed with one click to the
owner's own Cloudflare account. Onboarding an agent means pasting one prompt
into it. A web UI shows all communication and holds settings. No CLI.

## Non-goals (v1)

- Multiple owners or tenants. One owner per deployment.
- Hub-to-hub federation (another hub can join later as an A2A agent).
- Import (export only).
- Any LLM call inside the hub. Routing, waking, retries and deadlines are code.
- Telemetry. The only unprompted outbound call is the daily release check,
  which Settings can disable.
- Non-English UI, prompts or docs.

## Architecture

```
Cloudflare Worker (one click)
  /                 React UI (static assets), live WebSocket feed
  /mcp              MCP server (stateless 2026-07-28 spec + older clients), OAuth
  /oauth/*, /authorize, /token, /register   OAuth 2.1 (CIMD + DCR)
  /a2a/<handle>     A2A v1.0 per-agent endpoints + hub directory card   [later]
  /api/v1/*         REST API for connectors, scripts, n8n, Letta
  /connect          connector WebSocket (outbound from local agents)
       │
  Hub Durable Object (single instance, SQLite)
    agents, grants, credentials, invites, messages, deliveries, audit,
    owner passkeys/sessions, settings; alarms for retries and deadlines;
    hibernatable WebSockets for the UI feed and connectors
```

Bindings: one Durable Object class, one KV namespace (OAuth provider state +
credential hash cache), static assets, Rate Limiting bindings. No D1, Queues or
VPC. Designed for the Workers Free plan; paid plans only raise limits.

Stack: TypeScript, pnpm, Hono, `agents` (`createMcpHandler`),
`@cloudflare/workers-oauth-provider`, `@simplewebauthn/*`, React + Vite +
Tailwind (shadcn-style components), `@cloudflare/vite-plugin`, Vitest with
`@cloudflare/vitest-pool-workers`. `@a2a-js/sdk` v1.0 when A2A lands.

## Deployment and updates

- "Deploy to Cloudflare" button from the public repo `iamomiid/agent-send`
  (MIT). It provisions the Durable Object, KV and assets and prompts for one
  secret, `SETUP_CODE` (≥ 24 chars; README gives a generator).
- Runs on `*.workers.dev` by default. Add a custom domain **before** the first
  sign-in, because passkeys are bound to the hostname. If the hub sees a new
  hostname it offers re-enrolment via `SETUP_CODE`.
- Updates: no GitHub Action in the user's copy. The UI shows "Update available"
  from a daily check of the latest release of `UPSTREAM_REPO` (default
  `iamomiid/agent-send`) and links to `docs/updating.md`. Migrations are
  additive and run automatically on first access.

## Owner

- One owner, several passkeys. First visit: enter `SETUP_CODE`, register a
  passkey. Enrolment closes after the first passkey. Setup attempts are
  rate-limited and lock 15 minutes after 5 failures. Lost passkeys: change
  `SETUP_CODE` in the Cloudflare dashboard, which reopens enrolment once.
- Session: passkey sign-in, 7-day `HttpOnly; Secure; SameSite=Strict` cookie.
- Step-up (fresh passkey) for: changing an agent's delivery target, revealing
  or rotating credentials, approving an OAuth grant, export, revoke-all.
- The owner is the built-in agent `owner`. Agents may `notify` or `request` the
  owner; these appear in the Owner inbox and the owner can answer from the UI.
  No browser/phone push in v1.

## Agents and identity

- Handle: immutable, `[a-z0-9-]{1,32}`, unique forever (revoked handles are not
  reused). Reserved: `owner`, `hub`, `admin`, `system`. Display name and
  description are editable. The agent suggests a handle at join; the owner can
  override it.
- Trust labels: `verified` (own credential) or `self_declared` (shared
  credential, e.g. Grok Bots on one account).
- Each agent has: handle, runtime, credential(s), delivery method, status
  (`pending`, `active`, `paused`, `revoked`), flags (`can_send`, `can_receive`,
  `hidden`, optional allow-list).
- Directory: approved agents see each other's handle, name, description,
  runtime and `can_receive`. Never credentials, URLs or trust internals.

### Registration

- Invite = pre-approval. "Add agent" creates a single-use invite (1-hour TTL)
  inside a runtime-specific prompt. Paste the prompt into the agent; it
  configures itself and joins. No second approval click.
- OAuth sign-in = approval for single-identity clients (Hermes MCP, Claude,
  ChatGPT, Cursor). The consent page (owner signed in, step-up) is where the
  owner approves and sets the handle and description.
- Uninvited, unapproved arrivals sit as `pending` until the owner approves.
- Clients without OAuth get a static API key generated in the UI.

### Multi-identity grants (Grok)

- Grok Bot connectors are account-wide, so one OAuth grant covers many Bots.
  Grants from Grok/Cursor's client ID (`https://cursor.com/oauth/mcp-client.json`)
  are marked multi-identity automatically; the owner can toggle it.
- On a multi-identity grant every tool takes a required `as: <handle>`, which
  must be a Bot that joined through that grant via `join(invite)`. Each Bot
  saves its handle in a skill private to itself. Shown as "self-declared".
- Replies are authorised by a per-request reply token, so no Bot can complete
  another Bot's task.

## Messages

- Kinds: `request` (expects a reply; deadline default 5 min, max 1 h),
  `notify` (one-way), and `reply`. Optional `thread` groups messages. Content is
  text or JSON, max 32 KB. No attachments.
- `send` waits up to 25 s, then returns a task ID for `check`. If the caller is
  no longer waiting when the reply arrives, the reply goes to the caller's
  inbox and wakes a wakeable caller (Grok routine run, connector delivery).
  A reply read through `check` within a short grace period is not re-delivered.
- Late replies are kept and marked `late`.
- Loop protection: 4-hop limit per chain, and a request back to an agent
  already in the chain (A→B→A) is rejected. Deadlines bound everything else.
- Delivery is at-least-once with a stable message ID for de-duplication.
  Retries at 10 s, 30 s, 2 min, 10 min, then every 30 min until the deadline;
  `notify` retries stop after 24 h. Exhausted deliveries go to a Failed list
  with a Retry button.
- Inbox (pull agents): `inbox` returns unread since a stored cursor and marks
  them seen; `inbox(since=…)` re-reads. Requests stay open until `reply` or
  deadline.
- Retention: messages are kept forever by default. Optional retention settings
  (off by default) delete older data via a daily alarm. Settings shows storage
  use and warns at 80 % of the Durable Object limit. JSON export.

## Tools (MCP; same operations in REST and connector plugins)

`whoami`, `agents`, `send(to, message, kind?, thread?, wait_seconds?,
deadline_seconds?)`, `check(task_id, wait_seconds?)`, `reply(request_id,
reply_token, result)`, `inbox(since?)`, `join(invite, handle?, name?,
description?)`. Multi-identity grants add `as`. Shapes follow the MCP Tasks
extension (task handle + poll interval) so moving to it later is cheap.

## Delivery methods (by how an agent is woken)

| Group | Runtimes | Sends via | Woken by |
|---|---|---|---|
| Hosted, webhook | Grok Bot, Claude routines, n8n/Zapier/Make | MCP or REST | Outbound webhook with per-runtime preset |
| Hosted, MCP Events | ChatGPT, future clients | MCP | MCP Events (SEP-3415) webhook delivery |
| A2A-native | Hermes, OpenClaw, ADK, LangGraph, MS Agent Framework, AgentCore | A2A or MCP | A2A `SendMessage` |
| Local agents | Hermes, OpenClaw (plugins); Claude Code (experimental channel) | plugin tools / MCP | Connector WebSocket (dial-out) |
| Coding agents | Claude Code, Codex, Cursor, OpenCode, Gemini CLI | MCP | Inbox (pull) |
| Anything else | Scripts, Letta, custom bots | REST + API key | Generic webhook or inbox |

### Connectors (no tunnels)

Agents behind NAT run a connector inside their own runtime that dials out to
the hub over a hibernatable WebSocket. One open protocol
(`docs/connector-protocol.md`): `hello` (token) → `deliver` → `ack` →
`reply`/`fail`, plus `ping`. Offline agents' messages queue until reconnect or
deadline; the UI shows Connected/Offline.

- **Hermes**: an `agent-send` platform plugin (not the experimental Relay). One
  gateway serves all profiles; each profile has its own token and therefore its
  own verified identity. The plugin also registers the send tools, so Hermes
  needs no MCP/OAuth setup. Each hub thread maps to its own Hermes session.
  Published as `iamomiid/agent-send-hermes` so
  `hermes plugins install iamomiid/agent-send-hermes --enable` works (moves
  into this repo if Hermes supports subdirectory installs).
- **OpenClaw**: a channel plugin (`openclaw plugins install npm:agent-send`)
  holding the WebSocket, one hub identity per OpenClaw agent via bindings; it
  also registers the send tools.
- **Claude Code**: experimental local stdio channel (needs
  `--dangerously-load-development-channels`; may need a legacy MCP protocol
  pin). Default for Claude Code and Codex is the MCP inbox.
- Agents with a public URL can also be reached directly by A2A or webhook.

### Grok Bot

One routine per Bot, `agent-send inbound`, handles requests, notifies and late
replies, and answers requests with `reply`. Onboarding prompt: add the MCP
connector by URL (first Bot on the account; owner clicks Connect once), `join`,
save the handle in a private skill, create the routine. The owner copies the
routine's webhook URL and key into the wizard (xAI only shows these to a
person). Webhook POST carries `Authorization: Bearer <key>` and the envelope.

## Security

Threat model: trusted owner; untrusted internet, compromised or
prompt-injected agents (limited to their own permissions), and all message
content (data, never instructions). Out of scope: Cloudflare itself and the
owner's Cloudflare account.

- Per-IP Rate Limiting binding on unauthenticated endpoints (`/authorize`,
  `/register`, `/join`, sign-in, setup). The Worker validates credentials
  before anything reaches the Durable Object (hashes cached in KV), so floods
  cannot exhaust the DO quota. 64 KB body cap and strict input validation.
- OAuth: open CIMD + DCR registration, but no token without owner consent.
  Unapproved clients pruned after 24 h, max 20 pending, per-IP limits. Access
  tokens 1 h, rotating refresh tokens, per-grant revocation.
- Agents cannot change their own delivery targets: reported targets apply only
  after owner approval; later changes need step-up. HTTPS only. Every outbound
  delivery is signed (Standard Webhooks HMAC or per-agent bearer token).
- Envelopes mark content untrusted: `from`, `trust`, and a fixed preamble that
  the content is peer data granting no permissions. The hub never interprets
  content. The UI renders content as plain text under a strict CSP.
- Stored outbound credentials live in DO SQLite (encrypted at rest by
  Cloudflare), write-only in UI and API. Inbound credentials stored as hashes.
- Kill switch: "Pause hub" stops deliveries and rejects new messages;
  per-agent Pause and Revoke.
- Default limits (adjustable): 60 tool calls/min per agent, 20 deliveries/min
  per recipient, 50 open requests per agent, 1,000 messages/day per agent,
  32 KB per message.
- Audit log of registrations, approvals, credential and setting changes.

## UI

React + Tailwind (shadcn-style), follows system light/dark, desktop-first and
usable on a phone. Views: Conversations (live threads, status, deadlines, late
replies), Agents (directory, delivery health, last seen, test/pause/revoke/
rotate, Add-agent wizard ending in an automatic `PONG` ping test), Owner inbox,
Settings (permissions, hop limit, deadlines, rate limits, retention, passkeys,
pause, update check, export), Audit.

## Docs

README (Deploy button, 2-minute quickstart), `docs/runtimes/*.md`,
`docs/security.md`, `docs/connector-protocol.md`, `docs/updating.md`, OpenAPI
for the REST API.

## Build order

1. Base: archive old Python work (`archive/python-bridge`), scaffold, owner
   setup + passkeys, Hub DO, UI shell with live feed.
2. Messaging core + MCP: messages, threads, deadlines, retries, MCP with OAuth,
   tools, rate limits, security.
3. Grok: webhook preset, invites, `as`, wizard.
4. Connector protocol + Hermes plugin.
5. OpenClaw plugin, A2A server/client, MCP Events, REST API completion, Claude
   routines preset.
6. Claude Code experimental channel, update check, export, docs, release,
   public repo.

Verification: unit/integration tests in the Workers runtime; live deploy to
the owner's account; real round trips Grok Bot ↔ Hermes profile, then
Hermes ↔ OpenClaw (installed locally for testing), Claude Code over MCP,
ChatGPT over Events if available. Then retire the old Python bridge.

### Session 1 scope (2026-11-20)

Milestones 1–4 plus deploy, the live Grok ↔ Hermes round trip in both
directions, and retiring the old bridge. Done: deployed to a custom domain,
Grok Bot ↔ Hermes verified both ways, old bridge retired. The Hermes plugin is
published as its own repo (`iamomiid/agent-send-hermes`), installed with
`hermes plugins install`.

## Open facts to verify during the build

- ~~Grok's OAuth registration against workers-oauth-provider~~: works. Grok
  connectors sign in as client "Cursor" with an https redirect to
  www.cursor.com, so consent suggests a shared connection for them.
- ~~Hermes plugin tool registration~~: works; `plugins enable` hot-loads the
  platform adapter in the running (multiplexed) gateway, no restart needed.
  A session exposes its profile as `HERMES_SESSION_PROFILE`.
- OpenClaw plugin tool registration (fallback: MCP).
- ~~Hermes subdirectory plugin installs~~: supported (`owner/repo/path`), but
  the plugin ships as its own repo for a short install command.
- Free-plan Durable Object CPU limits and WebSocket hibernation.
- Claude Code channel protocol pin.
