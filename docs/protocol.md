# Filesystem protocol v1

The bridge and local helper share a local directory owned by one OS user.
Remote agents access only MCP operations through the authenticated bridge.

## Agent registration

`agents/<agent-id>.json` is the persistent directory. The bridge registers all
configured routes, client principals and its local identity on startup. A valid
authenticated MCP initialize/request touches the credential-bound principal;
the local helper touches its identity on send/discovery. Native Hermes completion
also records activity. These are software hooks, with no model calls or idle
heartbeats. Activity is coalesced over 30 seconds for the same transport source.

The owner controls route IDs, runtime, display names, delivery endpoints and
credentials. `agent_register` can update only the caller's optional
`introduction` (a bounded description and capability list). Those claims are
untrusted metadata, not instructions or permissions. Calling it without metadata
does not clear an existing introduction. The remote caller cannot choose an ID
or change callback URLs, secrets or call targets through registration.

`agent_list` returns `self` and the caller's permitted directory entries. Local
`agent-send agents` reads the trusted local directory. Views omit credentials,
callback URLs and filesystem paths; `can_receive` means a delivery route is
configured, not that its runtime is currently reachable. `last_seen_at` records
observed connection/helper/completion activity, rather than online status.

Records survive restarts, and owner metadata refreshes from configuration.
Removed client/route entries stop being advertised, even if a historical record
remains on disk. A trusted local CLI identity without a route can register itself
as send-only. An unknown remote identity must first be provisioned by its owner.

## Request

`requests/r_<32 lowercase hex digits>.json` is immutable after submission:

```json
{
  "version": 1,
  "id": "r_0123456789abcdef0123456789abcdef",
  "sender": "hermes",
  "to": "grok",
  "message": "A short question and desired output",
  "created_at": 1794300000.0,
  "deadline_at": 1794300300.0
}
```

Use the CLI or MCP tool to submit so IDs, validation and circular-wait checks
are applied. A retry key deterministically selects a request ID scoped to its
authenticated/local sender. Reusing that key for different content is rejected.

Only atomically renamed complete files with valid schemas are eligible for
dispatch. Startup and periodic rescans recover committed files independently
of an in-memory event queue. No file event itself invokes inference.

## State

`state/<id>.json` belongs to the single bridge process. Main paths are:

```text
queued → dispatching → running (Hermes) → completed
                    → awaiting_reply (Grok) → completed
                    → unknown

An operation may also become failed, expired, or abandoned.
```

Hermes state includes its native run ID once known. During restart, a saved
native run is resumed by GET rather than created again. A crash while a Hermes
submission was in flight can reuse its original idempotency key. An HTTP
exception that leaves acceptance uncertain is recorded as unknown; it is not
automatically retried in an endless loop.

A Grok webhook 200 establishes acceptance only. A known awaiting reply stays
awaiting after restart; an in-flight dispatch becomes unknown and is not
reposted. A matching Bot callback can still complete an unknown operation.

An unknown outcome holds the recipient until it is resolved by a reply,
expires, or the operator explicitly abandons it. Abandonment is acknowledgment
of uncertainty, not cancellation or proof of absence of side effects.

## Reply

`replies/<id>.json` is immutable:

```json
{
  "request_id": "r_0123456789abcdef0123456789abcdef",
  "outcome": "completed",
  "result": "A concise answer",
  "completed_at": 1794300010.0,
  "late": false
}
```

The committed reply is authoritative even if the bridge crashed before its
state update. An identical repeated callback is accepted; a different result
for the same ID is rejected. Late Grok answers remain visible but do not turn
an expired request into a successful on-time request.

## Concurrency and permissions

There is one serving bridge per mailbox, enforced with an advisory process
lock. Store changes are serialized by a separate short-lived file lock. The
router serves one active operation per recipient, preserving submission order.
Opposite-direction calls that would create a circular wait are rejected.

Local submission is trusted to the filesystem owner. The remote caller is
derived from its configured bearer credential. It can submit only to allowed
targets, retrieve only its own outgoing results and complete only dispatched
requests assigned to its logical identity. Grok's account-wide connector does
not independently authenticate individual Bots sharing that credential, so a
client's `reply_for` list in `routes.json` names the additional Grok routes that
credential may answer (`configure` maintains it).

The bridge binds to loopback. MCP validates allowed hosts, limits HTTP bodies,
rejects browser-origin requests and checks auth before handling MCP messages.
The stable public hostname is explicitly allowed in local configuration.
Neither arbitrary path access nor model-driven routing is exposed.
