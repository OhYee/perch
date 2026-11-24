import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const semver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function validateVersion(version) {
  if (typeof version !== 'string' || !semver.test(version)) throw Error('package.json version must be valid semver');
  return version;
}

export function assetFilename(version) {
  return `agent-session-${validateVersion(version).replace('+', '-')}.tgz`;
}

export function releaseIntent(previous, current, notes) {
  validateVersion(current);
  if (previous !== null) validateVersion(previous);
  if (previous === current) return false;
  if (typeof notes !== 'string' || !notes.trim()) throw Error(`releases/v${current}.md must be a tracked, nonempty release note`);
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
  const current = validateVersion(JSON.parse(git('show', `${commit}:package.json`)).version);
  const previous = /^0{40}$/.test(before) || !hasObject(`${before}:package.json`)
    ? null : JSON.parse(git('show', `${before}:package.json`)).version;
  let notes;
  if (previous !== current) {
    const path = `releases/v${current}.md`;
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
