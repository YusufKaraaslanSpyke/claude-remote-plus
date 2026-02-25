import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

const SERVICE_NAME = 'com.claude-remote-plus';

function getNodePath(): string {
  return process.execPath;
}

function getCrpPath(): string {
  // Resolve the bin entry point
  const binPath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '../bin/crp.js',
  );
  return binPath;
}

// --- macOS launchd ---

function getLaunchdPlistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${SERVICE_NAME}.plist`);
}

function installLaunchd(): void {
  const plistPath = getLaunchdPlistPath();
  const nodePath = getNodePath();
  const crpPath = getCrpPath();

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${crpPath}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${path.join(os.homedir(), '.claude-remote-plus', 'launchd-stdout.log')}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(os.homedir(), '.claude-remote-plus', 'launchd-stderr.log')}</string>
</dict>
</plist>
`;

  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, plist, 'utf-8');

  try {
    execSync(`launchctl load "${plistPath}"`, { stdio: 'inherit' });
    console.log('Installed and loaded macOS LaunchAgent.');
    console.log(`Plist: ${plistPath}`);
  } catch {
    console.log(`Plist written to ${plistPath}`);
    console.log('Run manually: launchctl load ' + plistPath);
  }
}

function uninstallLaunchd(): void {
  const plistPath = getLaunchdPlistPath();

  try {
    execSync(`launchctl unload "${plistPath}"`, { stdio: 'inherit' });
  } catch {
    // May not be loaded
  }

  try {
    fs.unlinkSync(plistPath);
    console.log('Removed macOS LaunchAgent.');
  } catch {
    console.log('LaunchAgent plist not found.');
  }
}

// --- Linux systemd ---

function getSystemdUnitPath(): string {
  return path.join(os.homedir(), '.config', 'systemd', 'user', 'claude-remote-plus.service');
}

function installSystemd(): void {
  const unitPath = getSystemdUnitPath();
  const nodePath = getNodePath();
  const crpPath = getCrpPath();

  const unit = `[Unit]
Description=claude-remote-plus daemon
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${crpPath} start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;

  fs.mkdirSync(path.dirname(unitPath), { recursive: true });
  fs.writeFileSync(unitPath, unit, 'utf-8');

  try {
    execSync('systemctl --user daemon-reload', { stdio: 'inherit' });
    execSync('systemctl --user enable claude-remote-plus', { stdio: 'inherit' });
    execSync('systemctl --user start claude-remote-plus', { stdio: 'inherit' });
    console.log('Installed and started systemd user service.');
  } catch {
    console.log(`Unit file written to ${unitPath}`);
    console.log('Run manually:');
    console.log('  systemctl --user daemon-reload');
    console.log('  systemctl --user enable --now claude-remote-plus');
  }
}

function uninstallSystemd(): void {
  const unitPath = getSystemdUnitPath();

  try {
    execSync('systemctl --user stop claude-remote-plus', { stdio: 'inherit' });
    execSync('systemctl --user disable claude-remote-plus', { stdio: 'inherit' });
  } catch {
    // May not be running
  }

  try {
    fs.unlinkSync(unitPath);
    execSync('systemctl --user daemon-reload', { stdio: 'inherit' });
    console.log('Removed systemd user service.');
  } catch {
    console.log('Systemd unit file not found.');
  }
}

// --- Windows ---

function getWindowsStartupPath(): string {
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'claude-remote-plus.vbs');
}

function installWindows(): void {
  const startupPath = getWindowsStartupPath();
  const nodePath = getNodePath();
  const crpPath = getCrpPath();

  const vbs = `Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """${nodePath}"" ""${crpPath}"" start", 0, False
`;

  fs.mkdirSync(path.dirname(startupPath), { recursive: true });
  fs.writeFileSync(startupPath, vbs, 'utf-8');
  console.log(`Installed Windows startup script: ${startupPath}`);
}

function uninstallWindows(): void {
  const startupPath = getWindowsStartupPath();
  try {
    fs.unlinkSync(startupPath);
    console.log('Removed Windows startup script.');
  } catch {
    console.log('Startup script not found.');
  }
}

// --- Public API ---

export async function installService(): Promise<void> {
  switch (process.platform) {
    case 'darwin':
      installLaunchd();
      break;
    case 'linux':
      installSystemd();
      break;
    case 'win32':
      installWindows();
      break;
    default:
      console.error(`Unsupported platform: ${process.platform}`);
      console.log('You can manually configure your system to run: crp start');
      process.exit(1);
  }
}

export async function uninstallService(): Promise<void> {
  switch (process.platform) {
    case 'darwin':
      uninstallLaunchd();
      break;
    case 'linux':
      uninstallSystemd();
      break;
    case 'win32':
      uninstallWindows();
      break;
    default:
      console.error(`Unsupported platform: ${process.platform}`);
      process.exit(1);
  }
}
