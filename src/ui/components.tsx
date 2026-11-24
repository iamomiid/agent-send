import { useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import type { Agent, LiveEvent, Message } from "./api";
import { Link } from "./router";

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

// ---- buttons and fields

type Variant = "primary" | "secondary" | "ghost" | "danger";
export function Button({ variant = "secondary", className, busy, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  const styles: Record<Variant, string> = {
    primary: "bg-accent text-accent-fg hover:brightness-95",
    secondary: "border border-line bg-bg hover:bg-hover",
    ghost: "text-subtle hover:bg-hover hover:text-fg",
    danger: "border border-line bg-bg text-danger hover:bg-tag-red/50",
  };
  return (
    <button
      className={cx("inline-flex h-7 items-center justify-center gap-1.5 rounded-md px-2.5 text-sm font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50", styles[variant], className)}
      disabled={busy || rest.disabled}
      {...rest}
    >
      {busy && <span className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" />}
      {children}
    </button>
  );
}

const fieldClass = "w-full rounded-md bg-field px-2.5 py-1.5 text-sm shadow-[inset_0_0_0_1px_var(--line)] outline-none placeholder:text-faint focus:shadow-[inset_0_0_0_1px_var(--accent),0_0_0_3px_rgba(35,131,226,0.18)] disabled:opacity-60";

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(fieldClass, props.className)} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx(fieldClass, "resize-y leading-relaxed", props.className)} />;
}

/** A borderless input that looks like text until you hover or focus it (Notion page properties). */
export function InlineInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx("-mx-1.5 w-full min-w-0 rounded-md bg-transparent px-1.5 py-1 outline-none placeholder:text-faint hover:bg-hover focus:bg-hover disabled:hover:bg-transparent", className)} />;
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm text-subtle">{label}</span>
      {children}
      {hint && <span className="block text-xs text-faint">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx("relative h-[18px] w-[30px] shrink-0 rounded-full transition-colors disabled:opacity-50", checked ? "bg-accent" : "bg-tag-gray")}
    >
      <span className={cx("absolute top-[2px] size-[14px] rounded-full bg-white shadow-sm transition-all", checked ? "left-[14px]" : "left-[2px]")} />
    </button>
  );
}

// ---- tags, avatars, dots

export type Tone = "gray" | "green" | "red" | "yellow" | "blue" | "purple" | "orange";
const tagTones: Record<Tone, string> = {
  gray: "bg-tag-gray text-tag-gray-fg",
  green: "bg-tag-green text-tag-green-fg",
  red: "bg-tag-red text-tag-red-fg",
  yellow: "bg-tag-yellow text-tag-yellow-fg",
  blue: "bg-tag-blue text-tag-blue-fg",
  purple: "bg-tag-purple text-tag-purple-fg",
  orange: "bg-tag-orange text-tag-orange-fg",
};
const dotTones: Record<Tone, string> = { gray: "bg-dot-gray", green: "bg-dot-green", red: "bg-dot-red", yellow: "bg-dot-yellow", blue: "bg-accent", purple: "bg-dot-gray", orange: "bg-dot-yellow" };

export function Tag({ children, tone = "gray", dot }: { children: ReactNode; tone?: Tone; dot?: boolean }) {
  return (
    <span className={cx("inline-flex h-5 items-center gap-1.5 rounded px-1.5 text-[13px] leading-none whitespace-nowrap", tagTones[tone])}>
      {dot && <span className="size-1.5 rounded-full bg-current opacity-60" />}
      {children}
    </span>
  );
}

export function Dot({ tone, title }: { tone: Tone; title?: string }) {
  return <span title={title} className={cx("inline-block size-1.5 shrink-0 rounded-full", dotTones[tone])} />;
}

