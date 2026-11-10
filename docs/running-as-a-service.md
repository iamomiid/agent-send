# Running as a service

The bridge must run for messages to flow. Both generators below only write a
private file; review it, then install it yourself.

## macOS (launchd)

```sh
agent-send launchd
cp ~/.agent-bridge/com.agent-send.bridge.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agent-send.bridge.plist
```

Logs go to `~/.agent-bridge/logs/`. Restart with
`launchctl kickstart -k gui/$(id -u)/com.agent-send.bridge`.

## Linux (systemd user service)

```sh
agent-send systemd
mkdir -p ~/.config/systemd/user
cp ~/.agent-bridge/agent-send.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now agent-send
loginctl enable-linger "$USER"   # keep it running after you log out
```

Logs: `journalctl --user -u agent-send -f`.

## When to restart

Route changes (`agent-send configure <agent-id> …`) and credential changes are
picked up automatically. Restart after upgrading Agent Send or changing the
public URL, host or port.
