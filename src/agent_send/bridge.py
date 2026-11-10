"""Route committed files to the existing runtimes; never invoke a routing model."""

from __future__ import annotations

import asyncio
import logging
import time
from contextlib import asynccontextmanager

import httpx

from agent_send.config import Config, load
from agent_send.registry import Registry
from agent_send.store import TERMINAL, MailError, Request, Store

log = logging.getLogger(__name__)


class Bridge:
    def __init__(self, config: Config, store: Store, client: httpx.AsyncClient):
        self.config, self.store, self.client = config, store, client
        self.registry = Registry(config, store)
        self.tasks: dict[str, asyncio.Task] = {}
        self.config_stamp = self._stamp()

    # Fields that apply live. host/port/public_url are bound when the server starts.
    LIVE_FIELDS = ("routes", "clients", "local_agent", "scan_seconds", "poll_seconds")

    def _stamp(self) -> tuple[int, int] | None:
        try:
            stat = (self.store.root / "routes.json").stat()
        except OSError:
            return None
        return stat.st_mtime_ns, stat.st_size

    def refresh_config(self, *, force: bool = False) -> None:
        """Apply edits to routes.json without a restart; keep the last good config."""
        stamp = self._stamp()
        if stamp is None or (stamp == self.config_stamp and not force):
            return
        self.config_stamp = stamp
        try:
            fresh = load(self.store.root)
        except (ValueError, OSError):
            log.warning("routes.json is invalid; keeping the previous configuration")
            return
        # Mutate in place: the MCP server and registry share this Config object.
        for field in self.LIVE_FIELDS:
            setattr(self.config, field, getattr(fresh, field))
        self.registry.sync()
        log.info("Configuration reloaded")

    async def run(self) -> None:
        self.registry.sync()
        try:
            while True:
                self.refresh_config()
                requests = sorted(self.store.requests(), key=lambda r: r.created_at)
                owners = {}
                for request in requests:
                    state = self.store.state(request.id)
                    if (
                        state["status"] in {"dispatching", "running", "awaiting_reply", "unknown"}
                        and request.deadline_at > time.time()
                        and not self.store.path("replies", request.id).exists()
                    ):
                        owners.setdefault(request.to, request.id)
                for request in requests:
                    state = self.store.state(request.id)
                    if self.store.path("replies", request.id).exists():
                        continue
                    if state["status"] in TERMINAL:
                        continue
                    if request.deadline_at <= time.time():
                        self.store.update(request.id, status="expired")
                        continue
                    if request.to not in self.config.routes:
                        # The route may have been added an instant ago.
                        self.refresh_config(force=True)
                    if request.to not in self.config.routes:
                        self.store.update(request.id, status="failed", error="unknown recipient")
                        continue
                    if request.to in self.tasks and not self.tasks[request.to].done():
                        continue
                    if request.to in owners and owners[request.to] != request.id:
                        continue
                    route = self.config.routes[request.to]
                    if route.kind == "grok" and state["status"] in {
                        "dispatching",
                        "awaiting_reply",
                        "unknown",
                    }:
                        # No resubmission: a crash or lost receipt may hide a running Bot.
                        if state["status"] == "dispatching":
                            self.store.update(
                                request.id,
                                status="unknown",
                                error="webhook acceptance is unknown; not resubmitted",
                            )
                        continue
                    if state["status"] == "unknown":
                        continue
                    if not self.config.ready(self.store.root, request.to):
                        self.store.update(
                            request.id,
                            status="failed",
                            error=f"route {request.to!r} is not configured",
                        )
                        continue
                    # Each recipient has at most one active transport task.
                    self.tasks[request.to] = asyncio.create_task(self.deliver(request))
                await asyncio.sleep(self.config.scan_seconds)
        finally:
            for task in self.tasks.values():
                task.cancel()
            await asyncio.gather(*self.tasks.values(), return_exceptions=True)

    async def deliver(self, request: Request) -> None:
        try:
            if self.config.routes[request.to].kind == "hermes":
                await self.hermes(request)
            else:
                await self.grok(request)
        except asyncio.CancelledError:
            raise
        except (httpx.HTTPError, ValueError, OSError):
            # Never log payloads, URLs, tokens or upstream exception text.
            log.warning("Delivery requires reconciliation: %s", request.id)
            self.store.update(
                request.id,
                status="unknown",
                error="delivery outcome unknown; inspect before retrying",
            )

    def headers(self, recipient: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.config.route_secret(self.store.root, recipient)}"}

    async def grok(self, request: Request) -> None:
        self.store.update(request.id, status="dispatching")
        route = self.config.routes[request.to]
        response = await self.client.post(
            route.url,
            headers=self.headers(request.to),
            json={
                "request_id": request.id,
                "from_agent": request.sender,
                "to_agent": request.to,
                "message": request.message,
                "deadline_at": request.deadline_at,
                "reply_tool": "agent_reply",
            },
        )
        if response.status_code == 200:
            # A fast callback may have completed the request before POST returns.
            self.store.update(request.id, status="awaiting_reply")
        elif 400 <= response.status_code < 500:
            self.store.finish(
                request.id,
                f"Grok webhook rejected request (HTTP {response.status_code})",
                status="failed",
            )
        else:
            # Redirects and server errors are not safe evidence that no Bot started.
            self.store.update(
                request.id,
                status="unknown",
                error=f"webhook returned HTTP {response.status_code}; not resubmitted",
            )

    async def hermes(self, request: Request) -> None:
        route = self.config.routes[request.to]
        state = self.store.state(request.id)
        run_id = state.get("native_run_id")
        if not run_id:
            self.store.update(request.id, status="dispatching")
            response = await self.client.post(
                f"{route.url}/v1/runs",
                headers=self.headers(request.to) | {"Idempotency-Key": request.id},
                json={
                    "input": request.message,
                    "session_id": f"agent-send-{request.id}",
                    "instructions": (
                        f"This is a peer request from {request.sender}. "
                        "Follow your existing permissions and approval rules. "
                        "Return a concise final answer. Do not call the peer back to "
                        "answer this request: it may already be waiting for you."
                    ),
                },
            )
            if response.status_code not in {200, 201, 202}:
                if 400 <= response.status_code < 500:
                    self.store.finish(
                        request.id,
                        f"Hermes rejected request (HTTP {response.status_code})",
                        status="failed",
                    )
                    return
                raise MailError("Hermes admission outcome unknown")
            run_id = response.json().get("run_id")
            if not isinstance(run_id, str) or not run_id or len(run_id) > 200:
                raise MailError("Hermes returned no run ID")
            # Treat native IDs as one URL segment, never as an arbitrary upstream path.
            from urllib.parse import quote

            run_id = quote(run_id, safe="")
            self.store.update(request.id, status="running", native_run_id=run_id)
        failures = 0
        while time.time() < request.deadline_at:
            try:
                response = await self.client.get(
                    f"{route.url}/v1/runs/{run_id}", headers=self.headers(request.to)
                )
                if response.status_code in {404, 410}:
                    raise MailError("native run is no longer recoverable")
                response.raise_for_status()
                data = response.json()
                failures = 0
            except httpx.HTTPError:
                failures += 1
                if failures >= 5:
                    raise
                await asyncio.sleep(self.config.poll_seconds)
                continue
            status = data.get("status")
            if status == "completed":
                output = data.get("output", "")
                if not isinstance(output, str):
                    raise MailError("unsupported Hermes output format")
                self.store.finish(request.id, output)
                self.registry.register(request.to, source="hermes_api")
                return
            if status in {"failed", "cancelled", "interrupted"}:
                self.store.finish(request.id, f"Hermes run {status}", status="failed")
                return
            if status == "unknown":
                raise MailError("Hermes reports unknown execution")
            await asyncio.sleep(self.config.poll_seconds)
        self.store.update(request.id, status="expired")


@asynccontextmanager
async def running_bridge(config: Config, store: Store, transport=None):
    with store.bridge_lock():
        async with httpx.AsyncClient(
            timeout=20, follow_redirects=False, transport=transport
        ) as client:
            bridge = Bridge(config, store, client)
            async with asyncio.TaskGroup() as group:
                task = group.create_task(bridge.run())
                try:
                    yield bridge
                finally:
                    task.cancel()
