import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import extension from '../omp-extension.ts';

async function until(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(15);
  }
  assert.fail('Timed out waiting for condition');
}

const fakePerchScript = `#!${process.execPath}
const { appendFileSync, existsSync } = require('node:fs');
const args = process.argv.slice(2);
const log = process.env.PERCH_FIXTURE_LOG;
const release = process.env.PERCH_FIXTURE_RELEASE;
const chunks = [];
process.stdin.on('data', chunk => chunks.push(chunk));
process.stdin.on('end', () => {
  const stdin = Buffer.concat(chunks).toString('utf8');
  if (log) appendFileSync(log, JSON.stringify({ args, stdin }) + '\\n');
  const cmd = args[0];
  if (cmd === 'list') {
    console.log(JSON.stringify([
      { id: 'agy:11111111-1111-4111-8111-111111111111', provider: 'agy', status: 'running', cwd: '/work' },
      { id: 'omp:22222222-2222-4222-8222-222222222222', provider: 'omp', status: 'idle', cwd: '/other-terminal' },
    ]));
    return;
  }
  if (cmd === 'start') {
    const provider = args[1];
    console.log(JSON.stringify({ id: provider + ':11111111-1111-4111-8111-111111111111', provider }));
    return;
  }
  if (cmd === 'send') {
    console.log(JSON.stringify({ accepted: true }));
    return;
  }
  if (cmd === 'wait') {
    const id = args[1];
    const timeoutIdx = args.indexOf('--timeout');
    if (timeoutIdx >= 0 && args[timeoutIdx + 1] === '0') {
      console.log(JSON.stringify({ id, status: 'timeout' }));
      process.exit(2);
    }
    const finish = () => {
      console.log(JSON.stringify({ id, status: 'completed' }));
      process.exit(0);
    };
    if (!release || existsSync(release)) return finish();
    const timer = setInterval(() => {
      if (!existsSync(release)) return;
      clearInterval(timer);
      finish();
    }, 10);
    process.on('SIGTERM', () => { clearInterval(timer); process.exit(143); });
    return;
  }
  if (cmd === 'history') {
    console.log(JSON.stringify([
      { role: 'user', text: 'check bug' },
      { role: 'assistant', text: 'Root cause found in adapter.mjs:42' },
    ]));
    return;
  }
  if (cmd === 'close') {
    console.log(JSON.stringify({ id: args[1], closed: true }));
    return;
  }
  if (cmd === 'resume') {
    console.log(JSON.stringify({ id: args[1], provider: args[1].split(':')[0] }));
    return;
  }
  process.stderr.write('unknown cmd\\n');
  process.exit(1);
});
`;

function createHarness(dir) {
  const handlers = new Map();
  const tools = new Map();
  const sentMessages = [];
  let activeTools = ['vibe_spawn', 'vibe_send', 'vibe_wait', 'vibe_list', 'vibe_kill'];
  const ctx = {
    mode: 'rpc',
    cwd: dir,
    agent: { kind: 'main', id: 'main' },
    sessionModes: { getState: () => ({ vibe: { status: 'active' } }) },
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => 'omp-main-test', getBranch: () => [] },
    hasUI: false,
    ui: { notify: () => {} },
  };
  const pi = {
    arktype: schema => schema,
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: () => {},
    registerTool: tool => tools.set(tool.name, tool),
    getSessionName: () => 'Director',
    getActiveTools: () => [...activeTools],
    setActiveTools: async names => { activeTools = [...names]; },
    sendMessage: (message, options) => { sentMessages.push({ message, options }); },
    sendUserMessage: async () => {},
  };
  extension(pi);
  return { handlers, tools, sentMessages, ctx, getActiveTools: () => activeTools };
}

