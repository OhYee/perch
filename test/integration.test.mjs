import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readlink, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'agent-session-integration-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const agentDir = join(home, 'custom-agent');
  const env = { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: agentDir, LC_ALL: 'en_US.UTF-8' };
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });
  return { home, agentDir, env, run, path: join(agentDir, 'extensions', 'agent-session.ts') };
}

test('OMP install uses the active agent directory and repeat install is idempotent', async t => {
  const { home, agentDir, run, path } = await fixture(t);
  const first = run('integration', 'install', 'omp', '--json', '--lang', 'zh');
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout), { provider: 'omp', status: 'installed', path });
  assert.equal((await lstat(path)).isFile(), true);
  const content = await readFile(path, 'utf8');
  const second = run('integration', 'install', 'omp', '--json', '--lang', 'en');
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout), { provider: 'omp', status: 'already_installed', path });
  assert.equal(await readFile(path, 'utf8'), content);
  assert.deepEqual(await readdir(home), [agentDir.slice(home.length + 1)]);
});

test('OMP install defaults to HOME when PI_CODING_AGENT_DIR is unset', async t => {
  const { home, env } = await fixture(t);
  delete env.PI_CODING_AGENT_DIR;
  const result = spawnSync(process.execPath, [cli, 'integration', 'install', 'omp', '--json'], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    provider: 'omp', status: 'installed', path: join(home, '.omp', 'agent', 'extensions', 'agent-session.ts'),
  });
});


test('OMP profile selection takes precedence over the default agent directory', async t => {
  const { home, env, run, agentDir } = await fixture(t);
  env.PI_CONFIG_DIR = '.isolated-omp';
  env.PI_PROFILE = 'fallback';
  env.OMP_PROFILE = 'work';
  const result = run('integration', 'install', 'omp', '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    provider: 'omp', status: 'installed',
    path: join(home, '.isolated-omp', 'profiles', 'work', 'agent', 'extensions', 'agent-session.ts'),
  });
  await assert.rejects(lstat(agentDir), { code: 'ENOENT' });

  delete env.OMP_PROFILE;
  const fallback = run('integration', 'install', 'omp', '--json');
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.deepEqual(JSON.parse(fallback.stdout), {
    provider: 'omp', status: 'installed',
    path: join(home, '.isolated-omp', 'profiles', 'fallback', 'agent', 'extensions', 'agent-session.ts'),
  });

  env.OMP_PROFILE = 'default';
  const defaultProfile = run('integration', 'install', 'omp', '--json');
  assert.equal(defaultProfile.status, 0, defaultProfile.stderr);
  assert.deepEqual(JSON.parse(defaultProfile.stdout), {
    provider: 'omp', status: 'installed', path: join(agentDir, 'extensions', 'agent-session.ts'),
  });
});
test('OMP install refuses to overwrite a foreign extension file', async t => {
  const { path, run } = await fixture(t);
  await mkdir(join(path, '..'), { recursive: true });
  const content = 'foreign extension\n';
  await writeFile(path, content);
  const result = run('integration', 'install', 'omp', '--json');
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr);
  assert.equal((await lstat(path)).isFile(), true);
  assert.equal(await readFile(path, 'utf8'), content);
});

test('OMP install refuses existing symlinks without changing them or their targets', async t => {
  for (const broken of [false, true]) {
    const { home, path, run } = await fixture(t);
    await mkdir(join(path, '..'), { recursive: true });
    const target = join(home, broken ? 'missing-target' : 'foreign-target');
    if (!broken) await writeFile(target, 'target content\n');
    await symlink(target, path);
    const result = run('integration', 'install', 'omp', '--json');
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr);
    assert.equal((await lstat(path)).isSymbolicLink(), true);
    assert.equal(await readlink(path), target);
    if (broken) await assert.rejects(lstat(target), { code: 'ENOENT' });
    else assert.equal(await readFile(target, 'utf8'), 'target content\n');
  }
});

test('install rejects an unknown provider without creating the agent directory', async t => {
  const { agentDir, run } = await fixture(t);
  const result = run('integration', 'install', 'unknown-provider', '--json');
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr);
  await assert.rejects(lstat(agentDir), { code: 'ENOENT' });
});
