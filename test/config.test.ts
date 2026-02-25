import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, saveConfig, addProject, removeProject, updateProject, getProject } from '../src/config.js';
import type { AppConfig } from '../src/types.js';
import { paths } from '../src/constants.js';

let tmpDir: string;
let origAppDir: string;

describe('Config', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crp-test-'));
    origAppDir = paths.APP_DIR;
    paths.APP_DIR = tmpDir;
  });

  afterEach(() => {
    paths.APP_DIR = origAppDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return defaults when no config exists', () => {
    const config = loadConfig();
    expect(config.projects).toEqual([]);
    expect(config.healthCheckInterval).toBe(30000);
    expect(config.autoRestart).toBe(true);
    expect(config.port).toBe(24880);
  });

  it('should create config file on first load', () => {
    loadConfig();
    expect(fs.existsSync(paths.CONFIG_PATH)).toBe(true);
  });

  it('should save and load config', () => {
    const config: AppConfig = {
      projects: [{ name: 'test', path: '/tmp/test', sandbox: false }],
      defaultProject: 'test',
      healthCheckInterval: 60000,
      autoRestart: false,
      port: 9999,
    };

    saveConfig(config);
    const loaded = loadConfig();

    expect(loaded.projects).toHaveLength(1);
    expect(loaded.projects[0].name).toBe('test');
    expect(loaded.port).toBe(9999);
    expect(loaded.autoRestart).toBe(false);
  });

  it('should handle corrupt config gracefully', () => {
    fs.writeFileSync(paths.CONFIG_PATH, 'not json{{{', 'utf-8');
    const config = loadConfig();
    expect(config.projects).toEqual([]);
  });

  it('should validate config with zod', () => {
    fs.writeFileSync(paths.CONFIG_PATH, JSON.stringify({ port: -1 }), 'utf-8');
    const config = loadConfig();
    // Falls back to defaults due to validation error
    expect(config.port).toBe(24880);
  });
});

describe('addProject', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crp-test-'));
    origAppDir = paths.APP_DIR;
    paths.APP_DIR = tmpDir;
  });

  afterEach(() => {
    paths.APP_DIR = origAppDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should add a project', () => {
    let config = loadConfig();
    config = addProject(config, { name: 'myapp', path: tmpDir, sandbox: false });

    expect(config.projects).toHaveLength(1);
    expect(config.projects[0].name).toBe('myapp');
    expect(config.defaultProject).toBe('myapp');
  });

  it('should reject duplicate project names', () => {
    let config = loadConfig();
    config = addProject(config, { name: 'myapp', path: tmpDir, sandbox: false });

    expect(() => addProject(config, { name: 'myapp', path: tmpDir, sandbox: false })).toThrow(
      'already exists',
    );
  });

  it('should reject non-existent paths', () => {
    const config = loadConfig();
    expect(() => addProject(config, { name: 'bad', path: '/nonexistent/path', sandbox: false })).toThrow(
      'does not exist',
    );
  });

  it('should reject file paths (only directories allowed)', () => {
    // Create a temp file
    const tmpFile = path.join(tmpDir, 'file.txt');
    fs.writeFileSync(tmpFile, 'test', 'utf-8');
    
    const config = loadConfig();
    expect(() => addProject(config, { name: 'bad', path: tmpFile, sandbox: false })).toThrow(
      'not a directory',
    );
  });

  it('should set first project as default', () => {
    let config = loadConfig();
    config = addProject(config, { name: 'first', path: tmpDir, sandbox: false });
    expect(config.defaultProject).toBe('first');
  });
});

describe('removeProject', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crp-test-'));
    origAppDir = paths.APP_DIR;
    paths.APP_DIR = tmpDir;
  });

  afterEach(() => {
    paths.APP_DIR = origAppDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should remove a project', () => {
    let config = loadConfig();
    config = addProject(config, { name: 'myapp', path: tmpDir, sandbox: false });
    config = removeProject(config, 'myapp');

    expect(config.projects).toHaveLength(0);
  });

  it('should clear default when removing default project', () => {
    let config = loadConfig();
    config = addProject(config, { name: 'myapp', path: tmpDir, sandbox: false });
    expect(config.defaultProject).toBe('myapp');

    config = removeProject(config, 'myapp');
    expect(config.defaultProject).toBeUndefined();
  });

  it('should throw for non-existent project', () => {
    const config = loadConfig();
    expect(() => removeProject(config, 'nope')).toThrow('not found');
  });
});

describe('updateProject', () => {
  let tmpDir2: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crp-test-'));
    tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'crp-test2-'));
    origAppDir = paths.APP_DIR;
    paths.APP_DIR = tmpDir;
  });

  afterEach(() => {
    paths.APP_DIR = origAppDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(tmpDir2, { recursive: true, force: true });
  });

  it('should update project path', () => {
    let config = loadConfig();
    config = addProject(config, { name: 'myapp', path: tmpDir, sandbox: false });
    config = updateProject(config, 'myapp', { path: tmpDir2 });

    expect(config.projects[0].path).toBe(tmpDir2);
  });

  it('should update sandbox flag', () => {
    let config = loadConfig();
    config = addProject(config, { name: 'myapp', path: tmpDir, sandbox: false });
    config = updateProject(config, 'myapp', { sandbox: true });

    expect(config.projects[0].sandbox).toBe(true);
  });

  it('should update both path and sandbox', () => {
    let config = loadConfig();
    config = addProject(config, { name: 'myapp', path: tmpDir, sandbox: false });
    config = updateProject(config, 'myapp', { path: tmpDir2, sandbox: true });

    expect(config.projects[0].path).toBe(tmpDir2);
    expect(config.projects[0].sandbox).toBe(true);
  });

  it('should throw for non-existent project', () => {
    const config = loadConfig();
    expect(() => updateProject(config, 'nope', { sandbox: true })).toThrow('not found');
  });

  it('should reject non-existent path', () => {
    let config = loadConfig();
    config = addProject(config, { name: 'myapp', path: tmpDir, sandbox: false });
    expect(() => updateProject(config, 'myapp', { path: '/nonexistent/path' })).toThrow('does not exist');
  });

  it('should persist changes to disk', () => {
    let config = loadConfig();
    config = addProject(config, { name: 'myapp', path: tmpDir, sandbox: false });
    updateProject(config, 'myapp', { path: tmpDir2 });

    const reloaded = loadConfig();
    expect(reloaded.projects[0].path).toBe(tmpDir2);
  });
});

describe('getProject', () => {
  it('should return project by name', () => {
    const config: AppConfig = {
      projects: [{ name: 'test', path: '/tmp', sandbox: false }],
      healthCheckInterval: 30000,
      autoRestart: true,
      port: 24880,
    };

    const project = getProject(config, 'test');
    expect(project.name).toBe('test');
  });

  it('should throw for unknown project', () => {
    const config: AppConfig = {
      projects: [],
      healthCheckInterval: 30000,
      autoRestart: true,
      port: 24880,
    };

    expect(() => getProject(config, 'nope')).toThrow('not found');
  });
});
