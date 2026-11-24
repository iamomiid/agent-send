import { useEffect, useState, type ReactNode } from "react";
import { api, type Agent, type Runtime } from "../api";
import {
  Button,
  Callout,
  CopyBlock,
  Empty,
  ErrorNote,
  Field,
  H3,
  InlineInput,
  Input,
  Loading,
  Page,
  Prop,
  Props,
  SettingRow,
  Tag,
  Title,
  Toggle,
  Views,
  Avatar,
  clock,
  cx,
  deliveryState,
  runtimeLabel,
  runtimeTone,
  timeAgo,
  useLive,
} from "../components";
import { useAgents } from "../data";
import { Link, navigate } from "../router";
import { pairPath } from "./Conversations";

export function AgentsPage({ path }: { path: string }) {
  const { agents, reload } = useAgents();
  if (path === "/agents/new") return <AddAgent agents={agents ?? []} />;
  const handle = path.startsWith("/agents/") ? decodeURIComponent(path.slice(8)) : null;
  if (handle) {
    if (!agents) return <Loading />;
    const a = agents.find((x) => x.handle === handle);
    if (!a)
      return (
        <Page crumbs={[{ label: "🤖 Agents", to: "/agents" }]}>
          <Empty title="No such agent" />
        </Page>
      );
    return <AgentDetail key={a.handle} agent={a} onChange={() => void reload()} />;
  }
  return <AgentList agents={agents} />;
}

// ---- list

