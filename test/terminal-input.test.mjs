import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const moduleUrl = new URL('../terminal-input.mjs', import.meta.url).href;

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-session-terminal-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = join(dir, 'commands');
  const count = join(dir, 'process-count');
  const fake = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
if (name === 'ps') {
  const pid = Number(args[args.indexOf('-p') + 1]);
  const group = Number(process.env.TARGET_GROUP || 4242);
  console.log(pid + ' ' + (pid === 11 ? 11 : group) + ' ' + group + ' test0');
} else if (name === 'tmux' && args.includes('list-panes')) {
  if (!process.env.FAKE_TMUX) process.exit(1);
  console.log('%1|11|/dev/test0|0|' + (process.env.COPY_MODE || '0'));
} else if (name === 'tern' && args[0] === 'ls') {
  const blocks = [{id:10,live:true,program:'bash'}];
  if (process.env.EXTRA_NULL) blocks.push({id:12,live:true,program:'bash'});
  console.log(JSON.stringify({sessions:[{tabs:[{blocks}]}]}));
} else if (name === 'tern' && args[0] === 'process') {
  if (args[1] === '12') { console.log(JSON.stringify({pane:12,foreground:null})); process.exit(0); }
  let n = 0; try { n = Number(fs.readFileSync(process.env.COUNT)); } catch {}
  fs.writeFileSync(process.env.COUNT, String(++n));
  console.log(JSON.stringify({pane:10,child:{pid:11},foreground:{pid:process.env.CHANGE_FOREGROUND && n > 1 ? 9999 : 4242}}));
} else {
  fs.appendFileSync(process.env.LOG, JSON.stringify([name,...args]) + '\\n');
  if (process.env.FAIL_ENTER && (args.includes('Enter'))) process.exit(1);
}
`;
  for (const name of ['ps', 'tern', 'tmux']) await writeFile(join(dir, name), fake, { mode: 0o755 });
  const env = { HOME: dir, PATH: dir, LOG: log, COUNT: count, ...options };
  const run = async ({ mode = 'text', text = 'secret $(unsafe)', enter = false, confirmFailure = false } = {}) => {
    const script = `import { sendTerminalInput } from ${JSON.stringify(moduleUrl)};
let calls = 0;
try { await sendTerminalInput({pid:4242, mode:${JSON.stringify(mode)}, text:${JSON.stringify(text)}, enter:${enter}, lang:'en', confirm:async () => { if (${confirmFailure} && ++calls === 2) throw Error('stale session'); }}); console.log(JSON.stringify({ok:true})); }
catch (e) { console.log(JSON.stringify({ok:false, unknown:e.deliveryUnknown === true, error:e.message})); }`;
    const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', script], { env });
    return JSON.parse(stdout);
  };
  const commands = async () => {
    try { return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  return { run, commands };
}

test('refuses changed Tern foreground before writing any input', async t => {
  const f = await fixture(t, { CHANGE_FOREGROUND: '1' });
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.equal(result.unknown, false);
  assert.doesNotMatch(result.error, /secret/);
  assert.deepEqual(await f.commands(), []);
});

test('reports unknown after text was delivered but Enter fails', async t => {
  const f = await fixture(t, { FAIL_ENTER: '1' });
  const result = await f.run({ enter: true });
  assert.equal(result.ok, false);
  assert.equal(result.unknown, true);
  assert.doesNotMatch(result.error, /secret/);
  assert.deepEqual(await f.commands(), [
    ['tern', 'send', '10', 'text', 'secret $(unsafe)'],
    ['tern', 'send', '10', 'keys', 'Enter'],
  ]);
});

test('rechecks the session before Enter and does not send it after identity changes', async t => {
  const f = await fixture(t);
  const result = await f.run({ enter: true, confirmFailure: true });
  assert.equal(result.ok, false);
  assert.equal(result.unknown, true);
  assert.deepEqual(await f.commands(), [['tern', 'send', '10', 'text', 'secret $(unsafe)']]);
});

test('tmux sends literal arguments without invoking a shell', async t => {
  const f = await fixture(t, { FAKE_TMUX: '1' });
  const result = await f.run({ text: '-n $(unsafe)', enter: true });
  assert.equal(result.ok, true);
  assert.deepEqual(await f.commands(), [
    ['tmux', '-N', 'send-keys', '-t', '%1', '-l', '--', '-n $(unsafe)'],
    ['tmux', '-N', 'send-keys', '-t', '%1', 'Enter'],
  ]);
});

test('refuses tmux copy mode without sending', async t => {
  const f = await fixture(t, { FAKE_TMUX: '1', COPY_MODE: '1' });
  const result = await f.run({ mode: 'key', text: 'Enter' });
  assert.equal(result.ok, false);
  assert.equal(result.unknown, false);
  assert.deepEqual(await f.commands(), []);
});

test('refuses a tmux process that is only a sibling in the foreground group', async t => {
  const f = await fixture(t, { FAKE_TMUX: '1', TARGET_GROUP: '9999' });
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.equal(result.unknown, false);
  assert.deepEqual(await f.commands(), []);
});

test('ignores an unrelated Tern block with no foreground process', async t => {
  const f = await fixture(t, { EXTRA_NULL: '1' });
  const result = await f.run();
  assert.equal(result.ok, true);
  assert.deepEqual(await f.commands(), [['tern', 'send', '10', 'text', 'secret $(unsafe)']]);
});
