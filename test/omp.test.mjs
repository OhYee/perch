import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import extension from '../omp-extension.ts';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const runFile = promisify(execFile);

let list, start, send, waitIdle, close, history, isInteractiveOmp, mergeSessions, parsePersistedHistory, readJournalTitle;
let environmentDir;
let originalEnvironment;
before(async () => {
  environmentDir = await mkdtemp(join(tmpdir(), 'agent-session-omp-env-'));
  originalEnvironment = Object.fromEntries(['HOME', 'PATH', 'XDG_STATE_HOME', 'PI_CODING_AGENT_DIR', 'OMP_FIXTURE_UI', 'OMP_FIXTURE_RELEASE'].map(key => [key, process.env[key]]));
  await writeFile(join(environmentDir, 'omp'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  await symlink(process.execPath, join(environmentDir, 'node'));
  Object.assign(process.env, { HOME: environmentDir, PATH: environmentDir, XDG_STATE_HOME: environmentDir, PI_CODING_AGENT_DIR: environmentDir });
  delete process.env.OMP_FIXTURE_UI;
  delete process.env.OMP_FIXTURE_RELEASE;
  ({ list, start, send, waitIdle, close, history, isInteractiveOmp, mergeSessions, parsePersistedHistory, readJournalTitle } = await import('../adapters/omp.mjs'));
});
after(async () => {
  if (originalEnvironment) {
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  if (environmentDir) await rm(environmentDir, { recursive: true, force: true });
});

async function waitAfterCancellation(session) {
  const deadline = Date.now() + 2000;
  let result;
  do {
    result = await waitIdle(session, 0);
    if (result.status !== 'needs_input' && result.status !== 'timeout') return result;
    await sleep(10);
  } while (Date.now() < deadline);
  return result;
}

test('extension discovers its live session, delivers once, follows branch and rejects stale identities', async () => {
  const handlers = new Map();
  const delivered = [];
  const commands = new Map();
  let title = 'Live title';
  let busy = false;
  let queued = false;
  const jobs = { running: [], recent: [], delivery: { queued: 0, delivering: false, pendingJobIds: [] } };
  const pi = { on: (event, handler) => handlers.set(event, handler), registerCommand: (name, command) => commands.set(name, command), getSessionName: () => title, sendUserMessage: async text => { delivered.push(text); } };
  const sessionId = randomUUID();
  let branch = [
    { type: 'message', message: { role: 'user', content: 'first' } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }, { type: 'toolCall', name: 'ignored' }] } },
    { type: 'message', message: { role: 'toolResult', content: 'hidden' } },
  ];
  const context = { mode: 'tui', cwd: '/fixture', isIdle: () => !busy, hasPendingMessages: () => queued, getAsyncJobSnapshot: () => jobs, sessionManager: { getSessionId: () => sessionId, getBranch: () => branch } };
  extension(pi);
  await handlers.get('session_start')({}, context);
  try {
    let session;
    for (let attempt = 0; attempt < 50 && !session; attempt++) {
      session = (await list()).find(row => row._sessionId === sessionId);
      if (!session) await sleep(20);
    }
    assert.ok(session, 'extension endpoint was not discovered');
    assert.equal(session.title, 'Live title');
    assert.equal(session.status, 'idle');
    const stat = await lstat(session._path);
    assert.equal(stat.mode & 0o077, 0);
    assert.equal(session.send, true);
    assert.equal(session.history, true);
    assert.equal(session.wait, true);
    assert.equal(session.close, false);
    assert.deepEqual(await waitIdle(session, 0), { status: 'completed' });
    // The director has yielded with an empty prompt queue, but its worker has not.
    const worker = { id: 'worker-turn', status: 'running' };
    jobs.running.push(worker);
    assert.equal((await list()).find(row => row.id === session.id).status, 'running');
    assert.deepEqual(await waitIdle(session, 0), { status: 'timeout' });
    jobs.running.pop();
    jobs.recent.push({ ...worker, status: 'completed' });
    jobs.delivery.queued = 1;
    assert.equal((await list()).find(row => row.id === session.id).status, 'running');
    assert.deepEqual(await waitIdle(session, 0), { status: 'timeout' });
    jobs.delivery.queued = 0;
    assert.equal((await list()).find(row => row.id === session.id).status, 'idle');
    assert.deepEqual(await waitIdle(session, 0), { status: 'completed' });
    await assert.rejects(() => close(session), /not managed/);
    await send(session, 'hello');
    assert.deepEqual(delivered, ['hello']);
    queued = true;
    assert.equal((await list()).find(row => row.id === session.id).status, 'running');
    assert.deepEqual(await waitIdle(session, 0), { status: 'timeout' });
    queued = false;
    const held = Promise.withResolvers();
    let released = false;
    pi.sendUserMessage = async (text, options) => {
      delivered.push(text);
      busy = true;
      if (options?.deliverAs !== 'steer') await held.promise;
    };
    try {
      const { stdout } = await runFile(process.execPath, [fileURLToPath(new URL('../cli.mjs', import.meta.url)), 'send', session.id, 'held turn', '--json'], {
        env: { ...process.env }, signal: AbortSignal.timeout(10000),
      });
      assert.equal(JSON.parse(stdout).accepted, true);
      assert.equal(released, false, 'receipt must precede completion of the native turn');
      assert.deepEqual(delivered, ['hello', 'held turn']);
      assert.equal((await list()).find(row => row.id === session.id).status, 'running');
      assert.deepEqual(await waitIdle(session, 0), { status: 'timeout' });
      const waiting = waitIdle(session, null);
      busy = false;
      released = true;
      held.resolve();
      assert.deepEqual(await waiting, { status: 'completed' });
    } finally {
      busy = false;
      held.resolve();
    }
    assert.deepEqual(await history(session, Infinity), [{ role: 'user', text: 'first' }, { role: 'assistant', text: 'answer' }]);
    assert.deepEqual(await history(session, 1), [{ role: 'assistant', text: 'answer' }]);
    await assert.rejects(() => history(session, 0));
    await assert.rejects(() => send(session, ''));
    pi.sendUserMessage = async () => { throw new Error('prompt rejected'); };
    await assert.rejects(() => send(session, 'not admitted'));
    assert.deepEqual(delivered, ['hello', 'held turn']);
    await handlers.get('session_before_switch')({}, context);
    await assert.rejects(() => send(session, 'wrong session'));
    branch = [{ type: 'message', message: { role: 'user', content: 'other branch' } }];
    title = 'Renamed title';
    handlers.get('session_switch')({}, context);
    const replacement = (await list()).find(row => row._sessionId === sessionId);
    assert.ok(replacement);
    assert.equal(replacement.title, 'Renamed title');
    assert.equal(replacement.id, `omp:${sessionId}`);
    assert.equal(replacement.id, session.id);
    await assert.rejects(() => send(session, 'stale identity'));
    await assert.rejects(() => history(session, Infinity));
    assert.deepEqual(await history(replacement, Infinity), [{ role: 'user', text: 'other branch' }]);
    assert.deepEqual(delivered, ['hello', 'held turn']);
    await handlers.get('session_before_switch')({}, context);
    title = undefined;
    await assert.rejects(() => history(replacement, Infinity));
    await commands.get('perch-reconnect').handler('', context);
    const reconnected = (await list()).find(row => row._sessionId === sessionId);
    assert.ok(reconnected);
    assert.equal(reconnected.title, undefined);
    assert.equal(reconnected.id, replacement.id);
    assert.deepEqual(await history(reconnected, Infinity), [{ role: 'user', text: 'other branch' }]);
  } finally {
    await handlers.get('session_shutdown')({}, context);
  }
});

