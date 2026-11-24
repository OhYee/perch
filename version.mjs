import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const git = promisify(execFile);
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const betaVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta-[0-9a-f]{12}$/;

export function effectiveVersion(manifest, commit) {
  const { version, perchReleaseChannel = 'stable' } = manifest;
  if (perchReleaseChannel !== 'stable' && perchReleaseChannel !== 'beta') throw Error('Invalid release channel');
  if (perchReleaseChannel === 'beta' && betaVersion.test(version)) return version;
  if (!stableVersion.test(version)) throw Error('Invalid package version');
  if (perchReleaseChannel === 'stable') return version;
  if (typeof commit !== 'string' || !/^[0-9a-f]{12,64}$/.test(commit)) throw Error('A Git commit is required for a beta version');
  return `${version}-beta-${commit.slice(0, 12)}`;
}

export async function sourceVersion(manifest, directory) {
  if (manifest.perchReleaseChannel !== 'beta' || betaVersion.test(manifest.version)) return effectiveVersion(manifest);
  let commit;
  try {
    ({ stdout: commit } = await git('git', ['rev-parse', '--verify', 'HEAD'], { cwd: directory, encoding: 'utf8' }));
  } catch {
    throw Error('Cannot determine the Git commit for this beta source checkout');
  }
  return effectiveVersion(manifest, commit.trim());
}
