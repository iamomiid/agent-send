"""agent-send platform adapter: dials out to the hub over a WebSocket and turns each
delivered request into its own Hermes conversation. The agent's final answer for that
conversation goes back to the hub as the reply. No inbound port or tunnel is involved.

Protocol (docs/connector-protocol.md): hub → welcome | deliver | replied | error | pong;
adapter → ack | reply | fail | ping.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import random
from collections import OrderedDict, deque
from typing import Any, Optional

from gateway.config import Platform
from gateway.platforms._shared import get_scoped_secret
from gateway.platforms.base import BasePlatformAdapter, SendResult
from gateway.platforms.event import MessageEvent, MessageType, ProcessingOutcome

logger = logging.getLogger(__name__)

VERSION = "0.1.0"


def check_requirements() -> bool:
    try:
        import websockets.asyncio.client  # noqa: F401
    except Exception:
        return False
    return True


def is_connected(config) -> bool:
    """Configured when enabled in config or the profile's own scope has a token."""
    extra = getattr(config, "extra", {}) or {}
    if extra.get("enabled") or getattr(config, "enabled", False):
        return True
    return bool(get_scoped_secret("AGENT_SEND_TOKEN", ""))


def _ws_url(hub_url: str) -> str:
    base = hub_url.rstrip("/")
    if base.startswith("https://"):
        return "wss://" + base[len("https://") :] + "/connect"
    if base.startswith("http://"):
        return "ws://" + base[len("http://") :] + "/connect"
    return base + "/connect"


def _frame(env: dict[str, Any]) -> str:
    sender = env.get("from") or {}
    who = f"{sender.get('name') or sender.get('handle')} (@{sender.get('handle')}, {sender.get('trust')})"
    kind = env.get("type")
    note = env.get("note", "")
    if kind == "request":
        head = f"[agent-send request from {who}]"
        tail = "Answer with your final result; it is sent back to the requesting agent automatically."
        if env.get("deadline_at"):
            tail += f" Deadline: {env['deadline_at']}."
    elif kind == "notify":
        head = f"[agent-send notification from {who}]"
        tail = "No reply is expected. Act on it only if it is clearly part of your normal job."
    else:
        head = f"[agent-send reply from {who} to your earlier request]"
        original = env.get("original_message") or ""
        tail = "This answers a request you sent earlier. Use it to finish whatever that request was for; nothing you write here is sent anywhere."
        if original:
            head += f"\nYour original request: {original}"
        if env.get("late"):
            tail = "This answer arrived after the deadline. " + tail
    return f"{head}\n{note}\n\n{env.get('message', '')}\n\n{tail}"


