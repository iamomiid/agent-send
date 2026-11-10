# Exposing the bridge

Grok Bot runs in the cloud, so it needs a stable public HTTPS URL that forwards
to the bridge on `http://127.0.0.1:8766`. Expose **only the bridge**, never the
Hermes API or the mailbox directory. Every MCP request still needs the bridge's
bearer credential.

After choosing a hostname, run:

```sh
agent-send configure public --url https://agents.example.com
agent-send connector
```

Restart the bridge after changing the public URL. It is the one setting the
running bridge does not reload.

## Cloudflare Tunnel (recommended)

Add a public hostname to a **named** tunnel that routes to
`http://127.0.0.1:8766`
([docs](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/)).
Quick Tunnels change their hostname on each start, so they are not suitable. If
you put Cloudflare Access in front, Grok's machine calls need a non-interactive
way through, such as a service token.

## Tailscale Funnel

```sh
tailscale funnel --bg 8766
```

Use the `https://<machine>.<tailnet>.ts.net` URL it prints
([docs](https://tailscale.com/kb/1223/funnel)).

## ngrok

Use a reserved or static domain so the URL survives restarts:

```sh
ngrok http --url=agents.example.ngrok.app 8766
```

## Checking it

```sh
curl https://agents.example.com/health     # {"status": "ok", ...}, no auth needed
```

Requests to `/mcp` without the bearer token must return `401`.
