// SQLite schema for the Hub Durable Object. Migrations are additive and
// idempotent: each entry runs once, in order, and is recorded in `meta`.

export const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE IF NOT EXISTS passkeys (
    id TEXT PRIMARY KEY,
    public_key TEXT NOT NULL,
    counter INTEGER NOT NULL,
    transports TEXT,
    rp_id TEXT NOT NULL,
    label TEXT,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    stepup_until INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS challenges (
    id TEXT PRIMARY KEY,
    challenge TEXT NOT NULL,
    kind TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agents (
    handle TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    runtime TEXT NOT NULL,
    status TEXT NOT NULL,
    trust TEXT NOT NULL,
    grant_id TEXT,
    delivery_method TEXT NOT NULL DEFAULT 'none',
    delivery_preset TEXT,
    delivery_url TEXT,
    delivery_secret TEXT,
    pending_delivery TEXT,
    can_send INTEGER NOT NULL DEFAULT 1,
    can_receive INTEGER NOT NULL DEFAULT 1,
    hidden INTEGER NOT NULL DEFAULT 0,
    inbox_cursor INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    connected_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS agents_grant ON agents(grant_id);

  CREATE TABLE IF NOT EXISTS credentials (
    hash TEXT PRIMARY KEY,
    handle TEXT NOT NULL,
    kind TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER,
    last_used_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS credentials_handle ON credentials(handle);

  CREATE TABLE IF NOT EXISTS grants (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    client_name TEXT NOT NULL,
    client_domain TEXT,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS invites (
    code_hash TEXT PRIMARY KEY,
    id TEXT NOT NULL,
    runtime TEXT NOT NULL,
    handle TEXT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    used_by TEXT
  );

  CREATE TABLE IF NOT EXISTS messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    thread TEXT NOT NULL,
    from_handle TEXT NOT NULL,
    to_handle TEXT NOT NULL,
    body TEXT NOT NULL,
    reply_to TEXT,
    chain TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL,
    reply_token TEXT,
    deadline_at INTEGER,
    created_at INTEGER NOT NULL,
    completed_at INTEGER,
    read_at INTEGER,
    late INTEGER NOT NULL DEFAULT 0,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS messages_to ON messages(to_handle, seq);
  CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread, seq);
  CREATE INDEX IF NOT EXISTS messages_open ON messages(status, deadline_at);
  CREATE INDEX IF NOT EXISTS messages_reply_to ON messages(reply_to);

  CREATE TABLE IF NOT EXISTS deliveries (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    target TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_at INTEGER,
    give_up_at INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries(status, next_at);
  CREATE INDEX IF NOT EXISTS deliveries_message ON deliveries(message_id);

  CREATE TABLE IF NOT EXISTS audit (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '{}'
  );
  `,
];

export interface Settings {
  paused: boolean;
  hop_limit: number;
  default_deadline_seconds: number;
  max_deadline_seconds: number;
  tool_calls_per_minute: number;
  deliveries_per_minute: number;
  max_open_requests: number;
  max_messages_per_day: number;
  retention_days: number; // 0 = keep forever
  update_check: boolean;
  hermes_plugin_source: string; // `owner/repo`, Git URL, or an absolute local path
}

export const DEFAULT_SETTINGS: Settings = {
  paused: false,
  hop_limit: 4,
  default_deadline_seconds: 300,
  max_deadline_seconds: 3600,
  tool_calls_per_minute: 60,
  deliveries_per_minute: 20,
  max_open_requests: 50,
  max_messages_per_day: 1000,
  retention_days: 0,
  update_check: true,
  hermes_plugin_source: "iamomiid/agent-send-hermes",
};

export const MAX_MESSAGE_BYTES = 32 * 1024;
