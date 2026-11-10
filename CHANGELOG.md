# Changelog

## 0.1.0 (unreleased)

First public release.

- Request/reply between Hermes (API server) and Grok Bot (webhook routines plus
  an MCP connector) through a local filesystem mailbox.
- MCP tools: `agent_call`, `agent_await`, `agent_reply`, `agent_list`,
  `agent_register`.
- Automatic agent registration and an `agents` directory.
- Any number of Hermes profiles and Grok Bots as named routes; the type is
  inferred from the URL.
- Routes reload without restarting the bridge.
- Crash-safe delivery: no blind retries, idempotent submission, late replies kept.
- `launchd` and `systemd` service templates.
