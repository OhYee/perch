import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { close, historyManaged, listManaged, lookupBridge, managedDir, send, start, waitIdle } from '../adapters/agy-managed.mjs';

const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const provider = await readFile(new URL('../fixtures/agy.mjs', import.meta.url), 'utf8');
const marker = /fixture-private-provider-value/;

async function until(check) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await sleep(10);
  }
  assert.fail('AGY fixture did not reach the expected stage');
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function fixture(t, startup = '') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'perch-agy-managed-')));
  const home = join(root, 'home');
  const cwd = join(root, 'work space');
  const bin = join(root, 'bin');
  const log = join(root, 'acp.jsonl');
  const release = join(root, 'release');
  const state = join(home, '.local', 'state');
  const env = { HOME: home, PATH: bin, XDG_STATE_HOME: state, LC_ALL: 'C', AGY_FIXTURE_LOG: log,
    AGY_FIXTURE_RELEASE: release, AGY_FIXTURE_START: startup, AGY_FIXTURE_STORE: join(home, 'fixture-state') };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  const sessions = new Set();
  let socketDir;
  t.after(async () => {
    try {
      try {
        for (const id of sessions) {
          const row = await lookupBridge(id);
          if (row) await close(row);
        }
      } finally {
        if (socketDir) await rmdir(socketDir).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
      }
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
  await Promise.all([mkdir(home), mkdir(cwd), mkdir(bin)]);
  await writeFile(join(bin, 'agy'), provider.replace('#!/usr/bin/env node', `#!${process.execPath}`), { mode: 0o755 });
  Object.assign(process.env, env);
  socketDir = managedDir();
  const trace = async () => {
    try {
      const data = await readFile(log, 'utf8');
      return data.slice(0, data.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(JSON.parse);
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  const run = (args, input, overrides, untilText) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env: { ...env, ...overrides }, timeout: untilText ? 5000 : 40000 });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => {
      stdout += chunk;
      if (untilText && stdout.includes(untilText)) child.kill();
    });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
    child.stdin.end(input);
  });
  return {
    cwd, home, state, trace, run,
    release: phase => writeFile(`${release}-${phase}`, ''),
    own(row) { assert.ok(row?._socket, 'managed row must identify its socket'); sessions.add(row.id); return row; },
    async start(model) { return this.own(await start({ cwd, model })); },
  };
}

const methods = events => events.filter(event => event.method).map(event => event.method);
const prompts = events => events.filter(event => event.method === 'session/prompt').map(event => event.params);
const json = result => JSON.parse(result.stdout);
const outcome = promise => promise.then(() => 'accepted');

// 先监听拒绝，避免待测异步操作在断言期间提前结束而掩盖原始失败。
function observe(promise) { promise.catch(() => {}); return promise; }

async function expectPending(promise) {
  const pending = Symbol('pending');
  assert.equal(await Promise.race([promise, sleep(100, pending)]), pending);
}

