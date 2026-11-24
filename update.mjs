import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, readFile, realpath, rename, rmdir, stat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta-([0-9a-f]{12}))?(?![\s\S])/;
const portableAssets = ['perch.mjs', 'perch-darwin-arm64', 'perch-darwin-x64', 'perch-linux-arm64', 'perch-linux-x64'];
const maxMetadata = 1024 * 1024;
const maxReleaseMetadata = 4 * 1024 * 1024;
const releasesPerPage = 30;
const maxAsset = 512 * 1024 * 1024;
const downloadHosts = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-production-release-asset-2e65be.s3.amazonaws.com']);

function parseVersion(value) {
  const match = typeof value === 'string' && value.length <= 200 && semver.exec(value);
  if (!match) throw Error('Invalid semantic version');
  return { numbers: match.slice(1, 4).map(BigInt), beta: match[4] };
}

function compareVersions(left, right) {
  for (let i = 0; i < 3; i++) {
    if (left.numbers[i] !== right.numbers[i]) return left.numbers[i] > right.numbers[i] ? 1 : -1;
  }
  if (!left.beta || !right.beta) return left.beta ? -1 : right.beta ? 1 : 0;
  return 0;
}

function validRepository(value) {
  return typeof value === 'string' && value.length <= 201 && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?![\s\S])/.test(value)
    && value.split('/').every(part => part !== '.' && part !== '..' && part.length <= 100);
}

function repositoryName(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) value = value.url;
  if (typeof value !== 'string' || /[\x00-\x20\x7f]/.test(value)) throw Error('Invalid GitHub repository');
  if (validRepository(value)) return value;
  if (value.startsWith('git@github.com:')) {
    value = value.slice('git@github.com:'.length).replace(/\.git$/, '');
    if (validRepository(value)) return value;
    throw Error('Invalid GitHub repository');
  }
  if (value.startsWith('git+')) value = value.slice(4);
  let url;
  try { url = new URL(value); } catch { throw Error('Invalid GitHub repository'); }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) {
    throw Error('Invalid GitHub repository');
  }
  const path = url.pathname.replace(/^\//, '').replace(/\/$/, '').replace(/\.git$/, '');
  if (!validRepository(path)) throw Error('Invalid GitHub repository');
  return path;
}

function selectRepository(repository, override) {
  const origin = repository == null || repository === '' ? null : repositoryName(repository);
  if (override !== undefined && !validRepository(override)) throw Error('--repo must be OWNER/REPO');
  if (origin && override && origin.toLowerCase() !== override.toLowerCase()) {
    throw Error('--repo does not match this installation\'s release repository');
  }
  if (!origin && !override) throw Error('No trusted release repository is configured; specify --repo OWNER/REPO');
  return origin || override;
}

function secureUrl(value) {
  if (typeof value !== 'string' || /[\x00-\x20\x7f]/.test(value)) throw Error('Invalid release download URL');
  let url;
  try { url = new URL(value); } catch { throw Error('Invalid release download URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) throw Error('Invalid release download URL');
  return url;
}

async function request(fetch, url, headers) {
  try {
    return await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(300000) });
  } catch {
    throw Error('GitHub release request failed');
  }
}

