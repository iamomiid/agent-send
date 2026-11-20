import { useCallback, useEffect, useState } from "react";
import { api, type Agent, type Message, type ThreadSummary } from "../api";
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, Textarea, cx, statusTone, timeAgo, useLive } from "../components";
import { Link, navigate } from "../main";

export function ConversationsPage({ path }: { path: string }) {
  const threadId = path.startsWith("/threads/") ? decodeURIComponent(path.slice(9)) : null;
  const [threads, setThreads] = useState<ThreadSummary[] | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [composing, setComposing] = useState(false);

  const load = useCallback(() => {
    void api<ThreadSummary[]>("GET", "/api/owner/threads").then(setThreads);
    void api<Agent[]>("GET", "/api/owner/agents").then(setAgents);
  }, []);
  useEffect(load, [load]);

  const live = useLive((e) => {
    if (e.type !== "message") return;
    setThreads((prev) => {
      if (!prev) return prev;
      const m = e.message;
      const existing = prev.find((t) => t.thread === m.thread);
      const isNewer = !existing || existing.last.seq <= m.seq;
      const updated: ThreadSummary = existing
        ? { ...existing, last: isNewer ? m : existing.last, count: existing.last.id === m.id || !isNewer ? existing.count : existing.count + 1, participants: [...new Set([...existing.participants, m.from, m.to])] }
        : { thread: m.thread, participants: [m.from, m.to], count: 1, last: m };
      const rest = prev.filter((t) => t.thread !== m.thread);
      return [updated, ...rest].sort((a, b) => b.last.seq - a.last.seq);
    });
  });

  const names = Object.fromEntries(agents.map((a) => [a.handle, a.name]));
  return (
    <div className="flex h-full min-h-0">
      <section className={cx("flex w-full min-w-0 flex-col border-line md:w-80 md:shrink-0 md:border-r", threadId && "hidden md:flex")}>
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="flex items-center gap-2">
            <h1 className="font-semibold">Conversations</h1>
            <span title={live ? "Live" : "Reconnecting"} className={cx("size-2 rounded-full", live ? "bg-emerald-500" : "bg-amber-500")} />
          </div>
          <Button variant="primary" onClick={() => setComposing(true)}>
            New message
          </Button>
        </header>
        <div className="flex-1 overflow-y-auto">
          {threads === null ? (
            <p className="p-4 text-sm text-subtle">Loading…</p>
          ) : threads.length === 0 ? (
            <Empty title="No conversations yet">
              <Link to="/agents/new" className="underline">
                Add an agent
              </Link>{" "}
              and it will run a connection test here.
            </Empty>
          ) : (
            threads.map((t) => (
              <Link key={t.thread} to={`/threads/${encodeURIComponent(t.thread)}`} className={cx("block border-b border-line px-4 py-3 hover:bg-muted", t.thread === threadId && "bg-muted")}>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{t.participants.map((h) => names[h] ?? h).join(" ↔ ")}</span>
                  <span className="shrink-0 text-xs text-subtle">{timeAgo(t.last.created_at)}</span>
                </div>
                <p className="mt-0.5 truncate text-sm text-subtle">{t.last.message}</p>
                <div className="mt-1 flex gap-1">
                  <Badge tone={statusTone(t.last.status)}>{t.last.kind === "reply" ? "replied" : t.last.status}</Badge>
                  <Badge>{t.count} msg</Badge>
                </div>
              </Link>
            ))
          )}
        </div>
      </section>
      <section className={cx("min-w-0 flex-1", !threadId && "hidden md:block")}>
        {threadId ? <ThreadView thread={threadId} names={names} /> : <Empty title="Select a conversation">Every message between your agents shows up here as it happens.</Empty>}
      </section>
      {composing && <Compose agents={agents} onClose={() => setComposing(false)} />}
    </div>
  );
}

