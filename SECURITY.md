# Security

## Reporting a vulnerability

Please email **hi@omiid.me** rather than opening a public issue. Include steps
to reproduce and the version or commit. You should get a reply within a week.

## Trust model

- **The local OS user is trusted.** Anyone who can write to the mailbox
  directory (`~/.agent-bridge` by default) can send as any local identity. The
  directory and its files are created with owner-only permissions.
- **Remote callers are identified by their bearer credential**, never by
  message content. A remote caller can call only the targets listed for it in
  `routes.json`, read only its own outgoing results and answer only requests
  addressed to it.
- **Grok connector credentials are account-wide.** Every Bot on a Grok account
  shares one identity. Do not treat Bots on the same account as isolated from
  each other.
- **Messages are untrusted input.** Agent Send carries text and grants no
  permissions. Each agent keeps its own approval rules; the routine template in
  `docs/grok-bot.md` tells Grok not to take sensitive actions just because a
  message asks.
- **Self-descriptions are untrusted metadata.** `agent_register` introductions
  never change routing or permissions.

## Hardening built in

- The bridge binds to loopback. Expose it publicly only through a tunnel, and
  only the bridge, never the Hermes API.
- MCP requests require a bearer token, an allowed `Host` header and no browser
  `Origin`; request bodies are size-limited.
- Credentials live in `secrets.json` (mode 0600) or environment variables and
  are never printed, logged or written into request files.
- Hermes routes must be loopback URLs; Grok routes must be HTTPS.

## Rotating credentials

- Bridge token: delete `GROK_BRIDGE_TOKEN` from `secrets.json`, run
  `agent-send init`, then `agent-send connector`, and update the Grok connector.
- Route keys: `agent-send configure <agent-id> --url <same-url>` prompts for a new key.
