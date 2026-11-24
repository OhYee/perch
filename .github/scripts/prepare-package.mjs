import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assetFilename, validateVersion } from './release-intent.mjs';
import { sourceVersion } from '../../version.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const topLevel = ['cli.mjs', 'diagnostics.mjs', 'help.mjs', 'locale.mjs', 'terminal-input.mjs', 'portable-runtime.mjs', 'update.mjs', 'version.mjs', 'view.mjs', 'omp-extension.ts'];
const allowed = /^(?:package\.json|README\.md|LICENSE|SECURITY\.md|CONTRIBUTING\.md|AGENTS\.md|releases\/[A-Za-z0-9][A-Za-z0-9.+_-]*\.md|cli\.mjs|diagnostics\.mjs|help\.mjs|locale\.mjs|terminal-input\.mjs|portable-runtime\.mjs|update\.mjs|version\.mjs|view\.mjs|omp-extension\.ts|adapters\/[a-z0-9][a-z0-9-]*\.mjs)$/;

export function validatePackageEntries(entries, required) {
  if (!Array.isArray(entries) || entries.some(path => typeof path !== 'string' || path.includes('..') || !allowed.test(path))) throw Error('package contains an unexpected or unsafe file');
  const actual = new Set(entries);
  if (actual.size !== entries.length) throw Error('package contains duplicate files');
  for (const path of required) if (!actual.has(path)) throw Error(`package is missing ${path}`);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', ...options });
}

async function main() {
  if (process.argv.length !== 3) throw Error('usage: node .github/scripts/prepare-package.mjs OUTPUT_DIR');
  const output = resolve(process.argv[2]);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const baseVersion = validateVersion(pkg.version);
  const version = await sourceVersion(pkg, root);
  if (pkg.name !== 'perch' || pkg.private !== true) throw Error('expected the private perch package');
  const filename = assetFilename(version);
  const npmFilename = `perch-${version}.tgz`;
  const archive = join(output, filename);
  const npmArchive = join(output, npmFilename);
  const receipt = join(output, `${filename}.sha256`);
  mkdirSync(output, { recursive: true });
  if (existsSync(archive) || existsSync(npmArchive) || existsSync(receipt) || existsSync(join(output, 'SHA256SUMS.txt'))) throw Error('output already contains a release asset');
  const staging = mkdtempSync(join(tmpdir(), 'perch-pack-'));
  let packed;
  try {
    for (const path of ['README.md', 'LICENSE', 'SECURITY.md', 'CONTRIBUTING.md', 'AGENTS.md', 'releases', 'adapters', ...topLevel]) {
      cpSync(join(root, path), join(staging, path), { recursive: true });
    }
    if (process.env.PERCH_TRUSTED_RELEASE === '1') {
      const repository = process.env.GITHUB_REPOSITORY || '';
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw Error('invalid GITHUB_REPOSITORY');
      pkg.repository = { type: 'git', url: `git+https://github.com/${repository}.git` };
    }
    pkg.version = version;
    writeFileSync(join(staging, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
    [packed] = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--offline', '--json', '--pack-destination', output], { cwd: staging }));
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  if (packed.name !== pkg.name || packed.version !== version || packed.filename !== npmFilename) throw Error('npm pack returned an unexpected package');
  if (npmArchive !== archive) renameSync(npmArchive, archive);
  const data = readFileSync(archive);
  if (`sha512-${createHash('sha512').update(data).digest('base64')}` !== packed.integrity) throw Error('npm pack integrity mismatch');
  const expected = packed.files.map(file => file.path);
  const adapters = readdirSync(join(root, 'adapters')).filter(name => name.endsWith('.mjs')).map(name => `adapters/${name}`);
  validatePackageEntries(expected, ['package.json', 'README.md', 'LICENSE', 'SECURITY.md', 'CONTRIBUTING.md', 'AGENTS.md', `releases/v${baseVersion}.md`, ...topLevel, ...adapters]);
  const members = run('tar', ['-tzf', archive]).trimEnd().split('\n').map(path => {
    if (!path.startsWith('package/')) throw Error('archive member is outside package/');
    return path.slice('package/'.length);
  });
  validatePackageEntries(members, expected);
  if (members.length !== expected.length) throw Error('archive and npm pack file list differ');

  const temp = mkdtempSync(join(tmpdir(), 'perch-package-'));
  try {
    run('tar', ['-xzf', archive, '-C', temp]);
    const unpacked = join(temp, 'package');
    const manifest = JSON.parse(readFileSync(join(unpacked, 'package.json'), 'utf8'));
    if (manifest.version !== version || JSON.stringify(manifest.repository) !== JSON.stringify(pkg.repository)) throw Error('packaged manifest metadata mismatch');
    copyFileSync(join(root, 'package-lock.json'), join(unpacked, 'package-lock.json'));
    run('npm', ['ci', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'], { cwd: unpacked });
    const env = { ...process.env, HOME: temp, PI_CODING_AGENT_DIR: join(temp, 'agent'), OMP_PROFILE: '', PI_PROFILE: '', LC_ALL: 'en_US.UTF-8' };
    const prefix = join(temp, 'installed');
    run('npm', ['install', '--global', '--install-links=false', '--offline', '--ignore-scripts', '--prefix', prefix, unpacked]);
    const cli = join(prefix, 'bin', 'perch');
    if (run(cli, ['--version'], { env }).trim() !== version) throw Error('packaged CLI version does not match package.json');
    if (!run(cli, ['--help', '--lang', 'en'], { env }).includes('perch')) throw Error('packaged CLI help smoke failed');
    const installed = JSON.parse(run(cli, ['integration', 'install', 'omp', '--json', '--lang', 'en'], { env }));
    const extension = join(temp, 'agent', 'extensions', 'agent-session.ts');
    if (installed.status !== 'installed' || installed.path !== extension) throw Error('packaged integration install smoke failed');
    run(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', 'const m = await import(process.argv[1]); if (typeof m.default !== "function") throw Error("missing extension");', pathToFileURL(extension).href], { env });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  if (!readFileSync(archive).equals(data)) throw Error('package changed during smoke testing');
  const hash = createHash('sha256').update(data).digest('hex');
  writeFileSync(receipt, `${hash}\n`, { flag: 'wx' });
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `archive=${archive}\nreceipt=${receipt}\n`);
  console.log(`Prepared and smoke-tested ${filename}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
