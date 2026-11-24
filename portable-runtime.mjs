import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import manifest from './package.json' with { type: 'json' };
import { sourceVersion } from './version.mjs';

const portable = typeof __PERCH_PORTABLE__ !== 'undefined' && __PERCH_PORTABLE__;
const native = typeof __PERCH_NATIVE__ !== 'undefined' && __PERCH_NATIVE__;
export const clientVersion = typeof __PERCH_VERSION__ === 'string' ? __PERCH_VERSION__ : manifest.version;

let versionPromise;
export function getVersion() {
  if (typeof __PERCH_VERSION__ === 'string') return Promise.resolve(__PERCH_VERSION__);
  return versionPromise ??= sourceVersion(manifest, fileURLToPath(new URL('.', import.meta.url)));
}
export const repository = (typeof __PERCH_REPOSITORY__ === 'string' && __PERCH_REPOSITORY__)
  || (typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url);
export const kind = native ? 'native' : portable ? 'mjs' : 'package';
export const entry = native ? process.execPath : fileURLToPath(portable ? import.meta.url : new URL('./cli.mjs', import.meta.url));

export const embeddedOmpExtension = typeof __PERCH_OMP_EXTENSION__ === 'string' ? __PERCH_OMP_EXTENSION__ : null;

export function cliInvocation() {
  if (native) return [process.execPath];
  const script = portable ? import.meta.url : new URL('./cli.mjs', import.meta.url);
  return [process.execPath, fileURLToPath(script)];
}

export function bridgeInvocation(moduleURL) {
  if (portable) return [...cliInvocation(), '--perch-internal-bridge', basename(fileURLToPath(moduleURL))];
  return [process.execPath, fileURLToPath(moduleURL)];
}
