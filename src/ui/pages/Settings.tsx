import { useEffect, useState } from "react";
import { addPasskey, api, deviceLabel, type Settings } from "../api";
import { Badge, Button, Card, ErrorNote, Field, Input } from "../components";
import type { OwnerStatus } from "../main";

interface Stats {
  database_bytes: number;
  messages: number;
  agents: number;
  failed: number;
  version: string;
  latest_version: string | null;
}
interface Passkey {
  id: string;
  label: string;
  rp_id: string;
  created_at: number;
  last_used_at: number | null;
}
interface Grant {
  id: string;
  client_name: string;
  client_domain: string | null;
  mode: string;
  status: string;
  agents: string[];
}

const DO_LIMIT_BYTES = 1024 ** 3; // the Free plan's per-object limit; Paid allows more

function newer(latest: string | null, current: string) {
  if (!latest) return false;
  const a = latest.split(".").map(Number);
  const b = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}

export function SettingsPage({ status }: { status: OwnerStatus }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);

  const load = () => {
    void api<Settings>("GET", "/api/owner/settings").then((s) => {
      setSettings(s);
      setDraft(s);
    });
    void api<Stats>("GET", "/api/owner/stats").then(setStats);
    void api<Passkey[]>("GET", "/api/owner/passkeys").then(setPasskeys);
    void api<Grant[]>("GET", "/api/owner/grants").then(setGrants);
  };
  useEffect(load, []);
  if (!settings || !draft) return <p className="p-6 text-sm text-subtle">Loading…</p>;

  const save = async (patch: Partial<Settings>) => {
    setError(null);
    try {
      const s = await api<Settings>("PATCH", "/api/owner/settings", patch);
      setSettings(s);
      setDraft(s);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setError(e);
    }
  };
  const num = (key: keyof Settings, label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <Input type="number" min={0} value={draft[key] as number} onChange={(e) => setDraft({ ...draft, [key]: Number(e.target.value) })} />
    </Field>
  );

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4 md:p-6">
      <h1 className="text-lg font-semibold">Settings</h1>
      <ErrorNote error={error} />

      {stats && newer(stats.latest_version, stats.version) && (
        <Card className="flex items-center justify-between gap-3 border-accent p-4">
          <p className="text-sm">
            Update available: <strong>v{stats.latest_version}</strong> (you run v{stats.version}).
          </p>
          <a className="text-sm underline" href="https://github.com/iamomiid/agent-send/blob/main/docs/updating.md" target="_blank" rel="noreferrer">
            How to update
          </a>
        </Card>
      )}

      <Card className="flex items-center justify-between gap-3 p-5">
        <div>
          <h2 className="font-medium">Pause hub</h2>
          <p className="text-sm text-subtle">Stops all deliveries and rejects new messages until you resume.</p>
        </div>
        <Button variant={settings.paused ? "primary" : "danger"} onClick={() => save({ paused: !settings.paused })}>
          {settings.paused ? "Resume" : "Pause"}
        </Button>
      </Card>

      <Card className="space-y-4 p-5">
        <h2 className="font-medium">Messaging and limits</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {num("hop_limit", "Hop limit", "How many agents one chain of requests may span.")}
          {num("default_deadline_seconds", "Default deadline (s)")}
          {num("max_deadline_seconds", "Maximum deadline (s)")}
          {num("tool_calls_per_minute", "Tool calls per minute, per agent")}
          {num("deliveries_per_minute", "Deliveries per minute, per recipient")}
          {num("max_open_requests", "Open requests per agent")}
          {num("max_messages_per_day", "Messages per day, per agent")}
        </div>
        <div className="flex items-center justify-end gap-2">
          {saved && <span className="text-sm text-subtle">Saved</span>}
          <Button variant="primary" onClick={() => save(draft)}>
            Save
          </Button>
        </div>
      </Card>

      <Card className="space-y-4 p-5">
        <h2 className="font-medium">Retention and storage</h2>
        <label className="flex items-center justify-between text-sm">
          <span>Delete old messages automatically</span>
          <input type="checkbox" className="size-4" checked={settings.retention_days > 0} onChange={(e) => save({ retention_days: e.target.checked ? 90 : 0 })} />
        </label>
        {settings.retention_days > 0 && (
          <div className="flex items-end gap-2">
            <Field label="Keep messages for (days)">
              <Input type="number" min={1} value={draft.retention_days} onChange={(e) => setDraft({ ...draft, retention_days: Number(e.target.value) })} />
            </Field>
            <Button onClick={() => save({ retention_days: Math.max(1, draft.retention_days) })}>Save</Button>
          </div>
        )}
        {stats && (
          <p className="text-sm text-subtle">
            {stats.messages} messages, {stats.agents} agents, {(stats.database_bytes / 1024 / 1024).toFixed(1)} MB used
            {stats.database_bytes > DO_LIMIT_BYTES * 0.8 && <Badge tone="amber">near the storage limit</Badge>}
          </p>
        )}
      </Card>

      <Card className="space-y-3 p-5">
        <h2 className="font-medium">Connectors</h2>
        <Field label="Hermes plugin source" hint="Where the Hermes setup prompt installs the plugin from: owner/repo, a Git URL, or an absolute path on the agent's machine.">
          <Input value={draft.hermes_plugin_source} onChange={(e) => setDraft({ ...draft, hermes_plugin_source: e.target.value })} />
        </Field>
        <label className="flex items-center justify-between text-sm">
          <span>Check daily for new releases</span>
          <input type="checkbox" className="size-4" checked={settings.update_check} onChange={(e) => save({ update_check: e.target.checked })} />
        </label>
        <div className="flex justify-end">
          <Button onClick={() => save({ hermes_plugin_source: draft.hermes_plugin_source.trim() })}>Save</Button>
        </div>
      </Card>

      <Card className="space-y-3 p-5">
        <h2 className="font-medium">OAuth connections</h2>
        {grants.length === 0 ? (
          <p className="text-sm text-subtle">None yet. MCP clients appear here after you approve them.</p>
        ) : (
          grants.map((g) => (
            <div key={g.id} className="flex items-center justify-between gap-3 text-sm">
              <div>
                <span className="font-medium">{g.client_name}</span> <span className="text-subtle">{g.client_domain}</span>
                <p className="text-xs text-subtle">
                  {g.mode === "multi" ? "Shared" : "Single agent"} · {g.agents.join(", ") || "no agents"} · {g.status}
                </p>
              </div>
              {g.status === "active" && (
                <Button variant="danger" onClick={() => api("POST", `/api/owner/grants/${g.id}/revoke`, {}).then(load, setError)}>
                  Revoke
                </Button>
              )}
            </div>
          ))
        )}
      </Card>

      <Card className="space-y-3 p-5">
        <h2 className="font-medium">Passkeys</h2>
        <p className="text-sm text-subtle">Passkeys work on the address they were created on (this one: {status.rpId}).</p>
        {passkeys.map((p) => (
          <div key={p.id} className="flex items-center justify-between text-sm">
            <span>
              {p.label} <span className="text-subtle">· {p.rp_id}</span>
            </span>
            {passkeys.length > 1 && (
              <Button variant="ghost" onClick={() => api("DELETE", `/api/owner/passkeys/${encodeURIComponent(p.id)}`).then(load, setError)}>
                Remove
              </Button>
            )}
          </div>
        ))}
        <Button onClick={() => addPasskey(deviceLabel()).then(load, setError)}>Add a passkey</Button>
      </Card>
    </div>
  );
}
