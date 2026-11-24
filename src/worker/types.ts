// Shared shapes between the Worker, the Hub Durable Object and the UI.

export type Runtime = "grok" | "hermes" | "mcp" | "api" | "owner";
export type AgentStatus = "pending" | "active" | "paused" | "revoked";
export type Trust = "verified" | "self_declared";
export type DeliveryMethod = "none" | "webhook" | "connector" | "ui";
export type MessageKind = "request" | "notify" | "reply";
export type MessageStatus = "queued" | "delivered" | "completed" | "failed" | "expired" | "read";

/** Who is calling the hub, as established by the Worker before any DO call. */
export type Principal =
  | { kind: "owner" }
  | { kind: "credential"; tokenHash: string }
  | { kind: "grant"; grantId: string };

export interface AgentRow {
  handle: string;
  name: string;
  description: string;
  runtime: Runtime;
  status: AgentStatus;
  trust: Trust;
  grant_id: string | null;
  delivery_method: DeliveryMethod;
  delivery_preset: string | null;
  delivery_url: string | null;
  delivery_secret: string | null;
  pending_delivery: string | null;
  can_send: number;
  can_receive: number;
  hidden: number;
  inbox_cursor: number;
  created_at: number;
  last_seen_at: number | null;
  connected_at: number | null;
}

/** What other agents see in the directory. */
export interface DirectoryEntry {
  handle: string;
  name: string;
  description: string;
  runtime: Runtime;
  trust: Trust;
  can_receive: boolean;
}

/** What the owner sees. Never includes stored secrets. */
export interface OwnerAgentView extends DirectoryEntry {
  status: AgentStatus;
  grant_id: string | null;
  delivery: {
    method: DeliveryMethod;
    preset: string | null;
    url: string | null;
    has_secret: boolean;
    connected: boolean;
    pending: { method: DeliveryMethod; preset?: string; url?: string } | null;
  };
  can_send: boolean;
  hidden: boolean;
  created_at: number;
  last_seen_at: number | null;
}

export interface MessageRow {
  seq: number;
  id: string;
  kind: MessageKind;
  thread: string;
  from_handle: string;
  to_handle: string;
  body: string;
  reply_to: string | null;
  chain: string;
  status: MessageStatus;
  reply_token: string | null;
  deadline_at: number | null;
  created_at: number;
  completed_at: number | null;
  read_at: number | null;
  late: number;
  error: string | null;
}

export interface MessageView {
  seq: number;
  id: string;
  kind: MessageKind;
  thread: string;
  from: string;
  to: string;
  message: string;
  reply_to: string | null;
  status: MessageStatus;
  deadline_at: string | null;
  created_at: string;
  completed_at: string | null;
  late: boolean;
  error: string | null;
  /** For requests: the agents already waiting upstream when this was sent (the chain it belongs to). */
  via: string[];
}

/** Result of `send` and `check`, shaped like an MCP Tasks handle. */
export interface TaskResult {
  task_id: string;
  thread: string;
  status: MessageStatus;
  to: string;
  result?: string;
  from?: string;
  late?: boolean;
  error?: string;
  deadline_at?: string | null;
  poll_interval_seconds?: number;
  hint?: string;
}

export interface InviteView {
  id: string;
  runtime: Runtime;
  handle: string | null;
  name: string;
  expires_at: number;
  used_at: number | null;
  used_by: string | null;
}

export type LiveEvent =
  | { type: "message"; message: MessageView }
  | { type: "agent"; agent: OwnerAgentView }
  | { type: "agent_removed"; handle: string }
  | { type: "settings" }
  | { type: "invite"; invite: InviteView };
