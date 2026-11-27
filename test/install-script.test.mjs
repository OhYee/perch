import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../docs/install.sh', import.meta.url));

function run(args) {
  return spawnSync('sh', [script, ...args], { encoding: 'utf8', env: { ...process.env, PATH: process.env.PATH } });
}

test('install.sh parses as POSIX sh', () => {
  const result = spawnSync('sh', ['-n', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('install.sh --help prints usage without downloading', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: install\.sh/);
  assert.match(result.stdout, /--with-omp/);
});

test('install.sh rejects unknown options and missing values', () => {
  const unknown = run(['--nope']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown option: --nope/);

  const missing = run(['--version']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /--version needs a value/);
});
