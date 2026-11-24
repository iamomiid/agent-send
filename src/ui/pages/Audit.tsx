import { useEffect, useState } from "react";
import { api } from "../api";
import { Empty, Loading, Page, Title, cx } from "../components";

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
  const th = "border-b border-line px-2 py-1.5 text-left font-normal text-subtle whitespace-nowrap";
  const td = "border-b border-line px-2 py-2 align-top";
  return (
    <Page crumbs={[{ label: "📜 Audit log" }]}>
      <Title icon="📜">Audit log</Title>
      <p className="mb-6 text-sm text-subtle">Sign-ins, approvals, and changes to agents, credentials and settings.</p>
      {rows === null ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Empty title="Nothing yet" />
      ) : (
        <table className="w-full table-fixed border-collapse text-sm">
          <thead>
            <tr>
              <th className={cx(th, "w-36")}>
                <span className="mr-1.5 text-xs text-faint">◷</span>When
              </th>
              <th className={cx(th, "w-48")}>
                <span className="mr-1.5 text-xs text-faint">Aa</span>Action
              </th>
              <th className={cx(th, "hidden w-28 sm:table-cell")}>
                <span className="mr-1.5 text-xs text-faint">☺</span>By
              </th>
              <th className={cx(th, "hidden md:table-cell")}>
                <span className="mr-1.5 text-xs text-faint">≡</span>Details
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.seq}>
                <td className={cx(td, "text-subtle")}>{new Date(r.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
                <td className={cx(td, "truncate")}>{r.action}</td>
                <td className={cx(td, "hidden truncate text-subtle sm:table-cell")}>{r.actor}</td>
                <td className={cx(td, "hidden truncate font-mono text-xs text-faint md:table-cell")} title={JSON.stringify(r.detail)}>
                  {Object.keys(r.detail).length ? JSON.stringify(r.detail) : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Page>
  );
}
