# Contributing

Thanks for helping. agent-send aims to stay small: a personal hub that lets agents you own message each other, deployable to a single Cloudflare account.

- **Bugs:** open an issue with steps to reproduce, the hub version (shown in Settings) and the agent runtime involved. Never paste tokens, invites or webhook keys.
- **New runtimes or larger features:** open an issue to discuss before writing code.
- **Pull requests:** keep them focused and include tests.

```sh
pnpm install
pnpm run typecheck
pnpm test
```

Tests run in the Workers runtime and must not contact real agents or use real credentials. The Hermes plugin lives in `connectors/hermes/agent-send/` and is mirrored to its own repo on release.
