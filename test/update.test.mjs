import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { runUpdate } from '../update.mjs';

const repository = 'fixture/project';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const date = '2026-01-01T00:00:00Z';

function release(version, options = {}) {
  const tag = `v${version}`;
  const names = options.names || ['SHA256SUMS.txt', 'perch.mjs'];
  return {
    tag_name: tag,
    draft: options.draft ?? false,
    prerelease: options.prerelease ?? version.includes('-beta-'),
    published_at: options.published ?? date,
    assets: names.map(name => ({ name, state: 'uploaded', browser_download_url: `https://github.com/${repository}/releases/download/${tag}/${name}` })),
  };
}

function transport({ releases = [release('1.2.0')], contents = Buffer.from('new executable'), manifest, onAsset, assetResponse, apiResponse } = {}) {
  const calls = [];
  const fetch = async (input, options) => {
    const url = new URL(input);
    calls.push(url.href);
    assert.equal(options.redirect, 'manual');
    if (url.hostname === 'api.github.com') {
      assert.equal(url.pathname, `/repos/${repository}/releases`);
      if (apiResponse) return apiResponse(url);
      return Response.json(releases);
    }
    assert.equal(url.hostname, 'github.com', `unexpected network destination: ${url.hostname}`);
    const name = decodeURIComponent(url.pathname.split('/').at(-1));
    if (name === 'SHA256SUMS.txt') return new Response(manifest ?? `${sha256(contents)}  perch.mjs\n`);
    if (onAsset) await onAsset(name);
    if (assetResponse) return assetResponse(name);
    return new Response(contents);
  };
  return { fetch, calls };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'perch-updater-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, 'perch.mjs');
  await writeFile(entry, 'old executable', { mode: 0o751 });
  await chmod(entry, 0o751);
  return { root, entry };
}

const options = extra => ({ version: '1.0.0', repository, kind: 'mjs', check: true, ...extra });
const update = (settings, net) => runUpdate(settings, { fetch: net.fetch });

test('checks stable semantic versions numerically and never downgrades', async () => {
  for (const [current, versions, latest, status] of [
    ['1.2.3', ['1.9.0', '1.10.0', '0.99.0'], '1.10.0', 'available'],
    ['1.10.0', ['1.10.0'], '1.10.0', 'up_to_date'],
    ['2.0.0', ['1.99.99'], '1.99.99', 'up_to_date'],
    ['1.0.0-beta-aaaaaaaaaaaa', ['1.0.0'], '1.0.0', 'available'],
    ['1.0.0', ['1.0.0-beta-aaaaaaaaaaaa', '1.0.0'], '1.0.0', 'up_to_date'],
  ]) {
    const net = transport({ releases: versions.map(version => release(version)) });
    assert.deepEqual(await update(options({ version: current }), net), { current, latest, status });
    assert.equal(net.calls.length, 1);
  }
});

test('rejects invalid versions, unsafe repositories, conflicting origins, and missing origins before fetching', async () => {
  const net = transport();
  for (const version of ['01.2.3', '1.2', '1.2.3\n', '1.2.3+build', '1.2.3-beta.1', '1.2.3-beta-ABCDEF123456', '1.2.3-beta-123']) {
    await assert.rejects(update(options({ version }), net), /Invalid semantic version/);
  }
  for (const origin of ['https://github.com.evil.test/fixture/project', 'https://github.com/fixture/../project', 'https://github.com/fixture/project\n', 'file:///tmp/fixture/project', 'fixture/../project']) {
    await assert.rejects(update(options({ repository: origin }), net), /repository/i);
  }
  await assert.rejects(update(options({ repository: undefined }), net), /specify --repo/);
  await assert.rejects(update(options({ repo: 'other/project' }), net), /does not match/);
  await assert.rejects(update(options({ repository: undefined, repo: '../../oops' }), net), /OWNER\/REPO/);
  assert.equal(net.calls.length, 0);
});

test('accepts an explicit repository or the npm GitHub repository URL', async () => {
  for (const extra of [
    { repository: undefined, repo: repository },
    { repository: { type: 'git', url: `git+https://github.com/${repository}.git` } },
    { repository: `git@github.com:${repository}.git` },
  ]) {
    const net = transport();
    assert.equal((await update(options(extra), net)).status, 'available');
  }
});

