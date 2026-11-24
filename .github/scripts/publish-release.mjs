import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetFilename, validateVersion } from './release-intent.mjs';

const digest = data => createHash('sha256').update(data).digest('hex');
const isPrerelease = version => version.split('+')[0].includes('-');

export function readReleaseAssets(directory, version) {
  validateVersion(version);
  const filename = assetFilename(version);
  const names = readdirSync(directory).sort();
  if (names.length !== 2 || names[0] !== 'SHA256SUMS.txt' || names[1] !== filename) throw Error('release artifact must contain only the tarball and SHA256SUMS.txt');
  for (const name of names) if (!lstatSync(join(directory, name)).isFile()) throw Error(`release asset ${name} is not a regular file`);
  const archive = readFileSync(join(directory, filename));
  const checksum = readFileSync(join(directory, 'SHA256SUMS.txt'));
  if (checksum.toString('utf8') !== `${digest(archive)}  ${filename}\n`) throw Error('release artifact checksum mismatch');
  return new Map([[filename, archive], ['SHA256SUMS.txt', checksum]]);
}

export function publishRelease(gh, { repository, version, commit, output, notePath }) {
  validateVersion(version);
  if (!/^[0-9a-f]{40}$/.test(commit || '') || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '') || repository.split('/').some(part => part === '.' || part === '..')) throw Error('invalid repository or tested commit');
  const tag = `v${version}`;
  const releases = () => gh(['api', '--paginate', '--jq', '.[].tag_name', `repos/${repository}/releases?per_page=100`]).split('\n');
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
  const args = ['release', 'create', tag, join(output, assetFilename(version)), join(output, 'SHA256SUMS.txt'), '--repo', repository, '--verify-tag', '--title', tag, '--notes-file', notePath];
  if (isPrerelease(version)) args.push('--prerelease');
  try {
    gh(args);
  } catch (error) {
    throw Error(`release ${tag} may be partial; inspect its tag, draft and assets before retrying: ${error.message}`);
  }
}

function main() {
  const { VERSION: version, COMMIT: commit, OUTPUT_DIR: output, GITHUB_REPOSITORY: repository, GITHUB_TOKEN: token } = process.env;
  validateVersion(version);
  if (!/^[0-9a-f]{40}$/.test(commit || '') || !output || !token) throw Error('COMMIT, OUTPUT_DIR and GITHUB_TOKEN are required');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (head !== commit) throw Error('checkout does not match the tested commit');
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  if (manifest.name !== 'agent-session' || manifest.private !== true || manifest.version !== version) throw Error('checkout package metadata does not match the requested version');
  const notePath = join('releases', `v${version}.md`);
  if (!lstatSync(notePath).isFile()) throw Error('release notes must be a regular file');
  if (!readFileSync(notePath, 'utf8').trim()) throw Error('release notes must be nonempty');
  readReleaseAssets(output, version);
  const gh = args => execFileSync('gh', args, { encoding: 'utf8', env: { ...process.env, GH_TOKEN: token, GH_DEBUG: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  publishRelease(gh, { repository, version, commit, output, notePath });
  console.log(`Release v${version} matches the tested commit and assets`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
