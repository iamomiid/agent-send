import { useEffect, useState } from "react";
import { api } from "../api";
import { Button, Callout, ErrorNote, Field, Input, Loading, Textarea, cx } from "../components";

interface ConsentInfo {
  details: { clientId: string; clientName: string; clientDomain?: string; redirectHost: string; redirectIsLoopback: boolean; scope: string[] };
  suggestedMode: "single" | "multi";
  sharedConnections: { id: string; client_name: string; agents: string[] }[];
}

function suggestHandle(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "agent";
}

export function ConsentPage() {
  const handle = new URLSearchParams(location.search).get("h") ?? "";
  const [info, setInfo] = useState<ConsentInfo | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [mode, setMode] = useState<"single" | "multi">("single");
  const [reuse, setReuse] = useState<string>("");
  const [agent, setAgent] = useState({ handle: "", name: "", description: "" });
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);

  useEffect(() => {
    api<ConsentInfo>("GET", `/api/owner/consent/${encodeURIComponent(handle)}`)
      .then((i) => {
        setInfo(i);
        setMode(i.suggestedMode);
        setReuse(i.sharedConnections[0]?.id ?? "");
        setAgent({ handle: suggestHandle(i.details.clientName), name: i.details.clientName, description: "" });
      })
      .catch(setError);
  }, [handle]);

  async function decide(decision: "approve" | "deny") {
    setBusy(decision);
    setError(null);
    try {
      const r = await api<{ redirectTo: string }>("POST", "/api/owner/consent", { handle, decision, mode, reuseGrant: mode === "multi" ? reuse || undefined : undefined, agent: mode === "single" ? agent : undefined });
      location.assign(r.redirectTo);
    } catch (e) {
      setError(e);
      setBusy(null);
    }
  }

  if (!info) {
    return (
      <div className="mx-auto max-w-[460px] px-5 py-16">{error ? <ErrorNote error={error} /> : <Loading />}</div>
    );
  }
  const d = info.details;
  return (
    <div className="grid min-h-full place-items-center px-5 py-10">
      <div className="w-full max-w-[460px] space-y-5">
        <div>
          <img src="/favicon.svg" alt="" className="mb-4 size-10 rounded-lg" />
          <h1 className="text-2xl font-bold">Connect {d.clientName} to your hub?</h1>
          <p className="mt-2 text-sm text-subtle">
            {d.clientDomain ? (
              <>
                Published by <strong className="text-fg">{d.clientDomain}</strong>.
              </>
            ) : (
              "This app registered itself; its name is not verified."
            )}{" "}
            Access goes to <strong className="text-fg">{d.redirectHost}</strong>.
          </p>
          {info.suggestedMode === "multi" && <Callout icon="💡">Grok Bot connectors sign in through Cursor, so a Grok connection shows up here as Cursor. Choose “Shared by several agents”.</Callout>}
          {d.redirectIsLoopback && <Callout icon="⚠️" tone="yellow">This sends access to an app on a computer. Continue only if you just started connecting from it.</Callout>}
        </div>

        <div className="space-y-1">
          {(["single", "multi"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={cx("flex w-full items-start gap-3 rounded-md px-3 py-2.5 text-left text-sm", mode === m ? "bg-hover" : "hover:bg-hover")}
            >
              <span className={cx("mt-0.5 grid size-4 shrink-0 place-items-center rounded-full", mode === m ? "bg-accent" : "shadow-[inset_0_0_0_1.5px_var(--faint)]")}>{mode === m && <span className="size-1.5 rounded-full bg-white" />}</span>
              <span>
                <span className="block font-medium">{m === "single" ? "One agent" : "Shared by several agents"}</span>
                <span className="text-[13px] text-subtle">{m === "single" ? "This connection is one agent with its own identity." : "For Grok: every Bot on the account joins with its own invite."}</span>
              </span>
            </button>
          ))}
        </div>

        {mode === "single" ? (
          <div className="space-y-3">
            <Field label="Handle" hint="Permanent. Lowercase letters, digits and hyphens.">
              <Input value={agent.handle} onChange={(e) => setAgent({ ...agent, handle: e.target.value })} />
            </Field>
            <Field label="Name">
              <Input value={agent.name} onChange={(e) => setAgent({ ...agent, name: e.target.value })} />
            </Field>
            <Field label="Description" hint="Shown to other agents so they know what this one does.">
              <Textarea rows={2} value={agent.description} onChange={(e) => setAgent({ ...agent, description: e.target.value })} />
            </Field>
          </div>
        ) : info.sharedConnections.length > 0 ? (
          <Field label="Connection" hint="Reconnecting an account keeps the Bots that already joined.">
            <select className="w-full rounded-md bg-field px-2.5 py-1.5 text-sm shadow-[inset_0_0_0_1px_var(--line)] outline-none" value={reuse} onChange={(e) => setReuse(e.target.value)}>
              {info.sharedConnections.map((g) => (
                <option key={g.id} value={g.id}>
                  Reconnect {g.client_name} ({g.agents.length ? g.agents.join(", ") : "no Bots yet"})
                </option>
              ))}
              <option value="">New shared connection</option>
            </select>
          </Field>
        ) : (
          <p className="text-sm text-subtle">After you approve, each Bot joins with its own invite from the Agents page.</p>
        )}

        <ErrorNote error={error} />
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" busy={busy === "deny"} disabled={!!busy} onClick={() => decide("deny")}>
            Deny
          </Button>
          <Button variant="primary" busy={busy === "approve"} disabled={!!busy} onClick={() => decide("approve")}>
            Approve with passkey
          </Button>
        </div>
      </div>
    </div>
  );
}
