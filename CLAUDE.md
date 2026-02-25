# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**claude-remote-plus** is a daemon + MCP server that orchestrates Claude Code remote-control sessions. It manages one active `claude remote-control` session at a time, with the ability to hot-swap between pre-configured projects via MCP tools — directly from a remote session on claude.ai/code or the Claude mobile app.

### Core Concept

Claude Code's remote-control feature limits each process to one remote session. This tool embraces that constraint: a persistent daemon manages a pool of configured projects and swaps the active remote session on demand. The daemon exposes itself as an MCP server (SSE over HTTP), so switching is done from within the remote session itself.

## Architecture

```
┌──────────────────────────────────────────────────┐
│  claude-remote-plus (single process)              │
│  HTTP server on localhost:24880                   │
│                                                   │
│  ┌─────────────┐  ┌───────────────────────────┐  │
│  │ MCP Server   │  │ Session Manager            │  │
│  │ (SSE on /sse)│  │ spawn/kill claude          │  │
│  │              │  │ remote-control processes    │  │
│  │ + REST API   │  │                            │  │
│  │ (for CLI)    │  │ Health Monitor              │  │
│  │ /api/switch  │  │ auto-restart on crash       │  │
│  │ /api/list    │  │                            │  │
│  │ /api/status  │  │ Config Manager              │  │
│  │ etc.         │  │ read/write config.json      │  │
│  └─────────────┘  └───────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

**Session switching flow:**
1. User invokes `remote_switch` MCP tool from remote session (phone/browser)
2. Daemon gracefully stops current `claude remote-control` process
3. Daemon spawns new `claude remote-control` in target project directory
4. New session appears in claude.ai/code session list

## Tech Stack

- **Runtime:** Node.js (>=18) with TypeScript (ESM)
- **MCP SDK:** `@modelcontextprotocol/sdk` (SSE transport)
- **HTTP:** Express 5
- **Validation:** Zod
- **Testing:** Vitest
- **Process management:** Node.js `child_process.spawn`
- **Daemon management:** Manual start + optional auto-start (macOS launchd, Linux systemd, Windows startup)

## Project Structure

```
src/
├── types.ts              # Shared TypeScript types (zod schemas)
├── constants.ts          # Paths, defaults, port
├── logger.ts             # Log to file + stderr
├── config.ts             # Config file read/write with zod validation
├── session-manager.ts    # Spawns/kills claude remote-control processes
├── health-monitor.ts     # Periodic health checks, auto-restart
├── server.ts             # HTTP server: SSE MCP endpoint + REST API for CLI
├── cli.ts                # CLI command handlers
└── platform.ts           # Platform-specific auto-start (launchd/systemd/Windows)
bin/
└── crp.ts                # Shebang entry point (routes to server or CLI)
test/
├── config.test.ts
├── session-manager.test.ts
├── health-monitor.test.ts
└── server.test.ts
```

## Commands

```bash
# Install dependencies
npm install

# Build
npm run build

# Run in development (watch mode)
npm run dev

# Run tests
npm test

# Watch tests
npm run test:watch

# Type-check only
npm run lint
```

## MCP Tools Exposed

| Tool | Description |
|------|-------------|
| `remote_switch` | Switch active session to a different configured project |
| `remote_list` | List all configured projects with status |
| `remote_status` | Get current active session info (project, uptime, health) |
| `remote_add` | Register a new project (name + path + options) |
| `remote_remove` | Unregister a project |
| `remote_update` | Update a project's path or sandbox mode |
| `remote_restart` | Restart the current active session |
| `remote_logs` | View recent server logs for debugging |

## CLI Commands

| Command | Description |
|---------|-------------|
| `crp start [--project name] [--port PORT]` | Start daemon, optionally with initial project |
| `crp stop` | Stop daemon and active session |
| `crp status` | Show daemon + session status |
| `crp switch <name>` | Switch to a project |
| `crp list` | List configured projects |
| `crp add <name> <path> [--sandbox]` | Add project to config |
| `crp remove <name>` | Remove project from config |
| `crp update <name> [--path P] [--sandbox]` | Update project settings |
| `crp set-default <name>` | Set the default project |
| `crp restart` | Restart current session |
| `crp install` | Install as auto-start service |
| `crp uninstall` | Remove auto-start service |

## Configuration

Config lives at `~/.claude-remote-plus/config.json`:

```json
{
  "projects": [
    { "name": "my-app", "path": "/path/to/my-app", "sandbox": false }
  ],
  "defaultProject": "my-app",
  "healthCheckInterval": 30000,
  "autoRestart": true,
  "port": 24880
}
```

## MCP Integration Setup

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

This ensures every Claude Code session (including remote ones) has access to the switching tools.

## Key Design Decisions

- **SSE MCP transport** over stdio: SSE server is long-lived (HTTP), so MCP server IS the daemon — no separate IPC needed. CLI uses the same HTTP API.
- **Hot swap (one active session)** over session pool: saves resources, cleaner UX since remote users only see one session
- **Global MCP config** over per-project: switching tools must be available regardless of which project is active
- **Graceful shutdown**: SIGTERM to child process, wait 5s → SIGKILL — avoids orphaned processes
- **Mutex-protected switch**: rejects concurrent switch requests
- **Health checks via `process.kill(pid, 0)`**: detect crashes and auto-restart with backoff (max 5 restarts per 5 minutes)
