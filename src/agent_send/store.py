"""One immutable request and reply per ID; bridge-owned mutable execution state."""

from __future__ import annotations

import asyncio
import fcntl
import hashlib
import json
import math
import os
import re
import tempfile
import time
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

ID = re.compile(r"r_[0-9a-f]{32}\Z")
NAME = re.compile(r"[a-z][a-z0-9_-]{0,63}\Z")
ACTIVE = {"queued", "dispatching", "running", "awaiting_reply", "unknown"}
TERMINAL = {"completed", "failed", "expired", "cancelled", "abandoned"}
MAX_MESSAGE = 32_768
MAX_RESULT = 65_536


class MailError(ValueError):
    pass


class Request(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    version: Literal[1] = 1
    id: str
    sender: str
    to: str
    message: str = Field(min_length=1, max_length=MAX_MESSAGE)
    created_at: float
    deadline_at: float

    @field_validator("id")
    @classmethod
    def valid_id(cls, value: str) -> str:
        return check_id(value)

    @field_validator("sender", "to")
    @classmethod
    def valid_name(cls, value: str) -> str:
        if not NAME.fullmatch(value):
            raise ValueError("invalid agent name")
        return value

    @field_validator("message")
    @classmethod
    def valid_message(cls, value: str) -> str:
        if not value.strip() or len(value.encode()) > MAX_MESSAGE:
            raise ValueError("message must be nonempty and at most 32 KiB")
        return value

    @field_validator("created_at", "deadline_at")
    @classmethod
    def finite_time(cls, value: float) -> float:
        if not math.isfinite(value):
            raise ValueError("invalid timestamp")
        return value

    @model_validator(mode="after")
    def deadline_window(self):
        if not 1 <= self.deadline_at - self.created_at <= 3600:
            raise ValueError("request deadline window must be 1–3600 seconds")
        return self


def check_id(value: str) -> str:
    if not ID.fullmatch(value):
        raise MailError("invalid request ID")
    return value


def atomic_json(path: Path, value: Any) -> None:
    """Commit a complete JSON file; temp and destination must share a filesystem."""
    data = (json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2) + "\n").encode()
    fd, temp = tempfile.mkstemp(prefix=".tmp-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


class Store:
    def __init__(self, root: Path):
        self.root = root
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        for name in ("requests", "state", "replies"):
            path = root / name
            if path.is_symlink():
                raise MailError("mailbox directories cannot be symlinks")
            path.mkdir(exist_ok=True, mode=0o700)

    @contextmanager
    def lock(self) -> Iterator[None]:
        fd = os.open(self.root / ".store.lock", os.O_CREAT | os.O_RDWR, 0o600)
        with os.fdopen(fd, "a") as stream:
            fcntl.flock(stream, fcntl.LOCK_EX)
            yield

    @contextmanager
    def bridge_lock(self) -> Iterator[None]:
        fd = os.open(self.root / ".bridge.lock", os.O_CREAT | os.O_RDWR, 0o600)
        with os.fdopen(fd, "a") as stream:
            try:
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise MailError("another bridge already owns this mailbox") from None
            yield

    def path(self, folder: str, request_id: str) -> Path:
        path = self.root / folder / f"{check_id(request_id)}.json"
        if path.is_symlink():
            raise MailError("mailbox records cannot be symlinks")
        return path

    def request(self, request_id: str) -> Request:
        try:
            path = self.path("requests", request_id)
            if path.stat().st_size > MAX_MESSAGE * 6 + 2048:
                raise MailError("request file too large")
            request = Request.model_validate_json(path.read_text())
            if request.id != request_id:
                raise MailError("request ID does not match its filename")
            return request
        except FileNotFoundError:
            raise MailError("request not found") from None

    def state(self, request_id: str) -> dict[str, Any]:
        path = self.path("state", request_id)
        value = json.loads(path.read_text()) if path.exists() else {"status": "queued"}
        if not isinstance(value, dict) or value.get("status") not in ACTIVE | TERMINAL:
            raise MailError("invalid execution state; inspect the state file before continuing")
        return value

    def update(self, request_id: str, **changes: Any) -> dict[str, Any]:
        with self.lock():
            current = self.state(request_id)
            # A fast callback/expiry must not be regressed by a late HTTP acknowledgment.
            if current["status"] in TERMINAL and changes.get("status") != current["status"]:
                return current
            state = current | changes | {"updated_at": time.time()}
            atomic_json(self.path("state", request_id), state)
            return state

    def requests(self) -> Iterator[Request]:
        for path in sorted((self.root / "requests").glob("r_*.json")):
            if not ID.fullmatch(path.stem):
                continue
            try:
                request = self.request(path.stem)
                self.state(path.stem)  # Invalid state must not cause accidental re-execution.
                yield request
            except (ValueError, OSError):
                # Ignore incomplete/invalid files, never hand their text to an agent.
                continue

    def _would_cycle(self, sender: str, to: str) -> bool:
        graph: dict[str, set[str]] = {}
        for request in self.requests():
            if self.path("replies", request.id).exists():
                continue
            if self.state(request.id)["status"] in ACTIVE and request.deadline_at > time.time():
                graph.setdefault(request.sender, set()).add(request.to)
        seen, todo = set(), [to]
        while todo:
            name = todo.pop()
            if name == sender:
                return True
            if name not in seen:
                seen.add(name)
                todo.extend(graph.get(name, ()))
        return False

    def submit(
        self, sender: str, to: str, message: str, *, deadline: float = 300, key: str | None = None
    ) -> Request:
        if not math.isfinite(deadline) or not 1 <= deadline <= 3600:
            raise MailError("deadline must be between 1 and 3600 seconds")
        if key is not None and (not key or len(key) > 128 or not key.isprintable()):
            raise MailError("idempotency key must be 1–128 printable characters")
        request_id = "r_" + (
            hashlib.sha256(f"{sender}\0{key}".encode()).hexdigest()[:32]
            if key
            else uuid.uuid4().hex
        )
        now = time.time()
        request = Request(
            id=request_id,
            sender=sender,
            to=to,
            message=message,
            created_at=now,
            deadline_at=now + deadline,
        )
        with self.lock():
            if self.path("requests", request_id).exists():
                old = self.request(request_id)
                if (old.sender, old.to, old.message) != (sender, to, message):
                    raise MailError("idempotency key already used for a different request")
                return old
            if self._would_cycle(sender, to):
                raise MailError(
                    "call would create a circular wait; finish the current exchange first"
                )
            atomic_json(self.path("requests", request_id), request.model_dump())
        return request

    def finish(
        self, request_id: str, result: str, *, sender: str | None = None, status: str = "completed"
    ) -> dict[str, Any]:
        if not isinstance(result, str) or len(result.encode()) > MAX_RESULT:
            raise MailError("result must be text of at most 64 KiB")
        with self.lock():
            request = self.request(request_id)
            state = self.state(request_id)
            if sender is not None and (
                request.to != sender
                or state["status"]
                not in {"dispatching", "awaiting_reply", "unknown", "expired", "completed"}
            ):
                raise MailError("request is not assigned to this caller")
            path = self.path("replies", request_id)
            if path.exists():
                reply = json.loads(path.read_text())
                if reply["result"] != result or reply["outcome"] != status:
                    raise MailError("request already has a different result")
                return reply
            if state["status"] in {"cancelled", "abandoned", "failed"}:
                raise MailError("request is already closed")
            now = time.time()
            late = now > request.deadline_at or state["status"] == "expired"
            reply = {
                "request_id": request_id,
                "outcome": status,
                "result": result,
                "completed_at": now,
                "late": late,
            }
            atomic_json(path, reply)
            atomic_json(
                self.path("state", request_id),
                state
                | {
                    "status": "expired" if late else status,
                    "updated_at": now,
                },
            )
            return reply

    def result(self, request_id: str, *, sender: str | None = None) -> dict[str, Any]:
        request = self.request(request_id)
        if sender is not None and request.sender != sender:
            raise MailError("request not found")
        state = self.state(request_id)
        path = self.path("replies", request_id)
        if path.exists():
            reply = json.loads(path.read_text())
            return {
                "request_id": request_id,
                "status": "expired" if reply["late"] else reply["outcome"],
                "result": reply["result"],
                "late": reply["late"],
            }
        status = state["status"]
        if request.deadline_at <= time.time() and status not in TERMINAL:
            status = "expired"
        value = {"request_id": request_id, "status": status}
        if state.get("error"):
            value["error"] = state["error"]
        return value

    async def wait(
        self, request_id: str, seconds: float, *, sender: str | None = None
    ) -> dict[str, Any]:
        if not math.isfinite(seconds) or not 0 <= seconds <= 3600:
            raise MailError("wait must be between 0 and 3600 seconds")
        end = time.monotonic() + seconds
        while True:
            result = self.result(request_id, sender=sender)
            if result["status"] in TERMINAL | {"unknown"} or time.monotonic() >= end:
                if result["status"] in {"queued", "dispatching", "running", "awaiting_reply"}:
                    result["state"] = result["status"]
                    result["status"] = "pending"
                return result
            await asyncio.sleep(min(0.1, max(0, end - time.monotonic())))
