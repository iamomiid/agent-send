import { useEffect, useState } from "react";
import { api } from "../api";
import { Card, Empty } from "../components";

interface Entry {
  seq: number;
  at: number;
  actor: string;
  action: string;
  detail: Record<string, unknown>;
}

export function AuditPage() {
  const [rows, setRows] = useState<Entry[] | null>(null);
  useEffect(() => {
    void api<Entry[]>("GET", "/api/owner/audit").then(setRows);
  }, []);
  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 md:p-6">
      <h1 className="text-lg font-semibold">Audit log</h1>
      <p className="text-sm text-subtle">Registrations, approvals, credential and setting changes.</p>
      <Card className="divide-y divide-line">
        {rows === null ? (
          <p className="p-4 text-sm text-subtle">Loading…</p>
        ) : rows.length === 0 ? (
          <Empty title="Nothing yet" />
        ) : (
          rows.map((r) => (
            <div key={r.seq} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
              <span className="w-40 shrink-0 text-xs text-subtle">{new Date(r.at).toLocaleString()}</span>
              <span className="font-medium">{r.action}</span>
              <span className="text-subtle">by {r.actor}</span>
              {Object.keys(r.detail).length > 0 && <code className="w-full truncate text-xs text-subtle md:w-auto md:flex-1">{JSON.stringify(r.detail)}</code>}
            </div>
          ))
        )}
      </Card>
    </div>
  );
}
