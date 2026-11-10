import json

from agent_send.cli import main
from agent_send.store import atomic_json


def test_init_is_private_idempotent_and_doctor_hides_tokens(tmp_path, capsys):
    root = tmp_path / "mail"
    args = ["--home", str(root)]
    assert main(args + ["init"]) == 0
    secret = json.loads((root / "secrets.json").read_text())["GROK_BRIDGE_TOKEN"]
    assert main(args + ["init"]) == 0
    assert json.loads((root / "secrets.json").read_text())["GROK_BRIDGE_TOKEN"] == secret
    assert main(args + ["doctor"]) == 0
    assert secret not in capsys.readouterr().out


def test_send_alias_pending_and_retrieve_saved_answer(mailbox, capsys):
    store, _ = mailbox
    args = ["--home", str(store.root)]
    assert main(args + ["grok", "question", "--wait", "0", "--key", "same"]) == 2
    value = json.loads(capsys.readouterr().out)
    assert value["status"] == "pending"
    store.update(value["request_id"], status="awaiting_reply")
    store.finish(value["request_id"], "answer", sender="grok")
    assert main(args + ["wait", value["request_id"], "--wait", "0"]) == 0
    assert json.loads(capsys.readouterr().out)["result"] == "answer"
    assert main(args + ["grok", "question", "--wait", "0", "--key", "same"]) == 0
    assert len(list(store.requests())) == 1


def test_connector_and_launchd_generate_files_without_installing(mailbox, capsys):
    store, config = mailbox
    config.public_url = "https://agents.example.test"
    atomic_json(store.root / "routes.json", config.model_dump())
    args = ["--home", str(store.root)]
    assert main(args + ["connector"]) == 0
    contents = json.loads((store.root / "grok-connector.json").read_text())
    assert contents["mcpServers"]["agent-send"]["url"] == "https://agents.example.test/mcp"
    assert "test-bridge-secret" not in capsys.readouterr().out
    assert main(args + ["launchd"]) == 0
    assert (store.root / "com.agent-send.bridge.plist").exists()
    assert main(args + ["systemd"]) == 0
    unit = (store.root / "agent-send.service").read_text()
    assert "serve" in unit and "test-bridge-secret" not in unit


def test_configure_invalid_public_url_does_not_change_config(mailbox):
    store, _ = mailbox
    path = store.root / "routes.json"
    previous = path.read_bytes()
    assert main(["--home", str(store.root), "configure", "public", "--url", "http://bad"]) == 1
    assert path.read_bytes() == previous


def test_invalid_wait_does_not_submit_a_task(mailbox):
    store, _ = mailbox
    assert main(["--home", str(store.root), "grok", "question", "--wait", "nan"]) == 1
    assert list(store.requests()) == []
