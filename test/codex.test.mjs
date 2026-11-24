import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { close, history, isInteractive, list, lookupBridge, managedDir, messagesFromThread, send, start, waitIdle } from '../adapters/codex.mjs';

const id = '01912345-1234-7123-8123-123456789abc';
const otherId = '01912345-1234-7123-8123-123456789abd';
const tuiId = '01912345-1234-7123-8123-123456789abe';
let dir;
let oldHome;
let oldMode;
let oldLog;
let server;
let wss;
let fixtureTurns;
let fixtureStatus;
let onThreadRead;
let readTurnFlags;

before(async () => {
  dir = await mkdtemp('/tmp/cx-');
  oldHome = process.env.CODEX_HOME;
  oldMode = process.env.CODEX_TEST_MODE;
  oldLog = process.env.CODEX_TEST_LOG;
  process.env.CODEX_HOME = join(dir, 'home');
  process.env.CODEX_TEST_LOG = join(dir, 'methods');
  delete process.env.CODEX_TEST_MODE;
  await writeFile(process.env.CODEX_TEST_LOG, '');
  const aliasDir = join(process.env.CODEX_HOME, 'app-server-control');
  const privateDir = join(dir, 'private');
  await mkdir(aliasDir, { recursive: true, mode: 0o700 });
  await mkdir(privateDir, { mode: 0o700 });
  const alias = join(await realpath(aliasDir), 'app-server-control.sock');
  const hash = createHash('sha256').update(alias).digest('hex');
  const socket = join(await realpath(privateDir), hash);
  server = createServer();
  wss = new WebSocketServer({ server });
  wss.on('connection', ws => ws.on('message', data => {
    const m = JSON.parse(data.toString());
    if (!('id' in m)) return;
    appendFileSync(process.env.CODEX_TEST_LOG, `${m.method}\n`);
    const mode = process.env.CODEX_TEST_MODE || '';
    let result;
    if (m.method === 'initialize') result = {};
    else if (m.method === 'thread/loaded/list') result = { data: mode === 'unloaded' ? [] : [id, otherId, tuiId], nextCursor: null };
    else if (m.method === 'thread/read') {
      if (readTurnFlags) readTurnFlags.push(m.params.includeTurns);
      if (m.params.includeTurns && mode === 'no-turn-history') {
        ws.send(JSON.stringify({ id: m.id, error: { code: -32601 } }));
        return;
      }
      if (m.params.includeTurns && mode === 'becomes-active') fixtureStatus = { type: 'active', activeFlags: [] };
      result = { thread: {
        id: m.params.threadId, source: m.params.threadId === id ? 'cli' : 'vscode',
        originator: m.params.threadId === tuiId ? 'codex-tui' : 'desktop',
        name: m.params.threadId === id ? 'Named thread' : null, preview: 'Not a title',
        status: fixtureStatus === undefined ? { type: 'idle' } : fixtureStatus, cwd: '/sample', ...(m.params.includeTurns ? { turns: fixtureTurns ?? [{ items: [
          { type: 'userMessage', content: [{ type: 'text', text: 'hello' }] }, { type: 'agentMessage', text: 'world' },
        ] }] } : {}),
      } };
      if (onThreadRead) { const callback = onThreadRead; onThreadRead = undefined; setTimeout(callback, 25); }
    }
    else if (m.method === 'turn/start') {
      if (mode === 'disconnect') { ws.terminate(); return; }
      if (mode === 'reject') { ws.send(JSON.stringify({ id: m.id, error: { code: -32600, message: 'rejected' } })); return; }
      result = { turn: { id: 'turn-1' } };
    } else throw new Error('unexpected method');
    ws.send(JSON.stringify({ id: m.id, result }));
  }));
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(socket, ok); });
  await chmod(socket, 0o600);
  await symlink(socket, alias);
});