test('session transition waits for native queue admission and rejects stale requests', async () => {
  const handlers = new Map();
  const started = Promise.withResolvers();
  const admitted = Promise.withResolvers();
  const received = [];
  const pi = {
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: () => {},
    getSessionName: () => undefined,
    sendUserMessage: async (text, options) => {
      assert.equal(options.deliverAs, 'steer');
      started.resolve();
      await admitted.promise;
      received.push(text);
    },
  };
  const sessionId = randomUUID();
  const context = { mode: 'tui', cwd: '/fixture', isIdle: () => true, hasPendingMessages: () => false, sessionManager: { getSessionId: () => sessionId, getBranch: () => [] } };
  extension(pi);
  await handlers.get('session_start')({}, context);
  try {
    let session;
    for (let attempt = 0; attempt < 50 && !session; attempt++) {
      session = (await list()).find(row => row._sessionId === sessionId);
      if (!session) await sleep(20);
    }
    assert.ok(session);
    const sending = send(session, 'before transition');
    await started.promise;
    assert.equal((await list()).find(row => row.id === session.id).status, 'running');
    let transitioned = false;
    const transition = handlers.get('session_before_switch')({}, context).then(() => { transitioned = true; });
    await assert.rejects(() => send(session, 'during transition'));
    assert.equal(transitioned, false);
    admitted.resolve();
    await sending;
    await transition;
    assert.deepEqual(received, ['before transition']);
    handlers.get('session_switch')({}, context);
    await assert.rejects(() => send(session, 'old identity'));
    assert.deepEqual(received, ['before transition']);
  } finally {
    admitted.resolve();
    await handlers.get('session_shutdown')({}, context);
  }
});

