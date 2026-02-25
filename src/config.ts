import fs from 'node:fs';
import path from 'node:path';
import { AppConfigSchema, type AppConfig, type ProjectConfig } from './types.js';
import { paths } from './constants.js';
import { log } from './logger.js';

function ensureAppDir(): void {
  fs.mkdirSync(paths.APP_DIR, { recursive: true });
}

export function loadConfig(): AppConfig {
  ensureAppDir();

  if (!fs.existsSync(paths.CONFIG_PATH)) {
    const defaults = AppConfigSchema.parse({});
    saveConfig(defaults);
    return defaults;
  }

  try {
    const raw = fs.readFileSync(paths.CONFIG_PATH, 'utf-8');
    return AppConfigSchema.parse(JSON.parse(raw));
  } catch (err) {
    log.error('Failed to load config, using defaults', { error: String(err) });
    return AppConfigSchema.parse({});
  }
}

export function saveConfig(config: AppConfig): void {
  ensureAppDir();
  const tmpPath = paths.CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmpPath, paths.CONFIG_PATH);
}

export function addProject(config: AppConfig, project: ProjectConfig): AppConfig {
  if (config.projects.some((p) => p.name === project.name)) {
    throw new Error(`Project "${project.name}" already exists`);
  }

  const absPath = path.resolve(project.path);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Path does not exist: ${absPath}`);
  }
  
  const stat = fs.statSync(absPath);
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${absPath}`);
  }

  const updated: AppConfig = {
    ...config,
    projects: [...config.projects, { ...project, path: absPath }],
  };

  if (!updated.defaultProject && updated.projects.length === 1) {
    updated.defaultProject = project.name;
  }

  saveConfig(updated);
  return updated;
}

export function removeProject(config: AppConfig, name: string): AppConfig {
  if (!config.projects.some((p) => p.name === name)) {
    throw new Error(`Project "${name}" not found`);
  }

  const updated: AppConfig = {
    ...config,
    projects: config.projects.filter((p) => p.name !== name),
    defaultProject: config.defaultProject === name ? undefined : config.defaultProject,
  };

  saveConfig(updated);
  return updated;
}

export function updateProject(
  config: AppConfig,
  name: string,
  updates: { path?: string; sandbox?: boolean },
): AppConfig {
  const idx = config.projects.findIndex((p) => p.name === name);
  if (idx === -1) {
    throw new Error(`Project "${name}" not found`);
  }

  const project = { ...config.projects[idx] };

  if (updates.path !== undefined) {
    const absPath = path.resolve(updates.path);
    if (!fs.existsSync(absPath)) {
      throw new Error(`Path does not exist: ${absPath}`);
    }
    const stat = fs.statSync(absPath);
    if (!stat.isDirectory()) {
      throw new Error(`Path is not a directory: ${absPath}`);
    }
    project.path = absPath;
  }

  if (updates.sandbox !== undefined) {
    project.sandbox = updates.sandbox;
  }

  const updatedProjects = [...config.projects];
  updatedProjects[idx] = project;

  const updated: AppConfig = { ...config, projects: updatedProjects };
  saveConfig(updated);
  return updated;
}

export function getProject(config: AppConfig, name: string): ProjectConfig {
  const project = config.projects.find((p) => p.name === name);
  if (!project) {
    throw new Error(`Project "${name}" not found. Available: ${config.projects.map((p) => p.name).join(', ') || '(none)'}`);
  }
  return project;
}
