import fs from 'node:fs';
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { SessionManager } from './session-manager.js';
import { HealthMonitor } from './health-monitor.js';
import { loadConfig, addProject, removeProject, updateProject, getProject } from './config.js';
import { initLogger, closeLogger, log } from './logger.js';
import type { AppConfig, ServerStatus } from './types.js';
import { paths, DEFAULT_PORT } from './constants.js';

let config: AppConfig;
let sessionManager: SessionManager;
let healthMonitor: HealthMonitor;
let httpServer: http.Server;
const startedAt = Date.now();

// Track SSE transports by session ID for message routing
const transports = new Map<string, SSEServerTransport>();

function createMcpServer(): McpServer {
  const mcp = new McpServer({
    name: 'claude-remote-plus',
    version: '0.1.0',
  });

  mcp.tool(
    'remote_switch',
    'Switch active remote session to a different configured project',
    { project: z.string().describe('Name of the project to switch to') },
    async ({ project }) => {
      try {
        const projectConfig = getProject(config, project);
        const state = await sessionManager.switch(projectConfig);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Switched to "${project}". Session URL: ${state.sessionUrl ?? 'pending'}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  mcp.tool('remote_list', 'List all configured projects with status', async () => {
    const state = sessionManager.getState();
    const lines = config.projects.map((p) => {
      const active = state?.projectName === p.name && state.status === 'running' ? ' [ACTIVE]' : '';
      const isDefault = config.defaultProject === p.name ? ' (default)' : '';
      return `- ${p.name}: ${p.path}${active}${isDefault}${p.sandbox ? ' [sandbox]' : ''}`;
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: lines.length > 0 ? lines.join('\n') : 'No projects configured. Use remote_add to add one.',
        },
      ],
    };
  });

  mcp.tool('remote_status', 'Get current active session info', async () => {
    const state = sessionManager.getState();
    const status: ServerStatus = {
      running: true,
      uptime: Date.now() - startedAt,
      session: state,
      config,
    };

    const sessionInfo = state
      ? `Project: ${state.projectName}\nStatus: ${state.status}\nPID: ${state.pid}\nURL: ${state.sessionUrl ?? 'N/A'}\nUptime: ${Math.round((Date.now() - state.startedAt.getTime()) / 1000)}s\nRestarts: ${state.restartCount}`
      : 'No active session';

    return {
      content: [
        {
          type: 'text' as const,
          text: `Server uptime: ${Math.round(status.uptime / 1000)}s\n\n${sessionInfo}`,
        },
      ],
    };
  });

  mcp.tool(
    'remote_add',
    'Register a new project',
    {
      name: z.string().describe('Project name'),
      path: z.string().describe('Absolute path to project directory'),
      sandbox: z.boolean().optional().describe('Run in sandbox mode'),
    },
    async ({ name, path, sandbox }) => {
      try {
        config = addProject(config, { name, path, sandbox: sandbox ?? false });
        return {
          content: [{ type: 'text' as const, text: `Added project "${name}" at ${path}` }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  mcp.tool(
    'remote_remove',
    'Unregister a project',
    { name: z.string().describe('Project name to remove') },
    async ({ name }) => {
      try {
        const state = sessionManager.getState();
        if (state?.projectName === name && state.status === 'running') {
          await sessionManager.stop();
        }
        config = removeProject(config, name);
        return {
          content: [{ type: 'text' as const, text: `Removed project "${name}"` }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  mcp.tool(
    'remote_update',
    'Update a project configuration (path or sandbox mode)',
    {
      name: z.string().describe('Project name to update'),
      path: z.string().optional().describe('New absolute path to project directory'),
      sandbox: z.boolean().optional().describe('Enable or disable sandbox mode'),
    },
    async ({ name, path, sandbox }) => {
      try {
        config = updateProject(config, name, { path, sandbox });
        const project = getProject(config, name);
        return {
          content: [{ type: 'text' as const, text: `Updated project "${name}": path=${project.path}, sandbox=${project.sandbox}` }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  mcp.tool('remote_restart', 'Restart the current active session', async () => {
    try {
      const state = sessionManager.getState();
      if (!state) {
        return {
          content: [{ type: 'text' as const, text: 'No active session to restart' }],
          isError: true,
        };
      }
      const project = getProject(config, state.projectName);
      // Use restart() for manual restart (doesn't increment restartCount)
      const newState = await sessionManager.restart(project);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Restarted "${newState.projectName}". Session URL: ${newState.sessionUrl ?? 'pending'}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  });

  mcp.tool(
    'remote_logs',
    'View recent server logs for debugging (e.g. crash reasons, restart history)',
    { lines: z.number().int().positive().default(50).describe('Number of recent log lines to return') },
    async ({ lines }) => {
      try {
        const content = fs.readFileSync(paths.LOG_FILE, 'utf-8');
        const allLines = content.trimEnd().split('\n');
        const tail = allLines.slice(-lines);
        return {
          content: [{ type: 'text' as const, text: tail.length > 0 ? tail.join('\n') : 'No logs found.' }],
        };
      } catch {
        return {
          content: [{ type: 'text' as const, text: 'No log file found.' }],
        };
      }
    },
  );

  return mcp;
}

function createApp(): express.Express {
  const app = express();
  app.use(express.json());

  // --- MCP SSE endpoint ---
  app.get('/sse', async (req: Request, res: Response) => {
    log.info('SSE client connected');
    const mcp = createMcpServer();
    const transport = new SSEServerTransport('/messages', res);
    transports.set(transport.sessionId, transport);

    res.on('close', () => {
      log.info('SSE client disconnected', { sessionId: transport.sessionId });
      transports.delete(transport.sessionId);
    });

    try {
      await transport.start();
      await mcp.connect(transport);
    } catch (err) {
      log.error('SSE connection error', { error: String(err) });
      transports.delete(transport.sessionId);
      // Response may already have SSE headers written; close gracefully
      if (!res.writableEnded) {
        res.end();
      }
    }
  });

  app.post('/messages', async (req: Request, res: Response) => {
    const sessionId = req.query.sessionId as string;
    const transport = transports.get(sessionId);
    if (!transport) {
      res.status(400).json({ error: 'Unknown session ID' });
      return;
    }
    await transport.handlePostMessage(req, res, req.body);
  });

  // --- REST API for CLI ---
  app.get('/api/status', (_req: Request, res: Response) => {
    const state = sessionManager.getState();
    const status: ServerStatus = {
      running: true,
      uptime: Date.now() - startedAt,
      session: state,
      config,
    };
    res.json(status);
  });

  app.get('/api/list', (_req: Request, res: Response) => {
    const state = sessionManager.getState();
    res.json({
      projects: config.projects,
      activeProject: state?.projectName ?? null,
      activeStatus: state?.status ?? null,
      defaultProject: config.defaultProject ?? null,
    });
  });

  app.post('/api/switch', async (req: Request, res: Response) => {
    const { project } = req.body as { project: string };
    if (!project) {
      res.status(400).json({ error: 'Missing "project" field' });
      return;
    }
    try {
      const projectConfig = getProject(config, project);
      const state = await sessionManager.switch(projectConfig);
      res.json({ ok: true, session: state });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/api/add', async (req: Request, res: Response) => {
    const { name, path, sandbox } = req.body as { name: string; path: string; sandbox?: boolean };
    if (!name || !path) {
      res.status(400).json({ error: 'Missing "name" or "path" field' });
      return;
    }
    try {
      config = addProject(config, { name, path, sandbox: sandbox ?? false });
      res.json({ ok: true, projects: config.projects });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/api/remove', async (req: Request, res: Response) => {
    const { name } = req.body as { name: string };
    if (!name) {
      res.status(400).json({ error: 'Missing "name" field' });
      return;
    }
    try {
      const state = sessionManager.getState();
      if (state?.projectName === name && state.status === 'running') {
        await sessionManager.stop();
      }
      config = removeProject(config, name);
      res.json({ ok: true, projects: config.projects });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/api/update', async (req: Request, res: Response) => {
    const { name, path, sandbox } = req.body as { name: string; path?: string; sandbox?: boolean };
    if (!name) {
      res.status(400).json({ error: 'Missing "name" field' });
      return;
    }
    try {
      config = updateProject(config, name, { path, sandbox });
      res.json({ ok: true, project: getProject(config, name) });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/api/restart', async (_req: Request, res: Response) => {
    try {
      const state = sessionManager.getState();
      if (!state) {
        res.status(400).json({ error: 'No active session to restart' });
        return;
      }
      const project = getProject(config, state.projectName);
      // Use restart() for manual restart (doesn't increment restartCount)
      const newState = await sessionManager.restart(project);
      res.json({ ok: true, session: newState });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/api/stop', async (_req: Request, res: Response) => {
    res.json({ ok: true, message: 'Server shutting down' });
    await gracefulShutdown();
  });

  return app;
}

async function gracefulShutdown(): Promise<void> {
  log.info('Shutting down...');
  healthMonitor.stop();
  await sessionManager.stop();

  // Close all SSE connections
  for (const transport of transports.values()) {
    await transport.close();
  }
  transports.clear();

  httpServer.close();
  removePidFile();
  closeLogger();
  process.exit(0);
}

function writePidFile(): void {
  fs.writeFileSync(paths.PID_FILE, String(process.pid), 'utf-8');
}

function removePidFile(): void {
  try {
    fs.unlinkSync(paths.PID_FILE);
  } catch {
    // Ignore if already removed
  }
}

export async function startServer(opts: { port?: number; project?: string } = {}): Promise<void> {
  initLogger({ stderr: true });
  config = loadConfig();

  const port = opts.port ?? config.port ?? DEFAULT_PORT;

  sessionManager = new SessionManager();
  healthMonitor = new HealthMonitor(sessionManager, {
    getConfig: () => config,
    getProject: (name) => config.projects.find((p) => p.name === name),
  });

  const app = createApp();
  httpServer = http.createServer(app);

  await new Promise<void>((resolve, reject) => {
    httpServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} is already in use. Is another instance running? Try --port to use a different port.`));
      } else {
        reject(err);
      }
    });
    httpServer.listen(port, '127.0.0.1', () => resolve());
  });

  writePidFile();
  healthMonitor.start();

  log.info('Server started', { port, pid: process.pid });
  console.log(`claude-remote-plus server running on http://127.0.0.1:${port}`);
  console.log(`MCP SSE endpoint: http://127.0.0.1:${port}/sse`);

  // Start initial project session if specified
  const projectName = opts.project ?? config.defaultProject;
  if (projectName) {
    try {
      const project = getProject(config, projectName);
      const state = await sessionManager.start(project);
      console.log(`Session started for "${projectName}": ${state.sessionUrl ?? 'URL pending...'}`);
    } catch (err) {
      console.error(`Failed to start session for "${projectName}": ${(err as Error).message}`);
    }
  }

  // Signal handlers
  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);
}

export { config, sessionManager, healthMonitor };
