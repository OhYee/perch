import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sourceVersion } from '../version.mjs';

if (process.argv.length !== 3) throw Error('usage: node scripts/smoke-portable.mjs ARTIFACT');
const source = resolve(process.argv[2]);
const mjs = source.endsWith('.mjs');
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'perch-smoke-')));
const entry = join(dir, mjs ? 'renamed CLI.mjs' : 'renamed CLI');
const bin = join(dir, 'bin');
const env = { HOME: dir, PATH: bin, CODEX_HOME: join(dir, 'codex'), XDG_STATE_HOME: 'perch state',
  AGY_FIXTURE_STORE: join(dir, 'agy-state'), LC_ALL: 'C' };
const opts = { cwd: dir, env, encoding: 'utf8', timeout: 40000 };
const run = (...args) => execFileSync(mjs ? process.execPath : entry, mjs ? [entry, ...args] : args, opts);
const json = (...args) => JSON.parse(run(...args, '--json'));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const version = await sourceVersion(pkg, fileURLToPath(new URL('..', import.meta.url)));
let id, agy;
try {
  copyFileSync(source, entry);
  chmodSync(entry, 0o755);
  mkdirSync(bin);
  // Only these fixtures are on PATH: neither Perch nor a provider can find a real agent, node or bun there.
  for (const name of ['codex', 'agy']) {
    const fixture = readFileSync(new URL(`../fixtures/${name}.mjs`, import.meta.url), 'utf8');
    writeFileSync(join(bin, name), fixture.replace('#!/usr/bin/env node', `#!${process.execPath}`), { mode: 0o755 });
  }
  writeFileSync(join(bin, 'terminal-pane'), `#!${process.execPath}\n` +
    `require('node:fs').writeFileSync('pane.json', JSON.stringify(process.argv.slice(2)));\n` +
    `console.log(JSON.stringify({backend:'tmux',pane:'fixture'}));\n`, { mode: 0o755 });
  assert.equal(run('--version').trim(), version);
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

  ({ id: agy } = json('start', 'agy', '--pane', 'right'));
  assert.match(agy, /^agy:[0-9a-f-]{36}$/);
  const agyPane = JSON.parse(readFileSync(join(dir, 'pane.json'), 'utf8'));
  const agyLaunch = agyPane.slice(agyPane.indexOf('--') + 1);
  assert.equal(agyLaunch[agyLaunch.indexOf('view') + 1], agy);
  assert.ok(agyLaunch.includes(`XDG_STATE_HOME=${join(dir, env.XDG_STATE_HOME)}`));
  assert.ok(agyLaunch.every(arg => !arg.startsWith('CLAUDE_CONFIG_DIR=')));
  const prompt = '/fixture\nstandalone prompt';
  const expected = [{ role: 'user', text: prompt }, { role: 'assistant', text: 'fixture answer 1' }];
  assert.deepEqual(json('send', agy, prompt), { accepted: true });
  assert.equal(json('wait', agy, '--timeout', '5').status, 'completed');
  assert.deepEqual(json('history', agy), expected);

  // 以窗格得到的 argv 进入真正的只读 viewer，而不只验证帮助能启动。
  await new Promise((resolve, reject) => {
    const viewer = spawn(agyLaunch[0], agyLaunch.slice(1), { ...opts, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', stderr = '', seen = false;
    viewer.stdout.setEncoding('utf8').on('data', chunk => {
      output += chunk;
      if (!seen && output.includes('[as-ready]') && output.includes('[assistant] fixture answer 1')) {
        seen = true;
        viewer.kill();
      }
    });
    viewer.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    viewer.once('error', reject);
    viewer.once('close', () => seen ? resolve() : reject(Error(`AGY pane viewer did not see synthetic history: ${stderr}`)));
  });
  assert.equal(json('close', agy).closed, true);
  const saved = agy;
  agy = undefined;
  const resumed = json('resume', saved);
  agy = resumed.id;
  assert.deepEqual(resumed, { id: saved, provider: 'agy' });
  assert.deepEqual(json('history', agy), expected);
} finally {
  try { if (agy) assert.equal(json('close', agy).closed, true); }
  finally {
    try { if (id) assert.equal(json('close', id).closed, true); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  }
}
console.log('Standalone help, OMP extension, detached Codex and AGY fixtures, AGY resume and pane re-entry passed.');