test('requires opt-in to beta and selects siblings by publication time, not hash', async () => {
  const earlier = release('2.0.0-beta-ffffffffffff', { published: '2026-02-01T00:00:00Z' });
  const later = release('2.0.0-beta-000000000000', { published: '2026-02-02T00:00:00Z' });
  const net = transport({ releases: [earlier, release('1.9.0'), later] });
  assert.deepEqual(await update(options({ beta: true, version: '2.0.0-beta-ffffffffffff' }), net), {
    current: '2.0.0-beta-ffffffffffff', latest: '2.0.0-beta-000000000000', status: 'available',
  });
  assert.equal((await update(options({ beta: true, version: later.tag_name.slice(1) }), net)).status, 'up_to_date');
  assert.deepEqual(await update(options(), net), { current: '1.0.0', latest: '1.9.0', status: 'available' });
  assert.equal((await update(options({ beta: true, version: '2.0.0' }), net)).status, 'up_to_date');
  const stable = transport({ releases: [later, release('2.0.0')] });
  assert.equal((await update(options({ beta: true, version: earlier.tag_name.slice(1) }), stable)).latest, '2.0.0');
});

test('fails closed on an unknown or ambiguously ordered installed beta', async () => {
  const one = release('2.0.0-beta-000000000000');
  const unknown = transport({ releases: [one] });
  await assert.rejects(update(options({ beta: true, version: '2.0.0-beta-ffffffffffff' }), unknown), /installed beta release order/);
  const tied = transport({ releases: [one, release('2.0.0-beta-ffffffffffff')] });
  await assert.rejects(update(options({ beta: true }), tied), /newest beta release/);
  await assert.rejects(update(options(), unknown), /--beta/);
});

test('ignores drafts, unsupported prereleases, and inconsistent release flags', async () => {
  const net = transport({ releases: [
    release('99.0.0', { draft: true }),
    release('98.0.0-rc.1', { prerelease: true }),
    release('97.0.0-beta-aaaaaaaaaaaa', { prerelease: false }),
    release('1.1.0'),
  ] });
  assert.equal((await update(options({ beta: true }), net)).latest, '1.1.0');
});

test('examines all GitHub release pages before selecting the highest version', async () => {
  const pages = [Array.from({ length: 30 }, (_, i) => release(`1.0.${i}`)), [release('2.0.0')]];
  const net = transport({ apiResponse: url => {
    assert.equal(url.searchParams.get('per_page'), '30');
    return Response.json(pages[Number(url.searchParams.get('page')) - 1]);
  } });
  assert.equal((await update(options(), net)).latest, '2.0.0');
  assert.equal(net.calls.length, 2);
});

test('accepts a bounded GitHub metadata page larger than one MiB', async () => {
  const large = { ...release('1.2.0'), body: 'x'.repeat(1024 * 1024) };
  const net = transport({ releases: [large] });
  assert.equal((await update(options(), net)).latest, '1.2.0');
});

test('rejects malformed release responses and repeated release tags', async () => {
  const malformed = transport({ apiResponse: () => Response.json({ tag_name: 'v2.0.0' }) });
  await assert.rejects(update(options(), malformed), /Invalid GitHub release response/);
  const repeated = transport({ releases: [release('2.0.0'), release('2.0.0')] });
  await assert.rejects(update(options(), repeated), /Duplicate GitHub release tag/);
});

test('rejects malformed release publication times', async () => {
  const net = transport({ releases: [release('1.2.0', { published: '2026-02-30T00:00:00Z' })] });
  await assert.rejects(update(options(), net), /publication time/);
});

test('atomically replaces a portable file, preserving its permissions and a symlink', async t => {
  const { root, entry } = await fixture(t);
  const link = join(root, 'perch');
  await symlink('perch.mjs', link);
  const net = transport();
  const result = await update(options({ check: false, entry: link }), net);
  assert.deepEqual(result, { current: '1.0.0', latest: '1.2.0', status: 'updated' });
  assert.equal(await readFile(entry, 'utf8'), 'new executable');
  assert.equal((await stat(entry)).mode & 0o777, 0o751);
  assert.equal(await readlink(link), 'perch.mjs');
  assert.deepEqual((await readdir(root)).sort(), ['perch', 'perch.mjs']);
});

