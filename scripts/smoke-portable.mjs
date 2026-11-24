import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.argv.length !== 3) throw Error('usage: node scripts/smoke-portable.mjs ARTIFACT');
const source = resolve(process.argv[2]);
const mjs = source.endsWith('.mjs');
const dir = mkdtempSync(join(tmpdir(), 'perch-smoke-'));
const entry = join(dir, mjs ? 'renamed CLI.mjs' : 'renamed CLI');
const bin = join(dir, 'bin');
const env = { HOME: dir, PATH: bin, CODEX_HOME: join(dir, 'codex'), LC_ALL: 'C' };
const opts = { cwd: dir, env, encoding: 'utf8', timeout: 40000 };
const run = (...args) => execFileSync(mjs ? process.execPath : entry, mjs ? [entry, ...args] : args, opts);
const json = (...args) => JSON.parse(run(...args, '--json'));
let id;
try {
  copyFileSync(source, entry);
  chmodSync(entry, 0o755);
  mkdirSync(bin);
  // Only these fixtures are on PATH: neither Perch nor a provider can find a real agent, node or bun there.
  const codex = readFileSync(new URL('../fixtures/codex.mjs', import.meta.url), 'utf8');
  writeFileSync(join(bin, 'codex'), codex.replace('#!/usr/bin/env node', `#!${process.execPath}`), { mode: 0o755 });
  writeFileSync(join(bin, 'terminal-pane'), `#!${process.execPath}\n` +
    `require('node:fs').writeFileSync('pane.json', JSON.stringify(process.argv.slice(2)));\n` +
    `console.log(JSON.stringify({backend:'tmux',pane:'fixture'}));\n`, { mode: 0o755 });
  assert.match(run('--help', '--lang', 'en'), /perch list/);
  const { path, status } = json('integration', 'install', 'omp');
  assert.equal(status, 'installed');
  assert.equal(json('integration', 'install', 'omp').status, 'already_installed');
  execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e',
    'if (typeof (await import(process.argv[1])).default !== "function") process.exit(1)', pathToFileURL(path).href], opts);
  ({ id } = json('start', 'codex', '--pane', 'right'));
  assert.match(id, /^codex:[0-9a-f-]+$/i);
  assert.deepEqual(json('history', id), []);
  const pane = JSON.parse(readFileSync(join(dir, 'pane.json'), 'utf8'));
  const launch = pane.slice(pane.indexOf('--') + 1);
  const view = launch.indexOf('view');
  assert.equal(launch[view + 1], id);
  assert.match(execFileSync(launch[0], [...launch.slice(1, view + 1), '--help', '--lang', 'en'], opts), /perch view/);
} finally {
  try { if (id) assert.equal(json('close', id).closed, true); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
console.log('Standalone help, OMP extension, detached Codex fixture and pane re-entry passed.');
