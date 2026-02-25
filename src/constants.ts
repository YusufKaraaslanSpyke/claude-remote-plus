import path from 'node:path';
import os from 'node:os';

const homeDir = os.homedir();

export const paths = {
  APP_DIR: path.join(homeDir, '.claude-remote-plus'),
  get CONFIG_PATH() { return path.join(this.APP_DIR, 'config.json'); },
  get PID_FILE() { return path.join(this.APP_DIR, 'server.pid'); },
  get LOG_FILE() { return path.join(this.APP_DIR, 'server.log'); },
};

export const DEFAULT_PORT = 24880;
export const PROCESS_KILL_TIMEOUT = 5_000;
export const SESSION_START_TIMEOUT = 15_000;
export const HEALTH_CHECK_MAX_RESTARTS = 5;
export const HEALTH_CHECK_RESTART_WINDOW = 5 * 60 * 1000; // 5 minutes