test('OMP extension registers perch tool, tracks ledger with name/owned, pushes async completion and cleans up on shutdown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'perch-omp-tool-'));
  const bin = join(dir, 'fake-perch');
  const logPath = join(dir, 'calls.jsonl');
  const releasePath = join(dir, 'release');
  const previous = {
    PERCH_BIN: process.env.PERCH_BIN,
    PERCH_FIXTURE_LOG: process.env.PERCH_FIXTURE_LOG,
    PERCH_FIXTURE_RELEASE: process.env.PERCH_FIXTURE_RELEASE,
    PERCH_HEARTBEAT_MS: process.env.PERCH_HEARTBEAT_MS,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  };
  await writeFile(bin, fakePerchScript);
  await chmod(bin, 0o700);
  process.env.PERCH_BIN = bin;
  process.env.PERCH_FIXTURE_LOG = logPath;
  process.env.PERCH_FIXTURE_RELEASE = releasePath;
  process.env.PERCH_HEARTBEAT_MS = '0';
  process.env.PI_CODING_AGENT_DIR = join(dir, 'agent');

  const h = createHarness(dir);
  try {
    const perch = h.tools.get('perch');
    assert.ok(perch, 'perch tool must be registered');
    assert.equal(h.handlers.get('context')({ messages: [] }, h.ctx), undefined, 'idle ledger injects nothing');

    await h.handlers.get('mode_changed')({ state: { vibe: { status: 'active' } } }, h.ctx);
    assert.ok(h.getActiveTools().includes('perch'), 'perch tool must be activated in vibe mode');

    const started = await perch.execute('t1', {
      op: 'start',
      name: 'investigate-bug',
      provider: 'agy',
      model: 'gemini-4-neon',
      prompt: 'Investigate the root cause\nwith details',
    }, undefined, undefined, h.ctx);
    assert.equal(started.details.id, 'agy:11111111-1111-4111-8111-111111111111');
    assert.equal(started.details.name, 'investigate-bug');
    assert.equal(started.details.accepted, true);
    assert.equal(started.details.notify, true);

    const runningLedger = h.handlers.get('context')({ messages: [] }, h.ctx);
    assert.ok(runningLedger, 'running task must appear in context ledger');
    assert.match(runningLedger.messages[0].content, /investigate-bug/);
    assert.match(runningLedger.messages[0].content, /running/);

    const ownedList = await perch.execute('t1b', { op: 'list', owned: true }, undefined, undefined, h.ctx);
    assert.equal(ownedList.details.length, 1, 'owned=true excludes foreign terminal sessions');
    assert.equal(ownedList.details[0].name, 'investigate-bug');
    assert.equal(ownedList.details[0].state, 'running');

    const instantWait = await perch.execute('t2', { op: 'wait', id: started.details.id, timeout: 0 }, undefined, undefined, h.ctx);
    assert.deepEqual(instantWait.details, { id: started.details.id, status: 'timeout' });

    assert.equal(h.sentMessages.length, 0, 'notification must wait until background wait completes');
    await writeFile(releasePath, 'go');
    await until(() => h.sentMessages.length === 1);

    const pushed = h.sentMessages[0];
    assert.deepEqual(pushed.options, { triggerTurn: true, deliverAs: 'followUp' });
    assert.equal(pushed.message.customType, 'perch-worker-event');
    assert.match(pushed.message.content, /investigate-bug/);
    assert.match(pushed.message.content, /agy:11111111-1111-4111-8111-111111111111/);
    assert.match(pushed.message.content, /gemini-4-neon/);
    assert.match(pushed.message.content, /Status: completed/);
    assert.match(pushed.message.content, /Root cause found in adapter\.mjs:42/);

    // Completed task stays UNHANDLED in ledger if the turn aborts or errors.
    const unhandledLedger = h.handlers.get('context')({ messages: [] }, h.ctx);
    assert.match(unhandledLedger.messages[0].content, /UNHANDLED/);
    h.handlers.get('message_end')({ message: { role: 'assistant', stopReason: 'aborted' } }, h.ctx);
    const stillUnhandled = h.handlers.get('context')({ messages: [] }, h.ctx);
    assert.match(stillUnhandled.messages[0].content, /UNHANDLED/);

    // Clean stop acknowledges the ledger entry.
    h.handlers.get('message_end')({ message: { role: 'assistant', stopReason: 'stop' } }, h.ctx);
    assert.equal(h.handlers.get('context')({ messages: [] }, h.ctx), undefined);

    const allListed = await perch.execute('t4', { op: 'list' }, undefined, undefined, h.ctx);
    assert.equal(allListed.details.length, 2);
    assert.equal(allListed.details[0].owned, true);
    assert.equal(allListed.details[0].name, 'investigate-bug');
    assert.equal(allListed.details[1].owned, undefined);

    await h.handlers.get('session_shutdown')({}, h.ctx);
    const calls = (await readFile(logPath, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(calls.some(c => c.args[0] === 'start' && c.args.includes('--model') && c.args.includes('gemini-4-neon')));
    assert.ok(calls.some(c => c.args[0] === 'send' && c.args.includes('--stdin') && c.stdin === 'Investigate the root cause\nwith details'));
    assert.ok(calls.some(c => c.args[0] === 'close' && c.args[1] === started.details.id), 'session_shutdown must close owned managed sessions');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test('OMP perch extension sends periodic heartbeat while long-running task is still active', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'perch-omp-heartbeat-'));
  const bin = join(dir, 'fake-perch');
  const releasePath = join(dir, 'release');
  const previous = {
    PERCH_BIN: process.env.PERCH_BIN,
    PERCH_FIXTURE_RELEASE: process.env.PERCH_FIXTURE_RELEASE,
    PERCH_HEARTBEAT_MS: process.env.PERCH_HEARTBEAT_MS,
  };
  await writeFile(bin, fakePerchScript);
  await chmod(bin, 0o700);
  process.env.PERCH_BIN = bin;
  process.env.PERCH_FIXTURE_RELEASE = releasePath;
  process.env.PERCH_HEARTBEAT_MS = '80';

  const h = createHarness(dir);
  try {
    const perch = h.tools.get('perch');
    await perch.execute('t1', {
      op: 'start',
      name: 'slow-design',
      provider: 'agy',
      model: 'gemini-4-neon',
      prompt: 'Design carefully',
    }, undefined, undefined, h.ctx);

    await until(() => h.sentMessages.some(m => m.message.customType === 'perch-worker-heartbeat'));
    const hb = h.sentMessages.find(m => m.message.customType === 'perch-worker-heartbeat');
    assert.deepEqual(hb.options, { triggerTurn: true, deliverAs: 'followUp' });
    assert.match(hb.message.content, /\[Perch heartbeat\]/);
    assert.match(hb.message.content, /slow-design/);
    assert.match(hb.message.content, /check #1/);

    await writeFile(releasePath, 'go');
    await until(() => h.sentMessages.some(m => m.message.customType === 'perch-worker-event'));
    await h.handlers.get('session_shutdown')({}, h.ctx);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test('OMP perch extension cancels pending async watchers across session switch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'perch-omp-switch-'));
  const bin = join(dir, 'fake-perch');
  const releasePath = join(dir, 'release');
  const previous = {
    PERCH_BIN: process.env.PERCH_BIN,
    PERCH_FIXTURE_RELEASE: process.env.PERCH_FIXTURE_RELEASE,
    PERCH_HEARTBEAT_MS: process.env.PERCH_HEARTBEAT_MS,
  };
  await writeFile(bin, fakePerchScript);
  await chmod(bin, 0o700);
  process.env.PERCH_BIN = bin;
  process.env.PERCH_FIXTURE_RELEASE = releasePath;
  process.env.PERCH_HEARTBEAT_MS = '0';

  const h = createHarness(dir);
  try {
    const perch = h.tools.get('perch');
    await perch.execute('t1', { op: 'send', id: 'agy:11111111-1111-4111-8111-111111111111', text: 'hello' }, undefined, undefined, h.ctx);
    await h.handlers.get('session_before_switch')({}, h.ctx);
    await writeFile(releasePath, 'go');
    await sleep(120);
    assert.equal(h.sentMessages.length, 0, 'cancelled watcher must not push into switched session');
    await h.handlers.get('session_shutdown')({}, h.ctx);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test('OMP extension hides perch tool inside managed PERCH_MANAGED_WORKER sessions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'perch-omp-worker-guard-'));
  const previous = process.env.PERCH_MANAGED_WORKER;
  process.env.PERCH_MANAGED_WORKER = '1';
  try {
    const h = createHarness(dir);
    assert.equal(h.tools.has('perch'), false, 'managed worker must not register perch tool');
    await h.handlers.get('mode_changed')({ state: { vibe: { status: 'active' } } }, h.ctx);
    assert.equal(h.getActiveTools().includes('perch'), false, 'managed worker must not activate perch tool in vibe mode');
  } finally {
    if (previous === undefined) delete process.env.PERCH_MANAGED_WORKER;
    else process.env.PERCH_MANAGED_WORKER = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test('OMP perch tool defaults to native side pane in TUI mode, discovers new session, and skips close on shutdown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'perch-omp-native-'));
  const bin = join(dir, 'fake-perch');
  const logPath = join(dir, 'calls.jsonl');
  const launchedMarker = join(dir, 'launched');
  const releasePath = join(dir, 'release');
  const nativeScript = `#!${process.execPath}
const { appendFileSync, existsSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const log = process.env.PERCH_FIXTURE_LOG;
const launched = process.env.PERCH_FIXTURE_LAUNCHED;
const release = process.env.PERCH_FIXTURE_RELEASE;
const chunks = [];
process.stdin.on('data', chunk => chunks.push(chunk));
process.stdin.on('end', () => {
  const stdin = Buffer.concat(chunks).toString('utf8');
  if (log) appendFileSync(log, JSON.stringify({ args, stdin, workerEnv: process.env.PERCH_MANAGED_WORKER }) + '\\n');
  const cmd = args[0];
  if (cmd === 'list') {
    const rows = [];
    if (existsSync(launched)) {
      rows.push({
        id: 'agy:native-999.0123456789abcdef-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        provider: 'agy',
        kind: 'session',
        status: 'idle',
        send: true,
        wait: true,
        history: true,
        cwd: ${JSON.stringify(dir)},
      });
    }
    console.log(JSON.stringify(rows));
    return;
  }
  if (cmd === 'start' && args.includes('--native')) {
    writeFileSync(launched, 'ok');
    console.log(JSON.stringify({ provider: args[1], mode: 'native', pane: { backend: 'tern', id: 'pane-42' } }));
    return;
  }
  if (cmd === 'send') {
    console.log(JSON.stringify({ accepted: true }));
    return;
  }
  if (cmd === 'wait') {
    const finish = () => { console.log(JSON.stringify({ id: args[1], status: 'completed' })); process.exit(0); };
    if (existsSync(release)) return finish();
    const timer = setInterval(() => { if (existsSync(release)) { clearInterval(timer); finish(); } }, 10);
    process.on('SIGTERM', () => { clearInterval(timer); process.exit(143); });
    return;
  }
  if (cmd === 'history') {
    console.log(JSON.stringify([{ role: 'assistant', text: 'Native AGY finished analysis.' }]));
    return;
  }
  process.exit(1);
});
`;
  const previous = {
    PERCH_BIN: process.env.PERCH_BIN,
    PERCH_FIXTURE_LOG: process.env.PERCH_FIXTURE_LOG,
    PERCH_FIXTURE_LAUNCHED: process.env.PERCH_FIXTURE_LAUNCHED,
    PERCH_FIXTURE_RELEASE: process.env.PERCH_FIXTURE_RELEASE,
    PERCH_HEARTBEAT_MS: process.env.PERCH_HEARTBEAT_MS,
    PERCH_NATIVE_DISCOVER_MS: process.env.PERCH_NATIVE_DISCOVER_MS,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  };
  await writeFile(bin, nativeScript);
  await chmod(bin, 0o700);
  process.env.PERCH_BIN = bin;
  process.env.PERCH_FIXTURE_LOG = logPath;
  process.env.PERCH_FIXTURE_LAUNCHED = launchedMarker;
  process.env.PERCH_FIXTURE_RELEASE = releasePath;
  process.env.PERCH_HEARTBEAT_MS = '0';
  process.env.PERCH_NATIVE_DISCOVER_MS = '3000';
  process.env.PI_CODING_AGENT_DIR = join(dir, 'agent');

  const h = createHarness(dir);
  h.ctx.mode = 'tui';
  try {
    const perch = h.tools.get('perch');
    const started = await perch.execute('n1', {
      op: 'start',
      name: 'native-neon',
      provider: 'agy',
      model: 'gemini-4-neon',
      prompt: 'Analyze repo',
    }, undefined, undefined, h.ctx);
    assert.equal(started.details.mode, 'native');
    assert.deepEqual(started.details.pane, { backend: 'tern', id: 'pane-42' });
    assert.equal(started.details.id, 'agy:native-999.0123456789abcdef-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    assert.equal(started.details.accepted, true);

    await writeFile(releasePath, 'go');
    await until(() => h.sentMessages.length === 1);
    assert.match(h.sentMessages[0].message.content, /Native AGY finished analysis\./);
    assert.match(h.sentMessages[0].message.content, /Action:/);

    await h.handlers.get('session_shutdown')({}, h.ctx);
    const calls = (await readFile(logPath, 'utf8')).trim().split('\n').map(JSON.parse);
    const startCall = calls.find(c => c.args[0] === 'start' && c.args.includes('--native') && c.args.includes('--pane') && c.args.includes('right'));
    assert.ok(startCall, 'expected native start call');
    // AGY native launch with prompt passes a zero-space staged file reference as positional prompt and does not double-send.
    assert.ok(!startCall.args[2].includes(' '), 'staged AGY launch prompt must have no spaces for macOS argv discovery');
    const stagedMatch = /:(\S+\.md)$/.exec(startCall.args[2]);
    assert.ok(stagedMatch, `expected staged prompt path in ${startCall.args[2]}`);
    assert.equal(await readFile(stagedMatch[1], 'utf8'), 'Analyze repo');
    assert.ok(!calls.some(c => c.args[0] === 'send'), 'AGY native launch must not send duplicate prompt');
    assert.ok(!calls.some(c => c.args[0] === 'close'), 'native sessions must not be closed via perch close on shutdown');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test('OMP perch tool attaches watcher when send returns deliveryUnknown (accepted: null) and worker is running', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'perch-omp-unknown-'));
  const bin = join(dir, 'fake-perch');
  const releasePath = join(dir, 'release');
  const unknownScript = `#!${process.execPath}
const { existsSync } = require('node:fs');
const args = process.argv.slice(2);
const release = process.env.PERCH_FIXTURE_RELEASE;
const chunks = [];
process.stdin.on('data', chunk => chunks.push(chunk));
process.stdin.on('end', () => {
  const cmd = args[0];
  if (cmd === 'send') {
    console.log(JSON.stringify({ accepted: null }));
    process.stderr.write('Antigravity CLI did not confirm the prompt; do not resend\\n');
    process.exit(1);
  }
  if (cmd === 'wait') {
    const timeoutIdx = args.indexOf('--timeout');
    if (timeoutIdx >= 0 && args[timeoutIdx + 1] === '0') {
      console.log(JSON.stringify({ id: args[1], status: 'timeout' }));
      process.exit(2);
    }
    const finish = () => { console.log(JSON.stringify({ id: args[1], status: 'completed' })); process.exit(0); };
    if (existsSync(release)) return finish();
    const timer = setInterval(() => { if (existsSync(release)) { clearInterval(timer); finish(); } }, 10);
    process.on('SIGTERM', () => { clearInterval(timer); process.exit(143); });
    return;
  }
  if (cmd === 'history') {
    console.log(JSON.stringify([{ role: 'assistant', text: 'Recovered slow turn completed.' }]));
    return;
  }
  process.exit(1);
});
`;
  const previous = {
    PERCH_BIN: process.env.PERCH_BIN,
    PERCH_FIXTURE_RELEASE: process.env.PERCH_FIXTURE_RELEASE,
    PERCH_HEARTBEAT_MS: process.env.PERCH_HEARTBEAT_MS,
  };
  await writeFile(bin, unknownScript);
  await chmod(bin, 0o700);
  process.env.PERCH_BIN = bin;
  process.env.PERCH_FIXTURE_RELEASE = releasePath;
  process.env.PERCH_HEARTBEAT_MS = '0';

  const h = createHarness(dir);
  try {
    const perch = h.tools.get('perch');
    const sent = await perch.execute('u1', {
      op: 'send',
      id: 'agy:11111111-1111-4111-8111-111111111111',
      text: 'Long prompt',
    }, undefined, undefined, h.ctx);
    assert.equal(sent.details.accepted, null);
    assert.equal(sent.details.running, true);
    assert.equal(sent.details.notify, true);

    await writeFile(releasePath, 'go');
    await until(() => h.sentMessages.length === 1);
    assert.match(h.sentMessages[0].message.content, /Recovered slow turn completed\./);
    await h.handlers.get('session_shutdown')({}, h.ctx);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
});
