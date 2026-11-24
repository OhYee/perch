import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import manifest from '../package.json' with { type: 'json' };
import { translateDiagnostic } from '../diagnostics.mjs';

const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const expectedVersion = manifest.perchReleaseChannel === 'beta' && !manifest.version.includes('-')
  ? `${manifest.version}-beta-${execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' }).trim().slice(0, 12)}`
  : manifest.version;
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

test('version forms report the package version', () => {
  for (const args of [['--version'], ['-V'], ['version']]) {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), expectedVersion);
  }
  const result = run('version', '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { version: expectedVersion });
});

test('source client metadata does not require Git in PATH', () => {
  const runtime = new URL('../portable-runtime.mjs', import.meta.url).href;
  const script = `import { clientVersion } from ${JSON.stringify(runtime)}; console.log(clientVersion)`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', env: { ...process.env, PATH: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), manifest.version);
});

test('update without a trusted repository reports a localized error without network access', () => {
  assert.equal(manifest.repository, undefined);
  const result = run('update', '--check', '--lang', 'zh');
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /未配置可信的发行仓库；请指定 --repo OWNER\/REPO/);
});

test('update diagnostics translate common failures without changing English', () => {
  for (const [message, expected] of [
    ["--repo does not match this installation's release repository", /发行仓库不匹配/],
    ['No published stable release found; use --beta to include beta releases', /未找到已发布的稳定版.*--beta/],
    ['Release asset checksum mismatch', /校验值不匹配/],
    ['GitHub releases request failed (HTTP 403)', /GitHub 发行版请求失败（HTTP 403）/],
    ['Missing checksum for perch.mjs', /缺少校验值：perch\.mjs/],
  ]) {
    assert.match(translateDiagnostic(message, 'zh'), expected);
    assert.equal(translateDiagnostic(message, 'en'), message);
  }
});

test('version and update have localized help and reject invalid arguments before network access', () => {
  for (const lang of ['en', 'zh']) {
    for (const command of ['version', 'update']) {
      const result = run(command, '--help', '--lang', lang);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, lang === 'zh' ? /示例：/ : /Examples:/);
      assert.ok(result.stdout.includes(`perch ${command}`));
      if (command === 'update') {
        assert.match(result.stdout, /--beta/);
        assert.match(result.stdout, lang === 'zh' ? /默认只检查稳定版/ : /Only stable releases are considered by default/);
      }
    }
  }
  for (const args of [['--version', 'extra'], ['version', 'extra'], ['version', '--check'], ['update', 'extra'], ['update', '--repo'], ['update', '--beta=false']]) {
    const result = run(...args);
    assert.notEqual(result.status, 0, args.join(' '));
    assert.equal(result.stdout, '');
    assert.ok(result.stderr);
  }
});
