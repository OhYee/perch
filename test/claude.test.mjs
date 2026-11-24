import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import net from 'node:net';
import { bridgeDir, history, list, lookupBridge, mergeNativeSessions, parseTranscript, privateBridgeDir, request, send, terminalSafeText, trackPending, waitIdle } from '../adapters/claude.mjs';

let environmentDir;
let originalEnvironment;
before(async () => {
  environmentDir = await mkdtemp(join(tmpdir(), 'agent-session-claude-env-'));
  originalEnvironment = Object.fromEntries(['HOME', 'PATH', 'CLAUDE_CONFIG_DIR'].map(key => [key, process.env[key]]));
  Object.assign(process.env, { HOME: environmentDir, PATH: environmentDir, CLAUDE_CONFIG_DIR: environmentDir });
});
after(async () => {
  if (originalEnvironment) {
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  if (environmentDir) await rm(environmentDir, { recursive: true, force: true });
});

async function socketFixture(handler) {
  await mkdir(bridgeDir, { recursive: true, mode: 0o700 });
  assert.equal(await privateBridgeDir(), true);
  const id = randomUUID();
  const path = join(bridgeDir, `${id}.sock`);
  const server = net.createServer(handler);
  await new Promise((resolve, reject) => server.once('error', reject).listen(path, resolve));
  return { id, close: async () => {
    await new Promise(resolve => server.close(resolve));
    await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  } };
}

test('history parser retains ordered text, excludes tool and sidechain records', () => {
  const id = randomUUID();
  const input = [
    { type: 'user', message: { role: 'user', content: 'hello' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'world' }, { type: 'tool_use', name: 'x' }] } },
    { type: 'user', isSidechain: true, message: { role: 'user', content: 'nested' } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'not a user prompt' }] } },
    { type: 'user', isMeta: true, message: { role: 'user', content: 'injected' } },
    { type: 'user', message: { role: 'user', content: '<system-reminder>injected</system-reminder>' } },
    { type: 'user', message: { role: 'user', content: '<div>hello</div>' } },
    { type: 'user', message: { role: 'user', content: 'What does <system-reminder> mean?' } },
    { type: 'user', message: { role: 'user', content: '<system-reminder> 是什么？' } },
  ].map(event => JSON.stringify({ sessionId: id, ...event })).join('\n') + '\nnull\n{partial\n' +
    JSON.stringify({ sessionId: randomUUID(), type: 'user', message: { role: 'user', content: 'other session' } });
  assert.deepEqual(parseTranscript(input, Infinity, id), [{ role: 'user', text: 'hello' }, { role: 'assistant', text: 'world' }, { role: 'user', text: '<div>hello</div>' }, { role: 'user', text: 'What does <system-reminder> mean?' }, { role: 'user', text: '<system-reminder> 是什么？' }]);
  assert.deepEqual(parseTranscript(input, 1, id), [{ role: 'user', text: '<system-reminder> 是什么？' }]);
});

test('closed requests release pending slots without requiring a replay', () => {
  const pending = new Map();
  for (let i = 0; i < 101; i++) {
    const socket = new EventEmitter();
    trackPending(pending, i, socket, 'prompt');
    assert.equal(pending.size, 1);
    socket.emit('close');
    assert.equal(pending.size, 0);
  }
});

test('terminal output strips escape and control characters but keeps layout', () => {
  assert.equal(terminalSafeText('ok\x1b[31mred\x07\r\x9b2J\n\tdone'), 'ok[31mred2J\n\tdone');
});

