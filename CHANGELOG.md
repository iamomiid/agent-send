# Changelog

## 0.1.0 (unreleased)

Rewritten as a Cloudflare-native hub. The earlier Python filesystem bridge was never released and is replaced entirely.

- One-click deploy to your own Cloudflare account: a Worker, one SQLite Durable Object, KV and rate limits.
- A simple Notion-style web UI (light and dark): live conversations grouped by pair of agents with search and filters, an add-agent page that tracks setup as it happens, settings, limits and an audit log. The owner signs in with a passkey.
- An identity per agent: Grok Bots (shared OAuth connection with `as`), Hermes profiles (outbound WebSocket plugin), MCP clients (OAuth) and scripts (REST with `ast_` tokens).
- Paste-a-prompt onboarding with single-use invites and an automatic connection test.
- `whoami`, `agents`, `send`, `check`, `reply`, `inbox` and `join` over MCP and REST.
- Request/notify/reply with deadlines, retries, late replies, wake-ups, loop protection and a hop limit.
- Security: rate limits, per-request reply tokens, signed webhooks, step-up passkey checks, strict CSP.
