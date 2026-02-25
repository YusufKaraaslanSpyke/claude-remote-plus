import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import type { ProjectConfig, SessionState, SessionStatus } from './types.js';
import { PROCESS_KILL_TIMEOUT, SESSION_START_TIMEOUT } from './constants.js';
import { log } from './logger.js';

export interface SessionManagerEvents {
  started: [state: SessionState];
  stopped: [];
  switched: [state: SessionState];
  crashed: [projectName: string, exitCode: number | null];
}

export class SessionManager extends EventEmitter<SessionManagerEvents> {
  private process: ChildProcess | null = null;
  private state: SessionState | null = null;
  private switching = false;

  getState(): SessionState | null {
    return this.state ? { ...this.state } : null;
  }

  async start(project: ProjectConfig): Promise<SessionState> {
    if (this.state && this.state.status === 'running') {
      if (this.state.projectName === project.name) {
        return { ...this.state };
      }
      throw new Error('A session is already running. Use switch() instead.');
    }

    return this.spawn(project);
  }

  async stop(): Promise<void> {
    if (!this.process || !this.state) return;

    this.state.status = 'stopping';
    await this.killProcess();
    this.state = null;
    this.emit('stopped');
  }

  async switch(project: ProjectConfig): Promise<SessionState> {
    if (this.switching) {
      throw new Error('A switch is already in progress');
    }

    // Check if already running this project
    if (this.state?.projectName === project.name && this.state.status === 'running') {
      return { ...this.state };
    }

    this.switching = true;
    try {
      await this.stop();
      const state = await this.spawn(project);
      this.emit('switched', { ...state });
      return { ...state };
    } finally {
      this.switching = false;
    }
  }

  /**
   * Restart the current session without incrementing restartCount.
   * Used for manual/user-initiated restarts.
   */
  async restart(project: ProjectConfig): Promise<SessionState> {
    await this.stop();
    const state = await this.spawn(project);
    return { ...state };
  }

  async restartWith(project: ProjectConfig): Promise<SessionState> {
    const restartCount = this.state?.restartCount ?? 0;
    await this.stop();
    await this.spawn(project);
    // Update restartCount on the canonical state directly
    this.state!.restartCount = restartCount + 1;
    return { ...this.state! };
  }

  private async spawn(project: ProjectConfig): Promise<SessionState> {
    const absPath = project.path;
    if (!fs.existsSync(absPath)) {
      throw new Error(`Project path does not exist: ${absPath}`);
    }

    const args = ['remote-control'];
    if (project.sandbox) {
      args.push('--sandbox');
    }

    log.info('Spawning claude remote-control', { project: project.name, path: absPath, args });

    let child: ChildProcess;
    try {
      child = spawn('claude', args, {
        cwd: absPath,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });
    } catch (err) {
      throw new Error(`Failed to spawn claude: ${(err as Error).message}`);
    }

    // child.pid is undefined if spawn itself failed synchronously (e.g. ENOENT on some platforms)
    if (child.pid === undefined) {
      // Wait for the error event to fire
      await new Promise<void>((resolve) => {
        child.once('error', () => resolve());
        // Safety timeout in case error never fires
        setTimeout(resolve, 1000);
      });
      throw new Error(`Failed to spawn claude remote-control for "${project.name}". Is 'claude' in your PATH?`);
    }

    this.process = child;

    const state: SessionState = {
      projectName: project.name,
      pid: child.pid,
      startedAt: new Date(),
      restartCount: 0,
      status: 'starting',
      sessionUrl: null,
    };
    this.state = state;

    // Collect output for URL parsing
    let stdoutBuffer = '';
    const sessionUrlPattern = /https:\/\/claude\.ai\/code\S*/;
    
    // Timer refs for cleanup (hoisted for access in error handler)
    let checkUrl: ReturnType<typeof setInterval> | null = null;
    let startupTimeout: ReturnType<typeof setTimeout> | null = null;

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdoutBuffer += text;
      log.debug('claude stdout', { text: text.trim() });

      if (!state.sessionUrl) {
        const match = stdoutBuffer.match(sessionUrlPattern);
        if (match) {
          state.sessionUrl = match[0];
          log.info('Session URL captured', { url: state.sessionUrl });
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      log.debug('claude stderr', { text: chunk.toString().trim() });
    });

    child.on('error', (err) => {
      log.error('Failed to spawn claude', { error: err.message });
      if (checkUrl) clearInterval(checkUrl);
      if (startupTimeout) clearTimeout(startupTimeout);
      if (state.status !== 'stopping') {
        state.status = 'crashed';
        this.emit('crashed', state.projectName, null);
      }
    });

    child.on('exit', (code, signal) => {
      log.info('claude process exited', { code, signal, project: state.projectName });
      if (state.status !== 'stopping') {
        state.status = 'crashed';
        this.emit('crashed', state.projectName, code);
      } else {
        state.status = 'stopped';
      }
      this.process = null;
    });

    // Wait for process to start (either URL appears or timeout)
    await new Promise<void>((resolve) => {
      checkUrl = setInterval(() => {
        if (state.sessionUrl) {
          if (checkUrl) clearInterval(checkUrl);
          if (startupTimeout) clearTimeout(startupTimeout);
          state.status = 'running';
          resolve();
        }
        if (state.status === 'crashed') {
          if (checkUrl) clearInterval(checkUrl);
          if (startupTimeout) clearTimeout(startupTimeout);
          resolve();
        }
      }, 200);

      startupTimeout = setTimeout(() => {
        if (checkUrl) clearInterval(checkUrl);
        // Even if no URL appeared, the process may be running
        if (state.status === 'starting') {
          state.status = 'running';
        }
        resolve();
      }, SESSION_START_TIMEOUT);
    });

    if (state.status === 'crashed') {
      throw new Error(`Failed to start claude remote-control for "${project.name}"`);
    }

    this.emit('started', { ...state });
    return { ...state };
  }

  private killProcess(): Promise<void> {
    return new Promise((resolve) => {
      const child = this.process;
      if (!child || child.exitCode !== null) {
        this.process = null;
        resolve();
        return;
      }

      const forceKillTimer = setTimeout(() => {
        log.warn('Process did not exit gracefully, sending SIGKILL');
        try {
          child.kill('SIGKILL');
        } catch {
          // Process may already be dead
        }
      }, PROCESS_KILL_TIMEOUT);

      child.once('exit', () => {
        clearTimeout(forceKillTimer);
        this.process = null;
        resolve();
      });

      try {
        child.kill('SIGTERM');
      } catch {
        clearTimeout(forceKillTimer);
        this.process = null;
        resolve();
      }
    });
  }
}