function ThreadView({ thread, names }: { thread: string; names: Record<string, string> }) {
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [reply, setReply] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setMessages(null);
    void api<Message[]>("GET", `/api/owner/threads/${encodeURIComponent(thread)}`).then(setMessages);
  }, [thread]);
  useLive((e) => {
    if (e.type !== "message" || e.message.thread !== thread) return;
    setMessages((prev) => {
      if (!prev) return prev;
      const i = prev.findIndex((m) => m.id === e.message.id);
      if (i === -1) return [...prev, e.message].sort((a, b) => a.seq - b.seq);
      const copy = [...prev];
      copy[i] = e.message;
      return copy;
    });
  });
  if (!messages) return <p className="p-4 text-sm text-subtle">Loading…</p>;
  const openForOwner = messages.filter((m) => m.kind === "request" && m.to === "owner" && (m.status === "delivered" || m.status === "queued"));
  const lastPeer = [...messages].reverse().find((m) => m.from !== "owner")?.from ?? [...messages].reverse().find((m) => m.to !== "owner")?.to;
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-line px-4 py-3">
        <button className="text-sm text-subtle md:hidden" onClick={() => navigate("/")}>
          ← Back
        </button>
        <h2 className="truncate font-semibold">Thread {thread}</h2>
      </header>
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.map((m) => (
          <Card key={m.id} className={cx("p-3", m.from === "owner" && "border-accent/40")}>
            <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs text-subtle">
              <span className="font-medium text-fg">{names[m.from] ?? m.from}</span>
              <span>→</span>
              <span className="font-medium text-fg">{names[m.to] ?? m.to}</span>
              <Badge>{m.kind}</Badge>
              <Badge tone={statusTone(m.status)}>{m.status}</Badge>
              {m.late && <Badge tone="amber">late</Badge>}
              <span className="ml-auto">{new Date(m.created_at).toLocaleString()}</span>
            </div>
            <p className="text-sm break-words whitespace-pre-wrap">{m.message}</p>
            {m.error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{m.error}</p>}
            {m.status === "failed" && (
              <Button className="mt-2" onClick={() => api("POST", `/api/owner/messages/${m.id}/retry`, {}).catch(setError)}>
                Retry delivery
              </Button>
            )}
          </Card>
        ))}
      </div>
      <form
        className="space-y-2 border-t border-line p-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!reply.trim()) return;
          setBusy(true);
          setError(null);
          try {
            if (openForOwner[0]) await api("POST", "/api/owner/reply", { request_id: openForOwner[0].id, result: reply });
            else if (lastPeer) await api("POST", "/api/owner/send", { to: lastPeer, message: reply, thread });
            setReply("");
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <ErrorNote error={error} />
        <div className="flex gap-2">
          <Textarea rows={2} placeholder={openForOwner[0] ? "Answer this request…" : `Message ${lastPeer ? (names[lastPeer] ?? lastPeer) : ""}…`} value={reply} onChange={(e) => setReply(e.target.value)} />
          <Button variant="primary" busy={busy}>
            {openForOwner[0] ? "Reply" : "Send"}
          </Button>
        </div>
      </form>
    </div>
  );
}

function Compose({ agents, onClose }: { agents: Agent[]; onClose: () => void }) {
  const reachable = agents.filter((a) => a.handle !== "owner" && a.status === "active" && a.can_receive);
  const [to, setTo] = useState(reachable[0]?.handle ?? "");
  const [message, setMessage] = useState("");
  const [kind, setKind] = useState<"request" | "notify">("request");
  const [deadline, setDeadline] = useState(300);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="fixed inset-0 z-10 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <Card className="w-full max-w-lg space-y-4 p-5" >
        <div onClick={(e) => e.stopPropagation()} className="space-y-4">
          <h2 className="font-semibold">New message</h2>
          {reachable.length === 0 ? (
            <p className="text-sm text-subtle">No agent can receive messages yet. Add one first.</p>
          ) : (
            <>
              <Field label="To">
                <select className="w-full rounded-md border border-line bg-panel px-3 py-2 text-sm" value={to} onChange={(e) => setTo(e.target.value)}>
                  {reachable.map((a) => (
                    <option key={a.handle} value={a.handle}>
                      {a.name} ({a.handle})
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Message">
                <Textarea rows={5} value={message} onChange={(e) => setMessage(e.target.value)} autoFocus />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Kind">
                  <select className="w-full rounded-md border border-line bg-panel px-3 py-2 text-sm" value={kind} onChange={(e) => setKind(e.target.value as "request" | "notify")}>
                    <option value="request">Request (expects a reply)</option>
                    <option value="notify">Notify (one-way)</option>
                  </select>
                </Field>
                {kind === "request" && (
                  <Field label="Deadline (seconds)">
                    <Input type="number" min={10} max={3600} value={deadline} onChange={(e) => setDeadline(Number(e.target.value))} />
                  </Field>
                )}
              </div>
            </>
          )}
          <ErrorNote error={error} />
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              busy={busy}
              disabled={!to || !message.trim()}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  const t = await api<{ thread: string }>("POST", "/api/owner/send", { to, message, kind, deadline_seconds: deadline });
                  onClose();
                  navigate(`/threads/${encodeURIComponent(t.thread)}`);
                } catch (err) {
                  setError(err);
                  setBusy(false);
                }
              }}
            >
              Send
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
