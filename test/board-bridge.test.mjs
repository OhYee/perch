import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { promisify } from 'node:util';
import extension from '../omp-extension.ts';
import { BoardStore } from '../board/store.ts';
import { boardPath } from '../board/runtime.ts';

const run = promisify(execFile);
const cliPath = fileURLToPath(new URL('../cli.mjs', import.meta.url));

test('workers write their own board item through `perch board` over the private bridge', async t => {
  const root = await mkdtemp(join(tmpdir(), 'perch-board-bridge-'));
  const home = join(root, 'home');
  const cwd = join(root, 'work');
  const bin = join(root, 'bin');
  const log = join(root, 'perch.jsonl');
  const state = join(root, 'state.json');
  const sessionFile = join(root, 'sessions', 'main.jsonl');
  await Promise.all([
    mkdir(join(home, '.omp', 'agent'), { recursive: true }),
    mkdir(cwd, { recursive: true }),
    mkdir(bin, { recursive: true }),
    mkdir(join(root, 'sessions'), { recursive: true }),
  ]);

  const fakePerch = join(bin, 'fake-perch');
  await writeFile(fakePerch, `#!${process.execPath}
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const chunks = [];
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', () => {
  appendFileSync(process.env.MOCK_LOG, JSON.stringify({ args, stdin: Buffer.concat(chunks).toString('utf8') }) + '\\n');
  const st = existsSync(process.env.MOCK_STATE) ? JSON.parse(readFileSync(process.env.MOCK_STATE, 'utf8')) : { count: 0 };
  if (args[0] === 'start') {
    st.count += 1;
    writeFileSync(process.env.MOCK_STATE, JSON.stringify(st));
    console.log(JSON.stringify({ id: 'omp:aaaaaaaa-aaaa-4aaa-8aaa-' + String(st.count).padStart(12, '0'), provider: 'omp' }));
  } else if (args[0] === 'send') {
    console.log(JSON.stringify({ accepted: true }));
  } else if (args[0] === 'list') {
    console.log('[]');
  } else {
    console.log(JSON.stringify({ id: args[1], closed: true }));
  }
});
`, { mode: 0o755 });
  await chmod(fakePerch, 0o755);

  const prev = { HOME: process.env.HOME, PERCH_BIN: process.env.PERCH_BIN, MOCK_LOG: process.env.MOCK_LOG, MOCK_STATE: process.env.MOCK_STATE };
  const handlers = new Map();
  const tools = new Map();
  const ctx = {
    mode: 'tui',
    cwd,
    agent: { kind: 'main', id: 'main' },
    sessionModes: { getState: () => ({ vibe: { status: 'inactive' } }) },
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => 'bridge-main', getSessionFile: () => sessionFile, getBranch: () => [], getEntries: () => [] },
    hasUI: true,
    ui: { notify() {}, setStatus() {} },
  };
  t.after(async () => {
    await handlers.get('session_shutdown')?.({}, ctx).catch(() => {});
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await rm(root, { recursive: true, force: true });
  });
  process.env.HOME = home;
  process.env.PERCH_BIN = fakePerch;
  process.env.MOCK_LOG = log;
  process.env.MOCK_STATE = state;

  extension({
    arktype: s => s,
    on: (ev, fn) => handlers.set(ev, fn),
    registerCommand() {},
    registerTool: tool => tools.set(tool.name, tool),
    getSessionName: () => 'Director',
    getActiveTools: () => ['perch', 'board'],
    setActiveTools: async () => {},
    appendEntry() {},
    sendMessage() {},
    sendUserMessage: async () => {},
  });
  await handlers.get('session_start')({}, ctx);

  const board = tools.get('board');
  const perch = tools.get('perch');
  const created = await board.execute('c', { op: 'create', title: 'Fix lint', description: 'd', criteria: 'lint passes' }, undefined, undefined, ctx);
  const item = created.details.item.id;

  const startWorker = async (name, boardRole) => {
    const started = await perch.execute(`s-${name}`, { op: 'start', provider: 'omp', native: false, name, item, boardRole, prompt: `work on ${name}`, notify: false }, undefined, undefined, ctx);
    const logged = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse)
      .filter(c => c.args[0] === 'send' && c.args[1] === started.details.id).at(-1);
    const socket = /--socket (\S+)/.exec(logged.stdin)?.[1];
    const token = /--token ([0-9a-f]{48})/.exec(logged.stdin)?.[1];
    assert.ok(socket && token, `worker prompt must carry board access: ${logged.stdin.slice(0, 400)}`);
    assert.match(logged.stdin, /\[Session Board access\]/);
    return { id: started.details.id, socket: socket.replace(/^'|'$/g, ''), token };
  };
  const board_ = (w, ...args) => run(process.execPath, [cliPath, 'board', ...args, '--socket', w.socket, '--token', w.token]);
  const store = new BoardStore(boardPath(sessionFile));
  t.after(() => store.close());
  const itemState = () => store.snapshot().items.find(i => i.id === item);

  // Executor: snapshot, progress(handoff), submit
  const executor = await startWorker('exec', 'execute');
  const snap = await board_(executor, 'snapshot');
  assert.match(snap.stdout, /\[Session Board Context\]/);
  assert.match(snap.stdout, /lint passes/);
  await board_(executor, 'progress', '--text', 'ruled out cache', '--handoff');
  assert.ok(itemState().history.some(h => h.kind === 'progress_handoff' && h.text.includes('ruled out cache')));
  await board_(executor, 'submit', '--text', 'lint is green');
  assert.equal(itemState().state, 'awaiting_review');

  // Guard rails: manager ops, wrong token, and executor cannot approve their own item
  await assert.rejects(board_(executor, 'create', '--text', 'x'), /not available to workers/);
  await assert.rejects(run(process.execPath, [cliPath, 'board', 'snapshot', '--socket', executor.socket, '--token', 'f'.repeat(48)]), /invalid or expired board token/);

  // Independent reviewer approves
  const reviewer = await startWorker('review', 'review');
  await board_(reviewer, 'approve', '--text', 'verified');
  assert.equal(itemState().state, 'done');
  await assert.rejects(board_(executor, 'progress', '--text', 'late'), /cannot update a closed item|no current board binding|not currently assigned/);
});