test('managed AGY starts only an empty owned ACP session and preserves provider prompts', async t => {
  const f = await fixture(t);
  assert.deepEqual(await listManaged(), []);
  assert.equal(await lookupBridge(`agy:${randomUUID()}`), null);
  assert.deepEqual(await f.trace(), []);

  const selected = await f.start('fixture-model');
  assert.match(selected.id, /^agy:[a-f0-9-]{36}$/);
  assert.equal((await lookupBridge(selected.id)).id, selected.id);
  const before = await f.trace();
  assert.deepEqual(before[0].argv, ['acp', '--dangerously-skip-permissions']);
  assert.deepEqual(methods(before), ['initialize', 'session/new', 'session/set_config_option']);
  assert.deepEqual(before[1].params, { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'perch', version: before[1].params.clientInfo.version } });
  assert.match(before[1].params.clientInfo.version, /\d+\.\d+\.\d+/);
  assert.deepEqual(before[2].params, { cwd: f.cwd, mcpServers: [] });
  const model = before[3].params;
  assert.deepEqual(model, { sessionId: model.sessionId, configId: 'select-model', value: 'fixture-model' });
  assert.match(model.sessionId, /^fixture\/opaque:/);
  assert.doesNotMatch(selected.id, /opaque/);
  assert.deepEqual(await historyManaged(selected, 20), []);
  assert.deepEqual(await waitIdle(selected, 0), { status: 'completed' });
  assert.deepEqual((await listManaged()).map(row => row.id), [selected.id]);
  assert.deepEqual(await f.trace(), before);

  const text = '/model\n  literal "你好"\n';
  const first = await f.run(['send', selected.id, '--stdin', '--json'], text);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(json(first), { accepted: true });
  assert.equal((await waitIdle(selected, 1000)).status, 'completed');
  await send(selected, 'second prompt');
  assert.equal((await waitIdle(selected, 1000)).status, 'completed');
  assert.deepEqual(prompts(await f.trace()), [text, 'second prompt'].map(text => ({ sessionId: model.sessionId, prompt: [{ type: 'text', text }] })));
  assert.deepEqual(await historyManaged(selected, 3), [
    { role: 'assistant', text: 'fixture answer 1' }, { role: 'user', text: 'second prompt' }, { role: 'assistant', text: 'fixture answer 2' },
  ]);
  assert.deepEqual(methods(await f.trace()), [...methods(before), 'session/prompt', 'session/prompt']);
  const closed = await f.run(['close', selected.id, '--json']);
  assert.equal(closed.status, 0, closed.stderr);
  assert.deepEqual(json(closed), { id: selected.id, closed: true });
  assert.equal(await lookupBridge(selected.id), null);
  assert.equal(alive(before[0].pid), false);
  await assert.rejects(lstat(selected._socket), { code: 'ENOENT' });
  const stale = await f.run(['send', selected.id, 'no stale delivery', '--json']);
  assert.equal(stale.status, 1);
  assert.deepEqual(json(stale), { accepted: false });

  const offset = (await f.trace()).length;
  const started = await f.run(['start', 'agy', '--cwd', f.cwd, '--json']);
  assert.equal(started.status, 0, started.stderr);
  const { id, provider: providerName } = json(started);
  f.own(await lookupBridge(id));
  assert.equal(providerName, 'agy');
  assert.notEqual(id, selected.id);
  assert.deepEqual(methods((await f.trace()).slice(offset)), ['initialize', 'session/new']);
});

test('AGY admission ignores foreign session, RPC IDs and metadata; wait follows one in-flight turn', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const row = await f.start();
  const sending = observe(outcome(send(row, 'fixture:gate')));
  await until(async () => prompts(await f.trace()).length === 1);
  await expectPending(sending);
  assert.deepEqual(await historyManaged(row, 20), []);
  assert.equal((await lookupBridge(row.id)).status, 'running');

  const rejected = await f.run(['send', row.id, 'must not interleave', '--json']);
  assert.equal(rejected.status, 1);
  assert.deepEqual(json(rejected), { accepted: false });
  assert.equal(prompts(await f.trace()).length, 1);
  const instant = await f.run(['wait', row.id, '--timeout', '0', '--json']);
  assert.equal(instant.status, 2, instant.stderr);
  assert.deepEqual(json(instant), { id: row.id, status: 'timeout' });
  const waiting = observe(Promise.all([waitIdle(row, null), waitIdle(row, 5000)]));
  await f.release('progress');
  assert.equal(await sending, 'accepted');
  assert.equal((await waitIdle(row, 20)).status, 'timeout');
  await expectPending(waiting);
  assert.equal((await lookupBridge(row.id)).title, 'Fixture session');
  await f.release('finish');
  assert.deepEqual(await waiting, [{ status: 'completed' }, { status: 'completed' }]);
  assert.deepEqual(await historyManaged(row, 20), [
    { role: 'user', text: 'fixture:gate' }, { role: 'assistant', text: 'echo echo done' },
  ]);
});

