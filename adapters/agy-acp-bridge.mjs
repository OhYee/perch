import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, rmdir, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { clientVersion } from '../portable-runtime.mjs';
import {
  MiB, admissionMs, descriptor, entry, failure, mode, object, opaqueId, ownerRecord, privateSocketDir,
  problems, protocolVersion, publishRecord, readFrames, requestBytes, sessionDirectory, socketPath,
  validLimit, validTimeout,
} from './agy-managed.mjs';

const [operation, id, model] = process.argv.slice(2);
const loading = operation === 'load';
const generation = randomUUID();
const startupDeadline = performance.now() + 23000;
const maxAcpBytes = 8 * MiB;
const maxHistoryBytes = 4 * MiB;
const maxHistoryMessages = 1024;
const socket = socketPath(id);
const connections = new Set();
const waiters = new Set();
const requests = new Map();
const history = [];
const completed = { status: 'completed' };
const stops = {
  end_turn: completed,
  cancelled: { status: 'interrupted' },
  refusal: { status: 'failed', error: problems.refusal },
  max_tokens: { status: 'failed', error: problems.truncated },
  max_turn_requests: { status: 'failed', error: problems.truncated },
};
const admissionErrors = new Set([-32700, -32600, -32601, -32602, -32000, -32002]);
let child, exited, server, bound, directory, lock, ownMarker, ownDescriptor, madeDirectory;
let providerId, title = null, supportsClose = false, row, replay, active, last = completed;
let nextId = 0, historyBytes = 0, omitted = false, closing = false, fault, shutdownTask;

function failed(reason) { return { status: 'failed', error: problems[reason] }; }
function usable() {
  return !fault && child?.pid && child.exitCode === null && child.signalCode === null && child.stdin.writable;
}
function writeAcp(message) {
  if (!usable() || child.stdin.writableLength > maxAcpBytes) return false;
  try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'); return true; }
  catch { return false; }
}

function rpc(method, params, timeoutMs = startupDeadline - performance.now()) {
  if (timeoutMs <= 0) return Promise.reject(failure('startupTimeout'));
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const finish = (error, value) => {
      requests.delete(id);
      clearTimeout(timer);
      if (method === 'session/load') replay.open = false;
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(failure('startupTimeout')), timeoutMs);
    requests.set(id, { method, finish });
    if (!writeAcp({ id, method, params })) finish(failure(fault ?? 'stopped'));
  });
}

function notifyWaiters(result) {
  for (const done of waiters) done(result);
}
// 固定大小的过滤器防止已丢弃的 ID 以迟到的尾块重新出现。碰撞只会多省略条目，不会留下残片。
function discardedId(state, key, add = false) {
  if (!state.discarded) {
    if (!add) return false;
    state.discarded = new Uint8Array(MiB);
  }
  const bits = state.discarded;
  const hash = createHash('sha256').update(generation).update(key).digest();
  for (let i = 0; i < 16; i += 4) {
    const bit = hash.readUInt32LE(i) & (bits.length * 8 - 1);
    const mask = 1 << (bit & 7);
    if (add) bits[bit >>> 3] |= mask;
    else if (!(bits[bit >>> 3] & mask)) return false;
  }
  return true;
}

function forgetMessage(state, message) {
  if (state.messageIds.get(message.key) === message) {
    state.messageIds.delete(message.key);
    discardedId(state, message.key, true);
  }
  if (state.segment === message) state.segment = { role: message.role, discarded: true };
  omitted = true;
}

const emptyMessage = (role, key = null) => ({ role, key, text: '', bytes: 0 });

function retainMessage(state, message, text) {
  const bytes = Buffer.byteLength(text);
  if (message.bytes + bytes > maxHistoryBytes) return false;
  let drop = 0, freed = 0;
  const newMessage = message.bytes === 0;
  while (historyBytes + bytes - freed > maxHistoryBytes || history.length + Number(newMessage) - drop > maxHistoryMessages) {
    // 迟到分片不能为了保住旧条目而挤掉更新的条目。
    const oldest = history[drop++];
    if (oldest === message) return false;
    freed += oldest.bytes;
  }
  if (drop) {
    for (let i = 0; i < drop; i++) forgetMessage(state, history[i]);
    history.splice(0, drop);
    historyBytes -= freed;
  }
  if (newMessage) history.push(message);
  message.text += text;
  message.bytes += bytes;
  historyBytes += bytes;
  return true;
}
function acceptTurn(turn) {
  if (turn.accepted) return;
  turn.accepted = true;
  retainMessage(turn, emptyMessage('user'), turn.text);
  turn.text = undefined;
  turn.admission?.(null, { accepted: true });
}
function releaseRequests(turn) {
  for (const [id, permission] of turn.permissions) {
    writeAcp({ id, result: permission ? { outcome: { outcome: 'cancelled' } } : { action: 'cancel' } });
  }
  turn.permissions.clear();
}
function finishTurn(turn, result, error) {
  active = null;
  last = result;
  turn.admission?.(error);
  releaseRequests(turn);
  notifyWaiters(result);
}