after(async () => {
  for (const client of wss?.clients ?? []) client.terminate();
  if (server) await new Promise(ok => server.close(ok));
  if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome;
  if (oldMode === undefined) delete process.env.CODEX_TEST_MODE; else process.env.CODEX_TEST_MODE = oldMode;
  if (oldLog === undefined) delete process.env.CODEX_TEST_LOG; else process.env.CODEX_TEST_LOG = oldLog;
  if (dir) await rm(dir, { recursive: true, force: true });
});

test('only terminal Codex processes are process clues, not helpers or desktop servers', () => {
  const p = { comm: '/bin/codex', tty: 'ttys001', args: 'codex -c model=example' };
  assert.equal(isInteractive(p), true);
  assert.equal(isInteractive({ ...p, tty: '?' }), false);
  assert.equal(isInteractive({ ...p, args: 'codex exec hello' }), false);
  assert.equal(isInteractive({ ...p, args: 'codex app-server --help' }), false);
  assert.equal(isInteractive({ ...p, comm: '/bin/other' }), false);
});

test('history includes only ordered user and assistant text and applies the limit', () => {
  const thread = { turns: [{ items: [
    { type: 'userMessage', content: [{ type: 'text', text: 'question' }, { type: 'image', url: 'ignored' }] },
    { type: 'commandExecution', command: 'ignored' },
    { type: 'agentMessage', text: 'answer' },
  ] }] };
  assert.deepEqual(messagesFromThread(thread, Infinity), [{ role: 'user', text: 'question' }, { role: 'assistant', text: 'answer' }]);
  assert.deepEqual(messagesFromThread(thread, 1), [{ role: 'assistant', text: 'answer' }]);
});

test('shared server identifies only loaded CLI threads and accepts a turn without resume or queue', async () => {
  const sessions = await list();
  const session = sessions.find(s => s.id === `codex:${id}`);
  assert.ok(session);
  assert.equal(session.pid, null);
  assert.equal(session.historyMode, 'live');
  assert.equal(session.title, 'Named thread');
  assert.equal(sessions.find(s => s.id === `codex:${tuiId}`).title, null);
  assert.equal(sessions.some(s => s.id === `codex:${otherId}`), false);
  assert.equal(sessions.some(s => s.id === `codex:${tuiId}`), true);
  assert.deepEqual(await history(session, 1), [{ role: 'assistant', text: 'world' }]);
  assert.deepEqual(await send(session, 'a test message'), { turnId: 'turn-1' });
  const calls = (await readFile(process.env.CODEX_TEST_LOG, 'utf8')).trim().split('\n');
  assert.ok(calls.includes('turn/start'));
  assert.equal(calls.includes('thread/resume'), false);
  assert.equal(calls.includes('thread/queue/add'), false);
});

test('shared list maps native current status without requesting turns or extra state', async () => {
  const cases = [
    [{ type: 'idle' }, 'idle'],
    [{ type: 'active', activeFlags: [] }, 'running'],
    [{ type: 'active', activeFlags: ['waitingOnApproval'] }, 'blocked'],
    [{ type: 'active', activeFlags: ['waitingOnUserInput'] }, 'blocked'],
    [{ type: 'systemError' }, 'failed'],
    [{ type: 'futureStatus' }, 'unknown'],
    [null, 'unknown'],
  ];
  fixtureTurns = [{ id: 'failed-before', status: 'failed', items: [] }];
  try {
    for (const [nativeStatus, expected] of cases) {
      fixtureStatus = nativeStatus;
      readTurnFlags = [];
      await writeFile(process.env.CODEX_TEST_LOG, '');
      const sessions = await list();
      assert.equal(sessions.find(session => session.id === `codex:${id}`).status, expected);
      assert.deepEqual(readTurnFlags, [false, false, false]);
      assert.deepEqual((await readFile(process.env.CODEX_TEST_LOG, 'utf8')).trim().split('\n'),
        ['initialize', 'thread/loaded/list', 'thread/read', 'thread/read', 'thread/read']);
    }
  } finally {
    fixtureTurns = undefined;
    fixtureStatus = undefined;
    readTurnFlags = undefined;
  }
});