async function readBody(response, limit) {
  if (!response.body) throw Error('Release response has no body');
  const length = response.headers.get('content-length');
  if (length && /^\d+$/.test(length) && BigInt(length) > BigInt(limit)) throw Error('Release response is too large');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw Error('Release response is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function latestRelease(fetch, repository, allowBeta, currentVersion, current) {
  const releases = [];
  const tags = new Set();
  let complete = false;
  for (let page = 1; page <= 100; page++) {
    const url = `https://api.github.com/repos/${repository}/releases?per_page=${releasesPerPage}&page=${page}`;
    const response = await request(fetch, url, { 'User-Agent': 'perch-updater', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' });
    if (response.status !== 200) throw Error(`GitHub releases request failed (HTTP ${response.status})`);
    let pageReleases;
    try { pageReleases = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBody(response, maxReleaseMetadata))); }
    catch { throw Error('Invalid GitHub release response'); }
    if (!Array.isArray(pageReleases) || pageReleases.length > releasesPerPage) throw Error('Invalid GitHub release response');
    for (const release of pageReleases) {
      if (!release || release.draft !== false || typeof release.tag_name !== 'string' || !release.tag_name.startsWith('v')) continue;
      const latest = release.tag_name.slice(1);
      let parsed;
      try { parsed = parseVersion(latest); } catch { continue; }
      if (release.prerelease !== Boolean(parsed.beta)) continue;
      if (tags.has(release.tag_name)) throw Error('Duplicate GitHub release tag');
      tags.add(release.tag_name);
      const published = typeof release.published_at === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(release.published_at)
        ? Date.parse(release.published_at) : NaN;
      if (!Number.isFinite(published) || new Date(published).toISOString() !== release.published_at.replace(/Z$/, '.000Z')) throw Error('Invalid GitHub release publication time');
      releases.push({ release, latest, parsed, published });
    }
    if (pageReleases.length < releasesPerPage) { complete = true; break; }
  }
  if (!complete) throw Error('Too many GitHub release pages to determine the latest release safely');
  let best, ambiguous = false;
  for (const candidate of releases) {
    if (candidate.parsed.beta && !allowBeta) continue;
    if (!best) { best = candidate; continue; }
    const order = compareVersions(candidate.parsed, best.parsed);
    if (order > 0 || (order === 0 && candidate.parsed.beta && candidate.published > best.published)) {
      best = candidate;
      ambiguous = false;
    } else if (order === 0 && candidate.parsed.beta && candidate.published === best.published && candidate.latest !== best.latest) {
      ambiguous = true;
    }
  }
  if (!best) throw Error(allowBeta ? 'No published stable or beta release found' : 'No published stable release found; use --beta to include beta releases');
  if (ambiguous) throw Error('Cannot determine the newest beta release from its publication time');
  let order = compareVersions(best.parsed, current);
  if (order === 0 && best.parsed.beta && current.beta && best.latest !== currentVersion) {
    const installed = releases.find(item => item.latest === currentVersion);
    if (!installed) throw Error('Cannot determine the installed beta release order; update manually');
    if (best.published === installed.published) throw Error('Cannot determine the installed beta release order; update manually');
    order = best.published > installed.published ? 1 : -1;
  }
  return { ...best, order };
}

function assetUrl(release, repository, tag, name, allowedNames) {
  if (!Array.isArray(release.assets) || release.assets.length > 100) throw Error('Invalid release assets');
  const seen = new Set();
  let selected;
  for (const asset of release.assets) {
    if (!asset || typeof asset.name !== 'string' || !allowedNames.has(asset.name) || seen.has(asset.name)) throw Error('Invalid or duplicate release asset');
    seen.add(asset.name);
    if (asset.name === name) selected = asset;
  }
  if (!selected || selected.state !== 'uploaded' || typeof selected.browser_download_url !== 'string') throw Error(`Missing release asset ${name}`);
  const url = secureUrl(selected.browser_download_url);
  let parts;
  try { parts = url.pathname.split('/').slice(1).map(decodeURIComponent); } catch { throw Error('Invalid release asset URL'); }
  const expected = [...repository.split('/'), 'releases', 'download', tag, name];
  if (url.hostname !== 'github.com' || url.search || parts.length !== expected.length || parts.some((part, i) => i < 2 ? part.toLowerCase() !== expected[i].toLowerCase() : part !== expected[i])) {
    throw Error('Invalid release asset URL');
  }
  return url;
}

async function downloadResponse(fetch, initial) {
  let url = initial;
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await request(fetch, url.href, { 'User-Agent': 'perch-updater', Accept: 'application/octet-stream' });
    if (response.status === 200) return response;
    if (![301, 302, 303, 307, 308].includes(response.status) || redirects === 5) throw Error(`Release asset request failed (HTTP ${response.status})`);
    const location = response.headers.get('location');
    if (!location || /[\x00-\x20\x7f]/.test(location)) throw Error('Invalid release asset redirect');
    let next;
    try { next = secureUrl(new URL(location, url).href); } catch { throw Error('Invalid release asset redirect'); }
    if (!downloadHosts.has(next.hostname) && !(next.hostname === 'github.com' && next.href === initial.href)) throw Error('Untrusted release asset redirect');
    await response.body?.cancel();
    url = next;
  }
  throw Error('Too many release asset redirects');
}

function checksumFor(text, target, allowedNames) {
  const checksums = new Map();
  for (const line of text.split('\n')) {
    if (!line) continue;
    const match = /^([a-fA-F0-9]{64})[ \t]+\*?([A-Za-z0-9][A-Za-z0-9._+-]*)\r?$/.exec(line);
    if (!match || !allowedNames.has(match[2]) || checksums.has(match[2])) throw Error('Invalid or duplicate release checksum');
    checksums.set(match[2], match[1].toLowerCase());
  }
  if (!checksums.has(target)) throw Error(`Missing checksum for ${target}`);
  return checksums.get(target);
}

