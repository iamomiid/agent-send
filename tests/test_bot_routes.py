import io
import json

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

from agent_send.cli import main
from agent_send.config import load
from agent_send.server import create_app
from tests.test_mcp import serving, text_result


def add_bot(store, monkeypatch, *extra):
    monkeypatch.setattr("sys.stdin", io.StringIO("creator-webhook-secret\n"))
    args = ["--home", str(store.root), "configure", "creator-analyst"]
    args += ["--url", "https://grok.test/creator", "--name", "Creator Analyst", "--token-stdin"]
    return main(args + list(extra))


def test_configure_adds_a_named_grok_bot_route(mailbox, monkeypatch, capsys):
    store, _ = mailbox
    assert add_bot(store, monkeypatch, "--allow-from", "grok") == 0
    config = load(store.root)
    route = config.routes["creator-analyst"]
    assert (route.kind, route.display_name) == ("grok", "Creator Analyst")
    assert route.token_env == "GROK_WEBHOOK_KEY_CREATOR_ANALYST"
    assert config.clients["grok"].call_targets == ["hermes", "creator-analyst"]
    assert config.clients["grok"].reply_for == ["creator-analyst"]
    secrets = json.loads((store.root / "secrets.json").read_text())
    assert secrets["GROK_WEBHOOK_KEY_CREATOR_ANALYST"] == "creator-webhook-secret"
    assert "creator-webhook-secret" not in capsys.readouterr().out
    assert config.ready(store.root, "creator-analyst")
    # Renaming later keeps the URL and does not prompt for the key again.
    assert main(["--home", str(store.root), "configure", "creator-analyst", "--name", "CA"]) == 0
    assert load(store.root).routes["creator-analyst"].url == "https://grok.test/creator"


def test_new_route_needs_a_recognisable_url_and_valid_id(mailbox):
    store, _ = mailbox
    home = ["--home", str(store.root), "configure"]
    assert main(home + ["new-bot", "--url", "http://x.test/hook"]) == 1
    assert main(home + ["new-bot"]) == 1
    assert main(home + ["Bad Name", "--kind", "grok", "--url", "https://x.test/h"]) == 1
    assert main(home + ["hermes", "--kind", "grok"]) == 1


async def test_shared_grok_credential_answers_for_its_bot_routes_only(mailbox, monkeypatch):
    store, _ = mailbox
    assert add_bot(store, monkeypatch) == 0
    config = load(store.root)
    for_bot = store.submit("hermes", "creator-analyst", "how many creators?")
    store.update(for_bot.id, status="awaiting_reply")
    for_hermes = store.submit("grok", "hermes", "not Grok's to answer")
    store.update(for_hermes.id, status="unknown")
    async with serving(create_app(config, store)) as base:
        async with httpx.AsyncClient(
            headers={"Authorization": "Bearer test-bridge-secret"}
        ) as http:
            async with streamable_http_client(f"{base}/mcp", http_client=http) as (read, write, _):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    ok = await session.call_tool(
                        "agent_reply", {"request_id": for_bot.id, "result": "31"}
                    )
                    assert text_result(ok)["status"] == "recorded"
                    forged = await session.call_tool(
                        "agent_reply", {"request_id": for_hermes.id, "result": "forged"}
                    )
                    assert forged.isError
                    # Not added with --allow-from: Grok cannot call it, and is told who it can.
                    denied = await session.call_tool(
                        "agent_call", {"to": "creator-analyst", "message": "hi"}
                    )
                    assert denied.isError and "hermes" in denied.content[0].text
    assert store.result(for_bot.id)["result"] == "31"


def test_kind_is_inferred_from_the_url(mailbox, monkeypatch):
    store, _ = mailbox
    assert add_bot(store, monkeypatch) == 0
    assert load(store.root).routes["creator-analyst"].kind == "grok"
    monkeypatch.setattr("sys.stdin", io.StringIO("local-key\n"))
    args = ["--home", str(store.root), "configure", "cmo", "--url"]
    assert main(args + ["http://127.0.0.1:8642/p/cmo", "--token-stdin"]) == 0
    assert load(store.root).routes["cmo"].kind == "hermes"


async def test_running_bridge_picks_up_new_routes_without_restart(mailbox, monkeypatch):
    import asyncio

    from agent_send.bridge import Bridge

    store, config = mailbox
    posted = []

    def handler(request):
        posted.append(str(request.url))
        return httpx.Response(200)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        bridge = Bridge(config, store, client)
        task = asyncio.create_task(bridge.run())
        try:
            await asyncio.sleep(0.1)
            path = store.root / "routes.json"
            good = path.read_text()
            path.write_text("{broken")  # Invalid edits are ignored.
            await asyncio.sleep(0.15)
            assert "hermes" in config.routes
            path.write_text(good)
            assert add_bot(store, monkeypatch) == 0
            request = store.submit("hermes", "creator-analyst", "hello")
            async with asyncio.timeout(3):
                while store.state(request.id)["status"] != "awaiting_reply":  # noqa: ASYNC110
                    await asyncio.sleep(0.02)
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
    assert posted == ["https://grok.test/creator"]
    assert config.routes["creator-analyst"].display_name == "Creator Analyst"
