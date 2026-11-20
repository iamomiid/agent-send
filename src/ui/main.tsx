import { StrictMode, useCallback, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { api } from "./api";
import { Button, cx } from "./components";
import { AgentsPage } from "./pages/Agents";
import { AuditPage } from "./pages/Audit";
import { ConsentPage } from "./pages/Consent";
import { ConversationsPage } from "./pages/Conversations";
import { LoginPage, SetupPage } from "./pages/Auth";
import { SettingsPage } from "./pages/Settings";
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

export function navigate(to: string) {
  history.pushState(null, "", to);
  dispatchEvent(new PopStateEvent("popstate"));
}

export function Link({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  return (
    <a
      href={to}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

function usePath() {
  const [path, setPath] = useState(location.pathname + location.search);
  useEffect(() => {
    const on = () => setPath(location.pathname + location.search);
    addEventListener("popstate", on);
    return () => removeEventListener("popstate", on);
  }, []);
  return path;
}

function App() {
  const path = usePath();
  const [status, setStatus] = useState<OwnerStatus | null>(null);
  const refresh = useCallback(() => api<OwnerStatus>("GET", "/api/owner/status").then(setStatus), []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!status) return <div className="grid h-full place-items-center text-sm text-subtle">Loading…</div>;
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

  return <Shell pathname={pathname} status={status}>{page}</Shell>;
}

function Shell({ pathname, status, children }: { pathname: string; status: OwnerStatus; children: ReactNode }) {
  const nav = [
    { to: "/", label: "Conversations", active: pathname === "/" || pathname.startsWith("/threads") },
    { to: "/agents", label: "Agents", active: pathname.startsWith("/agents") },
    { to: "/settings", label: "Settings", active: pathname === "/settings" },
    { to: "/audit", label: "Audit", active: pathname === "/audit" },
  ];
  return (
    <div className="flex h-full flex-col md:flex-row">
      <aside className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line bg-panel px-3 py-2 md:w-56 md:flex-col md:items-stretch md:border-r md:border-b-0 md:px-3 md:py-4">
        <div className="mr-3 flex items-center gap-2 px-2 md:mr-0 md:mb-4">
          <img src="/favicon.svg" alt="" className="size-6" />
          <span className="font-semibold">agent-send</span>
        </div>
        {nav.map((n) => (
          <Link key={n.to} to={n.to} className={cx("rounded-md px-2 py-1.5 text-sm whitespace-nowrap", n.active ? "bg-muted font-medium" : "text-subtle hover:bg-muted hover:text-fg")}>
            {n.label}
          </Link>
        ))}
        <div className="ml-auto md:mt-auto md:ml-0">
          <p className="hidden px-2 pb-2 text-xs text-subtle md:block">v{status.version}</p>
          <Button
            variant="ghost"
            className="w-full justify-start text-subtle"
            onClick={async () => {
              await api("POST", "/api/owner/logout", {});
              location.assign("/");
            }}
          >
            Sign out
          </Button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
