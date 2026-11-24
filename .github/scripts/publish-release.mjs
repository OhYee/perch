import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, readSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetFilename, validateVersion } from './release-intent.mjs';
import { effectiveVersion } from '../../version.mjs';

const portableNames = ['perch.mjs', 'perch-darwin-arm64', 'perch-darwin-x64', 'perch-linux-arm64', 'perch-linux-x64'];
const checksumName = 'SHA256SUMS.txt';
const isBeta = version => version.includes('-beta-');

export function releaseFilenames(version) {
  return [...portableNames, assetFilename(version)].sort();
}

function requireFiles(directory, expected) {
  const names = readdirSync(directory).sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) throw Error('release artifact must contain only the expected files');
  for (const name of names) if (!lstatSync(join(directory, name)).isFile()) throw Error(`release asset ${name} is not a regular file`);
}

function withRegularFile(path, callback) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw Error(`release asset ${path} is not a regular file`);
    return callback(fd, stat);
  } finally {
    closeSync(fd);
  }
}

function readSmallFile(path, size) {
  return withRegularFile(path, (fd, stat) => {
    if (stat.size !== size) throw Error(`invalid checksum file ${path}`);
    const buffer = Buffer.alloc(size + 1);
    let offset = 0;
    let length;
    while (offset < buffer.length && (length = readSync(fd, buffer, offset, buffer.length - offset, null)) !== 0) offset += length;
    if (offset !== size) throw Error(`invalid checksum file ${path}`);
    return buffer.toString('utf8', 0, offset);
  });
}

function hashFile(path) {
  return withRegularFile(path, fd => {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let length;
    while ((length = readSync(fd, buffer, 0, buffer.length, null)) !== 0) hash.update(buffer.subarray(0, length));
    return hash.digest('hex');
  });
}

function checksumText(directory, names) {
  return names.map(name => `${hashFile(join(directory, name))}  ${name}\n`).join('');
}

export function finalizeReleaseAssets(directory, receiptDirectory, version) {
  const names = releaseFilenames(version);
  requireFiles(directory, names);
  requireFiles(receiptDirectory, names.map(name => `${name}.sha256`).sort());
  const lines = [];
  for (const name of names) {
    const hash = hashFile(join(directory, name));
    const receipt = readSmallFile(join(receiptDirectory, `${name}.sha256`), 65);
    if (!/^[0-9a-f]{64}\n$/.test(receipt) || receipt !== `${hash}\n`) throw Error(`tested artifact checksum mismatch: ${name}`);
    lines.push(`${hash}  ${name}\n`);
  }
  writeFileSync(join(directory, checksumName), lines.join(''), { flag: 'wx' });
}

export function readReleaseAssets(directory, version) {
  const names = releaseFilenames(version);
  requireFiles(directory, [...names, checksumName].sort());
  const expected = checksumText(directory, names);
  if (readSmallFile(join(directory, checksumName), Buffer.byteLength(expected)) !== expected) throw Error('release artifact checksum mismatch');
  return new Map([...names, checksumName].map(name => [name, join(directory, name)]));
}

export function publishRelease(gh, { repository, version, commit, output, notePath }) {
  validateVersion(version);
  if (!/^[0-9a-f]{40}$/.test(commit || '') || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '') || repository.split('/').some(part => part === '.' || part === '..')) throw Error('invalid repository or tested commit');
  if (isBeta(version) && !version.endsWith(`-beta-${commit.slice(0, 12)}`)) throw Error('beta version does not match tested commit');
  const assets = readReleaseAssets(output, version);
  const tag = `v${version}`;
  const releases = () => gh(['api', '--paginate', '--jq', '.[].tag_name', `repos/${repository}/releases?per_page=100`]).split('\n');
  if (!isBeta(version)) {
    const betaTags = gh(['api', '--paginate', '--jq', '.[] | select(.draft == false and .prerelease == true) | .tag_name', `repos/${repository}/releases?per_page=100`]).split('\n');
    const prefix = `${tag}-beta-`;
    if (!betaTags.some(beta => beta.startsWith(prefix) && /^[0-9a-f]{12}$/.test(beta.slice(prefix.length)))) throw Error(`stable release ${tag} requires a published, non-draft prerelease beta for the same version`);
  }
  if (releases().includes(tag)) throw Error(`release ${tag} already exists; inspect the existing release rather than overwriting it`);
  try {
    // Ref creation is atomic, so an existing historical or concurrent tag is never overwritten.
    gh(['api', '--method', 'POST', `repos/${repository}/git/refs`, '-f', `ref=refs/tags/${tag}`, '-f', `sha=${commit}`]);
  } catch (error) {
    throw Error(`could not create tag ${tag}; an existing tag, partial release, or API error requires inspection: ${error.message}`);
  }
  if (releases().includes(tag)) throw Error(`release ${tag} appeared concurrently; inspect it before retrying`);
  const ref = gh(['api', '--jq', '.object.type + \":\" + .object.sha', `repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`]).trim();
  if (ref !== `commit:${commit}`) throw Error(`tag ${tag} no longer points to the tested commit`);
  const args = ['release', 'create', tag, ...assets.values(), '--repo', repository, '--verify-tag', '--title', tag, '--notes-file', notePath];
  if (isBeta(version)) args.push('--prerelease', '--latest=false');
  try {
    gh(args);
  } catch (error) {
    throw Error(`release ${tag} may be partial; inspect its tag, draft and assets before retrying: ${error.message}`);
  }
}

function main() {
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'));
  if (manifest.name !== 'perch' || manifest.private !== true) throw Error('expected the private perch package');
  if (isBeta(validateVersion(manifest.version))) throw Error('tracked package version must be a stable base');
  const { VERSION: version, COMMIT: commit, OUTPUT_DIR: output, GITHUB_REPOSITORY: repository, GITHUB_TOKEN: token } = process.env;
  if (!/^[0-9a-f]{40}$/.test(commit || '')) throw Error('COMMIT is required');
  if (validateVersion(version) !== effectiveVersion(manifest, commit)) throw Error('checkout package metadata does not match the requested version');
  const mode = process.argv[2];
  if (mode === '--finalize' && process.argv.length === 5) {
    finalizeReleaseAssets(resolve(process.argv[3]), resolve(process.argv[4]), version);
    console.log('Finalized SHA256SUMS.txt from the tested artifacts');
    return;
  }
  if (mode === '--verify' && process.argv.length === 4) {
    readReleaseAssets(resolve(process.argv[3]), version);
    console.log('Verified all release artifacts');
    return;
  }
  if (process.argv.length !== 2) throw Error('usage: node .github/scripts/publish-release.mjs [--finalize OUTPUT_DIR RECEIPT_DIR | --verify OUTPUT_DIR]');
  if (!output || !token) throw Error('OUTPUT_DIR and GITHUB_TOKEN are required');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (head !== commit) throw Error('checkout does not match the tested commit');
  const notePath = join('releases', `v${manifest.version}.md`);
  if (!lstatSync(notePath).isFile()) throw Error('release notes must be a regular file');
  if (!readFileSync(notePath, 'utf8').trim()) throw Error('release notes must be nonempty');
  const gh = args => execFileSync('gh', args, { encoding: 'utf8', env: { ...process.env, GH_TOKEN: token, GH_DEBUG: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  publishRelease(gh, { repository, version, commit, output, notePath });
  console.log(`Release v${version} matches the tested commit and assets`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
