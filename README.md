# Agent Send

**Let your agents talk to each other.**

Agent Send is a thin request/reply layer between AI agents. One agent asks a
question and waits; the other answers; the answer comes back to the exact
request that asked for it. Routing, waiting and retries are plain code, so no
model tokens are spent polling an inbox.

```text
 Hermes (your Mac)                      Agent Send bridge                    Grok Bot (hosted)
 ─────────────────                      ─────────────────                    ────────────────
 agent-send grok "…"  ──► request file ─►  POST routine webhook  ──────────►  routine runs
                                                                              │
 ◄── JSON answer ◄────── reply file ◄───  agent_reply (MCP)  ◄────────────────┘

 Hermes API run  ◄──── POST /v1/runs ◄──  agent_call (MCP)  ◄──────────────── Grok chat
 final output   ─────────────────────►    agent_await       ────────────────► answer
```

**Status: v0.1, early.** Two agent types are supported today:

| Type | How the bridge reaches it | How it answers |
|---|---|---|
| [Hermes](https://hermes-agent.nousresearch.com) | Hermes API server on loopback (`POST /v1/runs`) | Bridge polls the run's final output |
| [Grok Bot](https://docs.x.ai/grok-bot) | A webhook-triggered routine | The Bot calls the `agent_reply` MCP tool |

You can add any number of routes of each type (several Hermes profiles, several
Grok Bots). More agent types may come later; see [Scope](#scope).

## Requirements

- macOS or Linux (the mailbox uses `flock`; Windows is not supported)
- Python 3.11+ and [uv](https://docs.astral.sh/uv/)
- For Grok Bot: a stable public HTTPS URL for the bridge
  ([options](docs/exposing-the-bridge.md))

## Quickstart

```sh
uv tool install git+https://github.com/iamomiid/agent-send
agent-send init        # creates ~/.agent-bridge with a private bridge credential
agent-send doctor      # shows configuration; never prints credentials
```

### 1. Connect Hermes

Enable the Hermes API server for the profile that should take part
(`API_SERVER_ENABLED=true` and an `API_SERVER_KEY` in that profile), then:

```sh
agent-send configure hermes --url http://127.0.0.1:8642
# Paste the profile's API_SERVER_KEY into the hidden prompt.
```

A named profile served by a multiplexed gateway uses its own path, for example
`--url http://127.0.0.1:8642/p/work`.

So Hermes can start conversations, copy [`skills/agent-send`](skills/agent-send/SKILL.md)
into that profile's skills and make sure `agent-send` is on its terminal's PATH.

### 2. Run the bridge

```sh
agent-send serve
```

It listens on `127.0.0.1:8766`. To keep it running, see
[running as a service](docs/running-as-a-service.md).

### 3. Connect Grok Bot

1. Expose the bridge at a stable HTTPS URL ([how](docs/exposing-the-bridge.md)),
   then tell Agent Send about it and write the connector settings:

   ```sh
   agent-send configure public --url https://agents.example.com
   agent-send connector   # writes ~/.agent-bridge/grok-connector.json (private)
   ```

2. In Grok, add a **Remote HTTPS** custom connector with the `/mcp` URL and
   `Authorization` header from that file.
3. In the chat of the Bot that should receive requests, create a webhook routine
   using the instruction in [docs/grok-bot.md](docs/grok-bot.md), and copy the
   routine's webhook URL and key.
4. Register the routine:

   ```sh
   agent-send configure grok --url https://YOUR-ROUTINE-WEBHOOK
   # Paste the routine's webhook key into the hidden prompt.
   ```

### 4. Try it

```sh
agent-send grok "Reply with exactly PING_OK"
```

And from a Grok chat: *"Use agent-send's `agent_call` to ask hermes to reply
with exactly PONG_OK."*

## Usage

```sh
agent-send send <agent-id> "question"   # ask and wait up to 25 s
agent-send grok "question"              # shorthand for send grok
agent-send wait r_REQUEST_ID            # keep waiting; never resends
agent-send status [r_REQUEST_ID]        # one result, or all requests
agent-send agents                       # who can I talk to?
agent-send configure <agent-id> --url … # add or update a route
```

Results are JSON. Exit codes: `0` completed, `2` still pending, `3`
failed/expired/unknown, `1` local or configuration error. Useful flags:
`--wait 0` (submit only), `--deadline` (1–3600 s, default 300), and `--key`
(idempotent retries of the same request).

Remote agents get five MCP tools:

| Tool | Purpose |
|---|---|
| `agent_list()` | Discover yourself and the agents you may call |
| `agent_register(description?, capabilities?)` | Optionally introduce yourself |
| `agent_call(to, message, wait_seconds?, deadline_seconds?, idempotency_key?)` | Ask another agent |
| `agent_await(request_id, wait_seconds?)` | Keep waiting for a pending answer |
| `agent_reply(request_id, result)` | Answer a request delivered by webhook |

Remote waits are capped at 25 seconds per call; a pending request is resumed
with `agent_await`, never sent again.

## Adding more agents

`configure` accepts any ID. The type is inferred from the URL: a loopback URL is
a Hermes profile, an HTTPS webhook is a Grok Bot routine (`--kind` overrides).
The running bridge reloads `routes.json` automatically; no restart is needed.

```sh
agent-send configure research --url http://127.0.0.1:8642/p/research
agent-send configure creator-analyst --url https://ROUTINE-WEBHOOK \
  --name "Creator Analyst" --allow-from grok
```

`--allow-from grok` lets Grok Bots call that route too; without it, only local
agents can. Grok Bot cannot relay messages to its sibling Bots from inside a
webhook routine, so each Bot you want to reach needs its own routine and route
([details](docs/grok-bot.md#reaching-more-grok-bots)).

## How it works

Everything lives in one private directory, `~/.agent-bridge/` by default
(override with `AGENT_SEND_HOME` or `--home`):

```text
routes.json                 routes and permissions (no secrets)
secrets.json                credentials, mode 0600
agents/<agent-id>.json      automatic registration and optional introduction
requests/r_<id>.json        immutable request
state/r_<id>.json           bridge-owned delivery state
replies/r_<id>.json         immutable answer or failure
```

Files are written atomically. A single `agent-send serve` process owns the
mailbox, rescans it every 0.5 seconds, delivers requests and serves the MCP
endpoint. Agents are registered automatically the first time they connect or
send; no greeting turn is needed. See [the protocol](docs/protocol.md) for the
file formats and state machine.

## Guarantees and limits

- **Answers survive restarts.** A reply file is the authority even after a crash.
- **No blind retries.** A Hermes run is resumed by its run ID; a Grok webhook is
  posted once. If delivery is uncertain the request becomes `unknown` and waits
  for a late reply, its deadline, or `agent-send abandon <id>`.
- **One active request per recipient**, in submission order. Calls that would
  make two agents wait on each other are rejected.
- **Identity comes from credentials**, never from what a model claims. Remote
  callers can only call permitted targets, read their own results and answer
  requests addressed to them.
- **Small messages.** 32 KiB per request, 64 KiB per answer, no attachments.
- **Grok Bots share one identity.** A Grok connector credential is account-wide,
  so every Bot on the account authenticates as `grok`.
- A deadline ends the wait; it does not stop remote work that already started.

See [SECURITY.md](SECURITY.md) for the trust model.

## Scope

Agent Send is deliberately small: request/reply between agents you own, over
files and one local process. It is not a chat room, a message bus, an agent
marketplace or a hosted service. Adapters for other agent types are welcome to
be discussed in an issue first.

## Development

```sh
git clone https://github.com/iamomiid/agent-send && cd agent-send
uv sync
uv run pytest
uv run ruff check . && uv run ruff format --check .
```

Tests use temporary mailboxes, fake Hermes/Grok endpoints and the official MCP
client; they never contact real agents. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © Omid Sayfun
