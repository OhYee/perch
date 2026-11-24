import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-session-native-prompt-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const paneLog = join(dir, 'pane.log');
  const providerLog = join(dir, 'provider.log');
  await writeFile(join(dir, 'terminal-pane'), `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.PANE_LOG, JSON.stringify(args) + '\\n');
if (!process.env.SKIP_PROVIDER) {
  const command = args.slice(args.indexOf('--') + 1);
  const result = spawnSync(command[0], command.slice(1), { encoding: 'utf8' });
  if (result.status !== 0) { console.error(result.stderr || result.error); process.exit(1); }
}
const backendFlag = args.indexOf('--backend');
console.log(JSON.stringify({ backend: backendFlag < 0 ? 'tern' : args[backendFlag + 1], pane: 'test-pane' }));
`, { mode: 0o755 });
  const provider = `#!${process.execPath}
require('node:fs').appendFileSync(process.env.PROVIDER_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
`;
  for (const name of ['omp', 'codex']) await writeFile(join(dir, name), provider, { mode: 0o755 });
  const env = { PATH: dir, HOME: dir, LC_ALL: 'en_US.UTF-8', PANE_LOG: paneLog, PROVIDER_LOG: providerLog };
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });
  const lines = async path => {
    try { return (await readFile(path, 'utf8')).trim().split('\n').map(JSON.parse); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  return { dir, env, run, panes: () => lines(paneLog), providers: () => lines(providerLog) };
}

test('native initial prompts cross the launcher as one unchanged provider positional', async t => {
  const f = await fixture(t);
  const extension = join(f.dir, 'trusted extension.ts');
  await writeFile(extension, '');
  const marker = join(f.dir, 'unexpected-shell-execution');
  const prompt = `你好\n"quoted" $(touch ${marker}); --help`;
  const first = f.run('start', 'omp', prompt, '--pane', 'right', '--native', '--model', 'some-model:xhigh', '--json', '--', '--extension', extension);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout), { provider: 'omp', mode: 'native', pane: { backend: 'tern', id: 'test-pane' } });
  const literal = f.run('start', 'codex', '--native', '--pane', 'right', '--', '--help');
  assert.equal(literal.status, 0, literal.stderr);
  const subcommand = f.run('start', 'codex', 'exec', '--pane', 'right', '--native');
  assert.equal(subcommand.status, 0, subcommand.stderr);
  const noPrompt = f.run('start', 'omp', '--native', '--pane', 'right');
  assert.equal(noPrompt.status, 0, noPrompt.stderr);
  assert.deepEqual(await f.providers(), [['--model', 'some-model:xhigh', '--extension', extension, '--', prompt], ['--help'], ['--', 'exec'], []]);
  const panes = await f.panes();
  assert.equal(panes.length, 4);
  assert.deepEqual(panes[0].slice(0, 4), ['--mode', 'right', '--cwd', process.cwd()]);
  assert.ok(panes.every(args => !args.includes('--wait-output')));
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('Claude native launch uses the same provider option boundary', async t => {
  const f = await fixture(t);
  f.env.SKIP_PROVIDER = '1';
  const result = f.run('start', 'claude', 'hello', '--native', '--pane', 'tern', '--workspace', 'work', '--tab', 'agents', '--executable', process.execPath, '--model', 'model');
  assert.equal(result.status, 0, result.stderr);
  const [args] = await f.panes();
  assert.deepEqual(args.slice(0, 8), ['--mode', 'right', '--backend', 'tern', '--session', 'work', '--tab', 'agents']);
  assert.deepEqual(args.slice(-4), ['--model', 'model', '--', 'hello']);
  assert.deepEqual(await f.providers(), []);
});

test('named Herdr and tmux starts address the requested workspace and tab', async t => {
  const f = await fixture(t);
  for (const backend of ['herdr', 'tmux']) {
    const result = f.run('start', 'omp', '--native', '--pane', backend, '--workspace', 'work', '--tab', 'review', '--json');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).pane.backend, backend);
    assert.deepEqual((await f.panes()).at(-1).slice(0, 8), ['--mode', 'right', '--backend', backend, '--session', 'work', '--tab', 'review']);
  }
});

test('invalid native prompts and managed prompts do not launch a pane or provider', async t => {
  const f = await fixture(t);
  for (const args of [
    ['start', 'codex', '--native', '--pane', 'right', '--extension', f.dir],
    ['start', 'omp', '--native', '--pane', 'right', '--thinking', 'unknown'],
    ['start', 'omp', '--native', '--pane', 'right', '--extension', f.dir],
    ['start', 'omp', '', '--native', '--pane', 'right'],
    ['start', 'omp', '  \n', '--native', '--pane', 'right'],
    ['start', 'omp', 'first', 'second', '--native', '--pane', 'right'],
    ['start', 'omp', 'message', '--pane', 'right'],
    ['start', 'omp', '--', '--mode', 'json'],
  ]) {
    const result = f.run(...args);
    assert.notEqual(result.status, 0, JSON.stringify(args));
  }
  assert.deepEqual(await f.panes(), []);
  assert.deepEqual(await f.providers(), []);
});
