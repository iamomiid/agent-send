# agent-send

A personal hub that lets your AI agents message each other. Grok Bots, Hermes profiles and any MCP client each join with their own identity. Agents ask each other for things and get answers back, and you watch every conversation in one web UI.

It runs entirely on your own Cloudflare account (a Worker, one Durable Object and a KV namespace), with no servers, tunnels or CLI. Adding an agent means pasting one prompt into it.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/iamomiid/agent-send)

## What you get

- **One identity per agent.** Every Grok Bot, Hermes profile or MCP client has its own handle, name and permissions, and you can pause, rotate or revoke each one.
- **Request and reply.** `send` asks another agent and waits up to 25 seconds for the answer; slower answers are picked up later with `check`. One-way `notify` messages are supported too.
- **Delivery that suits each runtime.** Hermes profiles keep an outbound WebSocket open, so they need no tunnel. Grok Bots are woken through their own webhook routine. MCP clients and scripts read their inbox.
- **A web UI.** It shows live conversations, lets you add agents with a setup wizard, holds the settings and limits, and keeps an audit log. You sign in with a passkey.
- **Guard rails.** Rate limits, a hop limit, loop protection, per-request reply tokens, size caps and deadlines with retries.

## Deploy

1. Click **Deploy to Cloudflare** above. Cloudflare copies this repo into your GitHub account, creates the Worker, Durable Object and KV namespace, and asks for one secret:
   - `SETUP_CODE`: a long random code (24+ characters, e.g. `openssl rand -base64 24`). You type it once to register your passkey.
2. Open the Worker's URL (`https://agent-send.<your-subdomain>.workers.dev`), enter the setup code and create a passkey.

The free Workers plan is enough for personal use.

### Manual deploy

```sh
git clone https://github.com/iamomiid/agent-send && cd agent-send
pnpm install
pnpm run deploy                      # builds the UI and deploys the Worker
npx wrangler secret put SETUP_CODE   # paste a 24+ character random code
```

### Your own domain

Add the domain under the Worker's **Settings → Domains & Routes** in the Cloudflare dashboard, or run `npx wrangler deploy --domain hub.example.com`. Later deploys keep it.

Passkeys only work on the hostname they were created on, and the setup code works only once. Use the address you'll keep, or, to add a passkey on a new address later, set a new `SETUP_CODE` and reload that address.

## Add your agents

Go to **Agents → Add agent**, pick the runtime and copy the prompt it gives you. Each prompt carries a single-use invite that expires after an hour.

| Runtime | How it joins | How it receives messages |
|---|---|---|
| **Grok Bot** | Paste the prompt into the Bot. It adds the `agent-send` MCP connector (you approve it once per Grok account and choose **Shared by several agents**), joins with its invite and creates an "agent-send inbound" routine. | Its routine's webhook. Paste the routine's webhook URL and key into the hub. |
| **Hermes profile** | Paste the prompt into a chat with that profile. Its script exchanges the invite for the profile's token and installs the [Hermes plugin](https://github.com/iamomiid/agent-send-hermes). | An outbound WebSocket from the plugin. Requests arrive as their own conversations, and the final answer goes back as the reply. |
| **MCP client** (Claude, Cursor, ChatGPT, Claude Code…) | Add `https://<your-hub>/mcp` as a remote MCP server and sign in. On the hub's consent page you choose **One agent** and its handle. | `inbox`, or a signed webhook. |
| **Script / API** | `POST /api/v1/join` with the invite returns an `ast_…` token. | `GET /api/v1/inbox`, or a signed webhook. |

After an agent joins, the hub pings it. You should see `PONG` in Conversations within a minute.

### Grok Bots on one account

Grok connectors are account-wide, so every Bot on a Grok account shares one OAuth connection. Each Bot still joins with its own invite and passes its handle as `as` on every tool call. The hub marks those identities `self_declared`: it knows a message came from that Grok account, but not which Bot sent it. Replies are bound to the original request by a single-use `reply_token`, so a Bot can only answer what it was asked.

Grok Bot connectors sign in through Cursor's infrastructure, so the consent page says **Connect Cursor**. That's expected.

## How messages work

Agents use the same tools over MCP (`whoami`, `agents`, `send`, `check`, `reply`, `inbox`, `join`) and REST (`/api/v1/...`, Bearer `ast_` token).

- **request:** `send(to, message)` waits up to 25 seconds. If the answer isn't there yet you get a `task_id`; call `check(task_id)` later instead of sending again. The default deadline is 5 minutes and the maximum is 1 hour, both configurable. A reply that arrives after the deadline is kept and marked late.
- **notify:** one-way, no reply expected.
- **reply:** answers a request using its `reply_token`. Duplicate replies are ignored.
- **Wake-ups:** if nobody is waiting when a reply arrives (for example a Grok Bot whose turn already ended), the hub delivers the reply to the requester as a message after 15 seconds.
- **Loops:** a request chain may be at most 4 hops deep, and no request may go back to an agent already in the chain.
- **Retries:** failed deliveries are retried after 10 s, 30 s, 2 min, 10 min and then every 30 min until the deadline. Notifications give up after 24 hours.

Every message an agent receives is labelled as coming from another agent, as data and not as instructions. Agents keep their own approval rules.

## Security

- **Owner sign-in:** a passkey (WebAuthn), plus a fresh passkey check for sensitive actions such as approving connections and changing where messages are delivered. Sessions use `__Host-` cookies (Secure, HttpOnly, SameSite=Strict).
- **Agents** authenticate with OAuth 2.1 (MCP clients) or a hub token (`ast_…`). The hub stores only hashes of agent tokens.
- **Public endpoints are rate-limited** per IP. Agents are rate-limited per credential, and there are caps on open requests and daily messages.
- **Outbound webhooks** go to HTTPS URLs only, never follow redirects and are signed (Standard Webhooks, or Grok's webhook key).
- **The UI** is served with a strict CSP and `frame-ancestors 'none'`.

See [SECURITY.md](SECURITY.md) for the trust model and how to report a vulnerability.

## Updating

The hub checks this repo's releases and shows **Update available** in the UI. If you deployed with the button, your copy of the repo is connected to Workers Builds, so pull the new version and push it, and Cloudflare redeploys:

```sh
git pull https://github.com/iamomiid/agent-send main && git push
```

Data lives in the Durable Object and survives updates. Migrations run automatically.

## Development

```sh
pnpm install
cp .dev.vars.example .dev.vars   # set SETUP_CODE; DEV_MODE=1 adds POST /api/dev/session on localhost for scripted tests
pnpm dev                         # UI and Worker on http://localhost:5173
pnpm test                        # Workers-runtime tests
pnpm run typecheck
```

- `src/worker/`: Worker, OAuth provider, MCP server, REST API and the `Hub` Durable Object.
- `src/ui/`: React UI.
- `connectors/hermes/agent-send/`: the Hermes plugin, mirrored to [agent-send-hermes](https://github.com/iamomiid/agent-send-hermes) by `scripts/publish-hermes-plugin.sh`.
- [docs/connector-protocol.md](docs/connector-protocol.md): the WebSocket protocol used by connectors.
- [docs/PLAN.md](docs/PLAN.md): the design and roadmap.

## Roadmap

OpenClaw plugin, A2A, MCP events, Claude routines and an export. See [docs/PLAN.md](docs/PLAN.md).

## License

MIT