test('refuses unknown or unloaded thread and does not submit to stale identity', async () => {
  const session = { id: `codex:${id}`, _threadId: id };
  await assert.rejects(send({ id: 'codex:pid-1' }, 'hello'));
  await assert.rejects(send({ id: 'codex:../../bad', _threadId: '../../bad' }, 'hello'));
  process.env.CODEX_TEST_MODE = 'unloaded';
  await writeFile(process.env.CODEX_TEST_LOG, '');
  await assert.rejects(send(session, 'hello'), /no longer loaded/);
  const calls = await readFile(process.env.CODEX_TEST_LOG, 'utf8');
  assert.doesNotMatch(calls, /turn\/start/);
  delete process.env.CODEX_TEST_MODE;
});

test('rejection and unknown delivery are propagated without retry', async () => {
  const session = { id: `codex:${id}`, _threadId: id };
  for (const mode of ['reject', 'disconnect']) {
    process.env.CODEX_TEST_MODE = mode;
    await writeFile(process.env.CODEX_TEST_LOG, '');
    await assert.rejects(send(session, 'hello'), error => {
      assert.equal(error.deliveryUnknown === true, mode === 'disconnect');
      return true;
    });
    const calls = (await readFile(process.env.CODEX_TEST_LOG, 'utf8')).trim().split('\n');
    assert.equal(calls.filter(call => call === 'turn/start').length, 1);
  }
  delete process.env.CODEX_TEST_MODE;
});

test('rejects a forged socket rendezvous instead of sending user input', async () => {
  const alias = join(process.env.CODEX_HOME, 'app-server-control', 'app-server-control.sock');
  const original = await readlink(alias);
  await unlink(alias);
  try {
    await symlink(join(dir, 'untrusted.sock'), alias);
    await assert.rejects(send({ id: `codex:${id}`, _threadId: id }, 'hello'), /Untrusted/);
  } finally {
    await unlink(alias);
    await symlink(original, alias);
  }
});

test('shared wait uses native session state, including empty, pending and terminal states', async () => {
  const session = { id: `codex:${id}`, _threadId: id };
  fixtureTurns = [];
  fixtureStatus = { type: 'idle' };
  try {
    assert.deepEqual(await waitIdle(session, 0), { status: 'completed' });
    fixtureTurns = [{ id: 'older', status: 'completed', items: [{ type: 'agentMessage', text: 'old answer' }] }];
    fixtureStatus = { type: 'active', activeFlags: [] };
    assert.deepEqual(await waitIdle(session, 0), { status: 'timeout' });
    fixtureStatus.activeFlags = ['waitingOnApproval'];
    assert.deepEqual(await waitIdle(session, 0), { status: 'needs_input' });
    fixtureStatus.activeFlags = ['waitingOnUserInput'];
    assert.deepEqual(await waitIdle(session, 0), { status: 'needs_input' });
    fixtureStatus = { type: 'idle' };
    fixtureTurns.push({ id: 'current', status: 'failed', error: { message: 'failed' }, items: [] });
    assert.deepEqual(await waitIdle(session, 0), { status: 'failed', error: 'failed' });
    fixtureTurns[1] = { id: 'current', status: 'interrupted', items: [] };
    assert.deepEqual(await waitIdle(session, 0), { status: 'interrupted' });
    fixtureStatus = { type: 'systemError' };
    assert.deepEqual(await waitIdle(session, 0), { status: 'failed', error: 'Codex thread reported a system error' });
  } finally {
    fixtureTurns = undefined;
    fixtureStatus = undefined;
  }
});