function stopTransport(reason) {
  if (fault) return;
  fault = reason;
  for (const pending of requests.values()) pending.finish(failure(reason));
  if (row && !closing) void shutdown(false, reason).catch(() => { process.exitCode = 1; });
}
function startChild(cwd) {
  child = spawn('agy', ['acp', '--dangerously-skip-permissions'], { cwd, stdio: ['pipe', 'pipe', 'ignore'] });
  exited = new Promise(resolve => {
    child.once('error', () => { stopTransport('launch'); if (!child.pid) resolve(); });
    child.once('exit', () => {
      resolve();
      // stdout 可能仍有已写完的终态；留出排空机会，但不等待继承 fd 的后代。
      setTimeout(() => stopTransport('stopped'), 100).unref();
    });
  });
  child.stdin.on('error', () => stopTransport(child.pid ? 'stopped' : 'launch'));
  child.stdout.on('error', () => stopTransport('stopped'));
  readFrames(child.stdout, maxAcpBytes, message => {
    if (fault) return false;
    nativeFrame(message);
  }, () => stopTransport('protocol'));
  child.stdout.once('end', () => stopTransport(child.pid ? 'stopped' : 'launch'));
  if (!child.pid) throw failure('launch');
}

function setTitle(value) {
  if (value === null || typeof value === 'string' && Buffer.byteLength(value) <= 4096) title = value;
}
function keepChunk(state, role, { messageId }, text) {
  if (messageId != null && !opaqueId(messageId)) return stopTransport('protocol');
  let message;
  if (messageId == null) {
    if (state.segment?.role !== role) state.segment = null;
    if (!text || state.segment?.discarded) return;
    message = state.segment ??= emptyMessage(role);
  } else {
    const key = `${role}:${messageId}`;
    message = state.messageIds.get(key);
    if (!message) {
      if (discardedId(state, key)) return;
      // 已知 ID 的迟到分片不能结束当前匿名角色段。
      state.segment = null;
      if (!text) return;
      message = emptyMessage(role, key);
      state.messageIds.set(key, message);
    } else if (!text) return;
  }
  if (retainMessage(state, message, text)) return;
  // 整条去掉，且后续同 ID 或同一匿名角色段不重新入列为一条「完整」消息。
  if (message.bytes) {
    history.splice(history.indexOf(message), 1);
    historyBytes -= message.bytes;
  }
  forgetMessage(state, message);
  state.truncated = true;
}

function sessionUpdate(params) {
  if (!providerId || params?.sessionId !== providerId || !object(params.update)) return;
  const update = params.update;
  const type = update.sessionUpdate;
  if (type === 'session_info_update') { setTitle(update.title); return; }
  const content = update.content;
  const visible = content?.type === 'text' && typeof content.text === 'string';
  if (replay?.open) {
    if (visible && (type === 'user_message_chunk' || type === 'agent_message_chunk')) {
      keepChunk(replay, type === 'user_message_chunk' ? 'user' : 'assistant', update, content.text);
    }
    return;
  }
  const turn = active;
  if (!turn || params.requestId != null && params.requestId !== turn.id) return;
  if (type === 'agent_message_chunk' || type === 'agent_thought_chunk') {
    if (!(visible || object(content) && ['image', 'audio', 'resource', 'resource_link'].includes(content.type))) return;
    acceptTurn(turn);
    if (type === 'agent_message_chunk' && visible) keepChunk(turn, 'assistant', update, content.text);
  } else if ((type === 'tool_call' || type === 'tool_call_update') && opaqueId(update.toolCallId)) acceptTurn(turn);
}