test('AGY permission requests block without approval or execution of provider client tools', async t => {
  const f = await fixture(t);
  const row = await f.start();
  const sent = await f.run(['send', row.id, 'fixture:pending', '--json']);
  assert.equal(sent.status, 0, sent.stderr);
  assert.deepEqual(json(sent), { accepted: true });
  const waiting = await f.run(['wait', row.id, '--timeout', '1', '--json']);
  assert.equal(waiting.status, 3, waiting.stderr);
  assert.equal(json(waiting).status, 'needs_input');
  assert.doesNotMatch(waiting.stdout + waiting.stderr, marker);
  assert.equal((await lookupBridge(row.id)).status, 'blocked');
  const rejected = await f.run(['send', row.id, 'not an approval', '--json']);
  assert.equal(rejected.status, 1);
  assert.deepEqual(json(rejected), { accepted: false });
  const execution = await until(async () => (await f.trace()).find(m => m.id === 'client-exec-1'));
  assert.equal(execution.error.code, -32601);
  assert.doesNotMatch(JSON.stringify(execution), marker);
  assert.equal((await f.trace()).some(m => m.id === 'permission-1'), false);
  assert.equal(prompts(await f.trace()).length, 1);
  assert.deepEqual(await historyManaged(row, 20), [{ role: 'user', text: 'fixture:pending' }]);
  await close(row);
  assert.equal(await lookupBridge(row.id), null);
  for (const m of (await f.trace()).filter(m => m.id === 'permission-1')) {
    assert.notEqual(m.result?.outcome?.outcome, 'selected');
  }
});

test('AGY separates explicit denial, unknown delivery and matching ACP stop reasons', async t => {
  const f = await fixture(t);
  const row = await f.start();
  for (const [text, accepted, status] of [
    ['fixture:invalid', false, null],
    ['fixture:error-before-ack', null, 'failed'],
    ['fixture:terminal-only', true, 'completed'],
    ['fixture:refusal', true, 'failed'],
    ['fixture:max-tokens', true, 'failed'],
    ['fixture:cancelled', true, 'interrupted'],
  ]) {
    const sent = await f.run(['send', row.id, text, '--json']);
    assert.equal(sent.status, accepted === true ? 0 : 1, sent.stderr);
    assert.deepEqual(json(sent), { accepted });
    assert.doesNotMatch(sent.stderr, marker);
    if (status) {
      const stopped = await waitIdle(row, 1000);
      assert.equal(stopped.status, status);
      assert.doesNotMatch(JSON.stringify(stopped), marker);
    }
  }
  assert.deepEqual(await historyManaged(row, 20), [
    { role: 'user', text: 'fixture:terminal-only' }, { role: 'user', text: 'fixture:refusal' },
    { role: 'user', text: 'fixture:max-tokens' }, { role: 'user', text: 'fixture:cancelled' },
  ]);
  assert.equal(prompts(await f.trace()).length, 6);
});

test('AGY send timeout never clears the in-flight admission or retries the prompt', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const row = await f.start();
  const uncertain = await f.run(['send', row.id, 'fixture:ack-timeout', '--json']);
  assert.equal(uncertain.status, 1, uncertain.stderr);
  assert.deepEqual(json(uncertain), { accepted: null });
  assert.match(uncertain.stderr, /do not (?:resend|retry)/i);
  assert.equal((await waitIdle(row, 0)).status, 'timeout');
  await assert.rejects(send(row, 'unsafe retry'), { message: /busy|in progress/i });
  assert.equal(prompts(await f.trace()).length, 1);
  await f.release('finish');
  assert.equal((await waitIdle(row, 1000)).status, 'completed');
  assert.deepEqual(await historyManaged(row, 20), [{ role: 'user', text: 'fixture:ack-timeout' }]);
});

test('AGY post-ack failures wake waiting callers without echoing provider payloads', async t => {
  for (const [text, status] of [['fixture:error-after-ack', 'failed'], ['fixture:bad-frame', 'failed'], ['fixture:exit-after-ack', 'interrupted']]) {
    await t.test(text, { timeout: 10000 }, async t => {
      const f = await fixture(t);
      const row = await f.start();
      await send(row, text);
      const waiting = observe(waitIdle(row, null));
      await expectPending(waiting);
      await f.release('finish');
      const stopped = await waiting;
      assert.equal(stopped.status, status);
      assert.doesNotMatch(JSON.stringify(stopped), marker);
    });
  }
});

