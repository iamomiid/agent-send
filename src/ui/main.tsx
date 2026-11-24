import { StrictMode, useCallback, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { api } from "./api";
import { Avatar, Dot, Loading, cx, deliveryState, useLive } from "./components";
import { useAgents } from "./data";
import { AgentsPage } from "./pages/Agents";
import { AuditPage } from "./pages/Audit";
import { ConsentPage } from "./pages/Consent";
import { ConversationsPage } from "./pages/Conversations";
import { LoginPage, SetupPage } from "./pages/Auth";
import { SettingsPage } from "./pages/Settings";
import { Link, usePath } from "./router";
import "./styles.css";

export interface OwnerStatus {
  setupCodeConfigured: boolean;
  hasPasskeys: boolean;
  otherHostPasskeys: number;
  enrolOpen: boolean;
  signedIn: boolean;
  rpId: string;
  version: string;
}

function App() {
  const path = usePath();
  const [status, setStatus] = useState<OwnerStatus | null>(null);
  const refresh = useCallback(() => api<OwnerStatus>("GET", "/api/owner/status").then(setStatus), []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!status) return <Loading />;
  const pathname = path.split("?")[0]!;

  if (!status.signedIn) {
    if (status.enrolOpen && (!status.hasPasskeys || pathname === "/setup")) return <SetupPage status={status} onDone={refresh} />;
    return <LoginPage status={status} onDone={refresh} />;
  }
  if (pathname === "/setup" || pathname === "/login") {
    const next = new URLSearchParams(location.search).get("next");
    if (next && next.startsWith("/")) {
      location.assign(next);
      return null;
    }
  }
  if (pathname === "/consent") return <ConsentPage />;

  let page: ReactNode;
  if (pathname.startsWith("/agents")) page = <AgentsPage path={pathname} />;
  else if (pathname === "/settings") page = <SettingsPage status={status} />;
  else if (pathname === "/audit") page = <AuditPage />;
  else page = <ConversationsPage path={pathname} />;

  return (
    <Shell pathname={pathname} status={status}>
      {page}
    </Shell>
  );
}

const NAV = [
  { to: "/", icon: "💬", label: "Conversations", match: (p: string) => p === "/" || p.startsWith("/threads") || p.startsWith("/c/") },
  { to: "/agents", icon: "🤖", label: "Agents", match: (p: string) => p === "/agents" || p === "/agents/new" },
  { to: "/settings", icon: "⚙️", label: "Settings", match: (p: string) => p === "/settings" },
  { to: "/audit", icon: "📜", label: "Audit log", match: (p: string) => p === "/audit" },
];

function Shell({ pathname, status, children }: { pathname: string; status: OwnerStatus; children: ReactNode }) {
  const { agents } = useAgents();
  const live = useLive(() => {});
  const listed = (agents ?? []).filter((a) => a.handle !== "owner" && a.status !== "revoked");
  const item = "flex h-[30px] items-center gap-2 rounded-md px-2 text-sm";
  return (
    <div className="flex h-full flex-col md:flex-row">
      <aside className="hidden w-60 shrink-0 flex-col overflow-y-auto bg-side px-2 py-2.5 md:flex">
        <div className="mb-2 flex h-8 items-center gap-2 px-2 text-sm font-semibold">
          <img src="/favicon.svg" alt="" className="size-5 rounded" />
          agent-send
          <span className="ml-auto">
            <Dot tone={live ? "green" : "yellow"} title={live ? "Live" : "Reconnecting…"} />
          </span>
        </div>
        {NAV.map((n) => (
          <Link key={n.to} to={n.to} className={cx(item, n.match(pathname) ? "bg-hover font-medium" : "text-fg/75 hover:bg-hover")}>
            <span className="w-5 text-center">{n.icon}</span>
            {n.label}
          </Link>
        ))}

        <div className="mt-5 mb-1 px-2 text-xs font-medium text-faint">Agents</div>
        {listed.map((a) => {
          const d = deliveryState(a);
          return (
            <Link key={a.handle} to={`/agents/${a.handle}`} title={d.label} className={cx(item, pathname === `/agents/${a.handle}` ? "bg-hover font-medium" : "text-fg/75 hover:bg-hover")}>
              <Avatar name={a.name} size="sm" />
              <span className="min-w-0 flex-1 truncate">{a.name}</span>
              <Dot tone={d.tone} />
            </Link>
          );
        })}
        <Link to="/agents/new" className={cx(item, "text-faint hover:bg-hover")}>
          <span className="w-5 text-center">+</span>
          Add agent
        </Link>

        <div className="mt-auto flex items-center gap-2 px-2 pt-4 text-xs text-faint">
          <span>v{status.version}</span>
          <button
            className="ml-auto rounded px-1.5 py-0.5 hover:bg-hover hover:text-fg"
            onClick={async () => {
              await api("POST", "/api/owner/logout", {});
              location.assign("/");
            }}
          >
            Sign out
          </button>
        </div>
      </aside>

      <nav className="flex h-11 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line bg-side px-2 md:hidden">
        <img src="/favicon.svg" alt="" className="mr-1 size-5 rounded" />
        {NAV.map((n) => (
          <Link key={n.to} to={n.to} className={cx("flex h-8 items-center gap-1.5 rounded-md px-2 text-sm whitespace-nowrap", n.match(pathname) ? "bg-hover font-medium" : "text-fg/75")}>
            <span>{n.icon}</span>
            {n.label}
          </Link>
        ))}
      </nav>

      <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
