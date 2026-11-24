if (process.argv[2] === '--perch-internal-bridge') {
  if (!process.connected) throw new Error('A bridge requires a startup IPC channel');
  const bridge = process.argv[3];
  process.argv.splice(2, 2);
  if (bridge === 'omp-rpc-bridge.mjs') await import('../adapters/omp-rpc-bridge.mjs');
  else if (bridge === 'codex-bridge.mjs') await import('../adapters/codex-bridge.mjs');
  else if (bridge === 'claude-bridge.mjs') await import('../adapters/claude-bridge.mjs');
  else throw new Error('Unknown bridge');
} else {
  await import('../cli.mjs');
}