test('AGY disconnect before acknowledgment is unknown, never a successful or repeated send', async t => {
  const f = await fixture(t);
  const row = await f.start();
  const sent = await f.run(['send', row.id, 'fixture:disconnect', '--json']);
  assert.equal(sent.status, 1, sent.stderr);
  assert.deepEqual(json(sent), { accepted: null });
  assert.doesNotMatch(sent.stderr, marker);
  assert.equal(prompts(await f.trace()).length, 1);
  await until(async () => !await lookupBridge(row.id));
});

test('AGY startup failures never advertise an empty session or leave a provider running', async t => {
  for (const [mode, model] of [['auth'], ['protocol'], ['no-id'], ['exit'], ['', 'missing-model'], ['ignore-model', 'fixture-model']]) {
    await t.test(mode || model, async t => {
      const f = await fixture(t, mode);
      const started = await f.run(['start', 'agy', '--json', ...(model ? ['--model', model] : [])]);
      assert.equal(started.status, 1, started.stderr);
      assert.equal(started.stdout, '');
      assert.doesNotMatch(started.stderr, marker);
      if (mode === 'auth') assert.match(started.stderr, /authentication required/i);
      assert.deepEqual(await listManaged(), []);
      const events = await f.trace();
      assert.equal(events.filter(event => event.argv).length, 1);
      assert.equal(prompts(events).length, 0);
      await until(() => !alive(events[0].pid));
    });
  }
});

test('AGY rejects a writable or symlinked state root and accepts a separate private XDG_STATE_HOME', async t => {
  const f = await fixture(t);
  const startArgs = ['start', 'agy', '--json'];
  const check = async overrides => {
    const result = await f.run(startArgs, undefined, overrides);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /XDG_STATE_HOME.*0700.*symlink/);
    assert.deepEqual(await f.trace(), []);
  };
  await mkdir(f.state, { recursive: true });
  await chmod(f.state, 0o775);
  await check({ XDG_STATE_HOME: undefined });
  assert.equal((await lstat(f.state)).mode & 0o777, 0o775);
  assert.deepEqual(await readdir(f.state), []);
  await rmdir(f.state);

  const target = join(f.home, 'symlink-target');
  await mkdir(target, { mode: 0o700 });
  await symlink(target, f.state);
  await check();
  assert.ok((await lstat(f.state)).isSymbolicLink());
  assert.deepEqual(await readdir(target), []);

  const privateState = join(f.home, 'perch-state');
  await mkdir(privateState, { mode: 0o700 });
  const env = { XDG_STATE_HOME: privateState };
  const created = await f.run(startArgs, undefined, env);
  assert.equal(created.status, 0, created.stderr);
  const { id } = json(created);
  try {
    assert.deepEqual(json(await f.run(['list', '--provider', 'agy', '--json'], undefined, env)).map(row => row.id), [id]);
    assert.equal((await lstat(join(privateState, 'agent-session', 'agy', id.slice(4), 'session.json'))).mode & 0o777, 0o600);
  } finally {
    const closed = await f.run(['close', id, '--json'], undefined, env);
    assert.equal(closed.status, 0, closed.stderr);
  }
});