export function Avatar({ name, owner, size = "md" }: { name: string; owner?: boolean; size?: "sm" | "md" }) {
  return (
    <span
      className={cx(
        "grid shrink-0 place-items-center rounded-full font-semibold select-none",
        size === "sm" ? "size-5 text-[10px]" : "size-6 text-[11px]",
        owner ? "bg-fg text-bg" : "bg-tag-gray text-subtle",
      )}
    >
      {(name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}

// ---- page layout

export interface Crumb {
  label: ReactNode;
  to?: string;
}

export function Page({ crumbs, actions, children, wide }: { crumbs: Crumb[]; actions?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className="flex min-h-full flex-col">
      <div className="sticky top-0 z-10 flex h-11 shrink-0 items-center gap-0.5 bg-bg/90 px-3 text-sm backdrop-blur">
        {crumbs.map((c, i) => (
          <span key={i} className="flex min-w-0 items-center gap-0.5">
            {i > 0 && <span className="px-0.5 text-faint">/</span>}
            {c.to ? (
              <Link to={c.to} className="truncate rounded px-1.5 py-0.5 hover:bg-hover">
                {c.label}
              </Link>
            ) : (
              <span className="truncate px-1.5 py-0.5">{c.label}</span>
            )}
          </span>
        ))}
        <div className="ml-auto flex items-center gap-1">{actions}</div>
      </div>
      <div className={cx("mx-auto w-full px-5 pt-4 pb-24 md:px-16 md:pt-10", wide ? "max-w-6xl" : "max-w-[860px]")}>{children}</div>
    </div>
  );
}

export function Title({ icon, children }: { icon?: string; children: ReactNode }) {
  return (
    <div className="mb-1">
      {icon && <div className="mb-3 text-[44px] leading-none">{icon}</div>}
      <h1 className="text-[30px] leading-tight font-bold tracking-[-0.01em] md:text-[38px]">{children}</h1>
    </div>
  );
}

export function H3({ children, className }: { children: ReactNode; className?: string }) {
  return <h3 className={cx("mt-9 mb-2 text-lg font-semibold", className)}>{children}</h3>;
}

export function Divider() {
  return <div className="my-4 h-px bg-line" />;
}

/** Notion page properties: label column on the left, value on the right. */
export function Props({ children }: { children: ReactNode }) {
  return <div className="my-3 grid grid-cols-[124px_minmax(0,1fr)] gap-y-0.5 text-sm md:grid-cols-[160px_minmax(0,1fr)]">{children}</div>;
}

export function Prop({ icon, label, children }: { icon: string; label: string; children: ReactNode }) {
  return (
    <>
      <div className="flex h-8 items-center gap-2 text-subtle">
        <span className="w-4 text-center text-xs text-faint">{icon}</span>
        {label}
      </div>
      <div className="flex min-h-8 min-w-0 flex-wrap items-center gap-1.5">{children}</div>
    </>
  );
}

/** A view switcher row above a list or table. */
export function Views<T extends string>({ value, options, onChange, children }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void; children?: ReactNode }) {
  return (
    <div className="mt-6 flex items-center gap-1 border-b border-line pb-1.5">
      {options.map((o) => (
        <button key={o.id} onClick={() => onChange(o.id)} className={cx("h-7 rounded-md px-2 text-sm", value === o.id ? "bg-hover font-medium" : "text-subtle hover:bg-hover")}>
          {o.label}
        </button>
      ))}
      <div className="ml-auto flex items-center gap-1">{children}</div>
    </div>
  );
}

export function SettingRow({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-6 border-b border-line py-3.5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="text-sm">{label}</div>
        {hint && <div className="text-[13px] text-subtle">{hint}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

export function Callout({ icon = "💡", tone = "gray", children }: { icon?: string; tone?: "gray" | "red" | "yellow" | "blue"; children: ReactNode }) {
  const bg = { gray: "bg-code", red: "bg-tag-red/60", yellow: "bg-tag-yellow/60", blue: "bg-tag-blue/60" }[tone];
  return (
    <div className={cx("my-2 flex gap-2.5 rounded-md px-4 py-3 text-sm", bg)}>
      <span className="leading-5">{icon}</span>
      <div className="min-w-0 flex-1 leading-5">{children}</div>
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <Callout icon="⚠️" tone="red">
      {msg}
    </Callout>
  );
}

export function CopyBlock({ text, label, maxHeight = "20rem" }: { text: string; label?: string; maxHeight?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group relative my-2 rounded-md bg-code">
      <div className="flex h-9 items-center gap-2 px-4 text-xs text-faint">
        <span className="truncate">{label}</span>
        <Button
          className="ml-auto h-6 px-2 text-xs"
          onClick={async () => {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="overflow-auto px-4 pb-4 font-mono text-[12.5px] leading-relaxed break-words whitespace-pre-wrap" style={{ maxHeight }}>
        {text}
      </pre>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="py-14 text-center">
      <p className="text-sm font-medium">{title}</p>
      {children && <div className="mx-auto mt-1 max-w-sm text-sm text-subtle">{children}</div>}
    </div>
  );
}

export function Loading() {
  return <p className="p-6 text-sm text-faint">Loading…</p>;
}

export function Modal({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-30 grid place-items-start justify-center overflow-y-auto bg-black/40 px-4 pt-[12vh] pb-8" onMouseDown={onClose}>
      <div className="w-full max-w-xl rounded-lg bg-bg p-6 shadow-[0_0_0_1px_var(--line),0_12px_40px_rgba(0,0,0,0.18)]" onMouseDown={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

// ---- time

export function timeAgo(t: number | string | null): string {
  if (!t) return "Never";
  const at = typeof t === "string" ? Date.parse(t) : t;
  const ms = Date.now() - at;
  if (ms < 45_000) return "Just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h ago`;
  if (ms < 2 * 86_400_000) return "Yesterday";
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function clock(t: number | string): string {
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function duration(ms: number): string {
  if (ms < 1000) return "under a second";
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.round(ms / 3_600_000)} h`;
}

// ---- live events: one shared socket for the whole app

type Listener = (e: LiveEvent) => void;
const listeners = new Set<Listener>();
const connectionListeners = new Set<(c: boolean) => void>();
let socket: WebSocket | null = null;
let socketUp = false;
let users = 0;
let retry = 1000;
let pinger: ReturnType<typeof setInterval> | undefined;

function setUp(v: boolean) {
  socketUp = v;
  connectionListeners.forEach((l) => l(v));
}

function openSocket() {
  if (socket) return;
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/live`);
  socket = ws;
  ws.onopen = () => {
    retry = 1000;
    setUp(true);
  };
  ws.onmessage = (ev) => {
    let event: LiveEvent;
    try {
      event = JSON.parse(ev.data);
    } catch {
      return; // ignore malformed frames
    }
    listeners.forEach((l) => l(event));
  };
  ws.onclose = () => {
    socket = null;
    setUp(false);
    if (users > 0) setTimeout(() => users > 0 && openSocket(), (retry = Math.min(retry * 2, 15_000)));
  };
  pinger ??= setInterval(() => socket?.readyState === 1 && socket.send('{"type":"ping"}'), 30_000);
}

/** Subscribe to the hub's live event feed. Returns whether the feed is connected. */
export function useLive(onEvent: (e: LiveEvent) => void) {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const [connected, setConnected] = useState(socketUp);
  useEffect(() => {
    const l: Listener = (e) => handler.current(e);
    listeners.add(l);
    connectionListeners.add(setConnected);
    users++;
    openSocket();
    setConnected(socketUp);
    return () => {
      listeners.delete(l);
      connectionListeners.delete(setConnected);
      users--;
    };
  }, []);
  return connected;
}

// ---- domain labels

export const runtimeLabel: Record<string, string> = {
  grok: "Grok Bot",
  hermes: "Hermes",
  mcp: "MCP client",
  api: "API",
  owner: "Owner",
};

export const runtimeTone: Record<string, Tone> = { grok: "blue", hermes: "purple", mcp: "gray", api: "orange", owner: "gray" };

export function deliveryState(a: Agent): { label: string; tone: Tone } {
  if (a.status === "revoked") return { label: "Revoked", tone: "red" };
  if (a.status === "paused") return { label: "Paused", tone: "yellow" };
  if (a.status === "pending") return { label: "Pending", tone: "yellow" };
  if (a.delivery.method === "connector") return a.delivery.connected ? { label: "Connected", tone: "green" } : { label: "Offline", tone: "red" };
  if (a.delivery.method === "webhook") return { label: "Webhook", tone: "green" };
  if (a.runtime === "grok") return { label: "Needs webhook", tone: "yellow" };
  return { label: "Inbox", tone: "gray" };
}

export function messageState(m: Message): { label: string; tone: Tone } {
  if (m.status === "failed") return { label: "Failed", tone: "red" };
  if (m.status === "expired") return { label: "Expired", tone: "yellow" };
  if (m.kind === "reply") return { label: m.late ? "Replied late" : "Replied", tone: "green" };
  if (m.kind === "request") return m.status === "completed" ? { label: "Replied", tone: "green" } : { label: "Waiting", tone: "blue" };
  return { label: m.status === "read" ? "Read" : m.status === "queued" ? "Queued" : "Delivered", tone: "gray" };
}
