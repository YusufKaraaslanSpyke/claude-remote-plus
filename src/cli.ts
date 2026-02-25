import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { paths, DEFAULT_PORT } from './constants.js';
import { installService, uninstallService } from './platform.js';

function getPort(): number {
  const portArg = getArg('--port');
  if (portArg) return parseInt(portArg, 10);
  try {
    const config = loadConfig();
    return config.port ?? DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  return undefined;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function baseUrl(): string {
  return `http://127.0.0.1:${getPort()}`;
}

async function isServerRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl()}/api/status`);
    return res.ok;
  } catch {
    return false;
  }
}

function readPidFile(): number | null {
  try {
    const pid = parseInt(fs.readFileSync(paths.PID_FILE, 'utf-8').trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cleanStalePidFile(): void {
  const pid = readPidFile();
  if (pid !== null && !isProcessAlive(pid)) {
    try {
      fs.unlinkSync(paths.PID_FILE);
    } catch {
      // ignore
    }
  }
}

const API_TIMEOUT = 10_000; // 10 seconds

async function apiCall(method: string, path: string, body?: unknown): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT);
  
  try {
    const res = await fetch(`${baseUrl()}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error((data as { error: string }).error ?? `HTTP ${res.status}`);
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

// --- Commands ---

async function cmdStart(): Promise<void> {
  cleanStalePidFile();

  if (await isServerRunning()) {
    console.log('Server is already running.');
    return;
  }

  const project = getArg('--project');
  const port = getPort();

  // Find the bin entry point (which routes to server mode when given --port without a CLI command)
  const binPath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '../bin/crp.js',
  );

  // Check that the compiled entry point exists
  if (!fs.existsSync(binPath)) {
    console.error('Built entry point not found. Run `npm run build` first.');
    process.exit(1);
  }

  fs.mkdirSync(paths.APP_DIR, { recursive: true });
  const logPath = path.join(paths.APP_DIR, 'server.log');

  const out = fs.openSync(logPath, 'a');
  const err = fs.openSync(logPath, 'a');

  const args = [binPath, '--port', String(port)];
  if (project) args.push('--project', project);

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', out, err],
    env: { ...process.env },
  });

  child.unref();
  console.log(`Server starting (PID: ${child.pid}) on port ${port}...`);

  // Wait briefly and verify it started
  await new Promise((r) => setTimeout(r, 2000));
  if (await isServerRunning()) {
    console.log(`Server running at ${baseUrl()}`);
    console.log(`MCP SSE endpoint: ${baseUrl()}/sse`);
  } else {
    console.error('Server may have failed to start. Check logs at:', logPath);
  }
}

async function cmdStop(): Promise<void> {
  if (!(await isServerRunning())) {
    console.log('Server is not running.');
    return;
  }

  try {
    await apiCall('POST', '/api/stop');
    console.log('Server stopped.');
  } catch {
    // Server may have shut down before sending response
    console.log('Server stopped.');
  }
}

async function cmdStatus(): Promise<void> {
  if (!(await isServerRunning())) {
    console.log('Server is not running.');
    return;
  }

  const data = (await apiCall('GET', '/api/status')) as {
    uptime: number;
    session: {
      projectName: string;
      status: string;
      pid: number;
      sessionUrl: string | null;
      restartCount: number;
      startedAt: string;
    } | null;
  };

  console.log(`Server uptime: ${Math.round(data.uptime / 1000)}s`);
  console.log();

  if (data.session) {
    const s = data.session;
    console.log(`Active session:`);
    console.log(`  Project:  ${s.projectName}`);
    console.log(`  Status:   ${s.status}`);
    console.log(`  PID:      ${s.pid}`);
    console.log(`  URL:      ${s.sessionUrl ?? 'N/A'}`);
    console.log(`  Restarts: ${s.restartCount}`);
  } else {
    console.log('No active session.');
  }
}

async function cmdSwitch(): Promise<void> {
  const name = process.argv[3];
  if (!name) {
    console.error('Usage: crp switch <project-name>');
    process.exit(1);
  }

  if (!(await isServerRunning())) {
    console.error('Server is not running. Start it with: crp start');
    process.exit(1);
  }

  const data = (await apiCall('POST', '/api/switch', { project: name })) as {
    session: { projectName: string; sessionUrl: string | null };
  };

  console.log(`Switched to "${data.session.projectName}".`);
  if (data.session.sessionUrl) {
    console.log(`Session URL: ${data.session.sessionUrl}`);
  }
}

async function cmdList(): Promise<void> {
  if (!(await isServerRunning())) {
    // Fall back to reading config directly
    const config = loadConfig();
    if (config.projects.length === 0) {
      console.log('No projects configured.');
      return;
    }
    for (const p of config.projects) {
      const isDefault = config.defaultProject === p.name ? ' (default)' : '';
      console.log(`  ${p.name}: ${p.path}${isDefault}${p.sandbox ? ' [sandbox]' : ''}`);
    }
    return;
  }

  const data = (await apiCall('GET', '/api/list')) as {
    projects: Array<{ name: string; path: string; sandbox: boolean }>;
    activeProject: string | null;
    defaultProject: string | null;
  };

  if (data.projects.length === 0) {
    console.log('No projects configured. Add one with: crp add <name> <path>');
    return;
  }

  for (const p of data.projects) {
    const active = p.name === data.activeProject ? ' [ACTIVE]' : '';
    const isDefault = p.name === data.defaultProject ? ' (default)' : '';
    console.log(`  ${p.name}: ${p.path}${active}${isDefault}${p.sandbox ? ' [sandbox]' : ''}`);
  }
}