test('shared wait follows the session across active turn transitions until idle', async () => {
  const session = { id: `codex:${id}`, _threadId: id };
  fixtureTurns = [{ id: 'first', status: 'completed', items: [] }];
  fixtureStatus = { type: 'active', activeFlags: [] };
  onThreadRead = () => {
    fixtureTurns.push({ id: 'second', status: 'inProgress', items: [] });
    onThreadRead = () => {
      fixtureTurns[1] = { id: 'second', status: 'completed', items: [{ type: 'agentMessage', text: 'answer' }] };
      fixtureStatus = { type: 'idle' };
    };
  };
  try {
    assert.deepEqual(await waitIdle(session), { status: 'completed' });
    assert.deepEqual(await history(session, 1), [{ role: 'assistant', text: 'answer' }]);
  } finally {
    fixtureTurns = undefined;
    fixtureStatus = undefined;
    onThreadRead = undefined;
  }
});

test('shared wait reads turns only when idle and propagates unsupported history', async () => {
  const session = { id: `codex:${id}`, _threadId: id };
  fixtureTurns = [];
  fixtureStatus = { type: 'active', activeFlags: [] };
  readTurnFlags = [];
  try {
    assert.deepEqual(await waitIdle(session, 0), { status: 'timeout' });
    assert.deepEqual(readTurnFlags, [false]);
    readTurnFlags = [];
    fixtureStatus = { type: 'idle' };
    process.env.CODEX_TEST_MODE = 'no-turn-history';
    await assert.rejects(waitIdle(session, 0), /rejected -32601/);
    assert.deepEqual(readTurnFlags, [false, true]);
    fixtureStatus = { type: 'idle' };
    process.env.CODEX_TEST_MODE = 'becomes-active';
    assert.deepEqual(await waitIdle(session, 0), { status: 'timeout' });
  } finally {
    delete process.env.CODEX_TEST_MODE;
    fixtureTurns = undefined;
    fixtureStatus = undefined;
    readTurnFlags = undefined;
  }
});

test('dangling aliases and stopped daemons do not suppress process hints', async () => {
  const previousHome = process.env.CODEX_HOME;
  const home = join(dir, 'stale-home');
  const aliasDir = join(home, 'app-server-control');
  const privateDir = join(dir, 'stale-private');
  await mkdir(aliasDir, { recursive: true, mode: 0o700 });
  await mkdir(privateDir, { mode: 0o700 });
  const alias = join(await realpath(aliasDir), 'app-server-control.sock');
  const socket = join(await realpath(privateDir), createHash('sha256').update(alias).digest('hex'));
  await symlink(socket, alias);
  process.env.CODEX_HOME = home;
  let child;
  try {
    assert.ok(Array.isArray(await list()));
    child = spawn(process.execPath, ['-e', 'require(\"node:net\").createServer().listen(process.argv[1], () => console.log(\"ready\"))', socket], { stdio: ['ignore', 'pipe', 'ignore'] });
    await once(child.stdout, 'data');
    child.kill('SIGKILL');
    await once(child, 'exit');
    await chmod(socket, 0o600);
    assert.ok(Array.isArray(await list()));
  } finally {
    child?.kill('SIGKILL');
    process.env.CODEX_HOME = previousHome;
  }
});

