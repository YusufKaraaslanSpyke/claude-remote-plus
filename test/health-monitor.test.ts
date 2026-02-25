import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HealthMonitor } from '../src/health-monitor.js';
import { SessionManager } from '../src/session-manager.js';
import type { AppConfig, ProjectConfig } from '../src/types.js';

// Mock the logger
vi.mock('../src/logger.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('HealthMonitor', () => {
  let sessionManager: SessionManager;
  let healthMonitor: HealthMonitor;
  let config: AppConfig;
  const testProject: ProjectConfig = { name: 'test', path: '/tmp', sandbox: false };

  beforeEach(() => {
    vi.useFakeTimers();
    sessionManager = new SessionManager();
    config = {
      projects: [testProject],
      defaultProject: 'test',
      healthCheckInterval: 30000,
      autoRestart: true,
      port: 24880,
    };

    healthMonitor = new HealthMonitor(sessionManager, {
      getConfig: () => config,
      getProject: (name) => config.projects.find((p) => p.name === name),
    });
  });

  afterEach(() => {
    healthMonitor.stop();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('should start and stop without error', () => {
    healthMonitor.start();
    healthMonitor.stop();
  });

  it('should not restart if autoRestart is disabled', () => {
    config.autoRestart = false;
    healthMonitor.start();

    const restartSpy = vi.spyOn(sessionManager, 'restartWith');

    // Simulate crash event
    sessionManager.emit('crashed', 'test', 1);

    expect(restartSpy).not.toHaveBeenCalled();
  });

  it('should respect restart rate limit', async () => {
    healthMonitor.start();
    const restartSpy = vi.spyOn(sessionManager, 'restartWith').mockResolvedValue({
      projectName: 'test',
      pid: 123,
      startedAt: new Date(),
      restartCount: 0,
      status: 'running',
      sessionUrl: null,
    });

    // Emit 5 crashes (at the limit)
    for (let i = 0; i < 5; i++) {
      sessionManager.emit('crashed', 'test', 1);
      await vi.advanceTimersByTimeAsync(100);
    }

    expect(restartSpy).toHaveBeenCalledTimes(5);

    // 6th crash should be rate-limited
    sessionManager.emit('crashed', 'test', 1);
    await vi.advanceTimersByTimeAsync(100);

    expect(restartSpy).toHaveBeenCalledTimes(5);
  });
});
