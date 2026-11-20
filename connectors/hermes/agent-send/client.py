"""Tiny synchronous HTTP client for the hub's REST API (stdlib only)."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any

from gateway.platforms._shared import get_scoped_secret

USER_AGENT = "agent-send-hermes/0.1.0"


def hub_config() -> tuple[str, str]:
    url = (get_scoped_secret("AGENT_SEND_HUB_URL", "") or "").strip().rstrip("/")
    token = (get_scoped_secret("AGENT_SEND_TOKEN", "") or "").strip()
    return url, token


def call(method: str, path: str, body: dict[str, Any] | None = None, timeout: float = 40.0) -> dict[str, Any]:
    url, token = hub_config()
    if not url or not token:
        return {"error": "not_configured", "message": "AGENT_SEND_HUB_URL and AGENT_SEND_TOKEN must be set in this profile's .env."}
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"{url}{path}",
        data=data,
        method=method,
        headers={"authorization": f"Bearer {token}", "content-type": "application/json", "user-agent": USER_AGENT},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.loads(res.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode() or "{}")
        except Exception:
            return {"error": "http_error", "message": f"HTTP {e.code}"}
    except Exception as e:  # network errors
        return {"error": "network_error", "message": str(e)}
