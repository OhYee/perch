import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import extension from '../omp-extension.ts';
import { isInteractiveOmp } from '../adapters/omp.mjs';
import { BoardStore } from '../board/store.ts';
import { boardPath } from '../board/runtime.ts';

async function until(check, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await check();
    if (v) return v;
    await sleep(20);
  }
  assert.fail('Timed out waiting for condition');
}

const mockPerchStackScript = `#!${process.execPath}
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const log = process.env.MOCK_PERCH_LOG;
const stateFile = process.env.MOCK_PERCH_STATE;
const chunks = [];
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', () => {
  const stdin = Buffer.concat(chunks).toString('utf8');
  if (log) appendFileSync(log, JSON.stringify({ args, stdin }) + '\\n');
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { count: 0, sessions: [] };
  const cmd = args[0];
  if (cmd === 'list') {
    const providerIdx = args.indexOf('--provider');
    const provider = providerIdx >= 0 ? args[providerIdx + 1] : null;
    const rows = provider ? state.sessions.filter(s => s.provider === provider) : state.sessions;
    console.log(JSON.stringify(rows));
    return;
  }
  if (cmd === 'start') {
    const provider = args[1];
    state.count += 1;
    const n = state.count;
    const cwdIdx = args.indexOf('--cwd');
    const cwd = cwdIdx >= 0 ? args[cwdIdx + 1] : process.cwd();
    const isNative = args.includes('--native');
    if (isNative) {
      const id = provider + ':native-' + n;
      if (process.env.MOCK_DISCOVER_FAIL !== '1') {
        state.sessions.push({ id, provider, kind: 'session', status: 'idle', send: true, history: true, wait: true, cwd });
      }
      writeFileSync(stateFile, JSON.stringify(state));
      console.log(JSON.stringify({ provider, mode: 'native', pane: { backend: 'tern', id: 700 + n } }));
      return;
    }
    const id = provider + ':managed-' + n;
    state.sessions.push({ id, provider, kind: 'session', status: 'idle', send: true, history: true, wait: true, close: true, cwd });
    writeFileSync(stateFile, JSON.stringify(state));
    console.log(JSON.stringify({ id, provider }));
    return;
  }
  if (cmd === 'send') {
    console.log(JSON.stringify({ accepted: true }));
    return;
  }
  if (cmd === 'wait') {
    console.log(JSON.stringify({ id: args[1], status: 'completed' }));
    return;
  }
  if (cmd === 'history') {
    console.log(JSON.stringify([
      { role: 'user', text: 'task' },
      { role: 'assistant', text: 'MOCK_REPLY_FOR_' + args[1] },
    ]));
    return;
  }
  if (cmd === 'close') {
    console.log(JSON.stringify({ id: args[1], closed: true }));
    return;
  }
  process.exit(1);
});
`;

test('isInteractiveOmp recognizes Tern versioned binary paths alongside standard omp', () => {
  assert.equal(isInteractiveOmp({
    pid: 100,
    tty: 'ttys010',
    comm: '/Users/ohyee/Library/Application Support/Tern/omp/versions/19.1.1',
    args: '/Users/ohyee/Library/Application Support/Tern/omp/versions/19.1.1 --approval-mode yolo --model openai-codex/gpt-6.2-sol:medium',
  }), true);
  assert.equal(isInteractiveOmp({
    pid: 101,
    tty: 'ttys010',
    comm: '/Users/ohyee/Library/Application Support/Tern/omp/versions/19.1.1',
    args: '/Users/ohyee/Library/Application Support/Tern/omp/versions/19.1.1 __omp_worker_daemon',
  }), false);
});

