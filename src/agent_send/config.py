"""Private local configuration. Secrets never belong in mailbox messages."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator


class Route(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["hermes", "grok"]
    url: str | None = None
    token_env: str
    display_name: str | None = Field(default=None, min_length=1, max_length=128)
    description: str = Field(default="", max_length=512)

    @field_validator("url")
    @classmethod
    def valid_url(cls, value: str | None) -> str | None:
        if value is None:
            return None
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError("route must be an HTTP(S) URL")
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("route URLs cannot contain credentials, query strings or fragments")
        return value.rstrip("/")


class Client(BaseModel):
    model_config = ConfigDict(extra="forbid")
    token_env: str
    call_targets: list[str]
    # Routes this credential may answer for. A Grok connector is account-wide, so
    # every Bot on that account shares one credential and answers its own route.
    reply_for: list[str] = Field(default_factory=list)


class Config(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: Literal[1] = 1
    local_agent: str = "hermes"
    host: Literal["127.0.0.1", "::1"] = "127.0.0.1"
    port: int = Field(default=8766, ge=1024, le=65535)
    public_url: str | None = None
    scan_seconds: float = Field(default=0.5, ge=0.05, le=60)
    poll_seconds: float = Field(default=1, ge=0.01, le=60)
    routes: dict[str, Route] = Field(
        default_factory=lambda: {
            "hermes": Route(kind="hermes", url="http://127.0.0.1:8642", token_env="HERMES_API_KEY"),
            "grok": Route(kind="grok", token_env="GROK_WEBHOOK_KEY"),
        }
    )
    clients: dict[str, Client] = Field(
        default_factory=lambda: {
            "grok": Client(token_env="GROK_BRIDGE_TOKEN", call_targets=["hermes"]),
        }
    )

    def secret(self, root: Path, name: str) -> str | None:
        if value := os.environ.get(name):
            return value
        path = root / "secrets.json"
        values = json.loads(path.read_text()) if path.exists() else {}
        return values.get(name) or None

    def route_secret(self, root: Path, name: str) -> str | None:
        return self.secret(root, self.routes[name].token_env)

    def ready(self, root: Path, name: str) -> bool:
        return name in self.routes and bool(self.routes[name].url and self.route_secret(root, name))

    def allowed_hosts(self) -> list[str]:
        hosts = ["127.0.0.1:*", "localhost:*", "[::1]:*"]
        if self.public_url:
            parsed = urlsplit(self.public_url)
            if parsed.scheme != "https" or not parsed.hostname or parsed.path not in {"", "/"}:
                raise ValueError("public_url must be an HTTPS origin without a path")
            if parsed.username or parsed.password or parsed.query or parsed.fragment:
                raise ValueError("public_url must not contain credentials or a query")
            hosts.append(parsed.netloc)
        return hosts


def home(value: str | Path | None = None) -> Path:
    return (
        Path(value or os.environ.get("AGENT_SEND_HOME", "~/.agent-bridge")).expanduser().resolve()
    )


def load(root: Path) -> Config:
    path = root / "routes.json"
    if not path.exists():
        raise ValueError("Mailbox is not initialized. Run: agent-send init")
    return Config.model_validate_json(path.read_text())