async function withManagedFixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'codex-managed-test-'));
  const home = join(root, 'home');
  const work = join(root, 'work');
  const bin = join(root, 'bin');
  await Promise.all([mkdir(home), mkdir(work), mkdir(bin)]);
  await symlink(fileURLToPath(new URL('../fixtures/codex.mjs', import.meta.url)), join(bin, 'codex'));
  await symlink(process.execPath, join(bin, 'node'));
  const previous = { home: process.env.CODEX_HOME, path: process.env.PATH, log: process.env.CODEX_FIXTURE_LOG, release: process.env.CODEX_FIXTURE_RELEASE };
  process.env.CODEX_HOME = home;
  process.env.PATH = bin;
  process.env.CODEX_FIXTURE_LOG = join(root, 'fixture.log');
  process.env.CODEX_FIXTURE_RELEASE = join(root, 'release');
  let session;
  try {
    session = await start({ cwd: work, model: 'fixture-model' });
    await run(session, { root, work, log: process.env.CODEX_FIXTURE_LOG });
  } finally {
    if (session && await lookupBridge(session.id)) await close(session);
    await rm(managedDir(), { recursive: true, force: true });
    if (previous.home === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous.home;
    if (previous.path === undefined) delete process.env.PATH; else process.env.PATH = previous.path;
    if (previous.log === undefined) delete process.env.CODEX_FIXTURE_LOG; else process.env.CODEX_FIXTURE_LOG = previous.log;
    if (previous.release === undefined) delete process.env.CODEX_FIXTURE_RELEASE; else process.env.CODEX_FIXTURE_RELEASE = previous.release;
    await rm(root, { recursive: true, force: true });
  }
}

test('managed native bridge preserves event-correlated turns and zero-timeout snapshots', async () => {
  await withManagedFixture(async (session, fixture) => {
    assert.equal(session.provider, 'codex');
    assert.equal(session.close, true);
    assert.equal((await lookupBridge(session.id)).id, session.id);
    const aliasDir = join(process.env.CODEX_HOME, 'app-server-control');
    await mkdir(aliasDir, { mode: 0o700 });
    const alias = join(aliasDir, 'app-server-control.sock');
    await symlink('/tmp/untrusted-codex.sock', alias);
    try { assert.equal((await lookupBridge(session.id)).id, session.id); } finally { await unlink(alias); }
    assert.equal((await list()).find(row => row.id === session.id)?.close, true);
    assert.deepEqual(await history(session, 20), []);
    assert.deepEqual(await waitIdle(session, 0), { status: 'completed' });
    const early = await send(session, 'early');
    assert.deepEqual(await waitIdle(session, 1000), { status: 'completed' });
    assert.deepEqual((await history(session, 1))[0], { role: 'assistant', text: `answer ${early.turnId}` });
    await send(session, 'partial');
    assert.deepEqual(await waitIdle(session, 1000), { status: 'completed' });
    const legacy = await send(session, 'legacy');
    assert.deepEqual(await waitIdle(session, 1000), { status: 'completed' });
    assert.deepEqual(await waitIdle(session, 0), { status: 'completed' });
    assert.deepEqual((await history(session, 1))[0], { role: 'assistant', text: `answer ${legacy.turnId}` });
    const entries = (await readFile(fixture.log, 'utf8')).trim().split('\n').map(JSON.parse);
    const threadStart = entries.find(entry => entry.method === 'thread/start');
    assert.deepEqual(threadStart.params, { cwd: await realpath(fixture.work), model: 'fixture-model' });
    assert.equal(entries.some(entry => entry.method === 'thread/resume'), false);
    assert.equal(entries.some(entry => entry.method === 'thread/read'), false);
    const pid = session.pid;
    await close(session);
    assert.equal(await lookupBridge(session.id), null);
    assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
  });
});

test('managed list reports current state without extra native requests or using last turn outcome', async () => {
  await withManagedFixture(async (session, fixture) => {
    const status = async () => (await list()).find(row => row.id === session.id).status;
    assert.equal(await status(), 'idle');
    await send(session, 'fail');
    assert.deepEqual(await waitIdle(session, 1000), { status: 'failed', error: 'fixture failure' });
    assert.equal(await status(), 'idle');
    await send(session, 'hold');
    const before = await readFile(fixture.log, 'utf8');
    assert.equal(await status(), 'running');
    assert.equal(await readFile(fixture.log, 'utf8'), before);
  });
});

