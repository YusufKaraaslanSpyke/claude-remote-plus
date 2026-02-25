#!/usr/bin/env node

// When invoked directly with server-specific args (by the start command),
// run the server. Otherwise, run the CLI.

const CLI_COMMANDS = ['start', 'stop', 'status', 'switch', 'list', 'add', 'remove', 'update', 'restart', 'install', 'uninstall', 'set-default', '--help', '-h'];
const hasCliCommand = process.argv.slice(2).some(arg => CLI_COMMANDS.includes(arg));
const isServerMode = process.argv.includes('--port') && !hasCliCommand;

if (isServerMode) {
  // Running as the server process (spawned by `crp start`)
  const { startServer } = await import('../src/server.js');
  const portIdx = process.argv.indexOf('--port');
  const port = portIdx !== -1 ? parseInt(process.argv[portIdx + 1], 10) : undefined;
  const projectIdx = process.argv.indexOf('--project');
  const project = projectIdx !== -1 ? process.argv[projectIdx + 1] : undefined;
  await startServer({ port, project });
} else {
  // Running as the CLI
  const { main } = await import('../src/cli.js');
  await main();
}