test('AGY private rendezvous rejects other homes, symlinks and an unready endpoint before sending text', async t => {
  const f = await fixture(t);
  const row = await f.start();
  const [dir, socket] = await Promise.all([lstat(dirname(row._socket)), lstat(row._socket)]);
  assert.equal(dir.isDirectory(), true);
  assert.equal(socket.isSocket(), true);
  assert.equal(dir.uid, process.getuid());
  assert.equal(socket.uid, process.getuid());
  assert.equal(dir.mode & 0o777, 0o700);
  assert.equal(socket.mode & 0o777, 0o600);
  const otherHome = join(dirname(f.home), 'another-home');
  await mkdir(otherHome);
  process.env.HOME = otherHome;
  try { assert.equal(await lookupBridge(row.id), null); }
  finally { process.env.HOME = f.home; }
  await chmod(dirname(row._socket), 0o755);
  try { await assert.rejects(send(row, 'must not access a permissive directory')); }
  finally { await chmod(dirname(row._socket), 0o700); }
  assert.deepEqual(prompts(await f.trace()), []);
  let received = '';
  let connections = 0;
  const server = createServer(client => {
    connections++;
    client.on('data', chunk => { received += chunk; client.end('{}\n'); });
  });
  const listen = async path => {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, resolve);
    });
    await chmod(path, 0o600);
  };
  const stop = () => new Promise(resolve => server.close(resolve));
  // 保留正在运行的一方和其所有者标记，只替换本测试 socket，确保真正经过握手检测。
  const authentic = join(dirname(row._socket), 'fixture-authentic.sock');
  const alternate = join(dirname(row._socket), 'fixture-mismatch.sock');
  await rename(row._socket, authentic);
  try {
    await listen(alternate);
    try {
      await symlink(alternate, row._socket);
      try { await assert.rejects(send(row, 'do not disclose this prompt')); }
      finally { await unlink(row._socket); }
      assert.equal(connections, 0);
    } finally { await stop(); }
    await listen(row._socket);
    try {
      await assert.rejects(send(row, 'do not disclose this prompt'));
      assert.ok(connections > 0, 'forged socket should reach the identity check');
      assert.doesNotMatch(received, /do not disclose this prompt/);
    } finally { await stop(); }
  } finally { await rename(authentic, row._socket); }
});

const descriptorPath = (f, row) => join(f.state, 'agent-session', 'agy', row.id.slice('agy:'.length), 'session.json');
const resumeArgs = id => ['resume', id, '--json'];

async function seedReplay(f, messages) {
  // 仅替换合成提供方的存储，保留真实的 start/close/ACP load 路径。
  const path = join(f.home, 'fixture-state');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...saved, messages }));
}

test('AGY restores a bounded message tail without reviving earlier IDs from delayed fragments', async t => {
  const f = await fixture(t);
  const row = await f.start();
  await close(row);
  const messages = Array.from({ length: 1200 }, (_, i) => ({
    role: i % 2 ? 'agent_message_chunk' : 'user_message_chunk', text: `message ${i}`, messageId: `message-${i}`,
  }));
  await seedReplay(f, [...messages,
    { role: 'user_message_chunk', text: 'tail ', messageId: 'tail' },
    { role: 'agent_message_chunk', text: 'complete answer', messageId: 'answer' },
    { ...messages[0], text: 'late incomplete fragment' },
    { role: 'user_message_chunk', text: 'user', messageId: 'tail' },
  ]);
  const reopened = await f.run(resumeArgs(row.id));
  assert.equal(reopened.status, 0, reopened.stderr);
  assert.equal(json(reopened).id, row.id);
  const live = f.own(await lookupBridge(row.id));
  const history = await historyManaged(live, 1024);
  assert.equal(history.length, 1024);
  assert.equal(history[0].text, 'message 178');
  assert.deepEqual(history.slice(-2), [
    { role: 'user', text: 'tail user' }, { role: 'assistant', text: 'complete answer' },
  ]);
  await assert.rejects(historyManaged(live, Infinity), /exceeds the retained window/);
  await send(live, 'continue after count eviction');
  assert.equal((await waitIdle(live, 1000)).status, 'completed');
  assert.deepEqual((await historyManaged(live, 2))[0], { role: 'user', text: 'continue after count eviction' });
});

