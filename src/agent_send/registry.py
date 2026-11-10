"""Automatic, credential-bound introductions without inference or public signup."""

from __future__ import annotations

import time
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from agent_send.config import Config
from agent_send.store import NAME, MailError, Store, atomic_json

Capability = Annotated[str, Field(min_length=1, max_length=64)]
Source = Literal["cli", "mcp", "hermes_api"]


class Introduction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    description: str = Field(default="", max_length=512)
    capabilities: list[Capability] = Field(default_factory=list, max_length=16)


class Agent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: Literal[1] = 1
    id: str
    origin: Literal["configured", "local"]
    runtime: Literal["hermes", "grok", "local", "mcp"]
    display_name: str
    description: str = ""
    registered_at: float
    last_seen_at: float | None = None
    last_seen_via: Source | None = None
    introduction: Introduction | None = None

    @field_validator("id")
    @classmethod
    def valid_id(cls, value: str) -> str:
        if not NAME.fullmatch(value):
            raise ValueError("invalid agent ID")
        return value


class Registry:
    def __init__(self, config: Config, store: Store):
        self.config, self.store = config, store
        self.directory = store.root / "agents"
        if self.directory.is_symlink():
            raise MailError("agent directory cannot be a symlink")
        self.directory.mkdir(exist_ok=True, mode=0o700)

    def _path(self, agent_id: str):
        if not NAME.fullmatch(agent_id):
            raise MailError("invalid agent ID")
        path = self.directory / f"{agent_id}.json"
        if path.is_symlink():
            raise MailError("agent records cannot be symlinks")
        return path

    def get(self, agent_id: str) -> Agent:
        path = self._path(agent_id)
        if path.stat().st_size > 16_384:
            raise MailError("agent record is too large")
        agent = Agent.model_validate_json(path.read_text())
        if agent.id != agent_id:
            raise MailError("agent ID does not match its filename")
        return agent

    def _configured_ids(self) -> set[str]:
        return set(self.config.routes) | set(self.config.clients) | {self.config.local_agent}

    def register(
        self,
        agent_id: str,
        *,
        source: Source | None = None,
        introduction: Introduction | None = None,
    ) -> Agent:
        """Upsert one trusted identity. Introductions cannot modify routes or permissions."""
        path = self._path(agent_id)
        configured = agent_id in self._configured_ids()
        if not configured and source != "cli":
            raise MailError("agent identity must be provisioned before a remote connection")
        with self.store.lock():
            old = self.get(agent_id) if path.exists() else None
            route = self.config.routes.get(agent_id)
            runtime = (
                route.kind if route else ("mcp" if agent_id in self.config.clients else "local")
            )
            now = time.time()
            agent = Agent(
                id=agent_id,
                origin="configured" if configured else "local",
                runtime=runtime,
                display_name=(route.display_name if route else None) or agent_id,
                description=route.description if route else "",
                registered_at=old.registered_at if old else now,
                last_seen_at=old.last_seen_at if old else None,
                last_seen_via=old.last_seen_via if old else None,
                introduction=introduction
                if introduction is not None
                else (old.introduction if old else None),
            )
            # Connection activity is not presence. Coalesce repeated requests to avoid
            # fsync on every HTTP frame; this performs no background heartbeat/inference.
            if source and (
                agent.last_seen_at is None
                or now - agent.last_seen_at >= 30
                or source != agent.last_seen_via
            ):
                agent.last_seen_at, agent.last_seen_via = now, source
            if old != agent:
                atomic_json(path, agent.model_dump())
            return agent

    def sync(self) -> None:
        for agent_id in sorted(self._configured_ids()):
            self.register(agent_id)

    def view(self, agent: Agent) -> dict:
        """Only safe directory metadata; never include callback URLs or credentials."""
        return agent.model_dump(exclude={"version", "origin"}) | {
            "can_receive": self.config.ready(self.store.root, agent.id),
        }

    def list_agents(self, *, caller: str | None = None) -> list[dict]:
        self.sync()
        visible = None
        if caller is not None:
            if caller not in self.config.clients:
                raise MailError("unknown authenticated caller")
            visible = {caller, *self.config.clients[caller].call_targets}
        configured = self._configured_ids()
        agents = []
        for path in sorted(self.directory.glob("*.json")):
            if visible is not None and path.stem not in visible:
                continue
            if not NAME.fullmatch(path.stem):
                continue
            try:
                agent = self.get(path.stem)
            except (ValueError, OSError):
                continue
            if agent.id not in configured and agent.origin != "local":
                continue  # Removed credentials/routes must not remain discoverable.
            agents.append(self.view(agent))
        return agents
