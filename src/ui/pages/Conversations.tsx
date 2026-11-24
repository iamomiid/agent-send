import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, type Agent, type Message, type PairSummary } from "../api";
import { Avatar, Button, Divider, Empty, ErrorNote, Loading, Modal, Page, Prop, Props, Tag, Textarea, Title, Views, clock, cx, duration, runtimeLabel, timeAgo, useLive, type Tone } from "../components";
import { nameOf, useAgents } from "../data";
import { Link, navigate } from "../router";

/** The address of the conversation between two agents (order doesn't matter). */
export function pairPath(x: string, y: string) {
  const [a, b] = [x, y].sort();
  return `/c/${encodeURIComponent(a!)}/${encodeURIComponent(b!)}`;
}

export function ConversationsPage({ path }: { path: string }) {
  if (path.startsWith("/c/")) {
    const [a = "", b = ""] = path.slice(3).split("/").map(decodeURIComponent);
    return <PairPage key={`${a}/${b}`} a={a} b={b} />;
  }
  if (path.startsWith("/threads/")) {
    const thread = decodeURIComponent(path.slice(9));
    return <ThreadPage key={thread} thread={thread} />;
  }
  const agent = new URLSearchParams(location.search).get("agent") ?? "";
  return <PairList key={agent} agent={agent} />;
}

function oneLine(s: string) {
  return s.replace(/\s+/g, " ").trim();
}