test('AGY can resume and read a short retained tail from a byte-limited replay', async t => {
  const f = await fixture(t);
  const row = await f.start();
  await close(row);
  const messages = Array.from({ length: 5 }, (_, i) => ({
    role: i % 2 ? 'agent_message_chunk' : 'user_message_chunk', text: String(i).repeat(1024 * 1024), messageId: `payload-${i}`,
  }));
  await seedReplay(f, messages);
  const reopened = await f.run(resumeArgs(row.id));
  assert.equal(reopened.status, 0, reopened.stderr);
  assert.equal(json(reopened).id, row.id);
  const live = f.own(await lookupBridge(row.id));
  const retained = await f.run(['history', live.id, '--json']);
  assert.equal(retained.status, 0, retained.stderr);
  assert.deepEqual(json(retained).map(({ role, text }) => [role, text[0], text.length]), [
    ['assistant', '1', 1024 * 1024], ['user', '2', 1024 * 1024],
    ['assistant', '3', 1024 * 1024], ['user', '4', 1024 * 1024],
  ]);
  const all = await f.run(['history', live.id, '--all', '--json']);
  assert.equal(all.status, 1);
  assert.equal(all.stdout, '');
  assert.match(all.stderr, /exceeds the retained window/);
  await send(live, 'continue after byte eviction');
  assert.equal((await waitIdle(live, 1000)).status, 'completed');
  assert.deepEqual((await historyManaged(live, 2))[0], { role: 'user', text: 'continue after byte eviction' });
});

test('AGY omits entire oversized messages from live and replay history', async t => {
  const f = await fixture(t);
  const row = await f.start();
  await send(row, 'fixture:oversized');
  const [streaming] = await historyManaged(row, 1);
  assert.equal(streaming.role, 'assistant');
  assert.equal(streaming.text.length, 2 * 1024 * 1024 + 1);
  await f.release('finish');
  assert.deepEqual(await waitIdle(row, 5000), { status: 'failed', error: 'Antigravity CLI truncated the response' });
  assert.deepEqual(await historyManaged(row, 20), [
    { role: 'user', text: 'fixture:oversized' }, { role: 'assistant', text: 'complete after oversized message' },
  ]);
  await assert.rejects(historyManaged(row, Infinity), /exceeds the retained window/);
  await close(row);

  const text = 'y'.repeat(4 * 1024 * 1024 + 2);
  await seedReplay(f, [
    { role: 'user_message_chunk', text: 'earlier question', messageId: 'question' },
    { role: 'agent_message_chunk', text, messageId: 'oversized' },
    { role: 'agent_message_chunk', text: 'late incomplete fragment', messageId: 'oversized' },
    { role: 'user_message_chunk', text: 'anonymous question' },
    { role: 'agent_message_chunk', text },
    { role: 'agent_message_chunk', text: 'delayed tagged fragment', messageId: 'oversized' },
    { role: 'agent_message_chunk', text: 'late anonymous fragment' },
    { role: 'user_message_chunk', text: 'following question' },
    { role: 'agent_message_chunk', text: 'following complete answer' },
  ]);
  const reopened = await f.run(resumeArgs(row.id));
  assert.equal(reopened.status, 0, reopened.stderr);
  const live = f.own(await lookupBridge(row.id));
  assert.deepEqual(await historyManaged(live, 20), [
    { role: 'user', text: 'earlier question' }, { role: 'user', text: 'anonymous question' },
    { role: 'user', text: 'following question' }, { role: 'assistant', text: 'following complete answer' },
  ]);
  await assert.rejects(historyManaged(live, Infinity), /exceeds the retained window/);
  const view = await f.run(['view', live.id], undefined, undefined, 'following complete answer');
  assert.match(view.stdout, /following complete answer/);
  assert.doesNotMatch(view.stdout + view.stderr, /fragment|exceeds the retained window/);
});