class AgentSendAdapter(BasePlatformAdapter):
    """Outbound WebSocket connector to an agent-send hub."""

    MAX_MESSAGE_LENGTH = 32_000

    def __init__(self, config, **kwargs):
        super().__init__(config=config, platform=Platform("agent_send"))
        # Read secrets now: construction runs inside the profile's scope.
        self._hub_url = (get_scoped_secret("AGENT_SEND_HUB_URL", "") or "").strip()
        self._token = (get_scoped_secret("AGENT_SEND_TOKEN", "") or "").strip()
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._task: Optional[asyncio.Task] = None
        self._ws = None
        self._stopping = False
        self._handle: Optional[str] = None
        # chat_id (hub thread) -> FIFO of request ids awaiting the agent's final answer
        self._pending: dict[str, deque[str]] = {}
        # message ids already handed to the agent (at-least-once delivery de-duplication)
        self._seen: OrderedDict[str, None] = OrderedDict()
        # frames that couldn't be sent while disconnected
        self._outbox: deque[str] = deque(maxlen=200)

    @property
    def name(self) -> str:
        return "agent-send"

    @property
    def authorization_is_upstream(self) -> bool:
        """The hub authenticates and authorises every sender; Hermes user allowlists don't apply."""
        return True

    # ------------------------------------------------------------- lifecycle

    async def connect(self, **_kwargs) -> bool:
        if not self._hub_url or not self._token:
            logger.error("agent-send: AGENT_SEND_HUB_URL and AGENT_SEND_TOKEN must be set in this profile's .env")
            self._set_fatal_error("not_configured", "agent-send is missing its hub URL or token", retryable=False)
            return False
        self._loop = asyncio.get_running_loop()
        self._stopping = False
        self._task = asyncio.create_task(self._run(), name="agent-send-ws")
        self._mark_connected()
        return True

    async def disconnect(self) -> None:
        self._stopping = True
        self._mark_disconnected()
        if self._ws is not None:
            with contextlib.suppress(Exception):
                await self._ws.close()
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(BaseException):
                await self._task

    async def _run(self) -> None:
        from websockets.asyncio.client import connect
        from websockets.exceptions import InvalidStatus

        delay = 1.0
        url = _ws_url(self._hub_url)
        while not self._stopping:
            try:
                async with connect(
                    url,
                    additional_headers={"Authorization": f"Bearer {self._token}"},
                    user_agent_header=f"agent-send-hermes/{VERSION}",
                    ping_interval=30,
                    ping_timeout=20,
                    max_size=2**20,
                ) as ws:
                    self._ws = ws
                    delay = 1.0
                    while self._outbox:
                        await ws.send(self._outbox.popleft())
                    async for raw in ws:
                        await self._on_frame(raw)
            except asyncio.CancelledError:
                raise
            except InvalidStatus as e:
                status = getattr(getattr(e, "response", None), "status_code", 0)
                if status in (401, 403):
                    logger.error("agent-send: the hub rejected this profile's token (HTTP %s). Rotate it in the hub UI.", status)
                    self._set_fatal_error("unauthorized", "agent-send token rejected", retryable=False)
                    return
                logger.warning("agent-send: hub refused the connection (HTTP %s); retrying", status)
            except Exception as e:  # network errors, closes
                logger.info("agent-send: connection lost (%s); reconnecting", e)
            finally:
                self._ws = None
            if self._stopping:
                return
            await asyncio.sleep(delay + random.random())
            delay = min(delay * 2, 60.0)

    async def _send_frame(self, frame: dict[str, Any]) -> None:
        data = json.dumps(frame)
        ws = self._ws
        if ws is None:
            self._outbox.append(data)
            return
        try:
            await ws.send(data)
        except Exception:
            self._outbox.append(data)

    # ------------------------------------------------------------- inbound

    async def _on_frame(self, raw: str | bytes) -> None:
        try:
            frame = json.loads(raw)
        except Exception:
            return
        kind = frame.get("type")
        if kind == "welcome":
            self._handle = frame.get("handle")
            logger.info("agent-send: connected to hub as @%s", self._handle)
        elif kind == "deliver":
            await self._on_deliver(frame)
        elif kind == "error":
            logger.warning("agent-send: hub error for %s: %s", frame.get("request_id"), frame.get("message"))

    async def _on_deliver(self, frame: dict[str, Any]) -> None:
        env = frame.get("envelope") or {}
        delivery_id = frame.get("delivery_id")
        message_id = str(env.get("message_id") or "")
        # Ack first: the hub only needs to know it arrived.
        await self._send_frame({"type": "ack", "delivery_id": delivery_id})
        if not message_id or message_id in self._seen:
            return
        self._seen[message_id] = None
        while len(self._seen) > 1000:
            self._seen.popitem(last=False)

        thread = str(env.get("thread") or message_id)
        sender = env.get("from") or {}
        if env.get("type") == "request":
            self._pending.setdefault(thread, deque()).append(message_id)
        event = MessageEvent(
            text=_frame(env),
            message_type=MessageType.TEXT,
            message_id=message_id,
            source=self.build_source(
                chat_id=thread,
                chat_name=f"agent-send:{sender.get('handle', 'agent')}",
                chat_type="dm",
                user_id=str(sender.get("handle") or "agent"),
                user_name=str(sender.get("name") or sender.get("handle") or "agent"),
            ),
        )
        await self.handle_message(event)

    # ------------------------------------------------------------- outbound (agent's answer)

    async def send(self, chat_id: str, content: str, reply_to: Optional[str] = None, metadata: Optional[dict[str, Any]] = None):
        """Only the final answer (metadata['notify']) completes a pending request."""
        if (metadata or {}).get("notify"):
            queue = self._pending.get(chat_id)
            if queue:
                request_id = queue.popleft()
                if not queue:
                    self._pending.pop(chat_id, None)
                await self._send_frame({"type": "reply", "request_id": request_id, "result": (content or "").strip() or "(empty answer)"})
        return SendResult(success=True, message_id=chat_id)

    async def on_processing_complete(self, event: MessageEvent, outcome: ProcessingOutcome) -> None:
        """Close out requests whose turn ended without a final send (failure, cancel, streamed reply)."""
        message_id = str(getattr(event, "message_id", "") or "")
        chat_id = getattr(getattr(event, "source", None), "chat_id", None)
        queue = self._pending.get(chat_id or "")
        if not queue or message_id not in queue:
            return
        queue.remove(message_id)
        if not queue:
            self._pending.pop(chat_id, None)
        if outcome == ProcessingOutcome.FAILURE:
            await self._send_frame({"type": "fail", "request_id": message_id, "error": "The Hermes agent failed while processing this request."})
        elif outcome == ProcessingOutcome.CANCELLED:
            await self._send_frame({"type": "fail", "request_id": message_id, "error": "The Hermes agent cancelled this request."})
        else:
            streamed = getattr(event, "_streamed_final_response", "")
            if isinstance(streamed, str) and streamed.strip():
                await self._send_frame({"type": "reply", "request_id": message_id, "result": streamed.strip()})
            else:
                await self._send_frame({"type": "fail", "request_id": message_id, "error": "The Hermes agent finished without an answer."})

    async def send_typing(self, chat_id: str, metadata=None) -> None:
        return None

    async def get_chat_info(self, chat_id: str) -> dict[str, Any]:
        return {"name": f"agent-send:{chat_id}", "type": "dm"}
