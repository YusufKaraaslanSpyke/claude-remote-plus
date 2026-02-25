import fs from 'node:fs';
import path from 'node:path';
import { paths } from './constants.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LOG_MAX_SIZE = 10 * 1024 * 1024; // 10 MB
const LOG_MAX_BACKUPS = 3;

let logStream: fs.WriteStream | null = null;
let minLevel: LogLevel = 'info';
let stderrEnabled = false;

function ensureLogDir(): void {
  fs.mkdirSync(path.dirname(paths.LOG_FILE), { recursive: true });
}

function rotateIfNeeded(): void {
  try {
    const stat = fs.statSync(paths.LOG_FILE);
    if (stat.size < LOG_MAX_SIZE) return;
  } catch {
    return; // File doesn't exist yet
  }

  // Rotate: .3 → delete, .2 → .3, .1 → .2, current → .1
  for (let i = LOG_MAX_BACKUPS; i >= 1; i--) {
    const from = i === 1 ? paths.LOG_FILE : `${paths.LOG_FILE}.${i - 1}`;
    const to = `${paths.LOG_FILE}.${i}`;
    try {
      if (i === LOG_MAX_BACKUPS) {
        fs.unlinkSync(to);
      }
    } catch {
      // May not exist
    }
    try {
      fs.renameSync(from, to);
    } catch {
      // May not exist
    }
  }
}

export function initLogger(opts: { level?: LogLevel; stderr?: boolean } = {}): void {
  if (opts.level) minLevel = opts.level;
  if (opts.stderr !== undefined) stderrEnabled = opts.stderr;

  if (!logStream) {
    ensureLogDir();
    rotateIfNeeded();
    logStream = fs.createWriteStream(paths.LOG_FILE, { flags: 'a' });
  }
}

export function closeLogger(): void {
  if (logStream) {
    logStream.end();
    logStream = null;
  }
}

function write(level: LogLevel, message: string, data?: Record<string, unknown>): void {
  if (LOG_LEVELS[level] < LOG_LEVELS[minLevel]) return;

  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...data,
  });

  if (logStream) {
    logStream.write(entry + '\n');
  }

  if (stderrEnabled) {
    process.stderr.write(`[${level.toUpperCase()}] ${message}\n`);
  }
}

export const log = {
  debug: (msg: string, data?: Record<string, unknown>) => write('debug', msg, data),
  info: (msg: string, data?: Record<string, unknown>) => write('info', msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => write('warn', msg, data),
  error: (msg: string, data?: Record<string, unknown>) => write('error', msg, data),
};
