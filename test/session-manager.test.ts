import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionManager } from '../src/session-manager.js';
import type { ProjectConfig } from '../src/types.js';
import { EventEmitter } from 'node:events';
import * as child_process from 'node:child_process';

// Mock child_process.spawn
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof child_process>('node:child_process');
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

function createMockProcess(pid = 12345): child_process.ChildProcess {
  const proc = new EventEmitter() as child_process.ChildProcess;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();

  Object.assign(proc, {
    pid,
    exitCode: null,
    stdout,
    stderr,
    stdin: null,
    stdio: [null, stdout, stderr],
    killed: false,
    connected: false,
    signalCode: null,
    spawnargs: [],
    spawnfile: '',
    kill: vi.fn(() => {
      (proc as any).exitCode = 0;
      proc.emit('exit', 0, null);
      return true;
    }),
    send: vi.fn(),
    disconnect: vi.fn(),
    ref: vi.fn(),
    unref: vi.fn(),
    [Symbol.dispose]: vi.fn(),
  });

  return proc;
}

const testProject: ProjectConfig = {
  name: 'test-project',
  path: '/tmp',
  sandbox: false,
};

describe('SessionManager', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('should start with no state', () => {
    expect(manager.getState()).toBeNull();
  });

  it('should spawn a process on start', async () => {
    const mockProc = createMockProcess();
    vi.mocked(child_process.spawn).mockReturnValue(mockProc);

    // Simulate URL appearing on stdout after a short delay
    setTimeout(() => {
      mockProc.stdout!.emit('data', Buffer.from('Session URL: https://claude.ai/code/abc123\n'));
    }, 100);

    const state = await manager.start(testProject);
    expect(state.projectName).toBe('test-project');
    expect(state.status).toBe('running');
    expect(state.sessionUrl).toBe('https://claude.ai/code/abc123');
    expect(state.pid).toBe(12345);
  });

  it('should stop a running session', async () => {
    const mockProc = createMockProcess();
    vi.mocked(child_process.spawn).mockReturnValue(mockProc);

    setTimeout(() => {
      mockProc.stdout!.emit('data', Buffer.from('https://claude.ai/code/abc\n'));
    }, 100);

    await manager.start(testProject);
    expect(manager.getState()).not.toBeNull();

    await manager.stop();
    expect(manager.getState()).toBeNull();
  });

  it('should switch between projects', async () => {
    const mockProc1 = createMockProcess();
    const mockProc2 = createMockProcess(99999);

    let spawnCount = 0;
    vi.mocked(child_process.spawn).mockImplementation(() => {
      spawnCount++;
      return spawnCount === 1 ? mockProc1 : mockProc2;
    });

    // Start first
    setTimeout(() => {
      mockProc1.stdout!.emit('data', Buffer.from('https://claude.ai/code/abc\n'));
    }, 100);
    await manager.start(testProject);

    // Switch
    const otherProject: ProjectConfig = { name: 'other', path: '/tmp', sandbox: false };
    setTimeout(() => {
      mockProc2.stdout!.emit('data', Buffer.from('https://claude.ai/code/def\n'));
    }, 100);
    const state = await manager.switch(otherProject);

    expect(state.projectName).toBe('other');
    expect(state.sessionUrl).toBe('https://claude.ai/code/def');
  });

  it('should reject concurrent switches', async () => {
    const mockProc = createMockProcess();
    vi.mocked(child_process.spawn).mockReturnValue(mockProc);

    setTimeout(() => {
      mockProc.stdout!.emit('data', Buffer.from('https://claude.ai/code/abc\n'));
    }, 100);
    await manager.start(testProject);

    // Start two switches, the second should be rejected
    const mockProc2 = createMockProcess();
    vi.mocked(child_process.spawn).mockReturnValue(mockProc2);

    setTimeout(() => {
      mockProc2.stdout!.emit('data', Buffer.from('https://claude.ai/code/def\n'));
    }, 100);

    const switch1 = manager.switch({ name: 'a', path: '/tmp', sandbox: false });

    // While switch1 is in progress
    await expect(manager.switch({ name: 'b', path: '/tmp', sandbox: false })).rejects.toThrow(
      'switch is already in progress',
    );

    await switch1;
  });

  it('should no-op when switching to same project', async () => {
    const mockProc = createMockProcess();
    vi.mocked(child_process.spawn).mockReturnValue(mockProc);

    setTimeout(() => {
      mockProc.stdout!.emit('data', Buffer.from('https://claude.ai/code/abc\n'));
    }, 100);
    await manager.start(testProject);

    const state = await manager.switch(testProject);
    expect(state.projectName).toBe('test-project');
    // spawn should only have been called once
    expect(child_process.spawn).toHaveBeenCalledTimes(1);
  });

  it('should emit crashed event when process dies unexpectedly', async () => {
    const mockProc = createMockProcess();
    // Override kill to not auto-emit exit
    mockProc.kill = vi.fn(() => true);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc);

    setTimeout(() => {
      mockProc.stdout!.emit('data', Buffer.from('https://claude.ai/code/abc\n'));
    }, 100);
    await manager.start(testProject);

    const crashPromise = new Promise<void>((resolve) => {
      manager.on('crashed', () => resolve());
    });

    // Simulate unexpected exit
    mockProc.emit('exit', 1, null);

    await crashPromise;
    expect(manager.getState()?.status).toBe('crashed');
  });

  it('should preserve restartCount across restartWith()', async () => {
    const mockProc1 = createMockProcess();
    vi.mocked(child_process.spawn).mockReturnValue(mockProc1);

    setTimeout(() => {
      mockProc1.stdout!.emit('data', Buffer.from('https://claude.ai/code/abc\n'));
    }, 100);
    await manager.start(testProject);

    // Restart with restartWith (auto-restart scenario - increments count)
    const mockProc2 = createMockProcess(77777);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc2);

    setTimeout(() => {
      mockProc2.stdout!.emit('data', Buffer.from('https://claude.ai/code/def\n'));
    }, 100);
    const state = await manager.restartWith(testProject);

    expect(state.restartCount).toBe(1);
    expect(manager.getState()?.restartCount).toBe(1);

    // Restart again
    const mockProc3 = createMockProcess(88888);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc3);

    setTimeout(() => {
      mockProc3.stdout!.emit('data', Buffer.from('https://claude.ai/code/ghi\n'));
    }, 100);
    const state2 = await manager.restartWith(testProject);

    expect(state2.restartCount).toBe(2);
    expect(manager.getState()?.restartCount).toBe(2);
  });

  it('should not increment restartCount on manual restart()', async () => {
    const mockProc1 = createMockProcess();
    vi.mocked(child_process.spawn).mockReturnValue(mockProc1);

    setTimeout(() => {
      mockProc1.stdout!.emit('data', Buffer.from('https://claude.ai/code/abc\n'));
    }, 100);
    await manager.start(testProject);

    // Manual restart (doesn't increment count)
    const mockProc2 = createMockProcess(77777);
    vi.mocked(child_process.spawn).mockReturnValue(mockProc2);

    setTimeout(() => {
      mockProc2.stdout!.emit('data', Buffer.from('https://claude.ai/code/def\n'));
    }, 100);
    const state = await manager.restart(testProject);

    expect(state.restartCount).toBe(0);
    expect(manager.getState()?.restartCount).toBe(0);
  });

  it('should throw when claude is not in PATH (pid undefined)', async () => {
    // Create a mock process with no pid (simulating spawn failure)
    const mockProc = createMockProcess();
    Object.defineProperty(mockProc, 'pid', { value: undefined, writable: true });
    vi.mocked(child_process.spawn).mockReturnValue(mockProc);

    // Fire error event after a short delay
    setTimeout(() => {
      mockProc.emit('error', new Error('spawn claude ENOENT'));
    }, 50);

    await expect(manager.start(testProject)).rejects.toThrow("Is 'claude' in your PATH?");
  });

  it('should throw when trying to start while already running', async () => {
    const mockProc = createMockProcess();
    vi.mocked(child_process.spawn).mockReturnValue(mockProc);

    setTimeout(() => {
      mockProc.stdout!.emit('data', Buffer.from('https://claude.ai/code/abc\n'));
    }, 100);
    await manager.start(testProject);

    const otherProject: ProjectConfig = { name: 'other', path: '/tmp', sandbox: false };
    await expect(manager.start(otherProject)).rejects.toThrow('already running');
  });
});
