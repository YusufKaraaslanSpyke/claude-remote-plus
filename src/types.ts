import { z } from 'zod';

export const ProjectConfigSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  sandbox: z.boolean().default(false),
});

export const AppConfigSchema = z.object({
  projects: z.array(ProjectConfigSchema).default([]),
  defaultProject: z.string().optional(),
  healthCheckInterval: z.number().int().positive().default(30_000),
  autoRestart: z.boolean().default(true),
  port: z.number().int().min(1).max(65535).default(24880),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type AppConfig = z.infer<typeof AppConfigSchema>;

export type SessionStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'crashed';

export interface SessionState {
  projectName: string;
  pid: number;
  startedAt: Date;
  restartCount: number;
  status: SessionStatus;
  sessionUrl: string | null;
}

export interface ServerStatus {
  running: boolean;
  uptime: number;
  session: SessionState | null;
  config: AppConfig;
}
