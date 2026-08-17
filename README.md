# Live Preview MCP Server

**Version 1.1** (post red-team hardening) — Production-grade Model Context Protocol server that lets any MCP-capable AI assistant start, manage, and embed live application previews in an iframe.

## Security Hardening (v1.1)

- **No shell injection**: Docker and process spawn always use argument arrays (`shell: false`).
- **Safe environment**: Only an explicit allow-list of env vars is passed; dangerous keys (`NODE_OPTIONS`, `LD_PRELOAD`, etc.) are stripped.
- **Symlink-safe path checks**: `realpathSync` before allow-list validation.
- **WebSocket rate limiting** + per-preview connection caps.
- **Process-liveness readiness**: readiness probe also verifies the child process is still alive.
- **Concurrent preview limit** (default 10).
- **Docker**: `CapDrop: ALL`, `no-new-privileges`, non-root user where possible, AutoRemove + startup orphan reaper.
- **Stronger log redaction** (JWT, AWS keys, GitHub/Slack/OpenAI tokens, etc.).
- **Token length increased** to 32 random bytes.

## Features

- MCP Tools: `start_preview`, `stop_preview`, `get_preview_status`, `get_preview_logs`, `list_previews`, `reload_preview`, `update_preview_config`, `share_preview`, `get_mobile_qr`, `set_auth_token`
- Framework Auto-Detection: Vite, Next.js, CRA, Vue, Angular, Express, static, Expo, Flutter
- HTTP Dashboard + Reverse Proxy with framing headers removed
- Optional Docker, Cloudflare/ngrok tunnels, mobile QR, token auth, Cloud-IDE awareness

## Requirements

- Node.js ≥ 18
- Optional: Docker, `cloudflared`, `ngrok`

## Install & Build

```bash
cd live-preview-mcp
npm install
npm run build
```

## Run

```bash
node dist/index.js
```

## MCP Client Configuration

```json
{
  "mcpServers": {
    "live-preview": {
      "command": "node",
      "args": ["/absolute/path/to/live-preview-mcp/dist/index.js"],
      "env": {
        "PORT": "9000",
        "ALLOWED_DIRS": "/path/to/projects"
      }
    }
  }
}
```

## License

MIT
