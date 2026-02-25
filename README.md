# claude-remote-plus

Hot-swap Claude Code remote sessions between projects from your phone. A daemon + MCP server that manages `claude remote-control` processes with auto-restart, health monitoring, and project switching — all controllable via MCP tools from within the remote session itself.

## Why?

Claude Code's `remote-control` feature lets you code from your phone or browser, but each process handles only one session. If you work across multiple projects, you'd need to SSH in and manually restart. **claude-remote-plus** fixes this:

- A persistent daemon manages your project pool
- Switch projects from the remote session itself (no SSH needed)
- Health monitoring auto-restarts crashed sessions
- Works from phone, tablet, or any browser

## Quick Start

```bash
# Install
npm install -g claude-remote-plus

# Add your projects
crp add my-app ~/projects/my-app
crp add api-server ~/projects/api-server

# Start the daemon
crp start --project my-app

# Check status (shows session URL)
crp status
```

Open the session URL on your phone. You're in.

## Switching Projects

### From the remote session (phone/browser)

Just ask Claude to use the MCP tools:

> "Switch to api-server"
> "List my projects"
> "Show me the server logs"

Claude will call `remote_switch`, `remote_list`, `remote_logs` etc. automatically.

### From the terminal

```bash
crp switch api-server
crp list
crp status
```

## MCP Setup

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "claude-remote-plus": {
      "url": "http://localhost:24880/sse"
    }
  }
}
```

This gives every Claude Code session (including remote ones) access to the switching tools.

## CLI Commands

| Command | Description |
|---------|-------------|
| `crp start [--project name] [--port PORT]` | Start the daemon |
| `crp stop` | Stop the daemon |
| `crp status` | Show server and session status |
| `crp switch <name>` | Switch to a project |
| `crp list` | List configured projects |
| `crp add <name> <path> [--sandbox]` | Add a project |
| `crp remove <name>` | Remove a project |
| `crp update <name> [--path P] [--sandbox]` | Update project settings |
| `crp set-default <name>` | Set the default project |
| `crp restart` | Restart current session |
| `crp install` | Install as auto-start service |
| `crp uninstall` | Remove auto-start service |

## MCP Tools

Available from within any connected Claude Code session:

| Tool | Description |
|------|-------------|
| `remote_switch` | Switch to a different project |
| `remote_list` | List all projects with status |
| `remote_status` | Current session info |
| `remote_add` | Register a new project |
| `remote_remove` | Unregister a project |
| `remote_update` | Update project path or sandbox mode |
| `remote_restart` | Restart current session |
| `remote_logs` | View recent server logs |

## Configuration

Config lives at `~/.claude-remote-plus/config.json`:

```json
{
  "projects": [
    { "name": "my-app", "path": "/home/user/projects/my-app", "sandbox": false },
    { "name": "api-server", "path": "/home/user/projects/api-server", "sandbox": true }
  ],
  "defaultProject": "my-app",
  "healthCheckInterval": 30000,
  "autoRestart": true,
  "port": 24880
}
```

## Auto-Start on Login

```bash
# macOS (launchd)
crp install

# Also works on Linux (systemd) and Windows (startup script)
```

Remove with `crp uninstall`.

## How It Works

```
┌──────────────────────────────────────────┐
│  claude-remote-plus daemon               │
│  HTTP server on localhost:24880          │
│                                          │
│  MCP Server (SSE) ──── Claude sessions   │
│  REST API ──────────── CLI (crp)         │
│  Session Manager ───── claude processes  │
│  Health Monitor ────── auto-restart      │
└──────────────────────────────────────────┘
```

1. The daemon runs as a background HTTP server
2. It spawns `claude remote-control` as a child process in the target project directory
3. MCP tools and REST API both control the same session manager
4. Health monitor watches for crashes and auto-restarts with backoff (max 5 restarts per 5 minutes)
5. Log rotation keeps `~/.claude-remote-plus/server.log` under 10MB

## Requirements

- Node.js >= 18
- [Claude Code CLI](https://claude.ai/code) installed and authenticated

## Development

```bash
npm install
npm run build
npm test
npm run dev    # watch mode
```

## License

MIT