function clientRequest(id, method, params) {
  const permission = method === 'session/request_permission';
  const input = method === 'elicitation/create';
  const sameSession = providerId && params?.sessionId === providerId;
  const turn = active;
  const scopedInput = input && typeof params?.message === 'string' && ['form', 'url'].includes(params.mode) &&
    (sameSession || params.sessionId == null && params.requestId === turn?.id);
  const scopedPermission = permission && sameSession && opaqueId(params.toolCall?.toolCallId) && Array.isArray(params.options);
  if (turn && (params?.requestId == null || params.requestId === turn.id) && (scopedPermission || scopedInput)) {
    if (turn.permissions.has(id)) return;
    if (turn.permissions.size >= 64) return stopTransport('protocol');
    turn.permissions.set(id, permission);
    acceptTurn(turn);
    notifyWaiters({ status: 'needs_input' });
  } else if (closing && sameSession && (permission || input)) {
    writeAcp({ id, result: permission ? { outcome: { outcome: 'cancelled' } } : { action: 'cancel' } });
  } else if (!writeAcp({ id, error: { code: -32601, message: 'Method not supported' } })) stopTransport('protocol');
}

function nativeFrame(message) {
  if (!object(message) || message.jsonrpc !== '2.0') return stopTransport('protocol');
  const { id, method, params, error, result } = message;
  const hasId = Object.hasOwn(message, 'id');
  if (hasId && !(id === null || Number.isSafeInteger(id) || opaqueId(id))) return stopTransport('protocol');
  if (Object.hasOwn(message, 'method')) {
    if (typeof method !== 'string' || !method || Object.hasOwn(message, 'error') || Object.hasOwn(message, 'result')) return stopTransport('protocol');
    if (hasId) clientRequest(id, method, params);
    else if (method === 'session/update') sessionUpdate(params);
    return;
  }
  if (!hasId) return stopTransport('protocol');
  const turn = active?.id === id ? active : null;
  const pending = requests.get(id);
  if (!turn && !pending) return;
  const hasError = Object.hasOwn(message, 'error');
  if (hasError === Object.hasOwn(message, 'result') ||
      (hasError ? !Number.isInteger(error?.code) || typeof error?.message !== 'string' : !object(result))) return stopTransport('protocol');
  if (pending) {
    if (!hasError && pending.method === 'session/new') {
      if (!opaqueId(result.sessionId)) return stopTransport('protocol');
      providerId = result.sessionId;
      setTitle(result.title);
    }
    const reason = error?.code === -32000 ? 'auth' : pending.method === 'session/load' ? 'load' :
      pending.method === 'session/set_config_option' ? 'modelMismatch' : 'startup';
    pending.finish(hasError ? failure(reason) : null, result);
    return;
  }
  if (hasError) {
    if (!turn.accepted && admissionErrors.has(error.code)) {
      finishTurn(turn, last, failure(error.code === -32000 ? 'auth' : 'rejected'));
    } else {
      finishTurn(turn, error.code === -32800 ? stops.cancelled : failed('prompt'), failure('unknown', true));
    }
    return;
  }
  if (typeof result.stopReason !== 'string' || !Object.hasOwn(stops, result.stopReason) ||
      result.sessionId != null && result.sessionId !== providerId) return stopTransport('protocol');
  acceptTurn(turn);
  finishTurn(turn, turn.truncated && result.stopReason !== 'cancelled' ? failed('truncated') : stops[result.stopReason]);
}

function sendPrompt(params, connection, reply) {
  const text = params?.text;
  if (typeof text !== 'string' || !text.trim()) return reply(failure('empty'));
  if (Buffer.byteLength(text) > MiB) return reply(failure('size'));
  if (active) return reply(failure('busy'));
  if (!usable()) return reply(failure('absent'));
  // 先占用唯一轮次，再写 ACP；只有可归属的事件或有效的最终回复才确认。
  const turn = { id: ++nextId, text, permissions: new Map(), messageIds: new Map() };
  active = turn;
  const timer = setTimeout(() => turn.admission?.(failure('unknown', true)), admissionMs);
  function abandoned() { clearTimeout(timer); turn.admission = null; }
  connection.once('close', abandoned);
  turn.admission = (error, result) => {
    abandoned();
    connection.off('close', abandoned);
    reply(error, result);
  };
  if (!writeAcp({ id: turn.id, method: 'session/prompt', params: { sessionId: providerId, prompt: [{ type: 'text', text }] } })) {
    finishTurn(turn, last, failure('absent'));
  }
}

function wait(params, connection, reply) {
  const timeout = params?.timeoutMs;
  if (!validTimeout(timeout)) return reply(failure('timeout'));
  if (!active) return reply(null, last);
  if (active.permissions.size) return reply(null, { status: 'needs_input' });
  if (timeout === 0) return reply(null, { status: 'timeout' });
  const timer = timeout === null ? null : setTimeout(() => done({ status: 'timeout' }), timeout);
  function abandon() { waiters.delete(done); clearTimeout(timer); }
  function done(result) { abandon(); connection.off('close', abandon); reply(null, result); }
  connection.once('close', abandon);
  waiters.add(done);
}

