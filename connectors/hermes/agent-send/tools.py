"""Outbound tools: let this Hermes profile message other agents on the hub."""

from __future__ import annotations

import json

from .client import call


def _agents(args: dict, **_kw) -> str:
    return json.dumps(call("GET", "/api/v1/agents"))


def _send(args: dict, **_kw) -> str:
    body = {k: args[k] for k in ("to", "message", "kind", "thread", "wait_seconds", "deadline_seconds") if args.get(k) not in (None, "")}
    body.setdefault("wait_seconds", 25)
    return json.dumps(call("POST", "/api/v1/send", body, timeout=float(body["wait_seconds"]) + 20))


def _check(args: dict, **_kw) -> str:
    body = {"task_id": args.get("task_id", ""), "wait_seconds": int(args.get("wait_seconds") or 0)}
    return json.dumps(call("POST", "/api/v1/check", body, timeout=float(body["wait_seconds"]) + 20))


def _inbox(args: dict, **_kw) -> str:
    since = args.get("since")
    return json.dumps(call("GET", "/api/v1/inbox" + (f"?since={int(since)}" if since is not None else "")))


def register_tools(ctx) -> None:
    ctx.register_tool(
        name="agent_send_agents",
        toolset="agent_send",
        emoji="\U0001f4c7",
        handler=_agents,
        schema={
            "name": "agent_send_agents",
            "description": "List the other AI agents you can message through your owner's agent-send hub (handle, name, description, runtime).",
            "parameters": {"type": "object", "properties": {}},
        },
    )
    ctx.register_tool(
        name="agent_send_send",
        toolset="agent_send",
        emoji="\U0001f4e8",
        handler=_send,
        schema={
            "name": "agent_send_send",
            "description": (
                "Send a message to another agent on the agent-send hub. kind='request' (default) waits up to wait_seconds (max 25) "
                "for the answer. If the result is still pending, keep the task_id and use agent_send_check later; never send the "
                "same request again. kind='notify' is one-way. Keep it focused and don't include credentials or unrelated private history."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "to": {"type": "string", "description": "Recipient handle from agent_send_agents."},
                    "message": {"type": "string", "description": "The question or task, and the output you want."},
                    "kind": {"type": "string", "enum": ["request", "notify"]},
                    "thread": {"type": "string", "description": "Continue an existing conversation."},
                    "wait_seconds": {"type": "integer", "minimum": 0, "maximum": 25},
                    "deadline_seconds": {"type": "integer", "minimum": 10, "maximum": 3600},
                },
                "required": ["to", "message"],
            },
        },
    )
    ctx.register_tool(
        name="agent_send_check",
        toolset="agent_send",
        emoji="⏳",
        handler=_check,
        schema={
            "name": "agent_send_check",
            "description": "Check on a request you sent earlier with agent_send_send, optionally waiting up to wait_seconds (max 25).",
            "parameters": {
                "type": "object",
                "properties": {"task_id": {"type": "string"}, "wait_seconds": {"type": "integer", "minimum": 0, "maximum": 25}},
                "required": ["task_id"],
            },
        },
    )
    ctx.register_tool(
        name="agent_send_inbox",
        toolset="agent_send",
        emoji="\U0001f4ec",
        handler=_inbox,
        schema={
            "name": "agent_send_inbox",
            "description": "Read agent-send messages addressed to you that you haven't seen (normally they arrive as their own conversations).",
            "parameters": {"type": "object", "properties": {"since": {"type": "integer", "minimum": 0}}},
        },
    )
