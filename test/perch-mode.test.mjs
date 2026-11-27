import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import extension from '../omp-extension.ts';
import { isInteractiveOmp } from '../adapters/omp.mjs';
import { BoardStore } from '../board/store.ts';
import { boardPath } from '../board/runtime.ts';

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL('../cli.mjs', import.meta.url));

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

  // /perch registers argument completions (subcommands; worker names after `close`)
  assert.deepEqual(commands.get('perch').getArgumentCompletions('st').map(c => c.value), ['status']);
  assert.deepEqual(commands.get('perch').getArgumentCompletions('close ').map(c => c.value), ['close all']);

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

test('/perch mode enforces default allowTools, non-blocking wait, name resolution, and auto-resumes stopped managed and native workers on send', async t => {
  const root = await mkdtemp(join(tmpdir(), 'perch-ergonomics-'));
  const home = join(root, 'home');
  const agentDir = join(home, '.omp', 'agent');
  const cwd = join(root, 'work');
  const bin = join(root, 'bin');
  const sessionFile = join(root, 'sessions', 'main.jsonl');
  const perchLog = join(root, 'perch.jsonl');
  const perchState = join(root, 'perch-state.json');
  await Promise.all([
    mkdir(agentDir, { recursive: true }),
    mkdir(cwd, { recursive: true }),
    mkdir(bin, { recursive: true }),
    mkdir(join(root, 'sessions'), { recursive: true }),
  ]);

  await writeFile(join(agentDir, 'config.yml'), `
perch:
  default: true
  native: true
  layout: stack
  heartbeatSeconds: 0
  discoverTimeoutMs: 5000
  systemPrompt: ~/missing-override.md
  board:
    enabled: true
    autoCreate: true
  roles:
    investigate:
      label: 排查
      provider: agy
      model: gemini-4-neon
      write: false
    dev:
      label: 开发
      provider: omp
      model: openai-codex/gpt-6.2-sol:medium
      write: true
`);

  const fakePerch = join(bin, 'fake-perch');
  await writeFile(fakePerch, `#!${process.execPath}
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
    const pIdx = args.indexOf('--provider');
    const provider = pIdx >= 0 ? args[pIdx + 1] : null;
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
    const resumeIdx = args.indexOf('--resume');
    const resumeId = resumeIdx >= 0 ? args[resumeIdx + 1] : null;
    const isNative = args.includes('--native');
    if (isNative) {
      let id;
      if (provider === 'agy') {
        const uuid = resumeId || '11111111-1111-4111-8111-111111111111';
        id = 'agy:native-' + (1000 + n) + '.0123456789abcdef-' + uuid;
      } else {
        const uuid = resumeId || '22222222-2222-4222-8222-222222222222';
        id = 'omp:' + uuid;
      }
      state.sessions = state.sessions.filter(s => s.id !== id);
      state.sessions.push({ id, provider, kind: 'session', status: 'idle', send: true, history: true, wait: true, cwd });
      writeFileSync(stateFile, JSON.stringify(state));
      console.log(JSON.stringify({ provider, mode: 'native', pane: { backend: 'tern', id: 800 + n } }));
      return;
    }
    const id = provider + ':33333333-3333-4333-8333-33333333333' + n;
    state.sessions.push({ id, provider, kind: 'session', status: 'idle', send: true, history: true, wait: true, close: true, cwd });
    writeFileSync(stateFile, JSON.stringify(state));
    console.log(JSON.stringify({ id, provider }));
    return;
  }
  if (cmd === 'resume') {
    const id = args[1];
    const provider = id.split(':', 1)[0];
    if (!state.sessions.some(s => s.id === id)) {
      state.sessions.push({ id, provider, kind: 'session', status: 'idle', send: true, history: true, wait: true, close: true, cwd: process.cwd() });
      writeFileSync(stateFile, JSON.stringify(state));
    }
    console.log(JSON.stringify({ id, provider }));
    return;
  }
  if (cmd === 'send') {
    const id = args[1];
    if (!state.sessions.some(s => s.id === id)) {
      console.error(JSON.stringify({ error: 'Session is closed: ' + id }));
      process.exit(1);
    }
    console.log(JSON.stringify({ accepted: true }));
    return;
  }
  if (cmd === 'wait') {
    const timeoutIdx = args.indexOf('--timeout');
    const timeoutVal = timeoutIdx >= 0 ? args[timeoutIdx + 1] : null;
    if (timeoutVal === '0') {
      console.log(JSON.stringify({ id: args[1], status: 'timeout' }));
      return;
    }
    console.log(JSON.stringify({ id: args[1], status: 'completed' }));
    return;
  }
  if (cmd === 'history') {
    console.log(JSON.stringify([{ role: 'assistant', text: 'REPLY_' + args[1] }]));
    return;
  }
  if (cmd === 'close') {
    const id = args[1];
    state.sessions = state.sessions.filter(s => s.id !== id);
    writeFileSync(stateFile, JSON.stringify(state));
    console.log(JSON.stringify({ id, closed: true }));
    return;
  }
  process.exit(1);
});
`, { mode: 0o755 });
  await chmod(fakePerch, 0o755);

  const fakeTern = join(bin, 'tern');
  await writeFile(fakeTern, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === 'ls') {
  console.log(JSON.stringify({ sessions: [{ tabs: [{ blocks: [] }] }] }));
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
    PERCH_HEARTBEAT_MS: process.env.PERCH_HEARTBEAT_MS,
  };
  const handlers = new Map();
  const tools = new Map();
  const commands = new Map();
  const notifications = [];
  let activeTools = ['ask', 'bash', 'edit', 'glob', 'grep', 'perch', 'read', 'task', 'todo', 'write'];

  const ctx = {
    mode: 'tui',
    cwd,
    agent: { kind: 'main', id: 'main' },
    sessionModes: { getState: () => ({ vibe: { status: 'inactive' } }) },
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: {
      getSessionId: () => 'omp-ergo-test',
      getSessionFile: () => sessionFile,
      getBranch: () => [],
      getEntries: () => [],
    },
    hasUI: true,
    ui: {
      notify: (msg, level) => notifications.push({ msg, level }),
      setStatus: () => {},
    },
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
  delete process.env.PERCH_HEARTBEAT_MS;

  extension({
    arktype: s => s,
    on: (ev, fn) => handlers.set(ev, fn),
    registerCommand: (name, def) => commands.set(name, def),
    registerTool: tool => tools.set(tool.name, tool),
    getSessionName: () => 'Director',
    getActiveTools: () => [...activeTools],
    setActiveTools: async next => { activeTools = [...next]; },
    appendEntry: () => {},
    sendMessage: () => {},
    sendUserMessage: async () => {},
  });

  // 1. Default allowTools restricts director to [ask, board, perch, read] (no bash/edit/write/grep/glob/task/todo)
  await handlers.get('session_start')({}, ctx);
  assert.deepEqual([...activeTools].sort(), ['ask', 'board', 'perch', 'read']);

  // 1b. board op=decide rejects misplaced "decision" param with a clear hint
  const boardTool = tools.get('board');
  await assert.rejects(
    boardTool.execute('b-bad', { op: 'decide', title: 'Test', decision: 'body' }, undefined, undefined, ctx),
    /use "text" for the decision body, not "decision"/,
  );

  // 2. Missing explicit prompt file emits a deduped TUI warning once
  await handlers.get('before_agent_start')({ reason: 'prompt', prompt: 'hi', systemPrompt: ['BASE'] }, ctx);
  await handlers.get('before_agent_start')({ reason: 'prompt', prompt: 'hi again', systemPrompt: ['BASE'] }, ctx);
  const promptWarnings = notifications.filter(n => n.level === 'warning' && n.msg.includes('missing-override.md'));
  assert.equal(promptWarnings.length, 1);

  const perch = tools.get('perch');

  // 3. Managed worker: start -> close -> list shows stopped+resumable -> send by short name auto-resumes!
  const managed = await perch.execute('m-1', {
    op: 'start',
    provider: 'omp',
    native: false,
    name: 'worker-managed',
    prompt: 'first task',
    notify: false,
  }, undefined, undefined, ctx);
  await perch.execute('m-close', { op: 'close', id: 'worker-managed' }, undefined, undefined, ctx);

  const listed = await perch.execute('l-1', { op: 'list' }, undefined, undefined, ctx);
  assert.equal(listed.details.length, 1);
  assert.equal(listed.details[0].name, 'worker-managed');
  assert.equal(listed.details[0].state, 'stopped');
  assert.equal(listed.details[0].resumable, true);

  const revivedManaged = await perch.execute('m-send', {
    op: 'send',
    id: 'worker-managed',
    text: 'continue from where you left off',
    notify: false,
  }, undefined, undefined, ctx);
  assert.equal(revivedManaged.details.autoResumed, true);
  assert.equal(revivedManaged.details.id, managed.details.id);
  assert.equal(revivedManaged.details.accepted, true);

  // 4. Native AGY worker: start (with board item) -> close (idempotent repeat) -> send by short name auto-resumes with --resume <uuid> AND rebinds board item!
  const agy = await perch.execute('a-1', {
    op: 'start',
    role: 'investigate',
    name: 'scout',
    prompt: 'check logs',
    notify: false,
  }, undefined, undefined, ctx);
  assert.ok(agy.details.boardItem, 'expected board item on initial AGY start');
  await perch.execute('a-close', { op: 'close', id: 'scout' }, undefined, undefined, ctx);
  const repeatClose = await perch.execute('a-close-2', { op: 'close', id: 'scout' }, undefined, undefined, ctx);
  assert.deepEqual(repeatClose.details, { id: agy.details.id, closed: true });

  const revivedAgy = await perch.execute('a-send', {
    op: 'send',
    id: 'scout',
    text: 'check second log file',
    notify: true,
  }, undefined, undefined, ctx);
  assert.equal(revivedAgy.details.autoResumed, true);
  assert.equal(revivedAgy.details.mode, 'native');
  assert.equal(revivedAgy.details.previousId, agy.details.id);
  assert.equal(revivedAgy.details.boardItem, agy.details.boardItem);
  assert.match(revivedAgy.details.id, /11111111-1111-4111-8111-111111111111$/);
  const boardStore = new BoardStore(boardPath(sessionFile));
  t.after(() => boardStore.close());
  assert.equal(boardStore.bindingForWorker(revivedAgy.details.id)?.item, agy.details.boardItem);

  // Wait for scout's watcher to finish so scout transitions to completed/unhandled, then ack via context + message_end
  await until(() => {
    const c = handlers.get('context')({ messages: [] }, ctx);
    const txt = c?.messages?.find(m => m.customType === 'perch-task-ledger')?.content ?? '';
    return /scout.*completed \[UNHANDLED/.test(txt);
  });
  handlers.get('message_end')({ message: { role: 'assistant', stopReason: 'stop' } }, ctx);

  // 5. Native OMP worker: start -> unexpectedly disappears from live list -> send auto-resumes with --resume <uuid>!
  const nativeOmp = await perch.execute('o-1', {
    op: 'start',
    role: 'dev',
    name: 'coder',
    prompt: 'write code',
    notify: false,
  }, undefined, undefined, ctx);
  const stateObj = JSON.parse(await readFile(perchState, 'utf8'));
  stateObj.sessions = stateObj.sessions.filter(s => s.id !== nativeOmp.details.id);
  await writeFile(perchState, JSON.stringify(stateObj));

  const revivedOmp = await perch.execute('o-send', {
    op: 'send',
    id: 'coder',
    text: 'now run tests',
    notify: false,
  }, undefined, undefined, ctx);
  assert.equal(revivedOmp.details.autoResumed, true);
  assert.equal(revivedOmp.details.mode, 'native');
  assert.equal(revivedOmp.details.id, nativeOmp.details.id);

  // 6. Non-blocking wait in /perch mode converts timeout > 0 or omitted into timeout=0 probe
  const waitRes = await perch.execute('w-1', { op: 'wait', id: 'coder', timeout: 60 }, undefined, undefined, ctx);
  assert.equal(waitRes.details.status, 'running');
  assert.equal(waitRes.details.nonBlocking, true);
  assert.equal(waitRes.details.watcherAttached, false);

  // 6b. Complete Perch workspace view in /perch mode shows running, handled idle open pane (scout), AND closed resumable workers!
  await perch.execute('m-close-2', { op: 'close', id: 'worker-managed' }, undefined, undefined, ctx);
  const viewCtx = handlers.get('context')({ messages: [] }, ctx);
  const viewText = viewCtx.messages.find(m => m.customType === 'perch-task-ledger')?.content ?? '';
  assert.match(viewText, /\[Perch workspace view\]/);
  assert.match(viewText, /coder.*running \(turn #/);
  assert.match(viewText, /scout.*idle \(finished .*open pane/);
  assert.match(viewText, /Closed resumable workers.*worker-managed/);

  // 7. Expanding allowTools AND idleCloseSeconds: 1 auto-reaps handled idle scout pane after 1s while keeping running coder open!
  await writeFile(join(agentDir, 'config.yml'), `
perch:
  default: true
  idleCloseSeconds: 1
  allowTools:
    - perch
    - board
    - read
    - grep
  board:
    enabled: true
    autoCreate: false
`);
  await sleep(1100);
  await handlers.get('before_agent_start')({ reason: 'prompt', prompt: 'reload tools', systemPrompt: ['BASE'] }, ctx);
  assert.deepEqual([...activeTools].sort(), ['board', 'grep', 'perch', 'read']);

  const afterReapCtx = handlers.get('context')({ messages: [] }, ctx);
  const afterReapText = afterReapCtx.messages.find(m => m.customType === 'perch-task-ledger')?.content ?? '';
  assert.match(afterReapText, /coder.*running \(turn #/, 'running worker must not be reaped');
  assert.doesNotMatch(afterReapText, /scout.*open pane/, 'expired idle scout pane must be auto-closed');
  assert.match(afterReapText, /Closed resumable workers.*scout/, 'auto-closed scout must remain resumable');

  // Verify CLI invocations for --resume on AGY and OMP
  const calls = (await readFile(perchLog, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(calls.some(c => c.args[0] === 'resume' && c.args[1] === managed.details.id));
  assert.ok(calls.some(c => c.args[0] === 'start' && c.args[1] === 'agy' && c.args.includes('--resume') && c.args.includes('11111111-1111-4111-8111-111111111111')));
  assert.ok(calls.some(c => c.args[0] === 'start' && c.args[1] === 'omp' && c.args.includes('--resume') && c.args.includes('22222222-2222-4222-8222-222222222222')));

  // 8. /perch off restores all original tools
  await commands.get('perch').handler('off', ctx);
  assert.deepEqual([...activeTools].sort(), ['ask', 'bash', 'edit', 'glob', 'grep', 'perch', 'read', 'task', 'todo', 'write']);
});

test('cli start --resume requires --native, only accepts omp/agy, and enforces UUID for agy', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, 'start', 'omp', '--resume', '22222222-2222-4222-8222-222222222222']),
    /--resume.*--native|仅支持与 --native/,
  );
  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, 'start', 'codex', '--native', '--pane', 'right', '--resume', 'abc']),
    /仅支持 omp 和 agy|only supported for omp and agy/,
  );
  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, 'start', 'agy', '--native', '--pane', 'right', '--resume', '../../bad']),
    /UUID/,
  );
});