test('does not download or replace equal and older releases', async t => {
  const { root, entry } = await fixture(t);
  for (const version of ['1.2.0', '2.0.0']) {
    const net = transport();
    assert.equal((await update(options({ version, check: false, entry }), net)).status, 'up_to_date');
    assert.equal(net.calls.length, 1);
    assert.equal(await readFile(entry, 'utf8'), 'old executable');
    assert.deepEqual(await readdir(root), ['perch.mjs']);
  }
});

test('uses the platform-specific native release asset', async t => {
  const { entry } = await fixture(t);
  const name = `perch-${process.platform}-${process.arch}`;
  if (!['perch-darwin-arm64', 'perch-darwin-x64', 'perch-linux-arm64', 'perch-linux-x64'].includes(name)) return;
  const contents = Buffer.from('new native executable');
  const net = transport({ releases: [release('1.2.0', { names: ['SHA256SUMS.txt', name] })], contents, manifest: `${sha256(contents)}  ${name}\n` });
  assert.equal((await update(options({ check: false, entry, kind: 'native' }), net)).status, 'updated');
  assert.deepEqual(await readFile(entry), contents);
});

test('rejects bad or duplicate checksums without changing the installed file', async t => {
  const { root, entry } = await fixture(t);
  for (const manifest of [
    `${'0'.repeat(64)}  perch.mjs\n`,
    `${sha256('new executable')}  perch.mjs\n${sha256('new executable')}  perch.mjs\n`,
    `${sha256('new executable')}  ../perch.mjs\n`,
    `${sha256('new executable')}  other.mjs\n`,
  ]) {
    const net = transport({ manifest });
    await assert.rejects(update(options({ check: false, entry }), net), /checksum/i);
    assert.equal(await readFile(entry, 'utf8'), 'old executable');
    assert.equal((await stat(entry)).mode & 0o777, 0o751);
    assert.deepEqual(await readdir(root), ['perch.mjs']);
  }
});

test('rejects missing, duplicated, unrecognized, or unsafe release assets', async t => {
  const { entry } = await fixture(t);
  const missing = release('1.2.0', { names: ['SHA256SUMS.txt'] });
  const duplicate = release('1.2.0', { names: ['SHA256SUMS.txt', 'perch.mjs', 'perch.mjs'] });
  const extra = release('1.2.0', { names: ['SHA256SUMS.txt', 'perch.mjs', '../perch.mjs'] });
  const unsafe = release('1.2.0');
  unsafe.assets[1].browser_download_url = 'https://example.test/malware';
  const wrongRepo = release('1.2.0');
  wrongRepo.assets[1].browser_download_url = 'https://github.com/other/project/releases/download/v1.2.0/perch.mjs';
  for (const item of [missing, duplicate, extra, unsafe, wrongRepo]) {
    const net = transport({ releases: [item] });
    await assert.rejects(update(options({ check: false, entry }), net), /asset/i);
    assert.equal(await readFile(entry, 'utf8'), 'old executable');
  }
});

test('rejects redirects to untrusted hosts without requesting them', async t => {
  const { entry } = await fixture(t);
  const net = transport({ assetResponse: () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }) });
  await assert.rejects(update(options({ check: false, entry }), net), /redirect/i);
  assert.equal(net.calls.some(url => url.includes('127.0.0.1')), false);
  assert.equal(await readFile(entry, 'utf8'), 'old executable');
});