function accept(connection) {
  connection.on('error', () => {});
  if (connections.size >= 128) return connection.destroy();
  connections.add(connection);
  let timer = setTimeout(() => connection.destroy(), 10000);
  let greeted = false;
  connection.once('close', () => { clearTimeout(timer); connections.delete(connection); });
  function reply(error, result) {
    if (connection.destroyed) return;
    clearTimeout(timer);
    timer = setTimeout(() => connection.destroy(), 3000);
    connection.end(JSON.stringify(error ? { error: error.reason, deliveryUnknown: error.deliveryUnknown === true } : { result }) + '\n');
  }
  readFrames(connection, requestBytes, message => {
    if (message?.id !== id || message.version !== protocolVersion) { reply(failure('identity')); return false; }
    if (closing || !row || fault) { reply(failure('starting')); return false; }
    if (!greeted) {
      if (message.method !== 'info') { reply(failure('identity')); return false; }
      greeted = true;
      const status = active ? active.permissions.size ? 'blocked' : 'running' :
        last.status === 'failed' ? 'failed' : last.status === 'interrupted' ? 'stopped' : 'idle';
      connection.write(JSON.stringify({ result: { ...row, title, status } }) + '\n');
      return;
    }
    if (message.generation !== generation) { reply(failure('generation')); return false; }
    clearTimeout(timer);
    const { method, params } = message;
    if (method === 'send') sendPrompt(params, connection, reply);
    else if (method === 'wait') wait(params, connection, reply);
    else if (method === 'history') {
      const limit = params?.limit;
      if (!validLimit(limit)) reply(failure('limit'));
      else if (omitted && limit === null) reply(failure('history'));
      else reply(null, (limit === null ? history : history.slice(-limit)).map(({ role, text }) => ({ role, text })));
    } else if (method === 'close') {
      void shutdown(true, undefined, connection).then(() => reply(null, { closed: true }), () => reply(failure('shutdown')));
    } else reply(failure('identity'));
    return false;
  }, () => connection.destroy());
}

async function waitExit(ms) {
  let timer;
  try { return await Promise.race([exited.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); })]); }
  finally { clearTimeout(timer); }
}
async function stopChild(graceful) {
  if (!child) return;
  try {
    child.stdin.end();
    if (!child.pid || graceful && await waitExit(250)) return;
    child.kill('SIGTERM');
    if (!await waitExit(750)) {
      child.kill('SIGKILL');
      if (!await waitExit(1000)) throw failure('shutdown');
    }
  } finally { child.stdin.destroy(); child.stdout.destroy(); child.unref(); }
}
function shutdown(graceful = false, reason, requester) {
  if (shutdownTask) return shutdownTask;
  closing = true;
  shutdownTask = (async () => {
    if (server?.listening) server.close();
    if (active) {
      if (graceful) writeAcp({ method: 'session/cancel', params: { sessionId: providerId } });
      const result = reason === 'protocol' ? failed(reason) : { status: 'interrupted', ...(reason ? { error: problems[reason] } : {}) };
      finishTurn(active, result, failure('unknown', true));
    }
    // 已回信的 send/wait socket 有短排空时限；不让闲置的连接阻挡清理。
    for (const connection of connections) if (connection !== requester && !connection.writableEnded) connection.destroy();
    let childStopped = false;
    try {
      if (graceful && providerId && supportsClose && usable()) await rpc('session/close', { sessionId: providerId }, 750).catch(() => {});
      await stopChild(graceful);
      childStopped = true;
    } finally {
      try {
        const info = bound && await entry(socket);
        if (info && info.dev === bound.dev && info.ino === bound.ino) await unlink(socket);
        if (childStopped && ownMarker) await unlink(join(directory, 'owner.json'));
        if (!row && ownDescriptor) await unlink(join(directory, 'session.json'));
      } finally {
        lock?.close();
        if (!row && madeDirectory && childStopped) {
          await unlink(join(directory, 'owner.sqlite')).catch(error => { if (error.code !== 'ENOENT') throw error; });
          await rmdir(directory);
        }
      }
    }
  })();
  return shutdownTask;
}