function sameFile(a, b) {
  return ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
}

async function snapshotEntry(entry) {
  if (typeof entry !== 'string' || !isAbsolute(entry)) throw Error('Installation entry must be an absolute path');
  const target = await realpath(entry);
  const info = await stat(target, { bigint: true });
  if (!info.isFile() || info.nlink !== 1n) throw Error('Installation entry must be a regular file with one link');
  return { entry, target, info };
}

async function ensureEntryUnchanged(snapshot) {
  try {
    if (await realpath(snapshot.entry) !== snapshot.target || !sameFile(await stat(snapshot.target, { bigint: true }), snapshot.info)) throw Error();
  } catch {
    throw Error('Installation changed during update; retry after checking it');
  }
}

async function sourceCheckout(target) {
  for (let dir = dirname(target); ; dir = dirname(dir)) {
    try {
      await lstat(join(dir, '.git'));
      const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
      if (manifest.name === 'perch' && (await stat(join(dir, 'cli.mjs'))).isFile()) return true;
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR' && !(error instanceof SyntaxError)) throw error;
    }
    if (dirname(dir) === dir) return false;
  }
}

async function packageSnapshot(snapshot, run) {
  let output;
  try { output = await run('npm', ['prefix', '--global'], { encoding: 'utf8', maxBuffer: 1024 * 1024 }); }
  catch { throw Error('Could not detect the global npm prefix; update the package manually'); }
  const prefixText = typeof output?.stdout === 'string' ? output.stdout.trim() : '';
  if (!isAbsolute(prefixText) || /[\r\n\0]/.test(prefixText)) throw Error('Invalid global npm prefix; update the package manually');
  let prefix, rootInfo, manifestInfo, binInfo, manifest;
  try {
    prefix = await realpath(prefixText);
    const root = join(prefix, 'lib', 'node_modules', 'perch');
    rootInfo = await lstat(root, { bigint: true });
    if (!rootInfo.isDirectory() || await realpath(root) !== root || snapshot.target !== join(root, 'cli.mjs')) throw Error();
    const manifestPath = join(root, 'package.json');
    manifestInfo = await lstat(manifestPath, { bigint: true });
    if (!manifestInfo.isFile()) throw Error();
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const bin = join(prefix, 'bin', 'perch');
    binInfo = await lstat(bin, { bigint: true });
    if (!binInfo.isSymbolicLink() || await realpath(bin) !== snapshot.target || manifest.name !== 'perch') throw Error();
  } catch {
    throw Error('Not a verified global npm installation; update this package manually from the verified release tarball');
  }
  return { prefix, rootInfo, manifestInfo, binInfo, manifest };
}

async function ensurePackageUnchanged(snapshot, pkg, version) {
  try {
    await ensureEntryUnchanged(snapshot);
    const root = join(pkg.prefix, 'lib', 'node_modules', 'perch');
    const bin = join(pkg.prefix, 'bin', 'perch');
    if (!sameFile(await lstat(root, { bigint: true }), pkg.rootInfo)
      || !sameFile(await lstat(join(root, 'package.json'), { bigint: true }), pkg.manifestInfo)
      || !sameFile(await lstat(bin, { bigint: true }), pkg.binInfo)
      || await realpath(bin) !== snapshot.target || pkg.manifest.version !== version) throw Error();
  } catch {
    throw Error('Global npm installation changed or has a different version; update it manually');
  }
}