test('follows an allowlisted GitHub asset redirect', async t => {
  const { entry } = await fixture(t);
  const net = transport({ assetResponse: () => new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/fixture?signature=example' } }) });
  const fetch = async (url, opts) => {
    if (new URL(url).hostname === 'release-assets.githubusercontent.com') {
      assert.equal(opts.redirect, 'manual');
      return new Response('new executable');
    }
    return net.fetch(url, opts);
  };
  assert.equal((await runUpdate(options({ check: false, entry }), { fetch })).status, 'updated');
  assert.equal(await readFile(entry, 'utf8'), 'new executable');
});

test('does not overwrite an installation changed while downloading', async t => {
  const { entry } = await fixture(t);
  const net = transport({ onAsset: () => writeFile(entry, 'concurrent change') });
  await assert.rejects(update(options({ check: false, entry }), net), /Installation changed/);
  assert.equal(await readFile(entry, 'utf8'), 'concurrent change');
});

test('does not replace a symlink retargeted while downloading', async t => {
  const { root, entry } = await fixture(t);
  const other = join(root, 'other.mjs');
  const link = join(root, 'perch');
  await writeFile(other, 'other executable');
  await symlink('perch.mjs', link);
  const net = transport({ onAsset: async () => { await rm(link); await symlink('other.mjs', link); } });
  await assert.rejects(update(options({ check: false, entry: link }), net), /Installation changed/);
  assert.equal(await readFile(entry, 'utf8'), 'old executable');
  assert.equal(await readFile(other, 'utf8'), 'other executable');
  assert.equal(await readlink(link), 'other.mjs');
});

test('detects same-UID changes to the private temporary download', async t => {
  const { root, entry } = await fixture(t);
  let chunks = 0;
  const net = transport({ assetResponse: () => new Response(new ReadableStream({
    async pull(controller) {
      if (chunks++ === 0) { controller.enqueue(Buffer.from('new executable')); return; }
      const directory = (await readdir(root)).find(name => name.startsWith('.perch-update-'));
      assert.ok(directory);
      const temp = join(root, directory, 'download');
      const tempDir = await stat(join(root, directory));
      assert.equal(tempDir.mode & 0o077, 0);
      if (typeof process.getuid === 'function') assert.equal(tempDir.uid, process.getuid());
      await appendFile(temp, 'tampering'.repeat(20));
      controller.close();
    },
  })) });
  await assert.rejects(update(options({ check: false, entry }), net), /changed during update/);
  assert.equal(await readFile(entry, 'utf8'), 'old executable');
});

test('never overwrites a source checkout and allows a read-only check', async t => {
  const { root, entry } = await fixture(t);
  await mkdir(join(root, '.git'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'perch', version: '1.0.0' }));
  await writeFile(join(root, 'cli.mjs'), 'source code with local changes');
  const net = transport();
  assert.equal((await update(options({ check: true, entry, kind: 'package' }), net)).status, 'available');
  await assert.rejects(update(options({ check: false, entry: join(root, 'cli.mjs'), kind: 'package' }), net), /Source checkout.*manually/);
  await assert.rejects(update(options({ check: false, entry, kind: 'mjs' }), net), /Source checkout.*manually/);
  assert.equal(await readFile(join(root, 'cli.mjs'), 'utf8'), 'source code with local changes');
  assert.equal(await readFile(entry, 'utf8'), 'old executable');
});

async function globalPackage(t) {
  const { root } = await fixture(t);
  const prefix = join(root, 'prefix');
  const packageRoot = join(prefix, 'lib', 'node_modules', 'perch');
  const entry = join(packageRoot, 'cli.mjs');
  await mkdir(packageRoot, { recursive: true });
  await mkdir(join(prefix, 'bin'), { recursive: true });
  await writeFile(entry, 'old npm executable');
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'perch', version: '1.0.0', bin: { perch: './cli.mjs' } }));
  await symlink(entry, join(prefix, 'bin', 'perch'));
  return { root, prefix, packageRoot, entry };
}

function packageTransport(contents = Buffer.from('verified release tarball')) {
  const name = 'perch-1.2.0.tgz';
  return transport({ releases: [release('1.2.0', { names: ['SHA256SUMS.txt', name] })], contents, manifest: `${sha256(contents)}  ${name}\n` });
}