async function cmdAdd(): Promise<void> {
  const name = process.argv[3];
  const projectPath = process.argv[4];
  if (!name || !projectPath) {
    console.error('Usage: crp add <name> <path> [--sandbox]');
    process.exit(1);
  }

  const sandbox = hasFlag('--sandbox');
  const absPath = path.resolve(projectPath);

  if (await isServerRunning()) {
    await apiCall('POST', '/api/add', { name, path: absPath, sandbox });
  } else {
    // Modify config directly
    const { addProject } = await import('./config.js');
    let config = loadConfig();
    config = addProject(config, { name, path: absPath, sandbox });
  }
  console.log(`Added project "${name}" at ${absPath}`);
}

async function cmdRemove(): Promise<void> {
  const name = process.argv[3];
  if (!name) {
    console.error('Usage: crp remove <name>');
    process.exit(1);
  }

  if (await isServerRunning()) {
    await apiCall('POST', '/api/remove', { name });
  } else {
    const { removeProject } = await import('./config.js');
    let config = loadConfig();
    config = removeProject(config, name);
  }
  console.log(`Removed project "${name}"`);
}

async function cmdUpdate(): Promise<void> {
  const name = process.argv[3];
  if (!name) {
    console.error('Usage: crp update <name> [--path <new-path>] [--sandbox | --no-sandbox]');
    process.exit(1);
  }

  const newPath = getArg('--path');
  const sandbox = hasFlag('--sandbox') ? true : hasFlag('--no-sandbox') ? false : undefined;
  const absPath = newPath ? path.resolve(newPath) : undefined;

  if (absPath === undefined && sandbox === undefined) {
    console.error('Nothing to update. Use --path <new-path> and/or --sandbox / --no-sandbox');
    process.exit(1);
  }

  if (await isServerRunning()) {
    const data = (await apiCall('POST', '/api/update', { name, path: absPath, sandbox })) as {
      project: { name: string; path: string; sandbox: boolean };
    };
    console.log(`Updated project "${data.project.name}": path=${data.project.path}, sandbox=${data.project.sandbox}`);
  } else {
    const { updateProject } = await import('./config.js');
    let config = loadConfig();
    config = updateProject(config, name, { path: absPath, sandbox });
    const project = config.projects.find((p) => p.name === name)!;
    console.log(`Updated project "${project.name}": path=${project.path}, sandbox=${project.sandbox}`);
  }
}

async function cmdRestart(): Promise<void> {
  if (!(await isServerRunning())) {
    console.error('Server is not running. Start it with: crp start');
    process.exit(1);
  }

  const data = (await apiCall('POST', '/api/restart')) as {
    session: { projectName: string; sessionUrl: string | null };
  };

  console.log(`Restarted "${data.session.projectName}".`);
  if (data.session.sessionUrl) {
    console.log(`Session URL: ${data.session.sessionUrl}`);
  }
}

async function cmdInstall(): Promise<void> {
  await installService();
}

async function cmdUninstall(): Promise<void> {
  await uninstallService();
}

async function cmdSetDefault(): Promise<void> {
  const name = process.argv[3];
  if (!name) {
    console.error('Usage: crp set-default <project-name>');
    process.exit(1);
  }

  const config = loadConfig();
  const project = config.projects.find((p) => p.name === name);
  if (!project) {
    console.error(`Project "${name}" not found. Available: ${config.projects.map((p) => p.name).join(', ') || '(none)'}`);
    process.exit(1);
  }

  const { saveConfig } = await import('./config.js');
  config.defaultProject = name;
  saveConfig(config);
  console.log(`Set default project to "${name}"`);
}

function printUsage(): void {
  console.log(`claude-remote-plus - Hot-swap Claude Code remote sessions

Usage: crp <command> [options]

Commands:
  start [--project name] [--port PORT]  Start the daemon server
  stop                                  Stop the daemon server
  status                                Show server and session status
  switch <name>                         Switch to a project
  list                                  List configured projects
  add <name> <path> [--sandbox]         Add a project
  remove <name>                         Remove a project
  update <name> [--path P] [--sandbox]  Update a project's settings
  set-default <name>                    Set the default project
  restart                               Restart current session
  install                               Install as auto-start service
  uninstall                             Remove auto-start service
`);
}

export async function main(): Promise<void> {
  const command = process.argv[2];

  try {
    switch (command) {
      case 'start':
        await cmdStart();
        break;
      case 'stop':
        await cmdStop();
        break;
      case 'status':
        await cmdStatus();
        break;
      case 'switch':
        await cmdSwitch();
        break;
      case 'list':
        await cmdList();
        break;
      case 'add':
        await cmdAdd();
        break;
      case 'remove':
        await cmdRemove();
        break;
      case 'update':
        await cmdUpdate();
        break;
      case 'restart':
        await cmdRestart();
        break;
      case 'install':
        await cmdInstall();
        break;
      case 'uninstall':
        await cmdUninstall();
        break;
      case 'set-default':
        await cmdSetDefault();
        break;
      case '--help':
      case '-h':
      case undefined:
        printUsage();
        break;
      default:
        console.error(`Unknown command: ${command}`);
        printUsage();
        process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}