test('concurrent AGY resume shares one owned load, restores exact history and fences old requests', async t => {
  const f = await fixture(t);
  const row = await f.start();
  const texts = ['repeat me', 'repeat me', 'fixture:terminal-only', 'fixture:terminal-only'];
  for (const text of texts) {
    await send(row, text);
    assert.equal((await waitIdle(row, 1000)).status, 'completed');
  }
  const expected = await historyManaged(row, 20);
  assert.deepEqual(expected.filter(message => message.role === 'user').map(message => message.text), texts);
  assert.equal(expected.length, 6);
  const sessionId = prompts(await f.trace())[0].sessionId;
  await close(row);
  const saved = descriptorPath(f, row);
  const [file, dir] = await Promise.all([lstat(saved), lstat(dirname(saved))]);
  assert.equal(file.uid, process.getuid());
  assert.equal(file.mode & 0o777, 0o600);
  assert.equal(dir.mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(await readFile(saved, 'utf8')), { version: 1, handle: row.id, sessionId, cwd: f.cwd });
  assert.deepEqual(await listManaged(), []);
  const offset = (await f.trace()).length;
  for (const args of [['history', row.id, '--json'], ['send', row.id, 'no implicit load', '--json']]) {
    const result = await f.run(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /resume/i);
  }
  assert.equal((await f.trace()).length, offset);

  const overrides = { AGY_FIXTURE_START: 'gated-load' };
  const first = observe(f.run(resumeArgs(row.id), undefined, overrides));
  await until(async () => methods((await f.trace()).slice(offset)).includes('session/load'));
  const second = observe(f.run(resumeArgs(row.id), undefined, overrides));
  await expectPending(second);
  await f.release('load');
  for (const result of await Promise.all([first, second])) {
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(json(result), { id: row.id, provider: 'agy' });
  }
  const loaded = (await f.trace()).slice(offset);
  assert.equal(loaded.filter(m => m.argv).length, 1);
  assert.deepEqual(methods(loaded), ['initialize', 'session/load']);
  assert.deepEqual(loaded.find(m => m.method === 'session/load').params, { sessionId, cwd: f.cwd, mcpServers: [] });
  assert.deepEqual((await listManaged()).map(m => m.id), [row.id]);
  const reopened = f.own(await lookupBridge(row.id));
  assert.deepEqual(await historyManaged(reopened, 20), expected);
  assert.deepEqual(await waitIdle(reopened, 0), { status: 'completed' });
  await assert.rejects(send(row, 'from previous owner'));
  await assert.rejects(close(row));
  assert.ok(await lookupBridge(row.id));
  assert.deepEqual((await f.trace()).slice(offset), loaded);

  const sending = observe(send(reopened, 'fixture:gate'));
  await until(async () => prompts(await f.trace()).length === texts.length + 1);
  const live = await f.run(resumeArgs(row.id));
  assert.equal(live.status, 0, live.stderr);
  assert.deepEqual(json(live), { id: row.id, provider: 'agy' });
  assert.equal((await waitIdle(reopened, 0)).status, 'timeout');
  assert.deepEqual(methods((await f.trace()).slice(offset)), ['initialize', 'session/load', 'session/prompt']);
  await f.release('progress');
  await f.release('finish');
  await sending;
  assert.equal((await waitIdle(reopened, 1000)).status, 'completed');
});