test('/perch mode auto-enables from config.yml default:true, disables task, injects system prompt, resolves roles, stacks Tern panes, binds board, and closes native panes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'perch-mode-e2e-'));
  const home = join(root, 'home');
  const agentDir = join(home, '.omp', 'agent');
  const cwd = join(root, 'work');
  const bin = join(root, 'bin');
  const sessionFile = join(root, 'sessions', 'main-session.jsonl');
  const perchLog = join(root, 'perch.jsonl');
  const perchState = join(root, 'perch-state.json');
  const ternLog = join(root, 'tern.jsonl');
  await Promise.all([
    mkdir(agentDir, { recursive: true }),
    mkdir(cwd, { recursive: true }),
    mkdir(bin, { recursive: true }),
    mkdir(join(root, 'sessions'), { recursive: true }),
    mkdir(join(home, 'prompts'), { recursive: true }),
  ]);

  await writeFile(join(home, 'prompts', 'director.md'), `---\nname: director\n---\n# Director Protocol\n{{roles}}\nReport concisely.\n`);
  await writeFile(join(agentDir, 'config.yml'), `
modelRoles:
  slow: openai-codex/gpt-6.2-sol:medium
perch:
  default: true
  native: true
  layout: stack
  heartbeatSeconds: 0
  discoverTimeoutMs: 5000
  disableTools:
    - task
  systemPromptFiles:
    - ~/prompts/director.md
  appendSystemPrompt: "Local append note."
  workerPromptPrefix: "[Worker] Do not recurse."
  board:
    enabled: true
    autoCreate: true
  roles:
    investigate:
      label: 只读排查
      provider: agy
      model: gemini-4-neon
      write: false
      constraints: 只读输出证据
    complex-dev:
      label: 复杂开发
      provider: omp
      model: "@slow"
      write: true
`);

  const fakePerch = join(bin, 'fake-perch');
  await writeFile(fakePerch, mockPerchStackScript, { mode: 0o755 });
  await chmod(fakePerch, 0o755);

  const fakeTern = join(bin, 'tern');
  await writeFile(fakeTern, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_TERN_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'ls') {
  console.log(JSON.stringify({ sessions: [{ tabs: [{ blocks: [{ id: 701, live: true }, { id: 702, live: true }] }] }] }));
  process.exit(0);
}
if (args[0] === 'close') {
  process.exit(0);
}
process.exit(0);
`, { mode: 0o755 });
  await chmod(fakeTern, 0o755);

  const prev = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    PERCH_BIN: process.env.PERCH_BIN,
    MOCK_PERCH_LOG: process.env.MOCK_PERCH_LOG,
    MOCK_PERCH_STATE: process.env.MOCK_PERCH_STATE,
    MOCK_TERN_LOG: process.env.MOCK_TERN_LOG,
    PERCH_HEARTBEAT_MS: process.env.PERCH_HEARTBEAT_MS,
  };
  t.after(async () => {
    await handlers.get('session_shutdown')?.({}, ctx).catch(() => {});
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(root, { recursive: true, force: true });
  });

  process.env.HOME = home;
  process.env.PATH = `${bin}:${process.env.PATH ?? ''}`;
  process.env.PERCH_BIN = fakePerch;
  process.env.MOCK_PERCH_LOG = perchLog;
  process.env.MOCK_PERCH_STATE = perchState;
  process.env.MOCK_TERN_LOG = ternLog;
  delete process.env.PERCH_HEARTBEAT_MS;

  const handlers = new Map();
  const tools = new Map();
  const commands = new Map();
  const sentMessages = [];
  const entries = [];
  const statuses = new Map();
  const notifications = [];
  let activeTools = ['read', 'bash', 'task'];

  const ctx = {
    mode: 'tui',
    cwd,
    agent: { kind: 'main', id: 'main' },
    sessionModes: { getState: () => ({ vibe: { status: 'inactive' } }) },
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: {
      getSessionId: () => 'omp-mode-test',
      getSessionFile: () => sessionFile,
      getBranch: () => entries,
      getEntries: () => entries,
    },
    hasUI: true,
    ui: {
      notify: (msg, level) => notifications.push({ msg, level }),
      setStatus: (key, val) => statuses.set(key, val),
    },
  };

  extension({
    arktype: s => s,
    on: (ev, fn) => handlers.set(ev, fn),
    registerCommand: (name, def) => commands.set(name, def),
    registerTool: tool => tools.set(tool.name, tool),
    getSessionName: () => 'Director',
    getActiveTools: () => [...activeTools],
    setActiveTools: async next => { activeTools = [...next]; },
    appendEntry: (customType, data) => { entries.push({ type: 'custom', customType, data }); },
    sendMessage: (message, options) => { sentMessages.push({ message, options }); },
    sendUserMessage: async () => {},
  });

  // 1. session_start auto-enables /perch mode from config.yml default:true and disables task
  await handlers.get('session_start')({}, ctx);
  assert.equal(activeTools.includes('task'), false);
  assert.equal(activeTools.includes('perch'), true);
  assert.equal(activeTools.includes('board'), true);
  assert.equal(statuses.get('perch'), 'perch');

  // 2. before_agent_start injects configured override system prompt + expanded {{roles}} + appendSystemPrompt
  const before = await handlers.get('before_agent_start')({ reason: 'prompt', prompt: 'help', systemPrompt: ['BASE'] }, ctx);
  assert.ok(Array.isArray(before.systemPrompt));
  assert.equal(before.systemPrompt[0], 'BASE');
  assert.doesNotMatch(before.systemPrompt[1], /# Perch Mode/);
  assert.match(before.systemPrompt[1], /# Director Protocol/);
  assert.match(before.systemPrompt[1], /`complex-dev`.*`openai-codex\/gpt-6\.2-sol:medium`/);
  assert.match(before.systemPrompt[1], /Local append note\./);

  // 3. context hook strips stale eager-task-prelude while /perch mode is active
  const filtered = handlers.get('context')({
    messages: [
      { role: 'custom', customType: 'eager-task-prelude', content: 'use task' },
      { role: 'user', content: 'hello' },
    ],
  }, ctx);
  assert.equal(filtered.messages.some(m => m.customType === 'eager-task-prelude'), false);

  // 4. Built-in task subagents cannot invoke perch (anti-recursion)
  const perch = tools.get('perch');
  await assert.rejects(
    perch.execute('sub-1', { op: 'list' }, undefined, undefined, { ...ctx, agent: { kind: 'sub', id: 'worker-sub' } }),
    /only available in the main/,
  );

  // 5. Start worker 1 via role="investigate" (opens right pane 701, auto-creates board item, records receipt)
  const w1 = await perch.execute('s-1', {
    op: 'start',
    role: 'investigate',
    name: 'root-cause',
    prompt: 'Find the bug',
  }, undefined, undefined, ctx);
  assert.equal(w1.details.provider, 'agy');
  assert.equal(w1.details.role, 'investigate');
  assert.equal(w1.details.mode, 'native');
  assert.ok(w1.details.boardItem, 'expected automatic board item binding');

  // 6. Start worker 2 via role="complex-dev" -> stacks DOWN onto pane 701!
  const w2 = await perch.execute('s-2', {
    op: 'start',
    role: 'complex-dev',
    name: 'impl-fix',
    prompt: 'Implement fix',
  }, undefined, undefined, ctx);
  assert.equal(w2.details.provider, 'omp');
  assert.equal(w2.details.role, 'complex-dev');

  // Verify worker 1 & 2 calls: role expansion, workerPromptPrefix, and --split down --target 701 on worker 2
  const perchCalls = (await readFile(perchLog, 'utf8')).trim().split('\n').map(JSON.parse);
  const startCalls = perchCalls.filter(c => c.args[0] === 'start');
  assert.equal(startCalls.length, 2);
  assert.ok(startCalls[0].args.includes('--model') && startCalls[0].args.includes('gemini-4-neon'));
  assert.ok(startCalls[1].args.includes('openai-codex/gpt-6.2-sol:medium'));
  assert.ok(startCalls[1].args.includes('--split') && startCalls[1].args.includes('down'));
  assert.ok(startCalls[1].args.includes('--target') && startCalls[1].args.includes('701'));

  const sendW2 = perchCalls.find(c => c.args[0] === 'send' && c.args[1] === w2.details.id);
  assert.ok(sendW2 && sendW2.stdin.includes('[Worker] Do not recurse.'));

  // Wait for async completions & verify board receipts were recorded automatically
  await until(() => sentMessages.length >= 2);
  assert.match(sentMessages[0].message.content, /Board item:/);

  const store = new BoardStore(boardPath(sessionFile));
  t.after(() => store.close());
  const snap = store.snapshot();
  assert.equal(snap.items.length, 2);
  assert.ok(snap.items.some(i => i.history.some(h => h.kind === 'receipt' && h.text.includes('MOCK_REPLY_FOR_'))));

  // 7. Closing native worker via perch op=close invokes tern close 701 cleanly instead of erroring
  const closedW1 = await perch.execute('c-1', { op: 'close', id: w1.details.id }, undefined, undefined, ctx);
  assert.deepEqual(closedW1.details, { id: w1.details.id, closed: true, paneClosed: true });
  const ternCalls = (await readFile(ternLog, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(ternCalls.some(args => args[0] === 'close' && args[1] === '701'));

  // 8. `/perch close all` cleans up remaining worker panes, and `/perch off` restores `task` tool and clears status badge
  await commands.get('perch').handler('close all', ctx);
  await commands.get('perch').handler('off', ctx);
  assert.equal(activeTools.includes('task'), true);
  assert.equal(statuses.get('perch'), undefined);

  await handlers.get('session_shutdown')({}, ctx);
});
