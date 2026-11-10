"""Local file submission and explicit setup commands; never print credentials."""

from __future__ import annotations

import argparse
import asyncio
import getpass
import json
import math
import plistlib
import secrets
import sys
from pathlib import Path
from urllib.parse import urlsplit

from agent_send.config import Config, Route, home, load
from agent_send.registry import Introduction, Registry
from agent_send.store import NAME, MailError, Store, atomic_json


def output(value: object) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2))


def init(root: Path) -> None:
    store = Store(root)
    path = root / "routes.json"
    if not path.exists():
        atomic_json(path, Config().model_dump())
    path = root / "secrets.json"
    values = json.loads(path.read_text()) if path.exists() else {}
    if "GROK_BRIDGE_TOKEN" not in values:
        values["GROK_BRIDGE_TOKEN"] = secrets.token_urlsafe(32)
        atomic_json(path, values)
    Registry(load(root), store).sync()
    print(f"Mailbox ready: {root}\nConfigure the Hermes API and Grok webhook before sending.")


LOOPBACK = {"127.0.0.1", "localhost", "::1"}


def infer_kind(url: str | None) -> str:
    """A local API is Hermes; an HTTPS webhook is a Grok Bot routine."""
    if not url:
        raise MailError("provide --url for a new route")
    parsed = urlsplit(url)
    if parsed.hostname in LOOPBACK:
        return "hermes"
    if parsed.scheme == "https":
        return "grok"
    raise MailError("cannot tell the route kind from this URL; pass --kind")


def configure(root: Path, config: Config, args: argparse.Namespace) -> None:
    if args.target == "public":
        config.public_url = args.url.rstrip("/")
        config.allowed_hosts()  # Validate before changing the file.
    else:
        if not NAME.fullmatch(args.target):
            raise MailError("agent ID must be lowercase letters, digits, - or _ (max 64)")
        route = config.routes.get(args.target)
        kind = args.kind or (route.kind if route else infer_kind(args.url))
        if route and route.kind != kind:
            raise MailError("an existing route cannot change kind")
        env_prefix = "GROK_WEBHOOK_KEY" if kind == "grok" else "HERMES_API_KEY"
        token_env = (
            route.token_env if route else (f"{env_prefix}_{args.target.upper().replace('-', '_')}")
        )
        updated = Route(
            kind=kind,
            url=args.url or (route.url if route else None),
            token_env=token_env,
            display_name=args.name or (route.display_name if route else None),
            description=args.description
            if args.description is not None
            else (route.description if route else ""),
        )
        if not updated.url:
            raise MailError("provide --url for this route")
        parsed = urlsplit(updated.url)
        if updated.kind == "grok" and parsed.scheme != "https":
            raise MailError("Grok webhook must use HTTPS")
        if updated.kind == "hermes" and parsed.hostname not in LOOPBACK:
            raise MailError("v0 keeps the Hermes API on loopback")
        for client in args.allow_from or []:
            if client not in config.clients:
                raise MailError(f"unknown remote client {client!r}")
        values = json.loads((root / "secrets.json").read_text())
        if args.url or args.token_stdin or not values.get(token_env):
            if args.token_stdin:
                token = sys.stdin.read(8192).strip()
            else:
                token = getpass.getpass(f"{token_env} (hidden): ").strip()
            if not token or len(token) > 4096 or any(c.isspace() for c in token):
                raise MailError("provide one nonempty token without whitespace")
            values[token_env] = token
            atomic_json(root / "secrets.json", values)
        config.routes[args.target] = updated
        for client in args.allow_from or []:
            targets = config.clients[client].call_targets
            if args.target not in targets:
                targets.append(args.target)
        if kind == "grok" and args.target != "grok":
            # Every Grok Bot replies through the same account-wide connector credential.
            for name, client in config.clients.items():
                if name == "grok" and args.target not in client.reply_for:
                    client.reply_for.append(args.target)
    atomic_json(root / "routes.json", config.model_dump())
    Registry(config, Store(root)).sync()
    print(
        "Configuration saved. The running bridge applies route changes automatically"
        + (" (restart it to change the public URL)." if args.target == "public" else ".")
    )


