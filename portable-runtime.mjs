import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const portable = typeof __PERCH_PORTABLE__ !== 'undefined' && __PERCH_PORTABLE__;
const native = typeof __PERCH_NATIVE__ !== 'undefined' && __PERCH_NATIVE__;

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
