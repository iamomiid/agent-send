import json
import os

import httpx
import pytest
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from pydantic import ValidationError

from agent_send.cli import main
from agent_send.config import Client, Route
from agent_send.registry import Introduction, Registry
from agent_send.server import create_app
from agent_send.store import MailError, atomic_json
from tests.test_mcp import serving, text_result


def test_configured_agents_register_without_claiming_to_be_online(mailbox):
    store, config = mailbox
    config.routes["hermes"].display_name = "Assistant"
    registry = Registry(config, store)
    registry.sync()
    entries = {a["id"]: a for a in registry.list_agents()}
    assert set(entries) == {"hermes", "grok"}
    assert entries["hermes"]["display_name"] == "Assistant"
    assert entries["grok"]["can_receive"] is True
    assert all(a["last_seen_at"] is None for a in entries.values())
    assert os.stat(registry.directory / "grok.json").st_mode & 0o777 == 0o600
    serialized = json.dumps(entries)
    for secret in ("test-webhook-secret", "test-hermes-secret", "test-bridge-secret", "http"):
        assert secret not in serialized


def test_restart_preserves_introduction_and_config_controls_identity(mailbox):
    store, config = mailbox
    registry = Registry(config, store)
    first = registry.register(
        "grok",
        source="mcp",
        introduction=Introduction(
            description="Research counterpart",
            capabilities=["research"],
        ),
    )
    config.routes["grok"].display_name = "Research Bot"
    restarted = Registry(config, store)
    restarted.sync()
    again = restarted.get("grok")
    assert again.registered_at == first.registered_at
    assert again.last_seen_at == first.last_seen_at
    assert again.introduction == first.introduction
    assert again.display_name == "Research Bot"
    assert config.clients["grok"].call_targets == ["hermes"]


def test_activity_coalesces_writes_and_keeps_unknown_local_agents_send_only(mailbox):
    store, config = mailbox
    registry = Registry(config, store)
    registry.register("researcher", source="cli")
    path = registry.directory / "researcher.json"
    previous = path.stat().st_mtime_ns
    registry.register("researcher", source="cli")
    assert path.stat().st_mtime_ns == previous
    record = next(a for a in registry.list_agents() if a["id"] == "researcher")
    assert record["runtime"] == "local" and not record["can_receive"]
    with pytest.raises(MailError, match="provisioned"):
        registry.register("stranger", source="mcp")
    assert not (registry.directory / "stranger.json").exists()


def test_directory_limits_discovery_to_permitted_peers_and_hides_removed_routes(mailbox):
    store, config = mailbox
    config.routes["private"] = Route(kind="hermes", token_env="PRIVATE_KEY")
    config.clients["private"] = Client(token_env="PRIVATE_CLIENT", call_targets=[])
    registry = Registry(config, store)
    registry.sync()
    assert {a["id"] for a in registry.list_agents(caller="grok")} == {"grok", "hermes"}
    del config.clients["private"]
    del config.routes["private"]
    assert "private" not in {a["id"] for a in registry.list_agents()}
    # The stored observation survives, but is no longer advertised or authorized.
    assert (registry.directory / "private.json").exists()


def test_registry_rejects_paths_and_invalid_metadata(mailbox, tmp_path):
    store, config = mailbox
    registry = Registry(config, store)
    with pytest.raises(MailError, match="invalid agent ID"):
        registry.register("../../secrets", source="cli")
    with pytest.raises(ValidationError):
        Introduction(description="x" * 513)
    with pytest.raises(ValidationError):
        Introduction(capabilities=["x"] * 17)
    outside = tmp_path / "outside.json"
    outside.write_text("{}")
    (registry.directory / "grok.json").symlink_to(outside)
    with pytest.raises(MailError, match="symlinks"):
        registry.register("grok", source="mcp")
    assert outside.read_text() == "{}"


