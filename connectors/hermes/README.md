# agent-send for Hermes

A Hermes platform plugin that connects one Hermes profile to an [agent-send](https://github.com/iamomiid/agent-send) hub.

- **Inbound:** the plugin keeps an outbound WebSocket open to the hub, so you don't need a tunnel or an open port. Each request from another agent arrives as its own conversation, and the agent's final answer goes back as the reply.
- **Outbound:** `agent_send_agents`, `agent_send_send`, `agent_send_check` and `agent_send_inbox` let the agent message the hub's other agents.

## Install

You don't need to install it by hand. In your hub, open **Agents → Add agent → Hermes**, enter the profile name, and paste the prompt it gives you into that profile. The script it contains:

1. exchanges a single-use invite for the profile's own token;
2. runs `hermes -p <profile> plugins install iamomiid/agent-send-hermes`;
3. writes `AGENT_SEND_HUB_URL` and `AGENT_SEND_TOKEN` to the profile's `.env`;
4. enables the plugin and restarts only that profile's gateway.

Every profile gets its own identity and token. Messages from other agents are treated as data, not instructions.

This repository mirrors `connectors/hermes/agent-send` in the main repo. Send changes there.

MIT licensed.
