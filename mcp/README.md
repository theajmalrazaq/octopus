# Octopus MCP server

A small, zero-dependency MCP server that lets other AI assistants send
WhatsApp messages **as your Octopus bot** and look up the contacts and
groups it knows.

## Tools

| Tool | What it does |
|---|---|
| `octopus_status` | Is the bot connected to WhatsApp right now? |
| `octopus_list_contacts` | The contacts the bot has learned (name + number). |
| `octopus_list_groups` | The groups the bot is in, with their members. |
| `octopus_send_message` | Send a text (or voice note) as the bot to a contact name, group name, or phone number. Waits for the confirmed outcome by default; `wait: false` queues it fire-and-forget. |

## How it works

The MCP server never talks to WhatsApp directly. For low latency it
first calls the bot's direct send endpoint (`127.0.0.1:8766/send`,
token-authenticated, localhost only): the bot process — the only holder
of the WhatsApp socket — resolves the target exactly like its own
`send_message` tool and sends synchronously. If that endpoint does not
answer or the bot is disconnected, the send falls back to the durable
`outbox` table in the bot's SQLite database, which the bot drains every
second. Either way the outcome is recorded, so a sender can verify a
message actually went out.

## Setup

1. Copy `.env.example` to `.env` in this folder and set `MCP_TOKEN`
   to a long random value. The bot reads the same token from this file
   to enable its direct-send endpoint — without the file, the endpoint
   stays off and sends use the outbox queue only.
2. Run it: `node server.mjs` — or install `octopus-mcp.service`
   (repo root) as a systemd unit. It listens on port 8765
   (`MCP_PORT`/`MCP_HOST` override).
3. Point any MCP client at it (Streamable HTTP):

```json
{
  "mcpServers": {
    "octopus": {
      "url": "http://localhost:8765/mcp",
      "headers": { "Authorization": "Bearer YOUR_MCP_TOKEN" }
    }
  }
}
```

It can also run over stdio: `node server.mjs --stdio`.

## Exposure

The server binds `0.0.0.0` by default so other machines on your network
can reach it; the bearer token is the only gate, so treat it like a
password. If the bot only serves assistants on the same machine, set
`MCP_HOST=127.0.0.1`. Reaching it from outside your network (e.g. over a
VPN or an SSH tunnel) is up to your own infrastructure — the token
travels in the clear over plain HTTP, so tunnel it.
