// Browser-side API client for the owner UI.

import { startAuthentication, startRegistration } from "@simplewebauthn/browser";

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function raw<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: { "x-agent-send": "1", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(data?.error ?? "error", data?.message ?? `Request failed (${res.status})`, res.status);
  return data as T;
}

/** Confirm with a passkey (step-up) for sensitive actions. */
export async function stepUp(): Promise<void> {
  const { challengeId, options } = await raw<{ challengeId: string; options: never }>("POST", "/api/owner/stepup/begin", {});
  const response = await startAuthentication({ optionsJSON: options });
  await raw("POST", "/api/owner/stepup/finish", { challengeId, response });
}

/** Call the API; if it asks for a fresh passkey, confirm and retry once. */
export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  try {
    return await raw<T>(method, path, body);
  } catch (e) {
    if (e instanceof ApiError && e.code === "step_up_required") {
      await stepUp();
      return raw<T>(method, path, body);
    }
    throw e;
  }
}

export async function setupWithPasskey(code: string, label: string) {
  const { challengeId, options } = await raw<{ challengeId: string; options: never }>("POST", "/api/owner/setup/begin", { code });
  const response = await startRegistration({ optionsJSON: options });
  await raw("POST", "/api/owner/setup/finish", { challengeId, response, label });
}

export async function loginWithPasskey() {
  const { challengeId, options } = await raw<{ challengeId: string; options: never }>("POST", "/api/owner/login/begin", {});
  const response = await startAuthentication({ optionsJSON: options });
  await raw("POST", "/api/owner/login/finish", { challengeId, response });
}

export async function addPasskey(label: string) {
  const { challengeId, options } = await api<{ challengeId: string; options: never }>("POST", "/api/owner/passkeys/begin", {});
  const response = await startRegistration({ optionsJSON: options });
  await api("POST", "/api/owner/passkeys/finish", { challengeId, response, label });
}

export function deviceLabel(): string {
  const ua = navigator.userAgent;
  if (/iPhone|iPad/.test(ua)) return "iPhone or iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Mac/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  return "Passkey";
}

// ---- shared shapes (mirrors src/worker/types.ts)

export type Runtime = "grok" | "hermes" | "mcp" | "api" | "owner";

export interface Agent {
  handle: string;
  name: string;
  description: string;
  runtime: Runtime;
  trust: "verified" | "self_declared";
  can_receive: boolean;
  status: "pending" | "active" | "paused" | "revoked";
  grant_id: string | null;
  delivery: { method: "none" | "webhook" | "connector" | "ui"; preset: string | null; url: string | null; has_secret: boolean; connected: boolean; pending: unknown };
  can_send: boolean;
  hidden: boolean;
  created_at: number;
  last_seen_at: number | null;
}

export interface Message {
  seq: number;
  id: string;
  kind: "request" | "notify" | "reply";
  thread: string;
  from: string;
  to: string;
  message: string;
  reply_to: string | null;
  status: "queued" | "delivered" | "completed" | "failed" | "expired" | "read";
  deadline_at: string | null;
  created_at: string;
  completed_at: string | null;
  late: boolean;
  error: string | null;
}

export interface ThreadSummary {
  thread: string;
  participants: string[];
  count: number;
  last: Message;
}

export interface Settings {
  paused: boolean;
  hop_limit: number;
  default_deadline_seconds: number;
  max_deadline_seconds: number;
  tool_calls_per_minute: number;
  deliveries_per_minute: number;
  max_open_requests: number;
  max_messages_per_day: number;
  retention_days: number;
  update_check: boolean;
  hermes_plugin_source: string;
}

export type LiveEvent =
  | { type: "message"; message: Message }
  | { type: "agent"; agent: Agent }
  | { type: "settings" }
  | { type: "invite"; invite: unknown };