test('broken official registry is not mistaken for an absent installation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-registry-test-'));
  const executable = join(dir, 'claude');
  const run = async () => {
    const code = `import { list } from ${JSON.stringify(new URL('../adapters/claude.mjs', import.meta.url).href)}; try { await list(); console.log('ok'); } catch (e) { console.log(e.message); }`;
    return (await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, PATH: dir, CLAUDE_CONFIG_DIR: dir } })).stdout.trim();
  };
  try {
    await writeFile(executable, '#!/bin/sh\nprintf "{}"\n', { mode: 0o700 });
    assert.equal(await run(), 'Invalid Claude session registry response');
    await writeFile(executable, '#!/bin/sh\nexit 2\n');
    assert.equal(await run(), 'Claude session registry unavailable');
    await unlink(executable);
    assert.equal(await run(), 'ok');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('native registry names become session titles without falling back to previews', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-title-test-'));
  const named = randomUUID();
  const unnamed = randomUUID();
  const entries = [
    { sessionId: named, cwd: '/sample', name: 'Named session', preview: 'Not a title' },
    { sessionId: unnamed, cwd: '/sample', preview: 'Not a title' },
  ];
  try {
    await writeFile(join(dir, 'claude'), `#!/bin/sh\nprintf '%s' '${JSON.stringify(entries)}'\n`, { mode: 0o700 });
    const code = `import { list } from ${JSON.stringify(new URL('../adapters/claude.mjs', import.meta.url).href)}; const ids = ${JSON.stringify([named, unnamed])}; const sessions = await list(); console.log(JSON.stringify(ids.map(id => sessions.find(s => s.id === 'claude:' + id)?.title)));`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, PATH: dir, CLAUDE_CONFIG_DIR: dir } });
    assert.deepEqual(JSON.parse(stdout), ['Named session', null]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('native registry state is preserved only for unique sessions', async () => {
  const blocked = randomUUID();
  const missing = randomUUID();
  const future = randomUUID();
  const managed = randomUUID();
  const legacy = randomUUID();
  const duplicate = randomUUID();
  const sessions = [
    { id: `claude:${managed}`, status: 'running', _bridge: true },
    { id: `claude:${legacy}`, status: 'unknown', _bridge: true },
    { id: `claude:${duplicate}`, status: 'unknown', _bridge: true },
  ];
  const rows = await mergeNativeSessions(sessions, [
    { sessionId: blocked, cwd: '/sample', kind: 'background', state: 'blocked' },
    { sessionId: missing, cwd: '/sample' },
    { sessionId: future, cwd: '/sample', state: 'a-future-state' },
    { sessionId: managed, cwd: '/sample', state: 'blocked' },
    { sessionId: legacy, cwd: '/sample', state: 'blocked' },
    { sessionId: duplicate, cwd: '/sample', state: 'idle' },
    { sessionId: duplicate, cwd: '/sample', state: 'blocked' },
  ]);
  const state = id => rows.find(row => row.id === `claude:${id}`).status;
  assert.equal(state(blocked), 'blocked');
  assert.equal(state(missing), 'unknown');
  assert.equal(state(future), 'unknown');
  assert.equal(state(managed), 'running');
  assert.equal(state(legacy), 'blocked');
  assert.equal(state(duplicate), 'unknown');
  assert.equal(rows.length, 6);
});

test('bridge info reports current state without treating process liveness as activity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-session-state-bridge-'));
  const id = randomUUID();
  const socketPath = join(bridgeDir, `${id}.sock`);
  const script = join(dir, 'claude-bridge.mjs');
  let child;
  try {
    await mkdir(bridgeDir, { recursive: true, mode: 0o700 });
    assert.equal(await privateBridgeDir(), true);
    await writeFile(script, `
      import net from 'node:net';
      let meta = { running: true };
      const server = net.createServer(socket => socket.once('data', data => {
        const req = JSON.parse(data);
        if (req.op === 'set') { meta = req.meta; socket.end('{}\\n'); return; }
        socket.end(JSON.stringify({ id: ${JSON.stringify(id)}, pid: process.pid, bridgePid: process.pid,
          cwd: process.cwd(), managed: true, protocolVersion: 2, ...meta }) + '\\n');
      }));
      server.listen(${JSON.stringify(socketPath)}, () => console.log('ready'));
    `);
    child = spawn(process.execPath, [script, '--managed'], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => reject(new Error('state bridge fixture exited')));
      child.stdout.once('data', resolve);
    });
    for (const [meta, expected] of [
      [{ running: true }, 'unknown'],
      [{ running: true, status: 'new-state' }, 'unknown'],
      [{ running: true, status: 'idle' }, 'idle'],
      [{ running: true, status: 'running' }, 'running'],
      [{ running: false, status: 'running' }, 'stopped'],
    ]) {
      await request(id, { op: 'set', meta });
      assert.equal((await lookupBridge(`claude:${id}`)).status, expected);
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    await unlink(socketPath).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test('bridge deduplication keeps only uniquely matched native names', async () => {
  const named = randomUUID();
  const unnamed = randomUUID();
  const ambiguous = randomUUID();
  const bridgeOnly = randomUUID();
  const sessions = [named, unnamed, ambiguous, bridgeOnly].map(id => ({ id: `claude:${id}`, send: true, _bridge: true }));
  const result = await mergeNativeSessions(sessions, [
    { sessionId: named, cwd: '/sample', name: 'Bridge title' },
    { sessionId: unnamed, cwd: '/sample', preview: 'Not a title' },
    { sessionId: ambiguous, cwd: '/sample', name: 'First' },
    { sessionId: ambiguous, cwd: '/sample', name: 'Second' },
  ]);
  assert.equal(result.length, 4);
  assert.equal(result[0].title, 'Bridge title');
  assert.equal(result[0].send, true);
  assert.equal(result[1].title, null);
  assert.equal(result[2].title, undefined);
  assert.equal(result[3].title, undefined);
});

test('invalid session IDs and unsupported operations fail closed', async () => {
  assert.throws(() => request('../../other', { op: 'info' }), /Invalid/);
  await assert.rejects(send({ id: 'claude:x', send: false }, 'hello'), /does not support/);
  await assert.rejects(history({ id: 'claude:../../other', history: true }, 1), /Invalid/);
  await assert.rejects(history({ id: 'claude:x', history: true }, 0), /Invalid/);
});

test('bridge request sends one JSON message and receives acknowledgment', async () => {
  let got;
  const fixture = await socketFixture(socket => socket.once('data', data => {
    got = JSON.parse(String(data));
    socket.end('{"accepted":true}\n');
  }));
  try {
    assert.deepEqual(await request(fixture.id, { op: 'send', text: 'line 1\nline 2' }), { accepted: true });
    assert.deepEqual(got, { op: 'send', text: 'line 1\nline 2' });
  } finally { await fixture.close(); }
});

test('send transport failures distinguish unknown delivery from clear rejection', async () => {
  const closed = await socketFixture(socket => socket.once('data', () => socket.end()));
  try {
    await assert.rejects(request(closed.id, { op: 'send', text: 'x' }), error => error.deliveryUnknown === true);
  } finally { await closed.close(); }
  const busy = await socketFixture(socket => socket.once('data', () => socket.end('{"error":"Claude session is busy"}\n')));
  try {
    await assert.rejects(request(busy.id, { op: 'send', text: 'x' }), error => error.deliveryUnknown !== true);
  } finally { await busy.close(); }
  const failed = await socketFixture(socket => socket.once('data', () => socket.end('{"error":"Claude input failed; delivery status is unknown"}\n')));
  try {
    await assert.rejects(request(failed.id, { op: 'send', text: 'x' }), error => error.deliveryUnknown === true);
  } finally { await failed.close(); }
});

test('older managed bridges do not advertise session idle waits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-session-old-bridge-'));
  const id = randomUUID();
  const socketPath = join(bridgeDir, `${id}.sock`);
  const script = join(dir, 'claude-bridge.mjs');
  let child;
  try {
    await mkdir(bridgeDir, { recursive: true, mode: 0o700 });
    assert.equal(await privateBridgeDir(), true);
    await writeFile(script, `
      import net from 'node:net';
      const server = net.createServer(socket => socket.once('data', () => socket.end(JSON.stringify({
        id: ${JSON.stringify(id)}, pid: process.pid, bridgePid: process.pid,
        cwd: process.cwd(), managed: true, running: true
      }) + '\\n')));
      server.listen(${JSON.stringify(socketPath)}, () => console.log('ready'));
    `);
    child = spawn(process.execPath, [script, '--managed'], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => reject(new Error('old bridge fixture exited')));
      child.stdout.once('data', resolve);
    });
    const session = await lookupBridge(`claude:${id}`);
    assert.ok(session);
    assert.equal(session.send, true);
    assert.equal(session.wait, false);
    await assert.rejects(waitIdle(session, 0), /does not support waiting/);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    await unlink(socketPath).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test('a socket claiming a non-Claude process is not discovered as a bridge', async () => {
  let id;
  const fixture = await socketFixture(socket => socket.once('data', () => socket.end(JSON.stringify({ id, pid: process.pid, bridgePid: process.ppid, cwd: process.cwd() }) + '\n')));
  id = fixture.id;
  try {
    assert.equal(await lookupBridge(`claude:${id}`), null);
    assert.equal((await list()).some(session => session.id === `claude:${id}`), false);
  }
  finally { await fixture.close(); }
});
