import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { paths } from '../src/constants.js';
import { loadConfig } from '../src/config.js';

let tmpDir: string;
let origAppDir: string;

describe('Server REST API (config integration)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crp-server-test-'));
    origAppDir = paths.APP_DIR;
    paths.APP_DIR = tmpDir;
  });

  afterEach(() => {
    paths.APP_DIR = origAppDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should load config with projects from disk', () => {
    // Write config to the temp dir
    fs.writeFileSync(
      paths.CONFIG_PATH,
      JSON.stringify({
        projects: [{ name: 'test-project', path: tmpDir, sandbox: false }],
        defaultProject: 'test-project',
        healthCheckInterval: 30000,
        autoRestart: false,
        port: 12345,
      }),
      'utf-8',
    );

    const config = loadConfig();
    expect(config.projects).toHaveLength(1);
    expect(config.projects[0].name).toBe('test-project');
    expect(config.port).toBe(12345);
  });

  it('should load defaults when config does not exist', () => {
    const config = loadConfig();
    expect(config.projects).toEqual([]);
    expect(config.port).toBe(24880);
  });
});
