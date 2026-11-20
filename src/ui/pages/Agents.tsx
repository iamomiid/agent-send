import { useCallback, useEffect, useState } from "react";
import { api, type Agent, type Runtime } from "../api";
import { Badge, Button, Card, CopyBlock, Empty, ErrorNote, Field, Input, Textarea, cx, runtimeLabel, statusTone, timeAgo, useLive } from "../components";
import { Link, navigate } from "../main";

function useAgents() {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const load = useCallback(() => api<Agent[]>("GET", "/api/owner/agents").then(setAgents), []);
  useEffect(() => {
    void load();
  }, [load]);
  useLive((e) => {
    if (e.type === "agent") setAgents((prev) => (prev ? (prev.some((a) => a.handle === e.agent.handle) ? prev.map((a) => (a.handle === e.agent.handle ? e.agent : a)) : [...prev, e.agent]) : prev));
  });
  return { agents, reload: load };
}

export function AgentsPage({ path }: { path: string }) {
  const { agents, reload } = useAgents();
  if (path === "/agents/new") return <AddAgent agents={agents ?? []} />;
  const handle = path.startsWith("/agents/") ? decodeURIComponent(path.slice(8)) : null;
  if (handle) {
    const a = agents?.find((x) => x.handle === handle);
    if (!agents) return <p className="p-6 text-sm text-subtle">Loading…</p>;
    if (!a) return <Empty title="No such agent" />;
    return <AgentDetail agent={a} onChange={reload} />;
  }
  const visible = (agents ?? []).filter((a) => a.handle !== "owner");
  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 md:p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Agents</h1>
        <Button variant="primary" onClick={() => navigate("/agents/new")}>
          Add agent
        </Button>
      </header>
      {agents === null ? (
        <p className="text-sm text-subtle">Loading…</p>
      ) : visible.length === 0 ? (
        <Card>
          <Empty title="No agents yet">Add a Grok Bot, a Hermes profile or any MCP client. Setup is one prompt you paste into the agent.</Empty>
        </Card>
      ) : (
        <Card className="divide-y divide-line">
          {visible.map((a) => (
            <Link key={a.handle} to={`/agents/${a.handle}`} className="flex items-center gap-3 px-4 py-3 hover:bg-muted">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{a.name}</span>
                  <span className="text-sm text-subtle">@{a.handle}</span>
                </div>
                <p className="truncate text-sm text-subtle">{a.description || runtimeLabel[a.runtime]}</p>
              </div>
              <div className="flex shrink-0 flex-wrap justify-end gap-1">
                <Badge>{runtimeLabel[a.runtime]}</Badge>
                <DeliveryBadge a={a} />
                {a.status !== "active" && <Badge tone={statusTone(a.status)}>{a.status}</Badge>}
              </div>
            </Link>
          ))}
        </Card>
      )}
    </div>
  );
}

function DeliveryBadge({ a }: { a: Agent }) {
  if (a.delivery.method === "connector") return <Badge tone={a.delivery.connected ? "green" : "amber"}>{a.delivery.connected ? "connected" : "offline"}</Badge>;
  if (a.delivery.method === "webhook") return <Badge tone="green">webhook</Badge>;
  if (a.runtime === "grok") return <Badge tone="amber">needs webhook</Badge>;
  return <Badge>inbox</Badge>;
}

const RUNTIMES: { id: Runtime; title: string; blurb: string }[] = [
  { id: "grok", title: "Grok Bot", blurb: "A Bot in Grok. It joins through the agent-send connector and gets woken by its own routine." },
  { id: "hermes", title: "Hermes profile", blurb: "A Hermes Agent profile. A small plugin connects out to the hub, so no tunnel is needed." },
  { id: "mcp", title: "MCP client", blurb: "Claude, ChatGPT, Cursor, Claude Code, Codex… anything that adds a remote MCP server." },
  { id: "api", title: "Script or API", blurb: "Anything that can make HTTP requests, using a token." },
];

