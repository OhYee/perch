import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const targets = new Set(['mjs', 'darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']);
const [directory, target, ...extra] = process.argv.slice(2);
if (!directory || !targets.has(target) || extra.length) {
  throw new Error('Usage: bun scripts/build-portable.mjs <output-directory> <mjs|darwin-arm64|darwin-x64|linux-arm64|linux-x64>');
}
if (Bun.version !== '1.4.4') throw new Error('Building portable artifacts requires Bun 1.4.4');

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(resolve(directory), target === 'mjs' ? 'perch.mjs' : `perch-${target}`);
const build = async options => {
  const result = await Bun.build(options);
  if (!result.success) throw new AggregateError(result.logs, 'Portable build failed');
  return result;
};
const common = { root, format: 'esm', sourcemap: 'none', env: 'disable', minify: { whitespace: true, syntax: true } };
const extension = await build({ ...common, target: 'node', entrypoints: [join(root, 'omp-extension.ts')] });
if (extension.outputs.length !== 1) throw new Error('Expected one bundled OMP extension');
const wsDir = dirname(createRequire(import.meta.url).resolve('ws/package.json'));
const licenses = `/*\n${await readFile(join(root, 'LICENSE'), 'utf8')}\nws:\n${await readFile(join(wsDir, 'LICENSE'), 'utf8')}\n*/\n`;
const banner = target === 'mjs'
  ? `#!/usr/bin/env node\n${licenses}import { createRequire as __perchCreateRequire } from 'node:module';\nconst require = __perchCreateRequire(import.meta.url);\n`
  : licenses;
await mkdir(dirname(output), { recursive: true });
const result = await build({
  ...common,
  entrypoints: [join(root, 'scripts/portable-entry.mjs')],
  target: target === 'mjs' ? 'node' : 'bun',
  banner,
  define: {
    __PERCH_PORTABLE__: 'true',
    __PERCH_NATIVE__: String(target !== 'mjs'),
    __PERCH_OMP_EXTENSION__: JSON.stringify(await extension.outputs[0].text()),
    'process.env.WS_NO_BUFFER_UTIL': '"1"',
    'process.env.WS_NO_UTF_8_VALIDATE': '"1"',
  },
  ...(target === 'mjs' ? {} : {
    compile: {
      target: `bun-${target}`,
      outfile: output,
      autoloadDotenv: false,
      autoloadBunfig: false,
      autoloadTsconfig: false,
      autoloadPackageJson: false,
    },
  }),
});
if (target === 'mjs') {
  if (result.outputs.length !== 1) throw new Error('Expected one bundled Node entry point');
  await writeFile(output, new Uint8Array(await result.outputs[0].arrayBuffer()), { mode: 0o755 });
}
await chmod(output, 0o755);
