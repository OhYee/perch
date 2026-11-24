import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { effectiveVersion } from '../../version.mjs';

const semver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-beta-[0-9a-f]{12})?(?![\s\S])/;

export function validateVersion(version) {
  if (typeof version !== 'string' || !semver.test(version)) throw Error('version must be canonical semver x.y.z or x.y.z-beta-<commit>');
  return version;
}

export function assetFilename(version) {
  return `perch-${validateVersion(version)}.tgz`;
}

function trackedVersion(manifest, commit) {
  if (validateVersion(manifest.version).includes('-beta-')) throw Error('tracked package version must be a stable base');
  return validateVersion(effectiveVersion(manifest, commit));
}

export function releaseIntent(previous, current, notes) {
  validateVersion(current);
  if (previous !== null) validateVersion(previous);
  if (previous === current) return false;
  if (previous !== null) {
    const [oldBase, oldBeta] = previous.split('-beta-');
    const [newBase] = current.split('-beta-');
    if (oldBase === newBase) {
      if (!oldBeta) throw Error('invalid release version transition');
    } else {
      const [major, minor, patch] = oldBase.split('.').map(BigInt);
      const nextBases = [`${major}.${minor}.${patch + 1n}`, `${major}.${minor + 1n}.0`, `${major + 1n}.0.0`];
      if (!nextBases.includes(newBase)) throw Error('invalid release version transition');
    }
  }
  if (typeof notes !== 'string' || !notes.trim()) throw Error(`releases/v${current.split('-beta-')[0]}.md must be a tracked, nonempty release note`);
  return true;
}

function git(...args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw Error(`git ${args[0]} failed: ${result.stderr || result.error?.message || result.status}`);
  return result.stdout;
}

function hasObject(spec) {
  const result = spawnSync('git', ['cat-file', '-e', spec], { encoding: 'utf8' });
  if (result.error) throw result.error;
  return result.status === 0;
}

function main() {
  const { BEFORE: before, COMMIT: commit, GITHUB_OUTPUT: output } = process.env;
  if (!/^[0-9a-f]{40}$/.test(before || '') || !/^[0-9a-f]{40}$/.test(commit || '') || !output) throw Error('BEFORE, COMMIT and GITHUB_OUTPUT are required');
  if (!hasObject(`${commit}^{commit}`)) throw Error('tested commit is unavailable');
  if (!/^0{40}$/.test(before) && !hasObject(`${before}^{commit}`)) {
    // A force-pushed previous tip may not be included in the normal full-history checkout.
    git('fetch', '--no-tags', 'origin', before);
    if (!hasObject(`${before}^{commit}`)) throw Error('previous push commit is unavailable');
  }
  const current = trackedVersion(JSON.parse(git('show', `${commit}:package.json`)), commit);
  const previous = /^0{40}$/.test(before) || !hasObject(`${before}:package.json`)
    ? null : trackedVersion(JSON.parse(git('show', `${before}:package.json`)), before);
  let notes;
  if (previous !== current) {
    const path = `releases/v${current.split('-beta-')[0]}.md`;
    const entry = git('ls-tree', commit, '--', path).trim();
    if (!/^100(?:644|755) blob [0-9a-f]{40}\t/.test(entry)) throw Error(`${path} must be a tracked regular file`);
    notes = git('show', `${commit}:${path}`);
  }
  const release = releaseIntent(previous, current, notes);
  appendFileSync(output, `release=${release}\nversion=${current}\n`);
  console.log(release ? `Release v${current} requested` : `Version ${current} unchanged; no release requested`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
