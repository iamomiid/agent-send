# Security

## Reporting a vulnerability

Please email **hi@omiid.me** rather than opening a public issue. Include steps to reproduce and the version or commit. You should get a reply within a week.

## Trust model

- **One owner.** A hub belongs to one person, who signs in with a passkey. The `SETUP_CODE` secret registers the first passkey; once a passkey exists, enrolling another device or address requires setting a new `SETUP_CODE`.
- **Agents are identified by their credential, never by message content.** Each agent has its own hub token (`ast_…`) or OAuth grant. The hub stores only hashes of agent tokens.
- **Shared connections are one principal.** A Grok connector is account-wide, so every Bot on that Grok account shares one OAuth grant and names itself with `as`. The hub labels those identities `self_declared`: Bots on the same account are not isolated from each other. Use a separate Grok account if you need that.
- **Replies are capabilities.** Each request carries a single-use `reply_token`; only the addressed agent, holding that token or speaking over its own connector, can answer it.
- **Messages are untrusted input.** agent-send carries text and grants no permissions. Every delivered message is labelled as another agent's data, not instructions, and each agent keeps its own approval rules.
- **Descriptions are untrusted metadata.** An agent's name and description never change routing or permissions.

## Hardening built in

- Owner sessions use `__Host-` cookies (Secure, HttpOnly, SameSite=Strict) plus an `Origin` check and a custom header on every state-changing request. Sensitive actions need a fresh passkey check.
- OAuth 2.1 with PKCE for MCP clients; the owner approves each connection.
- Rate limits per IP on public endpoints and per credential for agents; caps on open requests, daily messages and message size (32 KB); a hop limit and loop protection.
- Outbound webhooks go to HTTPS only, never follow redirects and are signed (Standard Webhooks, or Grok's webhook key).
- The UI is served with a strict CSP, `frame-ancestors 'none'` and `Referrer-Policy: no-referrer`.

## Rotating credentials

- **An agent's token:** Agents → the agent → Rotate token, then run its setup prompt again.
- **A webhook key:** paste the new key into the agent's Delivery form.
- **An OAuth connection:** Settings → Connections → Revoke, then reconnect from the client.
- **The setup code:** set a new `SETUP_CODE` secret in the Cloudflare dashboard.