function groupAlive(group) {
  try { process.kill(-group, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}
async function takeOwnership() {
  if (!groupAlive(process.pid)) throw failure('startup');
  directory = await sessionDirectory(id, !loading);
  if (!directory) throw failure('notSaved');
  madeDirectory = !loading;
  await privateSocketDir(true);
  const lockPath = join(directory, 'owner.sqlite');
  const info = await entry(lockPath);
  if (info && (!info.isFile() || !mode(info, 0o600))) throw failure('identity');
  const { DatabaseSync } = await import('node:sqlite');
  lock = new DatabaseSync(lockPath);
  try { lock.exec('BEGIN IMMEDIATE'); }
  catch (error) {
    const busy = error.errcode === 5 || error.errno === 5 || error.code === 'SQLITE_BUSY' || error.code?.startsWith('SQLITE_BUSY_');
    throw failure(busy ? 'starting' : 'identity');
  }
  const prior = await ownerRecord(id, directory);
  if (prior && groupAlive(prior.group)) throw failure('owner');
  const existingSocket = await entry(socket);
  if (existingSocket) {
    if (!prior || !existingSocket.isSocket() || !mode(existingSocket, 0o600)) throw failure('identity');
    await unlink(socket);
  }
  if (prior) await unlink(join(directory, 'owner.json'));
  // 崩溃时 SQLite 会释放锁；预先登记进程组，避免上一代 agy 尚活时重开。
  await publishRecord(join(directory, 'owner.json'), { version: protocolVersion, handle: id, generation, group: process.pid });
  ownMarker = true;
  server = createServer(accept);
  // bind 时即为 0600，避免另一个 CLI 在 chmod 前看到权限不一致。
  const umask = process.umask(0o177);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, () => { server.off('error', reject); resolve(); });
    });
  } finally { process.umask(umask); }
  server.on('error', () => stopTransport('protocol'));
  bound = await entry(socket);
  if (!bound?.isSocket()) throw failure('identity');
  await chmod(socket, 0o600);
}

function modelOption(configOptions) {
  const options = Array.isArray(configOptions) ? configOptions.filter(option => option?.category === 'model') : [];
  return options.length === 1 && options[0].type === 'select' && opaqueId(options[0].id) ? options[0] : null;
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (row) void shutdown(true).catch(() => { process.exitCode = 1; });
  else stopTransport('stopped');
});
process.once('disconnect', () => { if (!row) stopTransport('stopped'); });
process.umask(0o077);
try {
  if (!process.connected || !['new', 'load'].includes(operation)) throw failure('startup');
  await takeOwnership();
  if (fault) throw failure(fault);
  const cwd = process.cwd();
  const saved = loading ? await descriptor(id, directory) : null;
  if (loading && (!saved || saved.cwd !== cwd)) throw failure('invalidSaved');
  if (fault) throw failure(fault);
  startChild(cwd);
  const welcome = await rpc('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'perch', version: clientVersion } });
  if (welcome.protocolVersion !== 1) throw failure('version');
  const caps = welcome.agentCapabilities;
  supportsClose = object(caps?.sessionCapabilities?.close);
  if (loading) {
    if (caps?.loadSession !== true) throw failure('noLoad');
    providerId = saved.sessionId;
    replay = { open: true, messageIds: new Map() };
    const result = await rpc('session/load', { sessionId: providerId, cwd, mcpServers: [] });
    replay = null;
    if (Object.hasOwn(result, 'sessionId') && result.sessionId !== providerId) throw failure('protocol');
  } else {
    const started = await rpc('session/new', { cwd, mcpServers: [] });
    if (model !== undefined) {
      const option = modelOption(started.configOptions);
      const choices = Array.isArray(option?.options) ? option.options.flatMap(choice => Array.isArray(choice?.options) ? choice.options : [choice]) : [];
      if (choices.filter(choice => choice?.value === model).length !== 1) throw failure('model');
      const configured = await rpc('session/set_config_option', { sessionId: providerId, configId: option.id, value: model });
      const returned = modelOption(configured.configOptions);
      if (returned?.id !== option.id || returned.currentValue !== model) throw failure('modelMismatch');
    }
    if (!usable()) throw failure(fault ?? 'stopped');
    await publishRecord(join(directory, 'session.json'), { version: 1, handle: id, sessionId: providerId, cwd });
    ownDescriptor = true;
  }
  if (!usable() || !process.connected || !server.listening) throw failure(fault ?? 'stopped');
  row = { id, provider: 'agy', pid: child.pid, cwd, title, status: 'idle', send: true, history: true, wait: true, close: true,
    historyMode: 'live', _agy: 'managed', _socket: socket, _protocolVersion: protocolVersion, _generation: generation };
  process.send({ ready: true, session: row }, error => { if (error) stopTransport('stopped'); });
} catch (error) {
  await shutdown().catch(() => {});
  if (process.connected) process.send({ ready: false, error: problems[error.reason] ?? problems.startup });
  process.exitCode = 1;
}