test('global npm uses the detected prefix and verified local tarball without lifecycle scripts', async t => {
  const { prefix, entry } = await globalPackage(t);
  const canonicalPrefix = await realpath(prefix);
  const net = packageTransport();
  const calls = [];
  const execFile = async (command, args) => {
    calls.push([command, args]);
    assert.equal(command, 'npm');
    if (args[0] === 'prefix') return { stdout: `${prefix}\n` };
    assert.deepEqual(args.slice(0, -1), ['install', '--global', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', canonicalPrefix, '--']);
    const tarball = args.at(-1);
    assert.equal(basename(tarball), 'perch-1.2.0.tgz');
    assert.equal(await readFile(tarball, 'utf8'), 'verified release tarball');
    assert.equal((await stat(join(tarball, '..'))).mode & 0o077, 0);
    return { stdout: '' };
  };
  const result = await runUpdate(options({ check: false, entry, kind: 'package' }), { fetch: net.fetch, execFile });
  assert.equal(result.status, 'updated');
  assert.equal(calls.length, 2);
  assert.equal(await readFile(entry, 'utf8'), 'old npm executable');
});

test('a bad npm tarball checksum never invokes npm install', async t => {
  const { prefix, entry } = await globalPackage(t);
  const name = 'perch-1.2.0.tgz';
  const net = transport({ releases: [release('1.2.0', { names: ['SHA256SUMS.txt', name] })], manifest: `${'0'.repeat(64)}  ${name}\n` });
  let installCalls = 0;
  const execFile = async (_command, args) => {
    if (args[0] === 'prefix') return { stdout: `${prefix}\n` };
    installCalls++;
    return { stdout: '' };
  };
  await assert.rejects(runUpdate(options({ check: false, entry, kind: 'package' }), { fetch: net.fetch, execFile }), /checksum mismatch/);
  assert.equal(installCalls, 0);
  assert.equal(await readFile(entry, 'utf8'), 'old npm executable');
});

test('rejects unverified npm prefixes, differing versions, and changed packages before installation', async t => {
  const { root, prefix, packageRoot, entry } = await globalPackage(t);
  const other = join(root, 'other-prefix');
  await mkdir(other);
  let installCalls = 0;
  const run = async (command, args) => {
    assert.equal(command, 'npm');
    if (args[0] === 'prefix') return { stdout: `${other}\n` };
    installCalls++;
    throw Error('must not install');
  };
  await assert.rejects(runUpdate(options({ check: false, entry, kind: 'package' }), { fetch: packageTransport().fetch, execFile: run }), /verified global npm/);
  const matchingPrefix = async (_command, args) => {
    if (args[0] === 'prefix') return { stdout: `${prefix}\n` };
    installCalls++;
    throw Error('must not install');
  };
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'perch', version: '0.9.0' }));
  await assert.rejects(runUpdate(options({ check: false, entry, kind: 'package' }), { fetch: packageTransport().fetch, execFile: matchingPrefix }), /different version/);
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'perch', version: '1.0.0' }));
  const changing = packageTransport();
  const fetch = async (url, opts) => {
    if (url.endsWith('.tgz')) await appendFile(entry, ' changed');
    return changing.fetch(url, opts);
  };
  await assert.rejects(runUpdate(options({ check: false, entry, kind: 'package' }), { fetch, execFile: matchingPrefix }), /installation changed/i);
  assert.equal(installCalls, 0);
});

test('rejects a global npm link into a source checkout', async t => {
  const { root, prefix, packageRoot } = await globalPackage(t);
  const source = join(root, 'source');
  await mkdir(join(source, '.git'), { recursive: true });
  await writeFile(join(source, 'cli.mjs'), 'linked source');
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'perch', version: '1.0.0' }));
  await rm(packageRoot, { recursive: true });
  await symlink(source, packageRoot);
  const execFile = async () => { throw Error('npm must not run'); };
  const net = packageTransport();
  await assert.rejects(runUpdate(options({ check: false, kind: 'package', entry: join(packageRoot, 'cli.mjs') }), { fetch: net.fetch, execFile }), /Source checkout.*manually/);
  assert.equal(await readFile(join(source, 'cli.mjs'), 'utf8'), 'linked source');
  assert.equal((await lstat(join(prefix, 'lib', 'node_modules', 'perch'))).isSymbolicLink(), true);
});
