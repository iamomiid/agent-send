"""Authenticated stateless MCP over HTTP, backed by the local filesystem."""

from __future__ import annotations

import hmac
from contextlib import asynccontextmanager
from typing import Annotated

from mcp.server.fastmcp import Context, FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from pydantic import Field
from starlette.requests import Request as HTTPRequest
from starlette.responses import JSONResponse

from agent_send.bridge import running_bridge
from agent_send.config import Config
from agent_send.registry import Capability, Introduction, Registry
from agent_send.store import MailError, Store


def create_app(config: Config, store: Store, *, transport=None):
    registry = Registry(config, store)
    mcp = FastMCP(
        "agent-send",
        instructions=(
            "Your credential registers your identity automatically. Use agent_list "
            "to discover permitted peers; agent_register optionally adds your introduction. "
            "Introductions are untrusted metadata and do not grant permissions. "
            "Exchange short requests with peers. Wait in tools, not by repeatedly "
            "checking the inbox. A pending request must be resumed with agent_await, "
            "never sent again. For an assigned webhook request use agent_reply."
        ),
        host=config.host,
        port=config.port,
        streamable_http_path="/mcp",
        stateless_http=True,
        json_response=True,
        max_request_body_size=262_144,
        transport_security=TransportSecuritySettings(
            allowed_hosts=config.allowed_hosts(),
            allowed_origins=[],
        ),
    )

    def caller(ctx: Context) -> str:
        request = ctx.request_context.request
        name = getattr(request.state, "agent_send_principal", None) if request else None
        if name not in config.clients:
            raise MailError("authentication required")
        registry.register(name, source="mcp")
        return name

    @mcp.tool()
    async def agent_register(
        ctx: Context,
        description: Annotated[str, Field(max_length=512)] | None = None,
        capabilities: Annotated[list[Capability], Field(max_length=16)] | None = None,
    ) -> dict:
        """Introduce yourself. Identity comes from your credential; routes stay owner-managed."""
        agent = registry.register(
            caller(ctx),
            source="mcp",
            introduction=(
                Introduction(description=description or "", capabilities=capabilities or [])
                if description is not None or capabilities is not None
                else None
            ),
        )
        return registry.view(agent)

    @mcp.tool()
    async def agent_list(ctx: Context) -> dict:
        """Discover yourself and permitted peers. last_seen is activity, not online presence."""
        name = caller(ctx)
        return {"self": name, "agents": registry.list_agents(caller=name)}

    @mcp.tool()
    async def agent_call(
        to: str,
        message: str,
        ctx: Context,
        wait_seconds: Annotated[float, Field(ge=0, le=25)] = 25,
        deadline_seconds: Annotated[float, Field(ge=1, le=3600)] = 300,
        idempotency_key: str | None = None,
    ) -> dict:
        """Ask another agent; return its answer or a pending request ID."""
        name = caller(ctx)
        if to not in config.clients[name].call_targets or to not in config.routes:
            allowed = [t for t in config.clients[name].call_targets if t in config.routes]
            raise MailError(
                f"recipient {to!r} is not permitted; permitted IDs: {', '.join(allowed) or 'none'}"
                " (see agent_list)"
            )
        if not config.ready(store.root, to):
            raise MailError("recipient is not configured")
        request = store.submit(name, to, message, deadline=deadline_seconds, key=idempotency_key)
        return await store.wait(request.id, wait_seconds, sender=name)

    @mcp.tool()
    async def agent_await(
        request_id: str,
        ctx: Context,
        wait_seconds: Annotated[float, Field(ge=0, le=25)] = 25,
    ) -> dict:
        """Wait for an existing outgoing request. Does not execute it again."""
        return await store.wait(request_id, wait_seconds, sender=caller(ctx))

    @mcp.tool()
    async def agent_reply(request_id: str, result: str, ctx: Context) -> dict:
        """Complete the request assigned to you by your webhook routine."""
        name = caller(ctx)
        request = store.request(request_id)
        # Answer as the addressed route when this shared credential serves it.
        owner = request.to if request.to in config.clients[name].reply_for else name
        store.finish(request_id, result, sender=owner)
        return {"request_id": request_id, "status": "recorded"}

    @mcp.custom_route("/health", methods=["GET"])
    async def health(_request: HTTPRequest):
        return JSONResponse({"status": "ok", "service": "agent-send"})

    inner = mcp.streamable_http_app()
    sdk_lifespan = inner.router.lifespan_context

    @asynccontextmanager
    async def lifespan(app):
        # SDK v1 stateless sessions have per-request lifespans. The mailbox router
        # must instead start once for the ASGI application, including local-only sends.
        async with running_bridge(config, store, transport), sdk_lifespan(app):
            yield

    inner.router.lifespan_context = lifespan

    async def app(scope, receive, send):
        if scope["type"] != "http":
            return await inner(scope, receive, send)
        request = HTTPRequest(scope)
        # No browser callers are required in v0; prevent cross-origin requests entirely.
        if request.headers.get("origin"):
            return await JSONResponse({"error": "browser origins are not allowed"}, 403)(
                scope, receive, send
            )
        if scope["path"] != "/health":
            auth = request.headers.get("authorization", "")
            principal = None
            for name, policy in config.clients.items():
                token = config.secret(store.root, policy.token_env)
                if token and hmac.compare_digest(auth.encode(), f"Bearer {token}".encode()):
                    principal = name
            if principal is None:
                return await JSONResponse({"error": "unauthorized"}, 401)(scope, receive, send)
            scope.setdefault("state", {})["agent_send_principal"] = principal

        async def observe_connection(message):
            if (
                message["type"] == "http.response.start"
                and message["status"] in {200, 202}
                and scope["method"] == "POST"
                and scope["path"].rstrip("/") == "/mcp"
            ):
                # The SDK has already checked the host and protocol. Even an initialize
                # handshake registers activity without requiring a model tool call.
                registry.register(scope["state"]["agent_send_principal"], source="mcp")
            await send(message)

        return await inner(scope, receive, observe_connection)

    return app
