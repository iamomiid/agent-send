import asyncio
import json
import socket
from contextlib import asynccontextmanager

import httpx
import uvicorn
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

from agent_send.server import create_app


@asynccontextmanager
async def serving(app):
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    address = f"http://127.0.0.1:{sock.getsockname()[1]}"
    server = uvicorn.Server(uvicorn.Config(app, log_level="critical", access_log=False))
    task = asyncio.create_task(server.serve(sockets=[sock]))
    try:
        async with asyncio.timeout(5):
            while not server.started:
                if task.done():
                    await task
                    raise RuntimeError("test server did not start")
                await asyncio.sleep(0.01)
        yield address
    finally:
        server.should_exit = True
        await asyncio.wait_for(task, 5)
        sock.close()


def text_result(value):
    assert not value.isError, value
    return json.loads(value.content[0].text)


async def test_real_mcp_client_bidirectional_roundtrip(mailbox):
    store, config = mailbox
    webhooks = []
    webhook_received = asyncio.Event()

    def upstream(req):
        if req.url.host == "grok.test":
            webhooks.append(json.loads(req.content))
            webhook_received.set()
            return httpx.Response(200)
        if req.method == "POST":
            return httpx.Response(202, json={"run_id": "run_fake"})
        return httpx.Response(200, json={"status": "completed", "output": "Hermes answer"})

    app = create_app(config, store, transport=httpx.MockTransport(upstream))
    async with serving(app) as base:
        async with httpx.AsyncClient(
            headers={"Authorization": "Bearer test-bridge-secret"}
        ) as http:
            async with streamable_http_client(f"{base}/mcp", http_client=http) as (read, write, _):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    tools = await session.list_tools()
                    assert {t.name for t in tools.tools} == {
                        "agent_register",
                        "agent_list",
                        "agent_call",
                        "agent_await",
                        "agent_reply",
                    }
                    result = text_result(
                        await session.call_tool(
                            "agent_call", {"to": "hermes", "message": "question", "wait_seconds": 2}
                        )
                    )
                    assert result["status"] == "completed"
                    assert result["result"] == "Hermes answer"
                    # Local Hermes submission, then remote Grok callback through the same server.
                    request = store.submit("hermes", "grok", "question back")
                    async with asyncio.timeout(3):
                        await webhook_received.wait()
                    reply = text_result(
                        await session.call_tool(
                            "agent_reply", {"request_id": request.id, "result": "Grok answer"}
                        )
                    )
                    assert reply["status"] == "recorded"
                    assert (await store.wait(request.id, 0))["result"] == "Grok answer"
                    # An incoming task is not an outgoing result the remote caller can read.
                    denied = await session.call_tool(
                        "agent_await", {"request_id": request.id, "wait_seconds": 0}
                    )
                    assert denied.isError


async def test_http_auth_origin_and_host_checks(mailbox):
    store, config = mailbox
    app = create_app(config, store)
    async with serving(app) as base, httpx.AsyncClient(base_url=base) as client:
        assert (await client.get("/health")).status_code == 200
        assert (await client.post("/mcp", json={})).status_code == 401
        headers = {"Authorization": "Bearer test-bridge-secret"}
        assert (
            await client.post("/mcp", headers=headers | {"Origin": "https://evil.test"}, json={})
        ).status_code == 403
        response = await client.post(
            "/mcp",
            headers=headers
            | {"Host": "evil.test", "Accept": "application/json, text/event-stream"},
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-11-25",
                    "capabilities": {},
                    "clientInfo": {"name": "test", "version": "1"},
                },
            },
        )
        assert response.status_code == 421


async def test_mcp_target_and_completion_authorization(mailbox):
    store, config = mailbox
    request = store.submit("grok", "hermes", "not assigned to grok")
    store.update(request.id, status="unknown")
    async with serving(create_app(config, store)) as base:
        async with httpx.AsyncClient(
            headers={"Authorization": "Bearer test-bridge-secret"}
        ) as http:
            async with streamable_http_client(f"{base}/mcp", http_client=http) as (read, write, _):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    denied = await session.call_tool("agent_call", {"to": "grok", "message": "bad"})
                    assert denied.isError
                    forged = await session.call_tool(
                        "agent_reply", {"request_id": request.id, "result": "forged"}
                    )
                    assert forged.isError
                    assert not store.path("replies", request.id).exists()