function AddAgent({ agents }: { agents: Agent[] }) {
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [form, setForm] = useState({ name: "", handle: "", description: "" });
  const [result, setResult] = useState<{ prompt: string; invite: { id: string; expires_at: number } } | null>(null);
  const [mcpPrompt, setMcpPrompt] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [joined, setJoined] = useState<string | null>(null);

  useLive((e) => {
    if (e.type === "invite" && result && (e.invite as { id: string; used_by: string | null }).id === result.invite.id) {
      const used = (e.invite as { used_by: string | null }).used_by;
      if (used) setJoined(used);
    }
  });
  useEffect(() => {
    if (runtime === "mcp") void api<{ prompt: string }>("GET", "/api/owner/mcp-prompt").then((r) => setMcpPrompt(r.prompt));
  }, [runtime]);

  const joinedAgent = joined ? agents.find((a) => a.handle === joined) : undefined;

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4 md:p-6">
      <header className="flex items-center gap-3">
        <button className="text-sm text-subtle" onClick={() => navigate("/agents")}>
          ← Agents
        </button>
        <h1 className="text-lg font-semibold">Add agent</h1>
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        {RUNTIMES.map((r) => (
          <button
            key={r.id}
            disabled={!!result}
            onClick={() => setRuntime(r.id)}
            className={cx("rounded-lg border bg-panel p-4 text-left disabled:opacity-60", runtime === r.id ? "border-accent ring-1 ring-accent" : "border-line hover:bg-muted")}
          >
            <span className="block font-medium">{r.title}</span>
            <span className="text-sm text-subtle">{r.blurb}</span>
          </button>
        ))}
      </div>

      {runtime === "mcp" && (
        <Card className="space-y-3 p-5">
          <h2 className="font-medium">Paste this into the agent (or follow it yourself)</h2>
          {mcpPrompt ? <CopyBlock text={mcpPrompt} rows={9} /> : <p className="text-sm text-subtle">Loading…</p>}
          <p className="text-sm text-subtle">When it connects, a sign-in page opens here. You approve it with your passkey and choose its handle. Then it appears in Agents.</p>
        </Card>
      )}

      {runtime && runtime !== "mcp" && !result && (
        <Card className="space-y-4 p-5">
          <Field label="Name" hint="How this agent shows up to you and other agents.">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={runtime === "grok" ? "Creator Analyst" : runtime === "hermes" ? "CMO" : "Nightly report"} autoFocus />
          </Field>
          <Field label="Handle (optional)" hint="Permanent. Leave empty to derive it from the name.">
            <Input value={form.handle} onChange={(e) => setForm({ ...form, handle: e.target.value })} />
          </Field>
          <Field label="Description (optional)" hint="Tells other agents what this one is good at.">
            <Textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
          <ErrorNote error={error} />
          <div className="flex justify-end">
            <Button
              variant="primary"
              busy={busy}
              disabled={!form.name.trim()}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  setResult(await api("POST", "/api/owner/invites", { runtime, ...form }));
                } catch (e) {
                  setError(e);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Create setup prompt
            </Button>
          </div>
        </Card>
      )}

      {result && (
        <Card className="space-y-4 p-5">
          <div>
            <h2 className="font-medium">1. Paste this into {runtime === "hermes" ? "a chat with the Hermes profile you want to connect" : runtime === "grok" ? "a chat with that Bot" : "the agent"}</h2>
            <p className="text-sm text-subtle">It contains a single-use invite that expires {new Date(result.invite.expires_at).toLocaleTimeString()}.</p>
          </div>
          <CopyBlock text={result.prompt} rows={14} />
          <Steps runtime={runtime!} joined={joinedAgent ?? null} joinedHandle={joined} />
        </Card>
      )}
    </div>
  );
}

function Check({ done, children }: { done: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      <span className={cx("mt-0.5 grid size-4 shrink-0 place-items-center rounded-full text-[10px]", done ? "bg-emerald-500 text-white" : "border border-line")}>{done ? "✓" : ""}</span>
      <span className={done ? "" : "text-subtle"}>{children}</span>
    </li>
  );
}

