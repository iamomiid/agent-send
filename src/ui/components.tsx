import { useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import type { LiveEvent } from "./api";

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "ghost" | "danger";
export function Button({ variant = "secondary", className, busy, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  const styles: Record<Variant, string> = {
    primary: "bg-accent text-accent-fg hover:opacity-90",
    secondary: "bg-panel border border-line hover:bg-muted",
    ghost: "hover:bg-muted",
    danger: "bg-panel border border-red-300 text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950",
  };
  return (
    <button
      className={cx("inline-flex items-center justify-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50", styles[variant], className)}
      disabled={busy || rest.disabled}
      {...rest}
    >
      {busy && <span className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" />}
      {children}
    </button>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx("w-full rounded-md border border-line bg-panel px-3 py-2 text-sm outline-none focus:border-accent", props.className)} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx("w-full rounded-md border border-line bg-panel px-3 py-2 text-sm outline-none focus:border-accent", props.className)} />;
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="block text-xs text-subtle">{hint}</span>}
    </label>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("rounded-lg border border-line bg-panel", className)}>{children}</div>;
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "green" | "amber" | "red" | "blue" }) {
  const tones = {
    neutral: "bg-muted text-subtle",
    green: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
    amber: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
    red: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
    blue: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300",
  };
  return <span className={cx("inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium", tones[tone])}>{children}</span>;
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{msg}</p>;
}

export function CopyBlock({ text, rows = 10 }: { text: string; rows?: number }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <textarea readOnly value={text} rows={rows} className="w-full resize-y rounded-md border border-line bg-muted p-3 pr-20 font-mono text-xs leading-relaxed" />
      <Button
        className="absolute top-2 right-2"
        onClick={async () => {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
      <p className="font-medium">{title}</p>
      {children && <div className="max-w-sm text-sm text-subtle">{children}</div>}
    </div>
  );
}

export function timeAgo(t: number | string | null): string {
  if (!t) return "never";
  const ms = Date.now() - (typeof t === "string" ? Date.parse(t) : t);
  if (ms < 45_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h ago`;
  return new Date(typeof t === "string" ? Date.parse(t) : t).toLocaleDateString();
}

/** Subscribe to the hub's live event feed (reconnects automatically). */
export function useLive(onEvent: (e: LiveEvent) => void) {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let ws: WebSocket | null = null;
    let stopped = false;
    let retry = 1000;
    const open = () => {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/live`);
      ws.onopen = () => {
        setConnected(true);
        retry = 1000;
      };
      ws.onmessage = (ev) => {
        try {
          handler.current(JSON.parse(ev.data));
        } catch {
          // ignore malformed frames
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (!stopped) setTimeout(open, (retry = Math.min(retry * 2, 15_000)));
      };
    };
    open();
    const ping = setInterval(() => ws?.readyState === 1 && ws.send('{"type":"ping"}'), 30_000);
    return () => {
      stopped = true;
      clearInterval(ping);
      ws?.close();
    };
  }, []);
  return connected;
}

export function statusTone(status: string): "neutral" | "green" | "amber" | "red" | "blue" {
  if (status === "completed" || status === "read" || status === "active") return "green";
  if (status === "failed" || status === "revoked") return "red";
  if (status === "expired" || status === "paused" || status === "pending") return "amber";
  if (status === "delivered") return "blue";
  return "neutral";
}

export const runtimeLabel: Record<string, string> = {
  grok: "Grok Bot",
  hermes: "Hermes",
  mcp: "MCP client",
  api: "API",
  owner: "Owner",
};