test('interactive process discovery excludes help, subcommands and unverified launches', () => {
  const proc = { comm: 'omp', tty: 'ttys001', args: 'omp' };
  assert.equal(isInteractiveOmp(proc), true);
  assert.equal(isInteractiveOmp({ ...proc, args: 'omp --model foo --offline' }), true);
  for (const args of ['omp --help', 'omp collab list', 'omp session lease --json', 'omp --print test', 'omp unknown']) {
    assert.equal(isInteractiveOmp({ ...proc, args }), false);
  }
  assert.equal(isInteractiveOmp({ ...proc, tty: '??' }), false);
  assert.equal(isInteractiveOmp({ ...proc, comm: 'other' }), false);
});

test('persisted history follows only the last saved chat branch and confirms ownership', async () => {
  const id = randomUUID();
  const rows = [
    { type: 'session', id },
    { type: 'message', id: 'a', parentId: null, message: { role: 'user', content: 'one' } },
    { type: 'message', id: 'b', parentId: 'a', message: { role: 'assistant', content: [{ type: 'text', text: 'discarded' }] } },
    { type: 'message', id: 'c', parentId: 'a', message: { role: 'user', content: 'two' } },
    { type: 'message', id: 'd', parentId: 'c', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'three' }, { type: 'toolCall', arguments: { secret: 'private' } }] } },
    { type: 'message', id: 'e', parentId: 'd', message: { role: 'toolResult', content: 'private' } },
  ];
  const journal = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  let checks = 0;
  const result = await parsePersistedHistory(journal, id, Infinity, async () => { checks++; });
  assert.deepEqual(result, [{ role: 'user', text: 'one' }, { role: 'user', text: 'two' }, { role: 'assistant', text: 'three' }]);
  assert.equal(checks, 1);
  assert.deepEqual(await parsePersistedHistory(journal, id, 1, async () => {}), [{ role: 'assistant', text: 'three' }]);
  await assert.rejects(() => parsePersistedHistory(journal, randomUUID(), Infinity, async () => {}));
  await assert.rejects(() => parsePersistedHistory(journal.slice(0, -1), id, Infinity, async () => {}));
  await assert.rejects(() => parsePersistedHistory(journal, id, Infinity, async () => { throw new Error('lease lost'); }));
  const broken = rows.map(row => row.id === 'c' ? { ...row, parentId: 'missing' } : row).map(row => JSON.stringify(row)).join('\n') + '\n';
  await assert.rejects(() => parsePersistedHistory(broken, id, Infinity, async () => {}));
});

