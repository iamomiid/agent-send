from __future__ import annotations

import pytest

from agent_send.config import Config, Route
from agent_send.store import Store, atomic_json


@pytest.fixture
def mailbox(tmp_path):
    store = Store(tmp_path / "mail")
    config = Config(
        scan_seconds=0.05,
        poll_seconds=0.01,
        routes={
            "hermes": Route(kind="hermes", url="http://hermes.test", token_env="HERMES_API_KEY"),
            "grok": Route(
                kind="grok", url="https://grok.test/webhook", token_env="GROK_WEBHOOK_KEY"
            ),
        },
    )
    atomic_json(store.root / "routes.json", config.model_dump())
    atomic_json(
        store.root / "secrets.json",
        {
            "HERMES_API_KEY": "test-hermes-secret",
            "GROK_WEBHOOK_KEY": "test-webhook-secret",
            "GROK_BRIDGE_TOKEN": "test-bridge-secret",
        },
    )
    return store, config
