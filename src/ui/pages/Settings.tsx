import { useEffect, useState } from "react";
import { addPasskey, api, deviceLabel, type Settings } from "../api";
import { Button, Callout, ErrorNote, Input, Loading, Page, SettingRow, Tag, Title, Toggle, Views, cx, timeAgo } from "../components";
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

type Section = "messaging" | "storage" | "connectors" | "connections" | "passkeys";
const SECTIONS: { id: Section; label: string }[] = [
  { id: "messaging", label: "Messaging" },
  { id: "storage", label: "Storage" },
  { id: "connectors", label: "Connectors" },
  { id: "connections", label: "Connections" },
  { id: "passkeys", label: "Passkeys" },
];

export function SettingsPage({ status }: { status: OwnerStatus }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [section, setSection] = useState<Section>("messaging");
  const [saved, setSaved] = useState(false);

  const load = () => {
    void api<Settings>("GET", "/api/owner/settings").then(setSettings);
    void api<Stats>("GET", "/api/owner/stats").then(setStats);
    void api<Passkey[]>("GET", "/api/owner/passkeys").then(setPasskeys);
    void api<Grant[]>("GET", "/api/owner/grants").then(setGrants);
  };
  useEffect(load, []);
  if (!settings) return <Loading />;

  const save = async (patch: Partial<Settings>) => {
    setError(null);
    try {
      setSettings(await api<Settings>("PATCH", "/api/owner/settings", patch));
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setError(e);
    }
  };
  const num = (key: keyof Settings, label: string, hint: string) => (
    <SettingRow key={key} label={label} hint={hint}>
      <NumberInput value={settings[key] as number} onSave={(v) => save({ [key]: v })} />
    </SettingRow>
  );

  return (
    <Page crumbs={[{ label: "⚙️ Settings" }]} actions={saved && <span className="px-2 text-xs text-faint">Saved</span>}>
      <Title icon="⚙️">Settings</Title>
      {stats && newer(stats.latest_version, stats.version) && (
        <Callout icon="✨" tone="blue">
          Update available: <strong>v{stats.latest_version}</strong> (you run v{stats.version}).{" "}
          <a className="underline" href="https://github.com/iamomiid/agent-send#updating" target="_blank" rel="noreferrer">
            How to update
          </a>
        </Callout>
      )}
      <div className="md:hidden">
        <Views value={section} onChange={setSection} options={SECTIONS} />
      </div>
      <div className="mt-6 flex gap-10">
        <nav className="hidden w-36 shrink-0 flex-col gap-0.5 md:flex">
          {SECTIONS.map((s) => (
            <button key={s.id} onClick={() => setSection(s.id)} className={cx("h-[30px] rounded-md px-2 text-left text-sm", section === s.id ? "bg-hover font-medium" : "text-subtle hover:bg-hover")}>
              {s.label}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1">
          <h2 className="border-b border-line pb-3 text-base font-semibold">{SECTIONS.find((s) => s.id === section)!.label}</h2>
          <ErrorNote error={error} />

          {section === "messaging" && (
            <>
              <SettingRow label="Pause hub" hint="Stops all deliveries and rejects new messages until you turn it off.">
                <Toggle label="Pause hub" checked={settings.paused} onChange={(v) => void save({ paused: v })} />
              </SettingRow>
              {num("default_deadline_seconds", "Default deadline", "How long a request waits for a reply, in seconds.")}
              {num("max_deadline_seconds", "Longest deadline", "The most an agent can ask for, in seconds.")}
              {num("hop_limit", "Hop limit", "How many agents one chain of requests may span.")}
              {num("max_open_requests", "Open requests per agent", "Unanswered requests an agent can have at once.")}
              {num("max_messages_per_day", "Messages per agent per day", "Sends over the cap are rejected.")}
              {num("tool_calls_per_minute", "Tool calls per minute", "Per agent.")}
              {num("deliveries_per_minute", "Deliveries per minute", "Per recipient.")}
            </>
          )}

          {section === "storage" && (
            <>
              <SettingRow label="Delete old messages" hint="Removes messages older than the number of days below.">
                <Toggle label="Delete old messages" checked={settings.retention_days > 0} onChange={(v) => void save({ retention_days: v ? 90 : 0 })} />
              </SettingRow>
              {settings.retention_days > 0 && num("retention_days", "Keep messages for", "In days.")}
              {stats && (
                <SettingRow label="Usage" hint={`${stats.messages} messages and ${stats.agents} agents.`}>
                  <span className="text-sm text-subtle">{(stats.database_bytes / 1024 / 1024).toFixed(1)} MB</span>
                  {stats.database_bytes > DO_LIMIT_BYTES * 0.8 && <Tag tone="yellow">Near the limit</Tag>}
                </SettingRow>
              )}
            </>
          )}

          {section === "connectors" && (
            <>
              <SettingRow label="Hermes plugin source" hint="Where Hermes setup prompts install the plugin from: owner/repo, a Git URL, or an absolute path on the agent's machine.">
                <TextInput value={settings.hermes_plugin_source} onSave={(v) => save({ hermes_plugin_source: v })} />
              </SettingRow>
              <SettingRow label="Check for updates" hint="Looks for a new release once a day.">
                <Toggle label="Check for updates" checked={settings.update_check} onChange={(v) => void save({ update_check: v })} />
              </SettingRow>
            </>
          )}

          {section === "connections" &&
            (grants.length === 0 ? (
              <p className="py-4 text-sm text-subtle">None yet. MCP clients and Grok accounts appear here after you approve them.</p>
            ) : (
              grants.map((g) => (
                <SettingRow
                  key={g.id}
                  label={
                    <>
                      {g.client_name} {g.client_domain && <span className="text-faint">{g.client_domain}</span>}
                    </>
                  }
                  hint={`${g.mode === "multi" ? "Shared" : "One agent"} · ${g.agents.join(", ") || "no agents yet"}`}
                >
                  {g.status === "active" ? (
                    <Button variant="danger" onClick={() => api("POST", `/api/owner/grants/${g.id}/revoke`, {}).then(load, setError)}>
                      Revoke
                    </Button>
                  ) : (
                    <Tag>{g.status}</Tag>
                  )}
                </SettingRow>
              ))
            ))}

          {section === "passkeys" && (
            <>
              <p className="py-3 text-[13px] text-subtle">Passkeys work only on the address they were created on. This one is {status.rpId}.</p>
              {passkeys.map((p) => (
                <SettingRow key={p.id} label={p.label} hint={`${p.rp_id} · last used ${timeAgo(p.last_used_at).toLowerCase()}`}>
                  {passkeys.length > 1 && (
                    <Button variant="ghost" onClick={() => api("DELETE", `/api/owner/passkeys/${encodeURIComponent(p.id)}`).then(load, setError)}>
                      Remove
                    </Button>
                  )}
                </SettingRow>
              ))}
              <div className="pt-4">
                <Button onClick={() => addPasskey(deviceLabel()).then(load, setError)}>Add a passkey</Button>
              </div>
            </>
          )}
        </div>
      </div>
    </Page>
  );
}

/** Saves when you leave the field or press Enter. */
function NumberInput({ value, onSave }: { value: number; onSave: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Number(draft);
    if (Number.isFinite(n) && n >= 0 && n !== value) onSave(n);
    else setDraft(String(value));
  };
  return <Input type="number" min={0} className="text-right" style={{ width: 88 }} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />;
}

function TextInput({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <Input
      className="font-mono text-[13px]" style={{ width: 240 }}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => (draft.trim() && draft.trim() !== value ? onSave(draft.trim()) : setDraft(value))}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
    />
  );
}