function Steps({ runtime, joined, joinedHandle }: { runtime: Runtime; joined: Agent | null; joinedHandle: string | null }) {
  const [ping, setPing] = useState<{ thread: string } | null>(null);
  const [pong, setPong] = useState<string | null>(null);
  const deliveryReady = !!joined && (runtime === "grok" ? joined.delivery.method === "webhook" : runtime === "hermes" ? joined.delivery.connected : true);
  useLive((e) => {
    if (e.type === "message" && ping && e.message.thread === ping.thread && e.message.kind === "reply") setPong(e.message.message);
  });
  useEffect(() => {
    if (deliveryReady && joined && !ping && runtime !== "api") void api<{ thread: string }>("POST", `/api/owner/agents/${joined.handle}/ping`, {}).then(setPing);
  }, [deliveryReady, joined, ping, runtime]);

  return (
    <div className="space-y-3">
      <h2 className="font-medium">2. Watch it connect</h2>
      <ul className="space-y-2">
        <Check done={!!joinedHandle}>{joinedHandle ? `Joined as @${joinedHandle}` : "Waiting for the agent to join…"}</Check>
        {runtime === "grok" && <Check done={deliveryReady}>Paste the routine's webhook URL and key below</Check>}
        {runtime === "hermes" && <Check done={deliveryReady}>{deliveryReady ? "Plugin connected" : "Waiting for the Hermes plugin to connect (after its gateway restarts)…"}</Check>}
        {runtime !== "api" && <Check done={!!pong}>{pong ? `Connection test answered: “${pong.slice(0, 80)}”` : ping ? "Connection test sent, waiting for the answer…" : "Connection test"}</Check>}
      </ul>
      {runtime === "grok" && joined && !deliveryReady && <WebhookForm agent={joined} />}
      {joined && (
        <p className="text-sm">
          <Link to={`/agents/${joined.handle}`} className="underline">
            Open {joined.name}
          </Link>
        </p>
      )}
    </div>
  );
}

function WebhookForm({ agent, onSaved }: { agent: Agent; onSaved?: () => void }) {
  const isGrok = agent.runtime === "grok";
  const [url, setUrl] = useState(agent.delivery.url ?? "");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="space-y-3 rounded-md border border-line p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await api("POST", `/api/owner/agents/${agent.handle}/delivery`, { method: "webhook", preset: isGrok ? "grok" : "generic", url: url.trim(), secret: secret.trim() || undefined });
          setSecret("");
          onSaved?.();
        } catch (err) {
          setError(err);
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="text-sm text-subtle">
        {isGrok ? "In Grok, open the Bot's “agent-send inbound” routine on desktop, then its Webhook section. Copy both values here." : "The hub POSTs each message here, signed with Standard Webhooks."}
      </p>
      <Field label="Webhook URL">
        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
      </Field>
      <Field label={isGrok ? "Webhook key" : "Signing secret (whsec_…)"} hint={agent.delivery.has_secret ? "Leave empty to keep the saved one." : undefined}>
        <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" />
      </Field>
      <ErrorNote error={error} />
      <Button variant="primary" busy={busy} disabled={!url.trim() || (!secret.trim() && !agent.delivery.has_secret)}>
        Save (confirm with passkey)
      </Button>
    </form>
  );
}