test('a contending AGY resume reports the failed startup without claiming a live owner', { timeout: 12000 }, async t => {
  const f = await fixture(t);
  const row = await f.start();
  await close(row);
  const offset = (await f.trace()).length;
  const first = observe(f.run(resumeArgs(row.id), undefined, { AGY_FIXTURE_START: 'gated-deny-load' }));
  await until(async () => methods((await f.trace()).slice(offset)).includes('session/load'));
  const contention = join(f.home, 'contender-saw-lock');
  // 观察真实的启动 IPC；只有第二个桥接确实撞上锁后才让原持锁者失败。
  const observeContention = `import { writeFileSync } from 'node:fs';
    const send = process.send;
    if (send) process.send = function (message, ...args) {
      if (message?.error === 'Antigravity CLI managed session is starting or closing') writeFileSync(${JSON.stringify(contention)}, '');
      return send.call(this, message, ...args);
    };`;
  const second = observe(f.run(resumeArgs(row.id), undefined, {
    NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(observeContention)}`,
  }));
  try {
    await until(() => lstat(contention).catch(error => { if (error.code !== 'ENOENT') throw error; }));
  } finally { await f.release('load'); }
  const [failed, contending] = await Promise.all([first, second]);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /could not load/);
  assert.equal(contending.status, 1);
  assert.equal(contending.stdout, '');
  assert.match(contending.stderr, /did not become ready; retry resume/);
  assert.doesNotMatch(contending.stderr, /already has an owner/);
  const trace = (await f.trace()).slice(offset);
  assert.equal(trace.filter(m => m.argv).length, 1);
  assert.deepEqual(methods(trace), ['initialize', 'session/load']);
  assert.equal(await lookupBridge(row.id), null);
  const later = await f.run(resumeArgs(row.id));
  assert.equal(later.status, 0, later.stderr);
  f.own(await lookupBridge(row.id));
});

test('AGY resume rejects unowned descriptors and fails closed on unsupported or refused load', async t => {
  const f = await fixture(t);
  const row = await f.start();
  await close(row);
  const saved = descriptorPath(f, row);
  const descriptor = await readFile(saved, 'utf8');
  const traceBefore = await f.trace();
  const externalId = JSON.parse(descriptor).sessionId;
  for (const id of [`agy:${externalId}`, `agy:${randomUUID()}`, 'agy:native-example', 'agy:pid-1']) {
    const rejected = await f.run(resumeArgs(id));
    assert.equal(rejected.status, 1);
    assert.equal(rejected.stdout, '');
  }
  await chmod(saved, 0o644);
  assert.equal((await f.run(resumeArgs(row.id))).status, 1);
  await chmod(saved, 0o600);
  const linkTarget = join(f.home, 'descriptor-copy');
  await writeFile(linkTarget, descriptor, { mode: 0o600 });
  await unlink(saved);
  await symlink(linkTarget, saved);
  assert.equal((await f.run(resumeArgs(row.id))).status, 1);
  await unlink(saved);
  await writeFile(saved, JSON.stringify({ ...JSON.parse(descriptor), handle: `agy:${randomUUID()}` }), { mode: 0o600 });
  assert.equal((await f.run(resumeArgs(row.id))).status, 1);
  assert.deepEqual(await f.trace(), traceBefore);
  await writeFile(saved, descriptor);

  for (const [mode, loadCount] of [['resume-only', 0], ['deny-load', 1], ['mismatch-load', 1]]) {
    const before = (await f.trace()).length;
    const rejected = await f.run(resumeArgs(row.id), undefined, { AGY_FIXTURE_START: mode });
    assert.equal(rejected.status, 1, mode);
    assert.equal(rejected.stdout, '');
    assert.doesNotMatch(rejected.stderr, marker);
    const trace = (await f.trace()).slice(before);
    assert.equal(trace.filter(m => m.argv).length, 1);
    const requested = methods(trace);
    assert.equal(requested.filter(method => method === 'session/load').length, loadCount);
    assert.ok(requested.every(method => ['initialize', 'session/load', 'session/close'].includes(method)));
    assert.equal(await lookupBridge(row.id), null);
    assert.equal(await readFile(saved, 'utf8'), descriptor);
  }
  const retry = await f.run(resumeArgs(row.id));
  assert.equal(retry.status, 0, retry.stderr);
  assert.deepEqual(json(retry), { id: row.id, provider: 'agy' });
  assert.deepEqual(await historyManaged(f.own(await lookupBridge(row.id)), 20), []);
});

test('AGY resume does not start a second ACP while a crashed owner still has a live child', async t => {
  const f = await fixture(t, 'linger-on-eof');
  const row = await f.start();
  const [{ pid, ppid }] = await f.trace();
  assert.equal(row.pid, pid);
  assert.ok(ppid > 1 && ppid !== process.pid);
  process.kill(ppid, 'SIGKILL');
  try {
    await until(async () => (await f.trace()).some(m => m.orphan === 'waiting'));
    assert.equal(alive(pid), true);
    const rejected = await f.run(resumeArgs(row.id));
    assert.equal(rejected.status, 1, rejected.stderr);
    assert.equal(rejected.stdout, '');
    assert.match(rejected.stderr, /owner|busy/i);
    assert.equal((await f.trace()).filter(m => m.argv).length, 1);
  } finally {
    await f.release('orphan-exit');
    await until(async () => (await f.trace()).some(m => m.orphan === 'released'));
    await unlink(row._socket).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
});