def connector(root: Path, config: Config) -> None:
    if not config.public_url:
        raise MailError("configure a stable public HTTPS URL first")
    config.allowed_hosts()
    token = config.secret(root, config.clients["grok"].token_env)
    if not token:
        raise MailError("Grok bridge credential is missing; run init")
    path = root / "grok-connector.json"
    atomic_json(
        path,
        {
            "mcpServers": {
                "agent-send": {
                    "url": f"{config.public_url}/mcp",
                    "headers": {"Authorization": f"Bearer {token}"},
                }
            }
        },
    )
    print(
        f"Private connector settings written to {path}\n"
        "Contains a credential; do not commit or share."
    )


def launchd(root: Path, config: Config) -> None:
    logs = root / "logs"
    logs.mkdir(exist_ok=True, mode=0o700)
    path = root / "com.agent-send.bridge.plist"
    value = {
        "Label": "com.agent-send.bridge",
        "ProgramArguments": [sys.executable, "-m", "agent_send", "--home", str(root), "serve"],
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 10,
        "StandardOutPath": str(logs / "bridge.log"),
        "StandardErrorPath": str(logs / "bridge-error.log"),
        "EnvironmentVariables": {"PYTHONUNBUFFERED": "1"},
    }
    path.write_bytes(plistlib.dumps(value))
    path.chmod(0o600)
    print(f"LaunchAgent template written to {path}\nNot installed or started.")


def systemd(root: Path, config: Config) -> None:
    path = root / "agent-send.service"
    path.write_text(
        "[Unit]\n"
        "Description=Agent Send bridge\n"
        "After=network-online.target\n\n"
        "[Service]\n"
        f"ExecStart={sys.executable} -m agent_send --home {root} serve\n"
        "Restart=always\n"
        "RestartSec=10\n"
        "Environment=PYTHONUNBUFFERED=1\n\n"
        "[Install]\n"
        "WantedBy=default.target\n"
    )
    path.chmod(0o600)
    print(f"systemd user unit written to {path}\nNot installed or started.")


