// Shared, live-updating agent list used by the sidebar and the pages.

import { useEffect, useState } from "react";
import { api, type Agent } from "./api";
import { useLive } from "./components";

let cache: Agent[] | null = null;
const subscribers = new Set<(a: Agent[] | null) => void>();

function publish(next: Agent[]) {
  cache = next;
  subscribers.forEach((s) => s(next));
}

export function reloadAgents() {
  return api<Agent[]>("GET", "/api/owner/agents").then(publish);
}

export function useAgents() {
  const [agents, setAgents] = useState(cache);
  useEffect(() => {
    subscribers.add(setAgents);
    if (!cache) void reloadAgents();
    return () => void subscribers.delete(setAgents);
  }, []);
  useLive((e) => {
    if (e.type !== "agent" || !cache) return;
    const a = e.agent;
    publish(cache.some((x) => x.handle === a.handle) ? cache.map((x) => (x.handle === a.handle ? a : x)) : [...cache, a]);
  });
  return { agents, reload: reloadAgents };
}

export function nameOf(agents: Agent[] | null, handle: string) {
  if (handle === "owner") return "You";
  return agents?.find((a) => a.handle === handle)?.name ?? handle;
}