test('cli start agy --native automatically adds realpath(cwd) to trustedWorkspaces and forwards --resume', async t => {
  const root = await mkdtemp(join(tmpdir(), 'perch-agy-trust-'));
  const home = join(root, 'home');
  const workDir = join(root, 'worktree-a');
  const bin = join(root, 'bin');
  const settingsDir = join(home, '.gemini', 'antigravity-cli');
  const settingsPath = join(settingsDir, 'settings.json');
  const paneLog = join(root, 'pane.jsonl');
  await Promise.all([
    mkdir(settingsDir, { recursive: true }),
    mkdir(workDir, { recursive: true }),
    mkdir(bin, { recursive: true }),
  ]);
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(settingsPath, JSON.stringify({
    model: 'Gemini 4 Neon (High)',
    trustedWorkspaces: ['/existing/trusted'],
  }, null, 2) + '\n');

  const fakeAgy = join(bin, 'agy');
  await writeFile(fakeAgy, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await chmod(fakeAgy, 0o755);

  const fakePane = join(bin, 'terminal-pane');
  await writeFile(fakePane, `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(process.env.MOCK_PANE_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
console.log(JSON.stringify({ backend: 'tern', pane: 901 }));
`, { mode: 0o755 });
  await chmod(fakePane, 0o755);

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    MOCK_PANE_LOG: paneLog,
  };

  // First launch trusts workDir and forwards --resume=<uuid>
  await execFileAsync(process.execPath, [
    cliPath, 'start', 'agy', 'continue-prompt',
    '--native', '--pane', 'right', '--cwd', workDir,
    '--resume', '11111111-1111-4111-8111-111111111111', '--json',
  ], { env });
  // Second launch in same cwd is idempotent (no duplicate)
  await execFileAsync(process.execPath, [
    cliPath, 'start', 'agy', '--native', '--pane', 'right', '--cwd', workDir, '--json',
  ], { env });

  const realWork = await realpath(workDir);
  const updated = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.equal(updated.model, 'Gemini 4 Neon (High)');
  assert.deepEqual(updated.trustedWorkspaces, ['/existing/trusted', realWork]);

  const launches = (await readFile(paneLog, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(launches[0].includes('--resume=11111111-1111-4111-8111-111111111111'));
  assert.ok(launches[0].includes('--prompt-interactive=continue-prompt'));
});