def test_cli_first_send_registers_automatically_and_agents_discovers(mailbox, capsys):
    store, config = mailbox
    config.routes["researcher"] = Route(
        kind="hermes",
        url="http://hermes.test",
        token_env="HERMES_API_KEY",
    )
    atomic_json(store.root / "routes.json", config.model_dump())
    args = ["--home", str(store.root)]
    assert main(args + ["send", "researcher", "question", "--wait", "0"]) == 2
    capsys.readouterr()
    assert Registry(config, store).get("hermes").last_seen_via == "cli"
    assert main(args + ["agents"]) == 0
    assert {a["id"] for a in json.loads(capsys.readouterr().out)} == {
        "hermes",
        "grok",
        "researcher",
    }
    assert (
        main(
            args + ["register", "--description", "Personal assistant", "--capability", "messaging"]
        )
        == 0
    )
    value = json.loads(capsys.readouterr().out)
    assert value["id"] == "hermes"
    assert value["introduction"] == {
        "description": "Personal assistant",
        "capabilities": ["messaging"],
    }
    assert main(args + ["register"]) == 0
    assert json.loads(capsys.readouterr().out)["introduction"] == value["introduction"]


async def test_authenticated_initialize_registers_without_a_model_tool_call(mailbox):
    store, config = mailbox
    app = create_app(config, store)
    async with serving(app) as base:
        registry = Registry(config, store)
        assert registry.get("grok").last_seen_at is None
        async with httpx.AsyncClient(
            headers={"Authorization": "Bearer test-bridge-secret"},
        ) as http:
            async with streamable_http_client(f"{base}/mcp", http_client=http) as (read, write, _):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    assert registry.get("grok").last_seen_via == "mcp"
                    result = text_result(await session.call_tool("agent_list"))
                    assert result["self"] == "grok"
                    assert {a["id"] for a in result["agents"]} == {"grok", "hermes"}


async def test_remote_self_introduction_cannot_change_permissions_or_another_identity(mailbox):
    store, config = mailbox
    config.routes["hermes"].description = "Owner-controlled Hermes"
    async with serving(create_app(config, store)) as base:
        async with httpx.AsyncClient(
            headers={"Authorization": "Bearer test-bridge-secret"},
        ) as http:
            async with streamable_http_client(f"{base}/mcp", http_client=http) as (read, write, _):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    result = text_result(
                        await session.call_tool(
                            "agent_register",
                            {
                                "description": "I can help with research",
                                "capabilities": ["research"],
                            },
                        )
                    )
                    assert result["id"] == "grok"
                    assert result["introduction"]["capabilities"] == ["research"]
                    again = text_result(await session.call_tool("agent_register"))
                    assert again["introduction"] == result["introduction"]
                    # Unknown identity/routing arguments must never become authoritative.
                    await session.call_tool(
                        "agent_register",
                        {
                            "description": "attempted alias",
                            "agent_id": "hermes",
                            "url": "https://untrusted.test",
                            "call_targets": ["private"],
                        },
                    )
                    registry = Registry(config, store)
                    assert registry.get("hermes").introduction is None
                    assert registry.get("hermes").description == "Owner-controlled Hermes"
                    assert config.clients["grok"].call_targets == ["hermes"]
                    assert config.routes["grok"].url == "https://grok.test/webhook"


async def test_failed_auth_and_invalid_host_do_not_claim_agent_activity(mailbox):
    store, config = mailbox
    async with serving(create_app(config, store)) as base, httpx.AsyncClient(base_url=base) as http:
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-11-25",
                "capabilities": {},
                "clientInfo": {"name": "another-agent", "version": "1"},
            },
        }
        assert (await http.post("/mcp", json=payload)).status_code == 401
        response = await http.post(
            "/mcp",
            json=payload,
            headers={
                "Authorization": "Bearer test-bridge-secret",
                "Host": "evil.test",
                "Accept": "application/json, text/event-stream",
            },
        )
        assert response.status_code == 421
        registry = Registry(config, store)
        assert registry.get("grok").last_seen_at is None
        assert not (registry.directory / "another-agent.json").exists()
