import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extension from '../omp-extension.ts';

test('parallel native starts across providers stack down on one right column instead of splitting horizontally', async t => {
  const root = await mkdtemp(join(tmpdir(), 'perch-parallel-layout-'));
  const home = join(root, 'home');
  const cwd = join(root, 'work');
  const bin = join(root, 'bin');
  const log = join(root, 'perch.jsonl');
  const state = join(root, 'state.json');
  await Promise.all([mkdir(join(home, '.omp', 'agent'), { recursive: true }), mkdir(cwd, { recursive: true }), mkdir(bin, { recursive: true })]);

  const fakePerch = join(bin, 'fake-perch');
  await writeFile(fakePerch, `#!${process.execPath}
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const chunks = [];
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', () => {
  appendFileSync(process.env.MOCK_LOG, JSON.stringify({ args }) + '\\n');
  const st = existsSync(process.env.MOCK_STATE) ? JSON.parse(readFileSync(process.env.MOCK_STATE, 'utf8')) : { count: 0, sessions: [] };
  if (args[0] === 'list') {
    const i = args.indexOf('--provider');
    console.log(JSON.stringify(i >= 0 ? st.sessions.filter(s => s.provider === args[i + 1]) : st.sessions));
  } else if (args[0] === 'start') {
    const provider = args[1];
    st.count += 1;
    const pad = String(st.count).padStart(12, '0');
    const cwdArg = args[args.indexOf('--cwd') + 1];
    const id = provider === 'agy'
      ? 'agy:native-' + (1000 + st.count) + '.0123456789abcdef-11111111-1111-4111-8111-' + pad
      : 'omp:22222222-2222-4222-8222-' + pad;
    st.sessions.push({ id, provider, kind: 'session', status: 'idle', send: true, history: true, wait: true, cwd: cwdArg });
    writeFileSync(process.env.MOCK_STATE, JSON.stringify(st));
    console.log(JSON.stringify({ provider, mode: 'native', pane: { backend: 'tern', id: 800 + st.count } }));
  } else if (args[0] === 'send') {
    console.log(JSON.stringify({ accepted: true }));
  } else if (args[0] === 'wait') {
    console.log(JSON.stringify({ id: args[1], status: 'timeout' }));
  } else {
    process.exit(1);
  }
});
`, { mode: 0o755 });
  await chmod(fakePerch, 0o755);

  const live = Array.from({ length: 20 }, (_, i) => ({ id: 801 + i, live: true }));
  await writeFile(join(bin, 'tern'), `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === 'ls') console.log(JSON.stringify({ sessions: [{ tabs: [{ blocks: ${JSON.stringify(live)} }] }] }));
process.exit(0);
`, { mode: 0o755 });
  await chmod(join(bin, 'tern'), 0o755);

  const prev = { HOME: process.env.HOME, PATH: process.env.PATH, PERCH_BIN: process.env.PERCH_BIN, MOCK_LOG: process.env.MOCK_LOG, MOCK_STATE: process.env.MOCK_STATE };
  const handlers = new Map();
  const tools = new Map();
  const ctx = {
    mode: 'tui',
    cwd,
    agent: { kind: 'main', id: 'main' },
    sessionModes: { getState: () => ({ vibe: { status: 'inactive' } }) },
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => 'parallel-layout', getSessionFile: () => undefined, getBranch: () => [], getEntries: () => [] },
    hasUI: true,
    ui: { notify() {}, setStatus() {} },
  };
  t.after(async () => {
    await handlers.get('session_shutdown')?.({}, ctx).catch(() => {});
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await rm(root, { recursive: true, force: true });
  });
  process.env.HOME = home;
  process.env.PATH = `${bin}:${process.env.PATH ?? ''}`;
  process.env.PERCH_BIN = fakePerch;
  process.env.MOCK_LOG = log;
  process.env.MOCK_STATE = state;

  extension({
    arktype: s => s,
    on: (ev, fn) => handlers.set(ev, fn),
    registerCommand() {},
    registerTool: tool => tools.set(tool.name, tool),
    getSessionName: () => 'Director',
    getActiveTools: () => ['perch'],
    setActiveTools: async () => {},
    appendEntry() {},
    sendMessage() {},
    sendUserMessage: async () => {},
  });
  await handlers.get('session_start')({}, ctx);

  const perch = tools.get('perch');
  await Promise.all([
    perch.execute('p-omp', { op: 'start', provider: 'omp', native: true, name: 'omp-w', prompt: 'task one', notify: false }, undefined, undefined, ctx),
    perch.execute('p-agy', { op: 'start', provider: 'agy', native: true, name: 'agy-w', prompt: 'task two', notify: false }, undefined, undefined, ctx),
  ]);

  const starts = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse).filter(c => c.args[0] === 'start');
  assert.equal(starts.length, 2);
  const splits = starts.filter(c => c.args.includes('--split'));
  assert.equal(splits.length, 1, 'exactly one start may be the first right pane; the other must stack down on it');
  assert.deepEqual(splits[0].args.slice(splits[0].args.indexOf('--split'), splits[0].args.indexOf('--split') + 4), ['--split', 'down', '--target', '801']);
});