def doctor(root: Path, config: Config) -> None:
    output(
        {
            "mailbox": str(root),
            "local_agent": config.local_agent,
            "bridge_listen": f"{config.host}:{config.port}",
            "public_host": urlsplit(config.public_url).hostname if config.public_url else None,
            "routes": {
                name: {
                    "configured": config.ready(root, name),
                    "host": urlsplit(route.url).hostname if route.url else None,
                }
                for name, route in config.routes.items()
            },
            "remote_clients": {
                name: bool(config.secret(root, policy.token_env))
                for name, policy in config.clients.items()
            },
        }
    )


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Agent Send: let your agents talk to each other.")
    p.add_argument("--home", help="Mailbox directory (or AGENT_SEND_HOME)")
    subs = p.add_subparsers(dest="command", required=True)
    subs.add_parser("init", help="Create private mailbox and a remote credential")
    send = subs.add_parser("send", help="Write a request and wait for its answer")
    send.add_argument("to", help="Configured recipient ID (see agent-send agents)")
    send.add_argument("message", help="Request text, or - to read stdin")
    send.add_argument("--from", dest="sender", help="Local agent identity (trusted local user)")
    send.add_argument("--key", help="Reuse for retries of the same request")
    send.add_argument("--wait", type=float, default=25)
    send.add_argument("--deadline", type=float, default=300)
    wait = subs.add_parser("wait", help="Wait without submitting another request")
    wait.add_argument("request_id")
    wait.add_argument("--wait", type=float, default=25)
    status = subs.add_parser("status", help="Read one result or list request states")
    status.add_argument("request_id", nargs="?")
    abandon = subs.add_parser(
        "abandon", help="Acknowledge unknown outcome; never cancels remote work"
    )
    abandon.add_argument("request_id")
    subs.add_parser("serve", help="Run the loopback bridge (single process)")
    subs.add_parser("doctor", help="Report configuration without revealing credentials")
    subs.add_parser("agents", help="Discover registered agents and their introductions")
    register = subs.add_parser("register", help="Optionally introduce the local agent")
    register.add_argument("--from", dest="sender", help="Local identity (trusted local user)")
    register.add_argument("--description")
    register.add_argument("--capability", action="append")
    conf = subs.add_parser("configure", help="Configure one route; enter its token privately")
    conf.add_argument("target", help="Route ID (e.g. hermes, grok, creator-analyst) or public")
    conf.add_argument(
        "--kind",
        choices=["hermes", "grok"],
        help="Usually inferred: local URL = hermes, HTTPS webhook = grok",
    )
    conf.add_argument("--url")
    conf.add_argument("--name", help="Display name shown by agent_list")
    conf.add_argument("--description", help="Operator description shown by agent_list")
    conf.add_argument(
        "--allow-from",
        action="append",
        help="Remote client allowed to call this route (e.g. grok); repeatable",
    )
    conf.add_argument("--token-stdin", action="store_true")
    subs.add_parser("connector", help="Write private Grok connector settings to a local file")
    subs.add_parser("launchd", help="Write a macOS LaunchAgent template without starting it")
    subs.add_parser("systemd", help="Write a Linux systemd user unit without starting it")
    return p


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    # Convenient alias: agent-send grok "question" (global --home remains supported).
    index = 2 if len(argv) >= 2 and argv[0] == "--home" else 0
    if len(argv) > index and argv[index] in {"grok", "hermes"}:
        argv.insert(index, "send")
    args = parser().parse_args(argv)
    root = home(args.home)
    try:
        if args.command == "init":
            init(root)
            return 0
        config = load(root)
        store = Store(root)
        if args.command == "configure":
            if args.target == "public" and not args.url:
                raise MailError("public requires --url")
            configure(root, config, args)
        elif args.command == "connector":
            connector(root, config)
        elif args.command == "launchd":
            launchd(root, config)
        elif args.command == "systemd":
            systemd(root, config)
        elif args.command == "doctor":
            doctor(root, config)
        elif args.command == "agents":
            registry = Registry(config, store)
            registry.register(config.local_agent, source="cli")
            output(registry.list_agents())
        elif args.command == "register":
            registry = Registry(config, store)
            agent = registry.register(
                args.sender or config.local_agent,
                source="cli",
                introduction=(
                    Introduction(
                        description=args.description or "",
                        capabilities=args.capability or [],
                    )
                    if args.description is not None or args.capability is not None
                    else None
                ),
            )
            output(registry.view(agent))
        elif args.command in {"send", "wait"}:
            if not math.isfinite(args.wait) or not 0 <= args.wait <= 3600:
                raise MailError("wait must be between 0 and 3600 seconds")
            if args.command == "send":
                if not config.ready(root, args.to):
                    raise MailError(f"route {args.to!r} is not configured")
                message = sys.stdin.read(32_769) if args.message == "-" else args.message
                request = store.submit(
                    args.sender or config.local_agent,
                    args.to,
                    message,
                    deadline=args.deadline,
                    key=args.key,
                )
                Registry(config, store).register(request.sender, source="cli")
                request_id = request.id
            else:
                request_id = args.request_id
            value = asyncio.run(store.wait(request_id, args.wait))
            output(value)
            return {"completed": 0, "pending": 2}.get(value["status"], 3)
        elif args.command == "status":
            output(
                store.result(args.request_id)
                if args.request_id
                else [store.result(r.id) | {"from": r.sender, "to": r.to} for r in store.requests()]
            )
        elif args.command == "abandon":
            store.request(args.request_id)
            if store.state(args.request_id)["status"] != "unknown":
                raise MailError("only an unknown outcome can be abandoned")
            store.update(
                args.request_id,
                status="abandoned",
                error="operator acknowledged unknown outcome; remote work may still run",
            )
            output(store.result(args.request_id))
        elif args.command == "serve":
            import uvicorn

            from agent_send.server import create_app

            uvicorn.run(
                create_app(config, store),
                host=config.host,
                port=config.port,
                access_log=False,
                log_level="warning",
            )
        return 0
    except (ValueError, OSError) as exc:
        # Pydantic/config parse errors can contain secrets: show concise validation context only.
        from pydantic import ValidationError

        if isinstance(exc, ValidationError):
            message = "; ".join(
                ".".join(map(str, e["loc"])) + ": " + e["type"]
                for e in exc.errors(include_input=False)
            )
        elif isinstance(exc, json.JSONDecodeError):
            message = "invalid JSON in a mailbox/configuration file"
        else:
            message = str(exc)
        print(f"agent-send: {message}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