test('reads only native title metadata from bounded journal prefixes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omp-title-test-'));
  const path = join(dir, 'session.jsonl');
  const id = randomUUID();
  const header = title => JSON.stringify({ type: 'session', id, ...(title === undefined ? {} : { title }) }) + '\n';
  const slot = title => {
    const row = { type: 'title', v: 1, title, source: 'user', updatedAt: '2026-01-01T00:00:00Z', pad: '' };
    row.pad = ' '.repeat(256 - Buffer.byteLength(JSON.stringify(row) + '\n'));
    return JSON.stringify(row) + '\n';
  };
  try {
    await writeFile(path, slot('标题') + header('old title') + JSON.stringify({ type: 'message', title: 'not a title' }) + '\n');
    assert.equal(await readJournalTitle(path, id), '标题');
    assert.equal(await readJournalTitle(path, randomUUID()), undefined);
    await writeFile(path, header('Legacy title') + JSON.stringify({ type: 'message', title: 'not a title' }) + '\n');
    assert.equal(await readJournalTitle(path, id), 'Legacy title');
    await writeFile(path, header() + JSON.stringify({ type: 'message', title: 'not a title' }) + '\n');
    assert.equal(await readJournalTitle(path, id), undefined);
    await writeFile(path, slot('') + header('Header title'));
    assert.equal(await readJournalTitle(path, id), undefined);
    await writeFile(path, JSON.stringify({ type: 'title', title: 'invalid slot' }) + '\n' + header('Header title'));
    assert.equal(await readJournalTitle(path, id), undefined);
    await writeFile(path, JSON.stringify({ type: 'session', id, title: 'x'.repeat(4096) }) + '\n');
    assert.equal(await readJournalTitle(path, id), undefined);
    await writeFile(path, slot('valid') + JSON.stringify({ type: 'session', id, title: 'incomplete' }));
    assert.equal(await readJournalTitle(path, id), undefined);
    assert.equal(await readJournalTitle(join(dir, 'missing'), id), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('deduplicates live and leased sessions while retaining the freshest native title', () => {
  const id = randomUUID();
  const local = { pid: 42, _sessionId: id.toUpperCase(), send: true };
  const lease = { pid: 42, _sessionId: id, title: 'Saved title', history: true };
  const collab = { pid: 42, _sessionId: id, title: 'Current title' };
  const rows = mergeSessions([local], [lease], [collab]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].send, true);
  assert.equal(rows[0].title, 'Current title');
  assert.equal(mergeSessions([], [{ ...lease }], [{ ...collab }])[0].history, true);
  assert.equal(mergeSessions([], [{ ...lease }], [{ ...collab }])[0].title, 'Current title');
  assert.equal(mergeSessions([{ ...local, title: 'Extension title' }], [{ ...lease }], [{ ...collab }])[0].title, 'Extension title');
  assert.equal(mergeSessions([{ ...local, title: undefined }], [{ ...lease }], [])[0].title, 'Saved title');
  assert.equal(mergeSessions([{ ...local, title: undefined }], [], [])[0].title, undefined);
});

test('native state enriches lease-only rows but not a live endpoint state', () => {
  const id = randomUUID();
  const lease = { pid: 42, _sessionId: id, status: 'unknown' };
  const native = { pid: 42, _sessionId: id, status: 'running' };
  assert.equal(mergeSessions([], [{ ...lease }], [native])[0].status, 'running');
  assert.equal(mergeSessions([{ ...lease, status: 'idle' }], [], [native])[0].status, 'idle');
});

test('older and unrecognized OMP endpoints report unknown without probing again', async () => {
  const dir = `/tmp/agent-session-${process.getuid()}`;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${process.pid}-${randomUUID().replaceAll('-', '')}.sock`);
  const sessionId = randomUUID();
  const id = `omp:${process.pid}:${randomUUID().replaceAll('-', '')}`;
  let status;
  const operations = [];
  const server = createServer(socket => {
    socket.once('data', data => {
      operations.push(JSON.parse(data).op);
      socket.end(JSON.stringify({ ok: true, pid: process.pid, sessionId, id, cwd: '/fixture', status }) + '\n');
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  await chmod(path, 0o600);
  try {
    assert.equal((await list()).find(row => row.id === `omp:${sessionId}`).status, 'unknown');
    status = 'unexpected';
    assert.equal((await list()).find(row => row.id === `omp:${sessionId}`).status, 'unknown');
    status = 'blocked';
    assert.equal((await list()).find(row => row.id === `omp:${sessionId}`).status, 'blocked');
    assert.deepEqual(operations, ['info', 'info', 'info']);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(path, { force: true });
  }
});

const fakeOmp = String.raw`#!/usr/bin/env node
const { createInterface } = require('node:readline');
const { join } = require('node:path');
const { existsSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'collab') { console.log(JSON.stringify({ version: 1, hosts: [] })); process.exit(0); }
if (args[0] === 'session') { console.log(JSON.stringify({ held: [], unknown: [] })); process.exit(0); }
if (args[0] !== '--mode' || args[1] !== 'rpc' || args[2] !== '--session-dir' || !args[3] || args.includes('--no-ui') || args.includes('--auto-approve')) process.exit(4);
const file = join(args[3], 'fixture.jsonl');
let sessionId = 'fixture-original', busy = false, asyncPending = false, uiTurn, uiDelay = 150, uiLocal = false;
const messages = [];
const emit = frame => process.stdout.write(JSON.stringify(frame) + '\n');
const reply = (req, data) => emit({ type: 'response', id: req.id, command: req.type, success: true, data });
function answer(id, text, chunk) {
  const message = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] };
  messages.push(message);
  const event = { type: 'message_end', message };
  if (chunk) {
    const bytes = Buffer.from(JSON.stringify(event));
    const split = Math.floor(bytes.length / 2);
    [bytes.subarray(0, split), bytes.subarray(split)].forEach((part, index) => emit({ type: 'rpc_chunk', chunkId: 'chunk-1', index, count: 2, byteLength: bytes.length, data: part.toString('base64') }));
  } else emit(event);
  busy = false;
  emit({ type: 'prompt_result', id, agentInvoked: true, status: 'completed', sessionSettled: true });
}
emit({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2] });
createInterface({ input: process.stdin }).on('line', line => {
  const req = JSON.parse(line);
  if (req.type === 'negotiate_protocol') return reply(req, { protocolVersion: 2 });
  if (req.type === 'get_state') return reply(req, { sessionId, sessionFile: file, sessionName: 'Fixture', messageCount: messages.length, isStreaming: busy, hasPendingAsyncWork: asyncPending, isSettled: !busy && !asyncPending });
  if (req.type === 'get_messages') return reply(req, { messages });
  if (req.type === 'extension_ui_response') {
    writeFileSync(process.env.OMP_FIXTURE_UI, JSON.stringify(req));
    return setTimeout(() => {
      if (uiLocal) { busy = false; emit({ type: 'prompt_result', id: uiTurn, agentInvoked: false, status: 'completed', sessionSettled: true }); }
      else answer(uiTurn, 'after cancellation');
    }, uiDelay);
  }
  if (req.type !== 'prompt') return emit({ type: 'response', id: req.id, command: req.type, success: false, error: 'unsupported' });
  if (req.message === '/local-reject') return emit({ type: 'response', id: req.id, command: req.type, success: false, error: 'local command rejected' });
  if (req.message === '/local-sync' || req.message === '/local-switch') {
    messages.push({ role: 'user', content: req.message });
    if (req.message === '/local-switch') sessionId = 'fixture-rebound';
    return reply(req, { agentInvoked: false });
  }
  if (req.message === '/local-background') {
    messages.push({ role: 'user', content: req.message });
    asyncPending = true;
    reply(req);
    emit({ type: 'prompt_result', id: req.id, agentInvoked: false, status: 'completed', sessionSettled: false });
    return setTimeout(() => { asyncPending = false; emit({ type: 'session_settled' }); }, 100);
  }
  if (req.message === '/local-error' || req.message === '/local-abort' || req.message === '/local-complete') {
    messages.push({ role: 'user', content: req.message });
    reply(req);
    const status = req.message === '/local-error' ? 'error' : req.message === '/local-abort' ? 'aborted' : 'completed';
    return emit({ type: 'prompt_result', id: req.id, agentInvoked: false, status, ...(status === 'error' ? { error: { message: 'local command failed' } } : {}), sessionSettled: true });
  }
  busy = true;
  messages.push({ role: 'user', content: req.message });
  reply(req);
  if (req.message !== '/local-approval') emit({ type: 'agent_start' });
  if (req.message === 'approval' || req.message === 'approval-held' || req.message === '/local-approval') {
    uiDelay = req.message === 'approval-held' ? 10000 : 150;
    uiTurn = req.id;
    uiLocal = req.message === '/local-approval';
    return emit({ type: 'extension_ui_request', id: 'ui-1', method: 'confirm', title: 'Approve?', message: 'Tool requires approval' });
  }
  if (req.message === 'abort') { busy = false; return emit({ type: 'prompt_result', id: req.id, agentInvoked: true, status: 'aborted', sessionSettled: true }); }
  if (req.message === 'failure') { busy = false; return emit({ type: 'prompt_result', id: req.id, agentInvoked: true, status: 'error', error: { message: 'fixture failure' }, sessionSettled: true }); }
  if (req.message === 'switch') { sessionId = 'fixture-rebound'; return answer(req.id, 'wrong session'); }
  if (req.message === 'delayed') return setTimeout(() => answer(req.id, 'late answer'), 100);
  if (req.message === 'yielded-background') {
    busy = false;
    asyncPending = true;
    emit({ type: 'prompt_result', id: req.id, agentInvoked: true, status: 'completed', sessionSettled: false });
    const timer = setInterval(() => {
      if (!existsSync(process.env.OMP_FIXTURE_RELEASE)) return;
      clearInterval(timer);
      asyncPending = false;
      emit({ type: 'session_settled' });
    }, 10);
    return;
  }
  if (req.message === 'background') {
    emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'intermediate' }] } });
    emit({ type: 'prompt_result', id: req.id, agentInvoked: true, status: 'completed', sessionSettled: false });
    return setTimeout(() => {
      emit({ type: 'agent_start' });
      const message = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'background final' }] };
      messages.push(message); emit({ type: 'message_end', message }); busy = false; emit({ type: 'session_settled' });
    }, 100);
  }
  return answer(req.id, req.message === 'chunk' ? 'chunked answer' : 'answer:' + req.message, req.message === 'chunk');
});
`;

test('managed OMP RPC tracks only its own admitted turns and never approves UI', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-session-omp-rpc-'));
  const before = { PATH: process.env.PATH, XDG_STATE_HOME: process.env.XDG_STATE_HOME, OMP_FIXTURE_UI: process.env.OMP_FIXTURE_UI };
  const fixture = join(dir, 'omp');
  const uiPath = join(dir, 'ui.json');
  let session;
  try {
    await writeFile(fixture, fakeOmp);
    await chmod(fixture, 0o700);
    process.env.PATH = `${dir}:${before.PATH}`;
    process.env.XDG_STATE_HOME = dir;
    process.env.OMP_FIXTURE_UI = uiPath;
    session = await start({ cwd: dir });
    assert.equal(session.provider, 'omp');
    assert.equal(session.wait, true);
    assert.equal(session.close, true);
    const listed = (await list()).filter(row => row.id === session.id);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]._sessionId, session._sessionId);
    assert.equal(listed[0].status, 'idle');
    assert.equal(listed[0]._path, session._path);
    assert.equal((await lstat(session._path)).mode & 0o077, 0);
    assert.deepEqual(await waitIdle(session, 0), { status: 'completed' });
    await assert.rejects(() => send({ ...session, id: 'omp:wrong' }, 'wrong'), /identity/);
    await send(session, '/skill:fixture task');
    assert.deepEqual(await waitIdle(session, null), { status: 'completed' });
    await send(session, '/skill:fixture task');
    assert.deepEqual(await waitIdle(session, null), { status: 'completed' });
    await send(session, '  /skill:fixture spaced');
    assert.deepEqual(await waitIdle(session, 1000), { status: 'completed' });
    await send(session, '/new');
    assert.deepEqual(await waitIdle(session, 1000), { status: 'completed' });
    await send(session, '/local-sync');
    assert.deepEqual(await waitIdle(session, 1000), { status: 'completed' });
    await send(session, '/local-complete');
    assert.deepEqual(await waitIdle(session, 1000), { status: 'completed' });
    await send(session, '/local-background');
    assert.deepEqual(await waitIdle(session, 0), { status: 'timeout' });
    await assert.rejects(() => send(session, '/local-sync'), /busy/);
    assert.deepEqual(await waitIdle(session, 1000), { status: 'completed' });
    await send(session, '/local-error');
    assert.deepEqual(await waitIdle(session, 1000), { status: 'failed', error: 'local command failed' });
    await assert.rejects(() => send(session, '/local-reject'), /local command rejected/);
    assert.deepEqual(await waitIdle(session, 1000), { status: 'failed', error: 'local command failed' });
    await send(session, '/local-abort');
    assert.deepEqual(await waitIdle(session, 1000), { status: 'interrupted' });
    await send(session, '/local-approval');
    assert.deepEqual(await waitIdle(session, 1000), { status: 'needs_input' });
    assert.deepEqual(JSON.parse(await readFile(uiPath, 'utf8')), { type: 'extension_ui_response', id: 'ui-1', cancelled: true });
    assert.deepEqual(await waitIdle(session, 1000), { status: 'needs_input' });
    assert.deepEqual(await waitAfterCancellation(session), { status: 'completed' });
    await send(session, 'repeat');
    assert.deepEqual(await waitIdle(session, 1000), { status: 'completed' });
    await send(session, 'repeat');
    assert.deepEqual(await waitIdle(session, 1000), { status: 'completed' });
    await send(session, 'delayed');
    assert.deepEqual(await waitIdle(session, 0), { status: 'timeout' });
    await assert.rejects(() => send(session, 'busy'), /busy/);
    assert.deepEqual(await waitIdle(session, null), { status: 'completed' });
    await send(session, 'background');
    assert.deepEqual(await waitIdle(session, 0), { status: 'timeout' });
    assert.deepEqual(await waitIdle(session, 1000), { status: 'completed' });
    await send(session, 'chunk');
    assert.deepEqual(await waitIdle(session, 1000), { status: 'completed' });
    await send(session, 'abort');
    assert.deepEqual(await waitIdle(session, 1000), { status: 'interrupted' });
    assert.equal((await list()).find(row => row.id === session.id).status, 'idle');
    await send(session, 'failure');
    assert.deepEqual(await waitIdle(session, 1000), { status: 'failed', error: 'fixture failure' });
    assert.equal((await list()).find(row => row.id === session.id).status, 'idle');
    await send(session, 'approval');
    assert.deepEqual(await waitIdle(session, 1000), { status: 'needs_input' });
    assert.deepEqual(JSON.parse(await readFile(uiPath, 'utf8')), { type: 'extension_ui_response', id: 'ui-1', cancelled: true });
    assert.deepEqual(await waitAfterCancellation(session), { status: 'completed' });
    const rows = await history(session, Infinity);
    assert.ok(rows.every(row => ['user', 'assistant'].includes(row.role)));
    assert.deepEqual(rows.slice(0, 6), [
      { role: 'user', text: '/skill:fixture task' }, { role: 'assistant', text: 'answer:/skill:fixture task' },
      { role: 'user', text: '/skill:fixture task' }, { role: 'assistant', text: 'answer:/skill:fixture task' },
      { role: 'user', text: '  /skill:fixture spaced' }, { role: 'assistant', text: 'answer:  /skill:fixture spaced' },
    ]);
    assert.deepEqual(await history(session, 1), [{ role: 'assistant', text: 'after cancellation' }]);
    await close(session);
    session = null;
    assert.equal((await list()).some(row => row.id === listed[0].id), false);
  } finally {
    if (session) { try { await close(session); } catch { try { process.kill(session.pid, 'SIGKILL'); } catch {} } }
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(dir, { recursive: true, force: true });
  }
});
test('managed OMP reports running after a cancelled UI request, not the latched wait outcome', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-session-omp-status-'));
  const before = { PATH: process.env.PATH, XDG_STATE_HOME: process.env.XDG_STATE_HOME, OMP_FIXTURE_UI: process.env.OMP_FIXTURE_UI };
  let session;
  try {
    await writeFile(join(dir, 'omp'), fakeOmp);
    await chmod(join(dir, 'omp'), 0o700);
    process.env.PATH = `${dir}:${before.PATH}`;
    process.env.XDG_STATE_HOME = dir;
    process.env.OMP_FIXTURE_UI = join(dir, 'ui.json');
    session = await start({ cwd: dir });
    assert.equal(session.status, 'idle');
    await send(session, 'approval-held');
    assert.deepEqual(await waitIdle(session, 1000), { status: 'needs_input' });
    assert.equal((await list()).find(row => row.id === session.id).status, 'running');
  } finally {
    if (session) { try { await close(session); } catch { try { process.kill(session.pid, 'SIGKILL'); } catch {} } }
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(dir, { recursive: true, force: true });
  }
});

test('managed OMP remains running after yield while native async work is pending', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-session-omp-async-'));
  const before = { PATH: process.env.PATH, XDG_STATE_HOME: process.env.XDG_STATE_HOME, OMP_FIXTURE_RELEASE: process.env.OMP_FIXTURE_RELEASE };
  let session;
  try {
    await writeFile(join(dir, 'omp'), fakeOmp);
    await chmod(join(dir, 'omp'), 0o700);
    process.env.PATH = `${dir}:${before.PATH}`;
    process.env.XDG_STATE_HOME = dir;
    process.env.OMP_FIXTURE_RELEASE = join(dir, 'release');
    session = await start({ cwd: dir });
    await send(session, 'yielded-background');
    assert.equal((await list()).find(row => row.id === session.id).status, 'running');
    assert.deepEqual(await waitIdle(session, 0), { status: 'timeout' });
    await writeFile(process.env.OMP_FIXTURE_RELEASE, '');
    assert.deepEqual(await waitIdle(session, 2000), { status: 'completed' });
    assert.equal((await list()).find(row => row.id === session.id).status, 'idle');
  } finally {
    if (session) { try { await close(session); } catch { try { process.kill(session.pid, 'SIGKILL'); } catch {} } }
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(dir, { recursive: true, force: true });
  }
});


test('managed OMP refuses a native session switch instead of rebinding', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-session-omp-switch-'));
  const before = { PATH: process.env.PATH, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  let session;
  try {
    await writeFile(join(dir, 'omp'), fakeOmp);
    await chmod(join(dir, 'omp'), 0o700);
    process.env.PATH = `${dir}:${before.PATH}`;
    process.env.XDG_STATE_HOME = dir;
    for (const command of ['switch', '/local-switch']) {
      session = await start({ cwd: dir });
      await send(session, command);
      await assert.rejects(() => waitIdle(session, 1000), /identity/);
      await assert.rejects(() => send(session, 'must not be delivered'), /identity/);
      await assert.rejects(() => close(session), /identity/);
      assert.equal((await list()).some(row => row.id === session.id), false);
      try { process.kill(session.pid, 'SIGKILL'); } catch {}
      session = null;
    }
  } finally {
    if (session) { try { process.kill(session.pid, 'SIGKILL'); } catch {} }
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(dir, { recursive: true, force: true });
  }
});
