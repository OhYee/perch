import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assetFilename, releaseIntent, validateVersion } from './release-intent.mjs';
import { validatePackageEntries } from './prepare-package.mjs';
import { publishRelease, readReleaseAssets } from './publish-release.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const commit = 'a'.repeat(40);
const version = '0.1.0';
const notes = '# Release 0.1.0\n';
const archiveName = assetFilename(version);
const request = { repository: 'owner/repository', version, commit, output: '/tmp/assets', notePath: 'releases/v0.1.0.md' };

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
  assert.equal(assetFilename('1.2.3+build.7'), 'agent-session-1.2.3-build.7.tgz');
});

test('archive member validation fails closed for omissions and unexpected files', () => {
  const required = ['package.json', 'cli.mjs', 'omp-extension.ts', 'adapters/omp.mjs', 'SECURITY.md', 'CONTRIBUTING.md', 'AGENTS.md', 'releases/v0.1.0.md'];
  validatePackageEntries(required, required);
  assert.throws(() => validatePackageEntries(required.filter(path => path !== 'omp-extension.ts'), required), /missing omp-extension/);
  for (const path of ['../outside', 'adapters/../../secret.mjs', '.env', 'node_modules/ws/index.js', 'adapters/session.json']) {
    assert.throws(() => validatePackageEntries([...required, path], required), /unexpected or unsafe/);
  }
  assert.throws(() => validatePackageEntries([...required, 'cli.mjs'], required), /duplicate/);
});

test('downloaded release assets must have an exact SHA256 manifest and no extra files', t => {
  const dir = mkdtempSync(join(tmpdir(), 'release-assets-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bytes = Buffer.from('archive');
  writeFileSync(join(dir, archiveName), bytes);
  writeFileSync(join(dir, 'SHA256SUMS.txt'), `${hash(bytes)}  ${archiveName}\n`);
  assert.deepEqual(readReleaseAssets(dir, version).get(archiveName), bytes);
  writeFileSync(join(dir, archiveName), 'tampered');
  assert.throws(() => readReleaseAssets(dir, version), /checksum mismatch/);
  writeFileSync(join(dir, 'unexpected.log'), 'unrelated');
  assert.throws(() => readReleaseAssets(dir, version), /only the tarball/);
});

test('a new release creates the tag at the tested SHA and uploads only the verified assets', () => {
  const { gh, calls } = fakeGh();
  publishRelease(gh, request);
  const createTag = calls.find(args => args.includes('POST'));
  assert.ok(createTag.includes(`ref=refs/tags/v${version}`));
  assert.ok(createTag.includes(`sha=${commit}`));
  const createRelease = calls.find(args => args[0] === 'release');
  assert.ok(createRelease.includes('--verify-tag'));
  assert.ok(createRelease.includes(join(request.output, archiveName)));
  assert.ok(createRelease.includes(join(request.output, 'SHA256SUMS.txt')));
  assert.ok(createRelease.includes(request.notePath));
  assert.equal(createRelease.includes('--clobber'), false);
});

test('existing releases and tags fail explicitly without uploading or overwriting assets', () => {
  for (const options of [{ existing: true }, { tagError: true }, { concurrent: true }, { moved: true }]) {
    const { gh, calls } = fakeGh(options);
    assert.throws(() => publishRelease(gh, request), /already exists|could not create tag|appeared concurrently|no longer points/);
    assert.equal(calls.some(args => args[0] === 'release'), false);
  }
});

test('partial release failures explain that inspection is required', () => {
  const { gh } = fakeGh({ partial: true });
  assert.throws(() => publishRelease(gh, request), /may be partial.*inspect/);
});

test('pre-releases are marked without altering their tag or tested SHA', () => {
  const { gh, calls } = fakeGh();
  publishRelease(gh, { ...request, version: '0.2.0-rc.1' });
  const create = calls.find(args => args[0] === 'release');
  assert.equal(create.includes('--prerelease'), true);
  assert.equal(create.includes('v0.2.0-rc.1'), true);
});
