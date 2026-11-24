import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assetFilename, releaseIntent, validateVersion } from './release-intent.mjs';
import { validatePackageEntries } from './prepare-package.mjs';
import { finalizeReleaseAssets, publishRelease, readReleaseAssets, releaseFilenames } from './publish-release.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const commit = 'a'.repeat(40);
const version = '0.1.0';
const notes = '# Release 0.1.0\n';
const archiveName = assetFilename(version);
const request = { repository: 'owner/repository', version, commit, notePath: 'releases/v0.1.0.md' };

function assetsFixture(t, assetVersion = version) {
  const root = mkdtempSync(join(tmpdir(), 'release-assets-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, 'assets');
  const receipts = join(root, 'receipts');
  mkdirSync(output);
  mkdirSync(receipts);
  for (const name of releaseFilenames(assetVersion)) {
    const bytes = name === 'perch-linux-x64' ? Buffer.alloc(70_000, 7) : Buffer.from(name);
    writeFileSync(join(output, name), bytes);
    writeFileSync(join(receipts, `${name}.sha256`), `${hash(bytes)}\n`);
  }
  return { output, receipts };
}

function fakeGh(options = {}) {
  const calls = [];
  let listings = 0;
  const gh = args => {
    calls.push(args);
    if (args.includes('--paginate')) {
      listings++;
      return options.existing || (options.concurrent && listings > 1) ? `v${version}\n` : '';
    }
    if (args.includes('POST')) {
      if (options.tagError) throw Error('reference already exists');
      return '{}';
    }
    if (args.includes('--jq')) return `commit:${options.moved ? 'b'.repeat(40) : commit}\n`;
    if (args[0] === 'release') {
      if (options.partial) throw Error('upload failed');
      return '';
    }
    throw Error(`unexpected command: ${args.join(' ')}`);
  };
  return { gh, calls };
}

test('release intent requires a new valid version and nonempty notes', () => {
  assert.equal(releaseIntent('0.1.0', '0.1.0'), false);
  assert.equal(releaseIntent(null, '0.1.0', notes), true);
  assert.equal(releaseIntent('0.1.0', '0.2.0', notes), true);
  assert.throws(() => releaseIntent('0.1.0', '0.2.0', undefined), /tracked, nonempty/);
  assert.throws(() => releaseIntent(null, '0.1.0', ' \n'), /tracked, nonempty/);
  assert.throws(() => releaseIntent('invalid', '0.1.0', notes), /semver/);
  for (const input of ['../0.1.0', '0.1.0\nother=x', '01.1.0', '1.0.0-01', '', null]) assert.throws(() => validateVersion(input), /semver/);
  assert.equal(validateVersion('1.2.3-rc.1+build.7'), '1.2.3-rc.1+build.7');
  assert.equal(assetFilename('1.2.3+build.7'), 'perch-1.2.3-build.7.tgz');
});

test('archive member validation fails closed for omissions and unexpected files', () => {
  const required = ['package.json', 'cli.mjs', 'portable-runtime.mjs', 'omp-extension.ts', 'adapters/omp.mjs', 'SECURITY.md', 'CONTRIBUTING.md', 'AGENTS.md', 'releases/v0.1.0.md'];
  validatePackageEntries(required, required);
  assert.throws(() => validatePackageEntries(required.filter(path => path !== 'omp-extension.ts'), required), /missing omp-extension/);
  assert.throws(() => validatePackageEntries(required.filter(path => path !== 'portable-runtime.mjs'), required), /missing portable-runtime/);
  for (const path of ['../outside', 'adapters/../../secret.mjs', '.env', 'node_modules/ws/index.js', 'adapters/session.json', 'scripts/build-portable.mjs', 'scripts/portable-entry.mjs', '.github/scripts/publish-release.mjs']) {
    assert.throws(() => validatePackageEntries([...required, path], required), /unexpected or unsafe/);
  }
  assert.throws(() => validatePackageEntries([...required, 'cli.mjs'], required), /duplicate/);
});

test('downloaded release assets must have an exact SHA256 manifest and no extra files', t => {
  const { output, receipts } = assetsFixture(t);
  finalizeReleaseAssets(output, receipts, version);
  const names = releaseFilenames(version);
  const expected = names.map(name => `${hash(readFileSync(join(output, name)))}  ${name}\n`).join('');
  assert.equal(readFileSync(join(output, 'SHA256SUMS.txt'), 'utf8'), expected);
  const assets = readReleaseAssets(output, version);
  assert.deepEqual([...assets.keys()], [...names, 'SHA256SUMS.txt']);
  assert.deepEqual(readFileSync(assets.get(archiveName)), Buffer.from(archiveName));
  writeFileSync(join(output, archiveName), 'tampered');
  assert.throws(() => readReleaseAssets(output, version), /checksum mismatch/);
  writeFileSync(join(output, 'unexpected.log'), 'unrelated');
  assert.throws(() => readReleaseAssets(output, version), /only the expected files/);
});

test('finalization rejects missing, extra, nonregular and mismatched tested artifacts', t => {
  const scenarios = [
    [({ output }) => unlinkSync(join(output, 'perch.mjs')), /only the expected files/],
    [({ output }) => writeFileSync(join(output, 'extra'), ''), /only the expected files/],
    [({ receipts }) => unlinkSync(join(receipts, 'perch.mjs.sha256')), /only the expected files/],
    [({ receipts }) => writeFileSync(join(receipts, 'extra'), ''), /only the expected files/],
    [({ output }) => { unlinkSync(join(output, 'perch.mjs')); symlinkSync('perch-linux-x64', join(output, 'perch.mjs')); }, /not a regular file/],
    [({ receipts }) => { unlinkSync(join(receipts, 'perch.mjs.sha256')); mkdirSync(join(receipts, 'perch.mjs.sha256')); }, /not a regular file/],
    [({ receipts }) => writeFileSync(join(receipts, 'perch.mjs.sha256'), `${'z'.repeat(64)}\n`), /checksum mismatch/],
    [({ receipts }) => writeFileSync(join(receipts, 'perch.mjs.sha256'), 'short\n'), /invalid checksum file/],
    [({ output }) => writeFileSync(join(output, 'perch.mjs'), 'changed after smoke'), /checksum mismatch/],
  ];
  for (const [mutate, error] of scenarios) {
    const fixture = assetsFixture(t);
    mutate(fixture);
    assert.throws(() => finalizeReleaseAssets(fixture.output, fixture.receipts, version), error);
    assert.throws(() => readFileSync(join(fixture.output, 'SHA256SUMS.txt')), /ENOENT/);
  }
});

test('release verification rejects malformed, duplicated and nonregular manifests before creating a tag', t => {
  const scenarios = [
    output => writeFileSync(join(output, 'SHA256SUMS.txt'), 'malformed\n'),
    output => {
      const path = join(output, 'SHA256SUMS.txt');
      const lines = readFileSync(path, 'utf8').split('\n');
      lines[1] = lines[0];
      writeFileSync(path, lines.join('\n'));
    },
    output => { unlinkSync(join(output, 'SHA256SUMS.txt')); symlinkSync('perch.mjs', join(output, 'SHA256SUMS.txt')); },
  ];
  for (const mutate of scenarios) {
    const { output, receipts } = assetsFixture(t);
    finalizeReleaseAssets(output, receipts, version);
    mutate(output);
    const { gh, calls } = fakeGh();
    assert.throws(() => publishRelease(gh, { ...request, output }), /checksum|not a regular file/);
    assert.deepEqual(calls, []);
  }
});

test('a new release creates the tag at the tested SHA and uploads only the verified assets', t => {
  const { output, receipts } = assetsFixture(t);
  finalizeReleaseAssets(output, receipts, version);
  const { gh, calls } = fakeGh();
  publishRelease(gh, { ...request, output });
  const createTag = calls.find(args => args.includes('POST'));
  assert.ok(createTag.includes(`ref=refs/tags/v${version}`));
  assert.ok(createTag.includes(`sha=${commit}`));
  const createRelease = calls.find(args => args[0] === 'release');
  assert.ok(createRelease.includes('--verify-tag'));
  assert.ok(createRelease.includes(join(output, archiveName)));
  assert.ok(createRelease.includes(join(output, 'SHA256SUMS.txt')));
  assert.deepEqual(createRelease.filter(arg => arg.startsWith(`${output}/`)), [...releaseFilenames(version), 'SHA256SUMS.txt'].map(name => join(output, name)));
  assert.ok(createRelease.includes(request.notePath));
  assert.equal(createRelease.includes('--clobber'), false);
});

test('existing releases and tags fail explicitly without uploading or overwriting assets', t => {
  const { output, receipts } = assetsFixture(t);
  finalizeReleaseAssets(output, receipts, version);
  for (const options of [{ existing: true }, { tagError: true }, { concurrent: true }, { moved: true }]) {
    const { gh, calls } = fakeGh(options);
    assert.throws(() => publishRelease(gh, { ...request, output }), /already exists|could not create tag|appeared concurrently|no longer points/);
    assert.equal(calls.some(args => args[0] === 'release'), false);
  }
});

test('partial release failures explain that inspection is required', t => {
  const { output, receipts } = assetsFixture(t);
  finalizeReleaseAssets(output, receipts, version);
  const { gh } = fakeGh({ partial: true });
  assert.throws(() => publishRelease(gh, { ...request, output }), /may be partial.*inspect/);
});

test('pre-releases are marked without altering their tag or tested SHA', t => {
  const preVersion = '0.2.0-rc.1';
  const { output, receipts } = assetsFixture(t, preVersion);
  finalizeReleaseAssets(output, receipts, preVersion);
  const { gh, calls } = fakeGh();
  publishRelease(gh, { ...request, output, version: preVersion });
  const create = calls.find(args => args[0] === 'release');
  assert.equal(create.includes('--prerelease'), true);
  assert.equal(create.includes('v0.2.0-rc.1'), true);
});