async function withPrivateTemp(parent, filename, callback) {
  const dir = await mkdtemp(join(parent, '.perch-update-'));
  const temp = join(dir, filename);
  try {
    const info = await lstat(dir);
    if (!info.isDirectory() || (info.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw Error('Updater temporary directory is not private');
    return await callback(temp);
  } finally {
    await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(dir).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function downloadVerified(fetch, url, path, expected, original) {
  const response = await downloadResponse(fetch, url);
  if (!response.body) throw Error('Release asset has no body');
  const length = response.headers.get('content-length');
  if (length && /^\d+$/.test(length) && BigInt(length) > BigInt(maxAsset)) throw Error('Release asset is too large');
  const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const written = createHash('sha256');
    let size = 0;
    for await (const bytes of response.body) {
      size += bytes.length;
      if (size > maxAsset) throw Error('Release asset is too large');
      written.update(bytes);
      for (let offset = 0; offset < bytes.length;) {
        const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset, null);
        if (!bytesWritten) throw Error('Could not write release asset');
        offset += bytesWritten;
      }
    }
    if (written.digest('hex') !== expected) throw Error('Release asset checksum mismatch');
    const before = await file.stat({ bigint: true });
    if (before.size !== BigInt(size)) throw Error('Downloaded asset changed during update');
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (let position = 0; position < size;) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - position), position);
      if (!bytesRead) throw Error('Downloaded asset changed during update');
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (hash.digest('hex') !== expected || !sameFile(before, await file.stat({ bigint: true }))) throw Error('Downloaded asset changed during update');
    if (original) {
      const current = await file.stat({ bigint: true });
      if (current.uid !== original.uid || current.gid !== original.gid) await file.chown(Number(original.uid), Number(original.gid));
      await file.chmod(Number(original.mode & 0o777n));
    }
    await file.sync();
    const stored = await file.stat({ bigint: true });
    const pathInfo = await lstat(path, { bigint: true });
    if (!stored.isFile() || stored.nlink !== 1n || !sameFile(stored, pathInfo)) throw Error('Downloaded asset changed during update');
    return stored;
  } finally {
    await file.close();
  }
}

export async function runUpdate({ version, repository, kind, entry, check = false, repo, beta = false }, dependencies = {}) {
  const current = parseVersion(version);
  const origin = selectRepository(repository, repo);
  if (!['native', 'mjs', 'package'].includes(kind) || typeof check !== 'boolean' || typeof beta !== 'boolean') throw Error('Invalid installation kind or update mode');
  const fetch = dependencies.fetch || globalThis.fetch;
  const run = dependencies.execFile || execFile;
  if (typeof fetch !== 'function' || typeof run !== 'function') throw Error('Updater transport is unavailable');
  const snapshot = check ? null : await snapshotEntry(entry);
  const { release, latest, order } = await latestRelease(fetch, origin, beta, version, current);
  if (order <= 0) return { current: version, latest, status: 'up_to_date' };
  if (check) return { current: version, latest, status: 'available' };
  if (await sourceCheckout(snapshot.target)) throw Error('Source checkout detected; update it manually after checking for local changes (for example, git pull --ff-only and npm ci --ignore-scripts)');

  const pkg = kind === 'package' ? await packageSnapshot(snapshot, run) : null;
  if (pkg) await ensurePackageUnchanged(snapshot, pkg, version);
  const archive = `perch-${latest}.tgz`;
  const name = kind === 'package' ? archive : kind === 'mjs' ? 'perch.mjs' : `perch-${process.platform}-${process.arch}`;
  const allowed = new Set([...portableAssets, archive, 'SHA256SUMS.txt']);
  if (!allowed.has(name)) throw Error('No release binary is available for this platform');
  const manifestUrl = assetUrl(release, origin, release.tag_name, 'SHA256SUMS.txt', allowed);
  const targetUrl = assetUrl(release, origin, release.tag_name, name, allowed);
  const manifestResponse = await downloadResponse(fetch, manifestUrl);
  const manifest = new TextDecoder('utf-8', { fatal: true }).decode(await readBody(manifestResponse, maxMetadata));
  const expected = checksumFor(manifest, name, new Set([...portableAssets, archive]));
  const parent = pkg ? dirname(join(pkg.prefix, 'lib', 'node_modules', 'perch')) : dirname(snapshot.target);
  await withPrivateTemp(parent, pkg ? archive : 'download', async temp => {
    const downloaded = await downloadVerified(fetch, targetUrl, temp, expected, pkg ? null : snapshot.info);
    if (pkg) {
      await ensurePackageUnchanged(snapshot, pkg, version);
      if (!sameFile(await lstat(temp, { bigint: true }), downloaded)) throw Error('Downloaded asset changed during update');
      try {
        await run('npm', ['install', '--global', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', pkg.prefix, '--', temp], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
      } catch {
        throw Error('Global npm update failed; inspect the installation and update manually if necessary');
      }
    } else {
      await ensureEntryUnchanged(snapshot);
      if (!sameFile(await lstat(temp, { bigint: true }), downloaded)) throw Error('Downloaded asset changed during update');
      await rename(temp, snapshot.target);
    }
  });
  return { current: version, latest, status: 'updated' };
}
