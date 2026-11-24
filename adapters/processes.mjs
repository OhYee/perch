import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
async function ps(columns) {
  const { stdout } = await exec('/bin/ps', ['-ww', '-U', String(process.getuid()), '-o', columns], { maxBuffer: 32 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } });
  return stdout.split('\n');
}

let snapshot;
// Concurrent adapters share the in-flight snapshot, not a stale PID cache. comm can
// contain spaces on macOS, so never split comm and args on whitespace.
export function processes() {
  return snapshot ??= Promise.all([ps('pid=,ppid=,tty=,comm='), ps('pid=,args=')]).then(([rows, commands]) => {
    const args = new Map();
    for (const line of commands) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (m) args.set(Number(m[1]), m[2]);
    }
    const result = [];
    for (const row of rows) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(row);
      if (m && args.has(Number(m[1]))) result.push({ pid: Number(m[1]), ppid: Number(m[2]), tty: m[3], comm: m[4].trimEnd(), args: args.get(Number(m[1])) });
    }
    return result;
  }).finally(() => { snapshot = undefined; });
}