test('legacy managed bridge is discoverable but cannot claim idle wait support', async () => {
  await withManagedFixture(async () => {
    const socketPath = join(managedDir(), `${id}.sock`);
    const row = { id: `codex:${id}`, provider: 'codex', send: true, history: true, wait: true, close: true,
      _threadId: id, _managed: true, _socket: socketPath };
    const legacy = createNetServer(socket => socket.once('data', () => socket.end(JSON.stringify({ result: row }) + '\n')));
    await new Promise((resolve, reject) => { legacy.once('error', reject); legacy.listen(socketPath, resolve); });
    await chmod(socketPath, 0o600);
    try {
      const discovered = await lookupBridge(row.id);
      assert.equal(discovered.wait, false);
      assert.equal(discovered.status, 'unknown');
      assert.equal((await list()).find(session => session.id === row.id).wait, false);
      assert.equal((await list()).find(session => session.id === row.id).status, 'unknown');
      await assert.rejects(waitIdle(discovered, 0), /does not support/);
    } finally {
      await new Promise(resolve => legacy.close(resolve));
    }
  });
});

test('managed approval stays pending without an automatic permission response', async () => {
  await withManagedFixture(async (session, fixture) => {
    await send(session, 'pending');
    assert.deepEqual(await waitIdle(session, 1000), { status: 'needs_input' });
    assert.equal((await list()).find(row => row.id === session.id).status, 'blocked');
    await assert.rejects(send(session, 'another message'), /busy/);
    const entries = (await readFile(fixture.log, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(entries.some(entry => entry.reply === 'approval-1'), false);
    assert.equal(entries.filter(entry => entry.method === 'turn/start').length, 1);
    await assert.rejects(close({ ...session, _managed: false }), /Only managed/);
  });
});

test('managed wait sees a submission in progress rather than the previous completed turn', async () => {
  await withManagedFixture(async (session, fixture) => {
    await send(session, 'early');
    assert.deepEqual(await waitIdle(session), { status: 'completed' });
    const sending = send(session, 'slow-start');
    const deadline = Date.now() + 3000;
    while (!(await readFile(fixture.log, 'utf8')).includes('"slow-start"')) {
      if (Date.now() >= deadline) throw new Error('fixture did not receive slow-start');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.deepEqual(await waitIdle(session, 0), { status: 'timeout' });
    assert.equal((await list()).find(row => row.id === session.id).status, 'running');
    const waiting = waitIdle(session);
    await writeFile(process.env.CODEX_FIXTURE_RELEASE, '');
    await sending;
    assert.deepEqual(await waiting, { status: 'completed' });
    assert.deepEqual((await history(session, 1))[0], { role: 'assistant', text: 'answer fixture-turn-2' });
  });
});

test('managed submission distinguishes native rejection from unknown delivery', async () => {
  await withManagedFixture(async (session, fixture) => {
    for (const [text, unknown] of [['reject', false], ['unconfirmed', true]]) {
      await assert.rejects(send(session, text), error => {
        assert.equal(error.deliveryUnknown === true, unknown);
        return true;
      });
    }
    const entries = (await readFile(fixture.log, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(entries.filter(entry => entry.method === 'turn/start').length, 2);
  });
});

test('managed timeout leaves a live turn running and rejects another send', async () => {
  await withManagedFixture(async session => {
    await send(session, 'hold');
    assert.deepEqual(await waitIdle(session, 0), { status: 'timeout' });
    assert.deepEqual(await waitIdle(session, 0), { status: 'timeout' });
    await assert.rejects(send(session, 'another message'), /busy/);
  });
});

test('managed failed and interrupted turns do not return an earlier answer', async () => {
  await withManagedFixture(async session => {
    await send(session, 'early');
    await waitIdle(session, 1000);
    await send(session, 'fail');
    assert.deepEqual(await waitIdle(session, 1000), { status: 'failed', error: 'fixture failure' });
    await send(session, 'interrupt');
    assert.deepEqual(await waitIdle(session, 1000), { status: 'interrupted' });
  });
});