function AgentList({ agents }: { agents: Agent[] | null }) {
  const [view, setView] = useState<"all" | "attention">("all");
  const all = (agents ?? []).filter((a) => a.handle !== "owner");
  const needsAttention = (a: Agent) => ["red", "yellow"].includes(deliveryState(a).tone) && a.status !== "revoked";
  const visible = view === "all" ? all : all.filter(needsAttention);
  const reachable = all.filter((a) => a.status === "active" && deliveryState(a).tone !== "red" && deliveryState(a).tone !== "yellow").length;
  const th = "border-b border-line px-2 py-1.5 text-left font-normal text-subtle whitespace-nowrap";
  const td = "border-b border-line px-2 py-2";

  return (
    <Page crumbs={[{ label: "🤖 Agents" }]}>
      <Title icon="🤖">Agents</Title>
      <p className="text-sm text-subtle">{agents ? `${all.length} ${all.length === 1 ? "agent" : "agents"} · ${reachable} reachable now` : " "}</p>
      <Views
        value={view}
        onChange={setView}
        options={[
          { id: "all", label: "All" },
          { id: "attention", label: `Needs attention${all.filter(needsAttention).length ? ` · ${all.filter(needsAttention).length}` : ""}` },
        ]}
      >
        <Button variant="primary" onClick={() => navigate("/agents/new")}>
          New
        </Button>
      </Views>
      {agents === null ? (
        <Loading />
      ) : visible.length === 0 ? (
        all.length === 0 ? (
          <Empty title="No agents yet">Add a Grok Bot, a Hermes profile or any MCP client. Setup is one prompt you paste into the agent.</Empty>
        ) : (
          <Empty title="Everything is working" />
        )
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th className={th}>
                <span className="mr-1.5 text-xs text-faint">Aa</span>Name
              </th>
              <th className={cx(th, "hidden sm:table-cell")}>
                <span className="mr-1.5 text-xs text-faint">@</span>Handle
              </th>
              <th className={th}>
                <span className="mr-1.5 text-xs text-faint">◉</span>Runtime
              </th>
              <th className={th}>
                <span className="mr-1.5 text-xs text-faint">◎</span>Delivery
              </th>
              <th className={cx(th, "hidden md:table-cell")}>
                <span className="mr-1.5 text-xs text-faint">◷</span>Last active
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((a) => {
              const d = deliveryState(a);
              return (
                <tr key={a.handle} className="cursor-pointer hover:bg-hover" onClick={() => navigate(`/agents/${a.handle}`)}>
                  <td className={td}>
                    <span className="flex items-center gap-2">
                      <Avatar name={a.name} />
                      <span className="truncate font-medium">{a.name}</span>
                    </span>
                  </td>
                  <td className={cx(td, "hidden font-mono text-[13px] text-subtle sm:table-cell")}>{a.handle}</td>
                  <td className={td}>
                    <Tag tone={runtimeTone[a.runtime]}>{runtimeLabel[a.runtime]}</Tag>
                  </td>
                  <td className={td}>
                    <Tag tone={d.tone} dot>
                      {d.label}
                    </Tag>
                  </td>
                  <td className={cx(td, "hidden text-subtle md:table-cell")}>{timeAgo(a.last_seen_at)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {agents !== null && (
        <Link to="/agents/new" className="-mx-0 block rounded-md px-2 py-2 text-sm text-faint hover:bg-hover">
          + New agent
        </Link>
      )}
    </Page>
  );
}

// ---- add agent

const RUNTIMES: { id: Runtime; title: string; blurb: string; placeholder: string }[] = [
  { id: "grok", title: "Grok Bot", blurb: "A Bot in Grok. It joins through the agent-send connector and is woken by its own routine.", placeholder: "Creator Analyst" },
  { id: "hermes", title: "Hermes profile", blurb: "A Hermes profile. A small plugin connects out to the hub, so no tunnel is needed.", placeholder: "CMO" },
  { id: "mcp", title: "MCP client", blurb: "Claude, ChatGPT, Cursor, Claude Code, Codex… anything that adds a remote MCP server.", placeholder: "" },
  { id: "api", title: "Script / API", blurb: "Anything that can make HTTP requests, using a token.", placeholder: "Nightly report" },
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
    if (e.type === "invite" && result && (e.invite as { id: string }).id === result.invite.id) {
      const used = (e.invite as { used_by: string | null }).used_by;
      if (used) setJoined(used);
    }
  });
  useEffect(() => {
    if (runtime === "mcp" && !mcpPrompt) void api<{ prompt: string }>("GET", "/api/owner/mcp-prompt").then((r) => setMcpPrompt(r.prompt));
  }, [runtime, mcpPrompt]);

  const meta = RUNTIMES.find((r) => r.id === runtime);
  const locked = !!result;
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await api("POST", "/api/owner/invites", { runtime, ...form }));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page crumbs={[{ label: "🤖 Agents", to: "/agents" }, { label: "New agent" }]}>
      {runtime === "mcp" ? (
        <Title>Connect an MCP client</Title>
      ) : (
        <InlineInput
          autoFocus
          disabled={locked}
          className="text-[30px] leading-tight font-bold tracking-[-0.01em] md:text-[38px]"
          placeholder={meta?.placeholder ? `New agent, e.g. ${meta.placeholder}` : "New agent"}
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          onKeyDown={(e) => e.key === "Enter" && runtime && form.name.trim() && !locked && void create()}
        />
      )}
      <Props>
        <Prop icon="◉" label="Runtime">
          {RUNTIMES.map((r) => (
            <button key={r.id} disabled={locked} onClick={() => setRuntime(r.id)} className={cx("rounded transition-opacity", runtime && runtime !== r.id && "opacity-45 hover:opacity-100")}>
              <Tag tone={runtime === r.id ? runtimeTone[r.id] : "gray"}>{r.title}</Tag>
            </button>
          ))}
        </Prop>
        {runtime && runtime !== "mcp" && (
          <>
            <Prop icon="@" label="Handle">
              <InlineInput disabled={locked} className="font-mono text-[13px]" placeholder="Derived from the name" value={form.handle} onChange={(e) => setForm({ ...form, handle: e.target.value })} />
            </Prop>
            <Prop icon="≡" label="Description">
              <InlineInput disabled={locked} placeholder="What it's good at (shown to other agents)" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </Prop>
          </>
        )}
      </Props>
      {meta && <p className="text-sm text-subtle">{meta.blurb}</p>}
      {!runtime && <p className="text-sm text-faint">Pick a runtime to start.</p>}

      {runtime && runtime !== "mcp" && !result && (
        <div className="mt-5">
          <ErrorNote error={error} />
          <Button variant="primary" busy={busy} disabled={!form.name.trim()} onClick={() => void create()}>
            Create setup prompt
          </Button>
        </div>
      )}

      {runtime === "mcp" && (
        <>
          <H3>Paste this into the agent</H3>
          {mcpPrompt ? <CopyBlock text={mcpPrompt} label="Prompt" /> : <Loading />}
          <Callout icon="🔑">When it connects, a sign-in page opens here. Approve it with your passkey and choose its handle. Then it shows up in Agents.</Callout>
        </>
      )}

      {result && (
        <>
          <H3>Paste this into {runtime === "hermes" ? "a chat with the Hermes profile you want to connect" : runtime === "grok" ? "a chat with that Bot" : "the agent"}</H3>
          <CopyBlock text={result.prompt} label={`Prompt · single use · expires at ${clock(result.invite.expires_at)}`} />
          <Progress runtime={runtime!} joined={agents.find((a) => a.handle === joined) ?? null} joinedHandle={joined} />
        </>
      )}
    </Page>
  );
}

function Todo({ done, waiting, children }: { done: boolean; waiting?: boolean; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 py-1 text-sm">
      {waiting && !done ? (
        <span className="size-4 shrink-0 animate-spin rounded-full border-2 border-line border-t-subtle" />
      ) : (
        <span className={cx("grid size-4 shrink-0 place-items-center rounded-[3px]", done ? "bg-accent" : "shadow-[inset_0_0_0_1.5px_var(--fg)] opacity-70")}>
          {done && (
            <svg viewBox="0 0 24 24" className="size-3" fill="none" stroke="#fff" strokeWidth="4">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          )}
        </span>
      )}
      <span className={done ? "text-faint line-through" : ""}>{children}</span>
    </div>
  );
}

function Progress({ runtime, joined, joinedHandle }: { runtime: Runtime; joined: Agent | null; joinedHandle: string | null }) {
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
    <>
      <H3>Progress</H3>
      <Todo done>Invite created</Todo>
      <Todo done={!!joinedHandle} waiting>
        {joinedHandle ? `Joined as @${joinedHandle}` : "Waiting for the agent to join…"}
      </Todo>
      {runtime === "grok" && <Todo done={deliveryReady}>Paste the routine's webhook URL and key</Todo>}
      {runtime === "hermes" && (
        <Todo done={deliveryReady} waiting={!!joinedHandle}>
          {deliveryReady ? "Plugin connected" : "Waiting for the Hermes plugin to connect…"}
        </Todo>
      )}
      {runtime !== "api" && (
        <Todo done={!!pong} waiting={!!ping}>
          {pong ? `Connection test answered: “${pong.slice(0, 80)}”` : ping ? "Connection test sent, waiting for the answer…" : "Connection test"}
        </Todo>
      )}
      {runtime === "grok" && joined && !deliveryReady && (
        <div className="mt-4">
          <WebhookForm agent={joined} />
        </div>
      )}
      {joined && (
        <p className="mt-5 text-sm">
          <Link to={`/agents/${joined.handle}`} className="text-subtle underline hover:text-fg">
            Open {joined.name} →
          </Link>
        </p>
      )}
    </>
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
      className="space-y-3 rounded-md bg-code p-4"
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
        Save with passkey
      </Button>
    </form>
  );
}

// ---- detail

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
  const saveText = (key: "name" | "description") => {
    const value = edit[key].trim();
    if (value === agent[key] || (key === "name" && !value)) return setEdit({ ...edit, [key]: agent[key] });
    void patch({ [key]: value });
  };
  const revoked = agent.status === "revoked";
  const d = deliveryState(agent);

  return (
    <Page crumbs={[{ label: "🤖 Agents", to: "/agents" }, { label: agent.name }]}>
      <InlineInput
        disabled={revoked}
        className="text-[30px] leading-tight font-bold tracking-[-0.01em] md:text-[38px]"
        value={edit.name}
        onChange={(e) => setEdit({ ...edit, name: e.target.value })}
        onBlur={() => saveText("name")}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      />
      <InlineInput
        disabled={revoked}
        className="mt-1 text-sm text-subtle"
        placeholder="Add a description other agents will see…"
        value={edit.description}
        onChange={(e) => setEdit({ ...edit, description: e.target.value })}
        onBlur={() => saveText("description")}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      />
      <Props>
        <Prop icon="@" label="Handle">
          <span className="font-mono text-[13px]">{agent.handle}</span>
        </Prop>
        <Prop icon="◉" label="Runtime">
          <Tag tone={runtimeTone[agent.runtime]}>{runtimeLabel[agent.runtime]}</Tag>
        </Prop>
        <Prop icon="◎" label="Delivery">
          <Tag tone={d.tone} dot>
            {d.label}
          </Tag>
        </Prop>
        <Prop icon="✓" label="Identity">
          {agent.trust === "verified" ? "Verified" : <span title="It shares one connection with other Bots on the same Grok account">Self-declared (shared connection)</span>}
        </Prop>
        <Prop icon="◷" label="Last active">
          {timeAgo(agent.last_seen_at)}
        </Prop>
        <Prop icon="💬" label="Conversations">
          <Link to={`/?agent=${encodeURIComponent(agent.handle)}`} className="text-subtle underline decoration-line underline-offset-2 hover:text-fg">
            View conversations
          </Link>
        </Prop>
        <Prop icon="+" label="Added">
          {new Date(agent.created_at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}
        </Prop>
      </Props>
      <ErrorNote error={error} />

      <H3>Delivery</H3>
      <p className="text-sm text-subtle">
        {agent.delivery.method === "connector"
          ? agent.delivery.connected
            ? "Its connector is online, so messages arrive instantly."
            : "Its connector is offline. Messages wait until it reconnects or their deadline passes."
          : agent.delivery.method === "webhook"
            ? `Messages are POSTed to ${agent.delivery.url}.`
            : "Messages wait in its inbox until it checks."}
      </p>
      {(agent.runtime === "grok" || agent.delivery.method === "webhook") && !revoked && (
        <div className="mt-3">
          <WebhookForm agent={agent} onSaved={onChange} />
        </div>
      )}
      {routine && (
        <details className="group mt-3 text-sm">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md py-1 hover:bg-hover">
            <span className="w-4 text-center text-[10px] text-faint transition-transform group-open:rotate-90">▶</span>
            Routine instruction for this Bot
          </summary>
          <div className="pl-5">
            <CopyBlock text={routine} label="Instruction" />
          </div>
        </details>
      )}
      <div className="mt-3">
        <Button disabled={revoked || agent.status !== "active"} onClick={() => act("ping", async () => {
              await api("POST", `/api/owner/agents/${agent.handle}/ping`, {});
              navigate(pairPath("owner", agent.handle));
            })}>
          Send connection test
        </Button>
      </div>

      <H3>Permissions</H3>
      {(
        [
          ["can_send", "Can send messages", "Lets it ask and notify other agents.", agent.can_send],
          ["can_receive", "Can receive messages", "Other agents and you can reach it.", agent.can_receive],
          ["hidden", "Hidden", "Leaves it out of other agents' directory.", agent.hidden],
        ] as const
      ).map(([key, label, hint, value]) => (
        <SettingRow key={key} label={label} hint={hint}>
          <Toggle label={label} checked={value} disabled={revoked} onChange={(v) => void patch({ [key]: v })} />
        </SettingRow>
      ))}

      <H3>Access</H3>
      {token && (
        <>
          <p className="text-sm">New token. It's shown only once: update the agent's configuration with it.</p>
          <CopyBlock text={token} label="Token" />
        </>
      )}
      {revoked ? (
        <p className="text-sm text-subtle">This agent is revoked. Its handle can't be reused.</p>
      ) : (
        <>
          <SettingRow label={agent.status === "paused" ? "Paused" : "Pause"} hint="Stops deliveries to it and rejects messages from it until you resume.">
            <Button busy={busy === "pause"} onClick={() => act("pause", () => api("PATCH", `/api/owner/agents/${agent.handle}`, { status: agent.status === "paused" ? "active" : "paused" }))}>
              {agent.status === "paused" ? "Resume" : "Pause"}
            </Button>
          </SettingRow>
          {!agent.grant_id && (
            <SettingRow label="Rotate token" hint="Issues a new token and invalidates the old one.">
              <Button busy={busy === "rotate"} onClick={() => act("rotate", async () => setToken((await api<{ token: string }>("POST", `/api/owner/agents/${agent.handle}/rotate`, {})).token))}>
                Rotate
              </Button>
            </SettingRow>
          )}
          <SettingRow label="Revoke" hint="Removes it for good. Its handle can never be reused.">
            <Button
              variant="danger"
              busy={busy === "revoke"}
              onClick={() => {
                if (confirm(`Revoke ${agent.name}? Its handle can never be reused.`)) void act("revoke", () => api("POST", `/api/owner/agents/${agent.handle}/revoke`, {}));
              }}
            >
              Revoke
            </Button>
          </SettingRow>
        </>
      )}
    </Page>
  );
}
