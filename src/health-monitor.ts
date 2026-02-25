import type { SessionManager } from './session-manager.js';
import type { AppConfig, ProjectConfig } from './types.js';
import { HEALTH_CHECK_MAX_RESTARTS, HEALTH_CHECK_RESTART_WINDOW } from './constants.js';
import { log } from './logger.js';

export class HealthMonitor {
  private interval: ReturnType<typeof setInterval> | null = null;
  private restartTimestamps: number[] = [];
  private restarting = false;
  private getConfig: () => AppConfig;
  private getProject: (name: string) => ProjectConfig | undefined;

  constructor(
    private sessionManager: SessionManager,
    opts: {
      getConfig: () => AppConfig;
      getProject: (name: string) => ProjectConfig | undefined;
    },
  ) {
    this.getConfig = opts.getConfig;
    this.getProject = opts.getProject;

    this.sessionManager.on('crashed', (projectName, exitCode) => {
      this.handleCrash(projectName, exitCode);
    });
  }

  start(): void {
    const config = this.getConfig();
    if (this.interval) return;

    this.interval = setInterval(() => {
      this.check();
    }, config.healthCheckInterval);

    log.info('Health monitor started', { interval: config.healthCheckInterval });
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    log.info('Health monitor stopped');
  }

  private check(): void {
    const state = this.sessionManager.getState();
    if (!state || this.restarting) return;

    if (state.status === 'running' && state.pid) {
      try {
        process.kill(state.pid, 0);
      } catch {
        log.warn('Health check: process not alive', { pid: state.pid, project: state.projectName });
        this.handleCrash(state.projectName, null);
      }
    }
  }

  private async handleCrash(projectName: string, exitCode: number | null): Promise<void> {
    // Prevent concurrent restart attempts (crashed event + health check can both fire)
    if (this.restarting) return;

    const config = this.getConfig();
    if (!config.autoRestart) {
      log.info('Auto-restart disabled, not restarting', { project: projectName });
      return;
    }

    // Check restart rate limit
    const now = Date.now();
    this.restartTimestamps = this.restartTimestamps.filter(
      (ts) => now - ts < HEALTH_CHECK_RESTART_WINDOW,
    );

    if (this.restartTimestamps.length >= HEALTH_CHECK_MAX_RESTARTS) {
      log.error('Restart rate limit exceeded, not restarting', {
        project: projectName,
        restartsInWindow: this.restartTimestamps.length,
      });
      return;
    }

    const project = this.getProject(projectName);
    if (!project) {
      log.error('Cannot restart: project not found in config', { project: projectName });
      return;
    }

    // Double-check current state - don't restart if a session is already running
    const currentState = this.sessionManager.getState();
    if (currentState?.status === 'running' && currentState.projectName !== projectName) {
      log.info('Not restarting: a different session is now active', { 
        project: projectName, 
        activeProject: currentState.projectName 
      });
      return;
    }

    this.restartTimestamps.push(now);
    this.restarting = true;

    log.info('Auto-restarting session', { project: projectName, exitCode });
    try {
      // Use restartWith which increments restartCount for crash tracking
      await this.sessionManager.restartWith(project);
      log.info('Session restarted successfully', { project: projectName });
    } catch (err) {
      log.error('Failed to auto-restart session', {
        project: projectName,
        error: String(err),
      });
    } finally {
      this.restarting = false;
    }
  }
}