function AgentDetail({ agent, onChange }: { agent: Agent; onChange: () => void }) {
  const [edit, setEdit] = useState({ name: agent.name, description: agent.description });
  const [error, setError] = useState<unknown>(null);
  const [token, setToken] = useState<string | null>(null);
  const [routine, setRoutine] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => setEdit({ name: agent.name, description: agent.description }), [agent.name, agent.description]);
  useEffect(() => {
    if (agent.runtime === "grok") void api<{ instruction: string }>("GET", `/api/owner/agents/${agent.handle}/routine`).then((r) => setRoutine(r.instruction));
  }, [agent.handle, agent.runtime]);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      onChange();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  const patch = (body: object) => act("patch", () => api("PATCH", `/api/owner/agents/${agent.handle}`, body));
  const revoked = agent.status === "revoked";

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4 md:p-6">
      <header className="flex flex-wrap items-center gap-3">
        <button className="text-sm text-subtle" onClick={() => navigate("/agents")}>
          ← Agents
        </button>
        <h1 className="text-lg font-semibold">{agent.name}</h1>
        <span className="text-subtle">@{agent.handle}</span>
        <Badge>{runtimeLabel[agent.runtime]}</Badge>
        <Badge tone={agent.trust === "verified" ? "green" : "amber"}>{agent.trust === "verified" ? "verified identity" : "self-declared"}</Badge>
        <Badge tone={statusTone(agent.status)}>{agent.status}</Badge>
      </header>
      <ErrorNote error={error} />

      <Card className="space-y-3 p-5">
        <h2 className="font-medium">Profile</h2>
        <Field label="Name">
          <Input value={edit.name} disabled={revoked} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
        </Field>
        <Field label="Description">
          <Textarea rows={2} value={edit.description} disabled={revoked} onChange={(e) => setEdit({ ...edit, description: e.target.value })} />
        </Field>
        <div className="flex items-center justify-between text-sm text-subtle">
          <span>Last seen {timeAgo(agent.last_seen_at)}</span>
          <Button busy={busy === "patch"} disabled={revoked} onClick={() => patch(edit)}>
            Save
          </Button>
        </div>
      </Card>

      <Card className="space-y-3 p-5">
        <h2 className="font-medium">Delivery</h2>
        <p className="text-sm text-subtle">
          {agent.delivery.method === "connector"
            ? agent.delivery.connected
              ? "Its connector is online. Messages are delivered instantly."
              : "Its connector is offline. Messages wait until it reconnects or their deadline passes."
            : agent.delivery.method === "webhook"
              ? `Messages are POSTed to ${agent.delivery.url}.`
              : "Messages wait in its inbox until it checks."}
        </p>
        {(agent.runtime === "grok" || agent.delivery.method === "webhook") && !revoked && <WebhookForm agent={agent} onSaved={onChange} />}
        {routine && (
          <details className="text-sm">
            <summary className="cursor-pointer text-subtle">Routine instruction for this Bot</summary>
            <div className="mt-2">
              <CopyBlock text={routine} rows={8} />
            </div>
          </details>
        )}
        <div className="flex flex-wrap gap-2">
          <Button disabled={revoked || agent.status !== "active"} onClick={() => act("ping", async () => navigate(`/threads/${encodeURIComponent((await api<{ thread: string }>("POST", `/api/owner/agents/${agent.handle}/ping`, {})).thread)}`))}>
            Send connection test
          </Button>
        </div>
      </Card>

      <Card className="space-y-3 p-5">
        <h2 className="font-medium">Permissions</h2>
        {[
          ["can_send", "Can send messages", agent.can_send],
          ["can_receive", "Can receive messages", agent.can_receive],
          ["hidden", "Hidden from other agents' directory", agent.hidden],
        ].map(([key, label, value]) => (
          <label key={key as string} className="flex items-center justify-between text-sm">
            <span>{label as string}</span>
            <input type="checkbox" className="size-4 accent-[var(--accent)]" disabled={revoked} checked={!!value} onChange={(e) => patch({ [key as string]: e.target.checked })} />
          </label>
        ))}
      </Card>

      <Card className="space-y-3 p-5">
        <h2 className="font-medium">Access</h2>
        {token && (
          <div className="space-y-2">
            <p className="text-sm">New token. It's shown only once; update the agent's configuration with it.</p>
            <CopyBlock text={token} rows={2} />
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {agent.status === "active" && (
            <Button busy={busy === "pause"} onClick={() => act("pause", () => api("PATCH", `/api/owner/agents/${agent.handle}`, { status: "paused" }))}>
              Pause
            </Button>
          )}
          {agent.status === "paused" && (
            <Button busy={busy === "pause"} onClick={() => act("pause", () => api("PATCH", `/api/owner/agents/${agent.handle}`, { status: "active" }))}>
              Resume
            </Button>
          )}
          {!agent.grant_id && !revoked && (
            <Button busy={busy === "rotate"} onClick={() => act("rotate", async () => setToken((await api<{ token: string }>("POST", `/api/owner/agents/${agent.handle}/rotate`, {})).token))}>
              Rotate token
            </Button>
          )}
          {!revoked && (
            <Button
              variant="danger"
              busy={busy === "revoke"}
              onClick={() => {
                if (confirm(`Revoke ${agent.name}? Its handle can never be reused.`)) void act("revoke", () => api("POST", `/api/owner/agents/${agent.handle}/revoke`, {}));
              }}
            >
              Revoke
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}