function dayLabel(t: string) {
  const d = new Date(t);
  if (d.toDateString() === new Date().toDateString()) return "Today";
  if (d.toDateString() === new Date(Date.now() - 86_400_000).toDateString()) return "Yesterday";
  const opts: Intl.DateTimeFormatOptions = Date.now() - d.getTime() < 6 * 86_400_000 ? { weekday: "long", month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" };
  return d.toLocaleDateString(undefined, opts);
}

function time(t: string) {
  return new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

const stateTag: Record<string, { label: string; tone: Tone }> = {
  waiting: { label: "Waiting", tone: "blue" },
  failed: { label: "Failed", tone: "red" },
  expired: { label: "Expired", tone: "yellow" },
};

// ---- list of pairs

type View = "all" | "waiting" | "failed";
const filterClass = "h-7 rounded-md bg-field px-2 text-sm shadow-[inset_0_0_0_1px_var(--line)] outline-none placeholder:text-faint focus:shadow-[inset_0_0_0_1px_var(--accent)]";

function PairList({ agent }: { agent: string }) {
  const { agents } = useAgents();
  const [pairs, setPairs] = useState<PairSummary[] | null>(null);
  const [more, setMore] = useState(false);
  const [view, setView] = useState<View>("all");
  const [query, setQuery] = useState("");
  const [q, setQ] = useState(""); // debounced
  const [loadingMore, setLoadingMore] = useState(false);
  const [composing, setComposing] = useState(false);
  const name = useCallback((h: string) => nameOf(agents, h), [agents]);
  const shown = useRef(50);

  useEffect(() => {
    const t = setTimeout(() => setQ(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const fetchPage = useCallback(
    (opts: { before?: number; limit?: number } = {}) => {
      const params = new URLSearchParams({ limit: String(opts.limit ?? 50) });
      if (agent) params.set("agent", agent);
      if (q) params.set("q", q);
      if (view !== "all") params.set("view", view);
      if (opts.before) params.set("before", String(opts.before));
      return api<{ pairs: PairSummary[]; more: boolean }>("GET", `/api/owner/pairs?${params}`);
    },
    [agent, q, view],
  );
  useEffect(() => {
    let stale = false;
    setPairs(null);
    shown.current = 50;
    void fetchPage().then((r) => {
      if (stale) return;
      setPairs(r.pairs);
      setMore(r.more);
    });
    return () => {
      stale = true;
    };
  }, [fetchPage]);

  // New activity reorders pairs and changes their counts, so refresh what's on screen (debounced).
  const refresh = useRef<ReturnType<typeof setTimeout>>(undefined);
  useLive((e) => {
    if (e.type !== "message") return;
    clearTimeout(refresh.current);
    refresh.current = setTimeout(() => {
      void fetchPage({ limit: Math.min(shown.current, 200) }).then((r) => {
        setPairs(r.pairs);
        setMore(r.more);
      });
    }, 400);
  });

  const filtered = !!(agent || q || view !== "all");
  const listed = (agents ?? []).filter((a) => a.handle !== "owner");
  const agentSelect = (className: string) => (
    <select aria-label="Agent" className={cx(filterClass, className, !agent && "text-subtle")} value={agent} onChange={(e) => navigate(e.target.value ? `/?agent=${encodeURIComponent(e.target.value)}` : "/")}>
      <option value="">All agents</option>
      {listed.map((a) => (
        <option key={a.handle} value={a.handle}>
          {a.name}
        </option>
      ))}
    </select>
  );
  const search = (className: string) => <input type="search" aria-label="Search messages" placeholder="Search…" className={cx(filterClass, className)} value={query} onChange={(e) => setQuery(e.target.value)} />;

  return (
    <Page crumbs={[{ label: "💬 Conversations" }]}>
      <Title icon="💬">Conversations</Title>
      <p className="text-sm text-subtle">Every exchange between your agents, one conversation per pair.</p>
      <Views
        value={view}
        onChange={setView}
        options={[
          { id: "all", label: "All" },
          { id: "waiting", label: "Waiting" },
          { id: "failed", label: "Failed" },
        ]}
      >
        {search("hidden w-40 sm:block")}
        {agentSelect("hidden max-w-40 sm:block")}
        <Button variant="primary" onClick={() => setComposing(true)}>
          New
        </Button>
      </Views>
      <div className="mt-2 flex gap-2 sm:hidden">
        {search("min-w-0 flex-1")}
        {agentSelect("max-w-36")}
      </div>

      {pairs === null ? (
        <Loading />
      ) : pairs.length === 0 ? (
        filtered ? (
          <Empty title="No conversations match" />
        ) : (
          <Empty title="No conversations yet">
            <Link to="/agents/new" className="underline">
              Add an agent
            </Link>{" "}
            and its connection test shows up here.
          </Empty>
        )
      ) : (
        <div className="mt-1">
          {pairs.map((p) => (
            <PairRow key={`${p.a}/${p.b}`} p={p} name={name} />
          ))}
          {more && (
            <div className="mt-4">
              <Button
                variant="ghost"
                busy={loadingMore}
                onClick={async () => {
                  setLoadingMore(true);
                  try {
                    const r = await fetchPage({ before: pairs[pairs.length - 1]!.last.seq });
                    setPairs((prev) => {
                      const next = [...(prev ?? []), ...r.pairs.filter((x) => !prev?.some((y) => y.a === x.a && y.b === x.b))];
                      shown.current = next.length;
                      return next;
                    });
                    setMore(r.more);
                  } finally {
                    setLoadingMore(false);
                  }
                }}
              >
                Load more
              </Button>
            </div>
          )}
        </div>
      )}
      {composing && <Compose agents={agents ?? []} onClose={() => setComposing(false)} />}
    </Page>
  );
}

function PairRow({ p, name }: { p: PairSummary; name: (h: string) => string }) {
  // Name the asker first ("CMO ↔ Content Helper"), and you first when you're in it.
  const [x, y] = p.a === "owner" || p.b === "owner" ? ["owner", p.a === "owner" ? p.b : p.a] : p.ask ? [p.ask.from, p.ask.to] : [p.a, p.b];
  const tag = p.state ? stateTag[p.state] : null;
  return (
    <Link to={pairPath(p.a, p.b)} className="-mx-2 flex items-center gap-3 rounded-md border-b border-line px-2 py-2.5 hover:bg-hover">
      <span className="flex shrink-0">
        <Avatar name={name(x!)} owner={x === "owner"} />
        <span className="-ml-1.5 rounded-full ring-2 ring-bg">
          <Avatar name={name(y!)} owner={y === "owner"} />
        </span>
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="truncate text-sm font-medium">
            {name(x!)} ↔ {name(y!)}
          </span>
          <span className="shrink-0 text-xs text-faint">
            · {p.exchanges} {p.exchanges === 1 ? "exchange" : "exchanges"}
          </span>
        </div>
        <div className="truncate text-[13px] text-subtle">
          {p.ask ? oneLine(p.ask.message) : oneLine(p.last.message)}
          {p.answer && <span className="text-faint"> · {oneLine(p.answer.message)}</span>}
        </div>
      </div>
      {tag && <Tag tone={tag.tone}>{p.state === "waiting" && p.open > 1 ? `${p.open} waiting` : tag.label}</Tag>}
      <span className="w-20 shrink-0 text-right text-xs text-faint">{timeAgo(p.last.created_at)}</span>
    </Link>
  );
}

// ---- one pair's history

interface PairData {
  messages: Message[];
  more: boolean;
  exchanges: number;
  since: string | null;
}

function PairPage({ a, b }: { a: string; b: string }) {
  const { agents } = useAgents();
  const [data, setData] = useState<PairData | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const scrolled = useRef(false);
  const name = useCallback((h: string) => nameOf(agents, h), [agents]);
  const url = `/api/owner/pairs/${encodeURIComponent(a)}/${encodeURIComponent(b)}`;

  useEffect(() => {
    api<PairData>("GET", url).then(setData, setError);
  }, [url]);
  useLayoutEffect(() => {
    if (data && !scrolled.current) {
      scrolled.current = true;
      end.current?.scrollIntoView({ block: "end" });
    }
  }, [data]);
  useLive((e) => {
    if (e.type !== "message") return;
    const m = e.message;
    if (!((m.from === a && m.to === b) || (m.from === b && m.to === a))) return;
    setData((prev) => {
      if (!prev) return prev;
      const i = prev.messages.findIndex((x) => x.id === m.id);
      if (i >= 0) {
        const messages = [...prev.messages];
        messages[i] = m;
        return { ...prev, messages };
      }
      return { ...prev, messages: [...prev.messages, m].sort((p, q) => p.seq - q.seq), exchanges: prev.exchanges + (m.kind === "reply" ? 0 : 1) };
    });
  });

  const groups = useMemo(() => {
    const messages = data?.messages ?? [];
    const replies = new Map<string, Message[]>();
    const tops: Message[] = [];
    const ids = new Set(messages.map((m) => m.id));
    for (const m of messages) {
      if (m.kind === "reply" && m.reply_to && ids.has(m.reply_to)) replies.set(m.reply_to, [...(replies.get(m.reply_to) ?? []), m]);
      else tops.push(m);
    }
    const out: { day: string; items: { top: Message; replies: Message[] }[] }[] = [];
    for (const top of tops) {
      const day = dayLabel(top.created_at);
      const item = { top, replies: replies.get(top.id) ?? [] };
      if (out[out.length - 1]?.day === day) out[out.length - 1]!.items.push(item);
      else out.push({ day, items: [item] });
    }
    return out;
  }, [data]);

  if (!data) return error ? <ErrorNote error={error} /> : <Loading />;
  const firstTop = groups[0]?.items[0]?.top;
  const [x, y] = a === "owner" || b === "owner" ? ["owner", a === "owner" ? b : a] : firstTop ? [firstTop.from, firstTop.to] : [a, b];
  const title = `${name(x!)} ↔ ${name(y!)}`;
  const agentOf = (h: string) => agents?.find((ag) => ag.handle === h);
  const other = x === "owner" ? y! : null;

  return (
    <Page crumbs={[{ label: "💬 Conversations", to: "/" }, { label: title }]}>
      <Title>{title}</Title>
      <Props>
        <Prop icon="☺" label="Agents">
          {[x!, y!].map((h) => (
            <span key={h} className="mr-2 inline-flex items-center gap-1.5">
              <Avatar name={name(h)} owner={h === "owner"} size="sm" />
              {h === "owner" ? (
                "You"
              ) : (
                <Link to={`/agents/${encodeURIComponent(h)}`} className="hover:underline">
                  {name(h)}
                </Link>
              )}
              {agentOf(h) && h !== "owner" && <span className="text-faint">{runtimeLabel[agentOf(h)!.runtime]}</span>}
            </span>
          ))}
        </Prop>
        <Prop icon="⇄" label="Exchanges">
          {data.exchanges}
          {data.since && <span className="text-faint">· since {new Date(data.since).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>}
        </Prop>
      </Props>
      <Divider />
      <ErrorNote error={error} />
      {data.more && (
        <Button
          variant="ghost"
          busy={loadingOlder}
          onClick={async () => {
            setLoadingOlder(true);
            try {
              const r = await api<PairData>("GET", `${url}?before=${data.messages[0]!.seq}`);
              setData((prev) => (prev ? { ...prev, more: r.more, messages: [...r.messages.filter((m) => !prev.messages.some((p) => p.id === m.id)), ...prev.messages] } : prev));
            } catch (e) {
              setError(e);
            } finally {
              setLoadingOlder(false);
            }
          }}
        >
          ↑ Load older
        </Button>
      )}
      {groups.length === 0 && <Empty title="Nothing here yet" />}
      {groups.map((g) => (
        <section key={g.day}>
          <h2 className="mt-6 mb-1 flex items-center gap-3 text-xs font-medium text-subtle after:h-px after:flex-1 after:bg-line">{g.day}</h2>
          {g.items.map(({ top, replies }) => (
            <div key={top.id} className="flex gap-3 py-1.5">
              <span className="hidden w-[4.25rem] shrink-0 pt-2.5 text-xs whitespace-nowrap text-faint tabular-nums sm:block">{time(top.created_at)}</span>
              <div className="min-w-0 flex-1">
                <Comment m={top} name={name} onError={setError} />
                {replies.map((r) => (
                  <div key={r.id} className="ml-3 border-l-2 border-line pl-5">
                    <Comment m={r} name={name} parent={top} onError={setError} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </section>
      ))}
      {other && <Composer messages={data.messages} name={name} other={other} thread={data.messages[data.messages.length - 1]?.thread} />}
      <div ref={end} />
    </Page>
  );
}

// ---- a single thread (old links, and conversations among three or more agents)

function ThreadPage({ thread }: { thread: string }) {
  const { agents } = useAgents();
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const name = useCallback((h: string) => nameOf(agents, h), [agents]);

  useEffect(() => {
    api<Message[]>("GET", `/api/owner/threads/${encodeURIComponent(thread)}`).then(setMessages, setError);
  }, [thread]);
  useLive((e) => {
    if (e.type !== "message" || e.message.thread !== thread) return;
    setMessages((prev) => {
      if (!prev) return prev;
      const i = prev.findIndex((m) => m.id === e.message.id);
      if (i === -1) return [...prev, e.message].sort((p, q) => p.seq - q.seq);
      const copy = [...prev];
      copy[i] = e.message;
      return copy;
    });
  });

  if (!messages) return error ? <ErrorNote error={error} /> : <Loading />;
  const first = messages[0];
  const participants = [...new Set(messages.flatMap((m) => [m.from, m.to]))];
  const title = participants.length === 2 && first ? `${name(first.from)} ↔ ${name(first.to)}` : participants.map(name).join(", ");
  const byId = new Map(messages.map((m) => [m.id, m]));
  const tops = messages.filter((m) => !(m.kind === "reply" && m.reply_to && byId.has(m.reply_to)));
  const other = participants.length === 2 && participants.includes("owner") ? participants.find((h) => h !== "owner")! : null;

  return (
    <Page crumbs={[{ label: "💬 Conversations", to: "/" }, { label: title }]}>
      <Title>{title}</Title>
      {participants.length === 2 && (
        <p className="text-sm">
          <Link to={pairPath(participants[0]!, participants[1]!)} className="text-subtle underline decoration-line underline-offset-2 hover:text-fg">
            See everything between {name(participants[0]!)} and {name(participants[1]!)}
          </Link>
        </p>
      )}
      <Divider />
      <ErrorNote error={error} />
      {tops.map((m) => (
        <div key={m.id}>
          <Comment m={m} name={name} onError={setError} />
          {messages
            .filter((r) => r.kind === "reply" && r.reply_to === m.id)
            .map((r) => (
              <div key={r.id} className="ml-3 border-l-2 border-line pl-5">
                <Comment m={r} name={name} parent={m} onError={setError} />
              </div>
            ))}
        </div>
      ))}
      {other && <Composer messages={messages} name={name} other={other} thread={thread} />}
    </Page>
  );
}

// ---- shared pieces

function Comment({ m, name, parent, onError }: { m: Message; name: (h: string) => string; parent?: Message; onError: (e: unknown) => void }) {
  const [open, setOpen] = useState(false);
  const long = m.message.length > 600 || m.message.split("\n").length > 8;
  const meta =
    m.kind === "reply"
      ? parent
        ? `replied in ${duration(Date.parse(m.created_at) - Date.parse(parent.created_at))}`
        : "replied"
      : m.kind === "notify"
        ? "notified"
        : "asked";
  const upstream = (m.via ?? []).filter((h) => h !== m.to);
  const waiting = m.kind === "request" && (m.status === "queued" || m.status === "delivered");
  return (
    <div className="flex gap-2.5 py-2">
      <Avatar name={name(m.from)} owner={m.from === "owner"} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm font-semibold">{name(m.from)}</span>
          <span className="text-xs text-faint">
            {meta}
            {upstream.length > 0 && (
              <>
                {" "}
                while answering{" "}
                <Link to={pairPath(upstream[upstream.length - 1]!, m.from)} className="underline decoration-line underline-offset-2 hover:text-fg">
                  {name(upstream[upstream.length - 1]!)}
                </Link>
              </>
            )}
            <span className="sm:hidden"> · {time(m.created_at)}</span>
          </span>
          {m.late && <Tag tone="yellow">late</Tag>}
        </div>
        <div className={cx("mt-0.5 text-sm leading-relaxed break-words whitespace-pre-wrap", long && !open && "line-clamp-6")}>{m.message}</div>
        {long && (
          <button className="mt-0.5 text-xs text-faint hover:text-fg" onClick={() => setOpen(!open)}>
            {open ? "Show less ▴" : "Show all ▾"}
          </button>
        )}
        {waiting && <div className="mt-1 text-xs text-faint">{m.status === "queued" ? "Queued" : "Delivered"} · waiting for a reply{m.deadline_at ? ` until ${clock(m.deadline_at)}` : ""}</div>}
        {m.status === "expired" && <div className="mt-1 text-xs text-faint">No reply before the deadline.</div>}
        {m.status === "failed" && (
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-danger">
            {m.error ?? "Delivery failed."}
            <button className="rounded px-1.5 py-0.5 text-subtle hover:bg-hover hover:text-fg" onClick={() => api("POST", `/api/owner/messages/${m.id}/retry`, {}).catch(onError)}>
              Retry
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Composer({ messages, name, other, thread }: { messages: Message[]; name: (h: string) => string; other: string; thread?: string }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const openForOwner = messages.filter((m) => m.kind === "request" && m.to === "owner" && (m.status === "delivered" || m.status === "queued"));

  return (
    <form
      className="mt-4 border-t border-line pt-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!text.trim()) return;
        setBusy(true);
        setError(null);
        try {
          if (openForOwner[0]) await api("POST", "/api/owner/reply", { request_id: openForOwner[0].id, result: text });
          else await api("POST", "/api/owner/send", { to: other, message: text, thread });
          setText("");
        } catch (err) {
          setError(err);
        } finally {
          setBusy(false);
        }
      }}
    >
      <ErrorNote error={error} />
      <div className="flex items-start gap-2.5">
        <Avatar name="You" owner />
        <textarea
          rows={text.includes("\n") ? 4 : 1}
          className="min-h-6 flex-1 resize-none bg-transparent py-0.5 text-sm outline-none placeholder:text-faint"
          placeholder={openForOwner[0] ? `Answer ${name(openForOwner[0].from)}…` : `Write to ${name(other)}…`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
          }}
        />
        <Button variant="primary" busy={busy} disabled={!text.trim()} className={cx(!text.trim() && "invisible")}>
          {openForOwner[0] ? "Reply" : "Send"}
        </Button>
      </div>
    </form>
  );
}

const selectClass = "rounded-md bg-field px-2 py-1 text-sm shadow-[inset_0_0_0_1px_var(--line)] outline-none";

function Compose({ agents, onClose }: { agents: Agent[]; onClose: () => void }) {
  const reachable = agents.filter((a) => a.handle !== "owner" && a.status === "active" && a.can_receive);
  const [to, setTo] = useState(reachable[0]?.handle ?? "");
  const [message, setMessage] = useState("");
  const [kind, setKind] = useState<"request" | "notify">("request");
  const [deadline, setDeadline] = useState(300);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal onClose={onClose}>
      <h2 className="text-xl font-bold">New message</h2>
      {reachable.length === 0 ? (
        <p className="mt-3 text-sm text-subtle">No agent can receive messages yet. Add one first.</p>
      ) : (
        <>
          <Props>
            <Prop icon="→" label="To">
              <select className={selectClass} value={to} onChange={(e) => setTo(e.target.value)}>
                {reachable.map((a) => (
                  <option key={a.handle} value={a.handle}>
                    {a.name} (@{a.handle})
                  </option>
                ))}
              </select>
            </Prop>
            <Prop icon="◉" label="Type">
              {(["request", "notify"] as const).map((k) => (
                <button key={k} onClick={() => setKind(k)}>
                  <Tag tone={kind === k ? "blue" : "gray"}>{k === "request" ? "Request a reply" : "Notify only"}</Tag>
                </button>
              ))}
            </Prop>
            {kind === "request" && (
              <Prop icon="◷" label="Deadline">
                <select className={selectClass} value={deadline} onChange={(e) => setDeadline(Number(e.target.value))}>
                  {[60, 300, 900, 1800, 3600].map((s) => (
                    <option key={s} value={s}>
                      {s / 60} min
                    </option>
                  ))}
                </select>
              </Prop>
            )}
          </Props>
          <Textarea rows={5} placeholder="Write a message…" value={message} onChange={(e) => setMessage(e.target.value)} autoFocus />
        </>
      )}
      <ErrorNote error={error} />
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          busy={busy}
          disabled={!to || !message.trim()}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await api("POST", "/api/owner/send", { to, message, kind, deadline_seconds: deadline });
              onClose();
              navigate(pairPath("owner", to));
            } catch (err) {
              setError(err);
              setBusy(false);
            }
          }}
        >
          Send
        </Button>
      </div>
    </Modal>
  );
}
