import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

const uid = process.getuid();
const socketDir = `/tmp/agent-session-${uid}`;
const stateHome = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
const stateDir = join(stateHome, 'agent-session');
// Constructed by the OMP adapter; never accept launch arguments over the session socket.
const startupArgs = process.argv.slice(2);
const resuming = startupArgs[0] === '--resume';
const savedPath = resuming ? startupArgs[1] : undefined;
const savedId = resuming ? startupArgs.pop() : undefined;
let child, server, socketPath, identity, sessionId, sessionFile;
let ready = false, stopped = false, invalid = false, active = null, latest = null;
let chunked = null;
const pending = new Map();
const decoder = new TextDecoder('utf-8', { fatal: true });

function failStartup(message) {
  if (!ready && process.connected) process.send({ ready: false, error: message });
  stopped = true;
  child?.kill('SIGKILL');
  server?.close();
  if (socketPath) void unlink(socketPath).catch(() => {});
  process.exitCode = 1;
}

function endTurn(turn, result) {
  if (turn.done) return;
  turn.done = true;
  turn.result = result;
  if (active === turn) active = null;
}

function needsInput(turn) {
  if (!turn || turn.done) return;
  turn.result = { turnId: turn.id, status: 'needs_input' };
}

function rpc(type, fields = {}, id = randomUUID()) {
  if (stopped || !child?.stdin.writable) return Promise.reject(new Error('OMP RPC process unavailable'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      const error = new Error(type === 'prompt' ? 'OMP prompt admission timed out; delivery status is unknown' : 'OMP RPC request timed out');
      if (type === 'prompt') error.deliveryUnknown = true;
      reject(error);
    }, type === 'prompt' ? 110000 : 15000);
    pending.set(id, { type, resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, type, ...fields }) + '\n', error => {
      if (!error) return;
      const entry = pending.get(id);
      if (entry) {
        clearTimeout(entry.timer); pending.delete(id);
        const failure = new Error('OMP RPC transport failed; delivery status may be unknown');
        if (type === 'prompt') failure.deliveryUnknown = true;
        entry.reject(failure);
      }
    });
  });
}

async function checkedState() {
  if (invalid) throw new Error('OMP session identity changed');
  const state = (await rpc('get_state')).data;
  if (!state || state.sessionId !== sessionId || state.sessionFile !== sessionFile) {
    invalid = true;
    if (active) endTurn(active, { turnId: active.id, status: 'failed', error: 'OMP session identity changed' });
    throw new Error('OMP session identity changed');
  }
  return state;
}

async function finishCompleted(turn) {
  if (turn.finalizing || turn.done) return;
  turn.finalizing = true;
  try {
    await checkedState();
    endTurn(turn, { turnId: turn.id, status: 'completed' });
  } catch (error) {
    endTurn(turn, { turnId: turn.id, status: 'failed', error: error.message });
  }
}

function acceptFrame(frame) {
  if (!frame || typeof frame !== 'object') throw new Error('Invalid OMP RPC frame');
  if (frame.type === 'rpc_chunk') {
    if (typeof frame.chunkId !== 'string' || !Number.isSafeInteger(frame.index) || !Number.isSafeInteger(frame.count) || frame.count < 1 || frame.count > 65536 || !Number.isSafeInteger(frame.byteLength) || frame.byteLength < 1 || frame.byteLength > 64 * 1024 * 1024 || typeof frame.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data)) throw new Error('Invalid OMP RPC chunk');
    if (!chunked) {
      if (frame.index !== 0) throw new Error('Invalid OMP RPC chunk order');
      chunked = { id: frame.chunkId, count: frame.count, length: frame.byteLength, parts: [], size: 0 };
    }
    if (frame.chunkId !== chunked.id || frame.count !== chunked.count || frame.byteLength !== chunked.length || frame.index !== chunked.parts.length) throw new Error('Invalid OMP RPC chunk sequence');
    const part = Buffer.from(frame.data, 'base64');
    chunked.size += part.length;
    if (chunked.size > chunked.length) throw new Error('Invalid OMP RPC chunk size');
    chunked.parts.push(part);
    if (chunked.parts.length === chunked.count) {
      if (chunked.size !== chunked.length) throw new Error('Invalid OMP RPC chunk size');
      const bytes = Buffer.concat(chunked.parts, chunked.size);
      chunked = null;
      acceptFrame(JSON.parse(decoder.decode(bytes)));
    }
    return;
  }
  if (chunked) throw new Error('Interrupted OMP RPC chunk sequence');
  if (frame.type === 'ready') {
    if (ready || !Array.isArray(frame.supportedProtocolVersions) || !frame.supportedProtocolVersions.includes(2)) throw new Error('OMP RPC does not support lossless protocol v2');
    void initialize();
    return;
  }
  if (frame.type === 'response') {
    const entry = pending.get(frame.id);
    const turn = active?.id === frame.id ? active : null;
    if (entry && entry.type === frame.command) {
      pending.delete(frame.id);
      clearTimeout(entry.timer);
      if (frame.success === true) {
        if (turn && entry.type === 'prompt') {
          turn.admitted = true;
          latest = turn;
          if (frame.data?.agentInvoked === false) void finishCompleted(turn);
        }
        entry.resolve(frame);
      } else entry.reject(new Error(typeof frame.error === 'string' ? frame.error.slice(0, 512) : 'OMP RPC request rejected'));
    } else if (turn && frame.command === 'prompt') {
      if (frame.success === true && !turn.admitted) {
        turn.admitted = true;
        latest = turn;
        if (frame.data?.agentInvoked === false) void finishCompleted(turn);
      } else if (frame.success === false) {
        if (turn.admitted) endTurn(turn, { turnId: turn.id, status: 'failed', error: typeof frame.error === 'string' ? frame.error.slice(0, 512) : 'OMP prompt failed' });
        else if (active === turn) active = null;
      }
    }
    return;
  }
  if (frame.type === 'rpc_frame_error') throw new Error('OMP RPC frame exceeded transport limits');
  if (frame.type === 'notice' && frame.source === 'session-persistence' && frame.level === 'error' && active) {
    endTurn(active, { turnId: active.id, status: 'failed', error: 'OMP session persistence failed' });
    return;
  }
  if (frame.type === 'extension_ui_request' && ['select', 'confirm', 'input', 'editor', 'ask', 'form'].includes(frame.method) && typeof frame.id === 'string') {
    if (!ready) {
      failStartup('OMP startup requires interactive input');
      return;
    }
    needsInput(active);
    // Cancellation is not approval; it also prevents OMP's dialog timeout from choosing defaults.
    child.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: frame.id, cancelled: true }) + '\n');
    return;
  }
  const turn = active;
  if (!turn || turn.done) return;
  if (frame.type === 'prompt_result' && frame.id === turn.id) {
    if (frame.status === 'aborted') endTurn(turn, { turnId: turn.id, status: 'interrupted' });
    else if (frame.status === 'error') endTurn(turn, { turnId: turn.id, status: 'failed', error: typeof frame.error?.message === 'string' ? frame.error.message.slice(0, 512) : 'OMP prompt failed' });
    else if (frame.status !== 'completed') endTurn(turn, { turnId: turn.id, status: 'failed', error: 'Invalid OMP prompt result' });
    else {
      turn.yielded = true;
      if (frame.sessionSettled === true) void finishCompleted(turn);
    }
  } else if (frame.type === 'session_settled' && turn.yielded) void finishCompleted(turn);
}

async function initialize() {
  try {
    await rpc('negotiate_protocol', { protocolVersion: 2 });
    const state = (await rpc('get_state')).data;
    const path = state?.sessionFile;
    if (!state || typeof state.sessionId !== 'string' || !state.sessionId || typeof path !== 'string' || !isAbsolute(path) || relative(sessionDir, path).startsWith('..') || state.isSettled !== true) throw new Error('OMP session identity changed');
    if (resuming ? (state.sessionId !== savedId || path !== savedPath) : state.messageCount !== 0) throw new Error('OMP session identity changed');
    sessionId = state.sessionId;
    sessionFile = path;
    identity = `omp:${child.pid}:${randomBytes(16).toString('hex')}`;
    socketPath = join(socketDir, `${child.pid}-${randomBytes(16).toString('hex')}.sock`);
    server = createServer(handleSocket);
    server.on('error', () => { if (!ready) failStartup('OMP local endpoint failed'); else { stopped = true; child.kill('SIGTERM'); } });
    server.on('close', () => { if (socketPath) void unlink(socketPath).catch(() => {}); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    await chmod(socketPath, 0o600);
    const session = row(state);
    ready = true;
    if (process.connected) process.send({ ready: true, session });
  } catch (error) { failStartup(error.message || 'OMP RPC startup failed'); }
}

function liveStatus(state) {
  if (active || state.isSettled === false) return 'running';
  return state.isSettled === true ? 'idle' : 'unknown';
}

function row(state) {
  return { id: `omp:${sessionId}`, _runtimeId: identity, provider: 'omp', pid: child.pid, cwd: process.cwd(), title: typeof state.sessionName === 'string' && state.sessionName ? state.sessionName : undefined, status: liveStatus(state), send: true, history: true, historyMode: 'live', wait: true, close: true, _path: socketPath, _sessionId: sessionId };
}

async function waitForIdle(timeoutMs, socket) {
  const deadline = timeoutMs === null ? Infinity : Date.now() + timeoutMs;
  while (true) {
    const state = await checkedState();
    if (socket.destroyed) return null;
    if (active?.result?.status === 'needs_input') return { status: 'needs_input' };
    if (!active && state.isSettled === true) {
      if (latest?.result && ['failed', 'interrupted'].includes(latest.result.status)) {
        return { status: latest.result.status, ...(latest.result.error ? { error: latest.result.error } : {}) };
      }
      return { status: 'completed' };
    }
    if (Date.now() >= deadline) return { status: 'timeout' };
    await delay(Math.min(50, deadline - Date.now()));
  }
}

async function handleRequest(req, socket) {
  if (!req || typeof req !== 'object' || typeof req.op !== 'string') throw new Error('Invalid request');
  if (req.op !== 'info' && req.id !== identity) throw new Error('OMP session identity changed');
  if (req.op === 'send') {
    if (typeof req.text !== 'string' || !req.text || Buffer.byteLength(req.text) > 512 * 1024) throw new Error('Invalid message');
    if (active) throw new Error('OMP session is busy');
    const turn = { id: randomUUID(), admitted: false, yielded: false, finalizing: false, done: false, result: null };
    active = turn;
    try {
      const state = await checkedState();
      if (state.isSettled !== true) throw new Error('OMP session is busy');
      await rpc('prompt', { message: req.text }, turn.id);
      return { turnId: turn.id };
    } catch (error) {
      if (!turn.admitted && !error.deliveryUnknown) {
        if (active === turn) active = null;
      }
      throw error;
    }
  }
  const state = await checkedState();
  if (req.op === 'info') return { id: identity, pid: child.pid, cwd: process.cwd(), sessionId, title: state.sessionName, status: liveStatus(state), managed: true };
  if (req.op === 'history') {
    if (req.limit !== null && (!Number.isSafeInteger(req.limit) || req.limit <= 0)) throw new Error('Invalid history limit');
    const result = await rpc('get_messages');
    if (!Array.isArray(result.data?.messages)) throw new Error('Invalid OMP history');
    const messages = [];
    for (const message of result.data.messages) {
      if (!['user', 'assistant'].includes(message?.role)) continue;
      const text = typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('') : '';
      if (text) messages.push({ role: message.role, text });
    }
    await checkedState();
    const selected = req.limit === null ? messages : messages.slice(-req.limit);
    if (Buffer.byteLength(JSON.stringify(selected)) > 16 * 1024 * 1024) throw new Error('OMP history exceeds response limit');
    return { messages: selected };
  }
  if (req.op === 'wait') {
    if (req.timeoutMs !== null && (!Number.isSafeInteger(req.timeoutMs) || req.timeoutMs < 0 || req.timeoutMs > 2147470000)) throw new Error('Invalid wait request');
    return waitForIdle(req.timeoutMs, socket);
  }
  if (req.op === 'close') {
    stopped = true;
    const exited = new Promise(resolve => child.once('exit', resolve));
    if (state.isSettled) child.stdin.end();
    else child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 1000);
    await exited;
    clearTimeout(force);
    // OMP lazily writes its journal after the first turn. Preserve an empty
    // conversation on explicit close, never replace or truncate an existing journal.
    if (state.messageCount === 0 && state.isSettled) {
      const header = { type: 'session', version: 3, id: sessionId, cwd: process.cwd(), timestamp: new Date().toISOString() };
      await writeFile(sessionFile, JSON.stringify(header) + '\n', { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    }
    return {};
  }
  throw new Error('Unsupported OMP operation');
}

function handleSocket(socket) {
  let data = '';
  socket.setEncoding('utf8');
  socket.on('error', () => {});
  socket.on('data', chunk => {
    data += chunk;
    if (Buffer.byteLength(data) > 1024 * 1024) return socket.destroy();
    const end = data.indexOf('\n');
    if (end < 0) return;
    socket.removeAllListeners('data');
    Promise.resolve().then(() => handleRequest(JSON.parse(data.slice(0, end)), socket)).then(result => {
      if (result !== null && !socket.destroyed) socket.end(JSON.stringify({ ok: true, ...result }) + '\n');
    }, error => {
      if (!socket.destroyed) socket.end(JSON.stringify({ ok: false, error: typeof error.message === 'string' ? error.message.slice(0, 512) : 'OMP request rejected', ...(error.deliveryUnknown ? { deliveryUnknown: true } : {}) }) + '\n');
    });
  });
}

process.umask(0o077);
let sessionDir;
try {
  if (!process.connected) throw new Error('OMP bridge requires a startup IPC channel');
  await mkdir(socketDir, { recursive: true, mode: 0o700 });
  const socketStat = await lstat(socketDir);
  if (!socketStat.isDirectory() || socketStat.uid !== uid || (socketStat.mode & 0o077)) throw new Error('OMP socket directory is not private');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const stateStat = await lstat(stateDir);
  if (!stateStat.isDirectory() || stateStat.uid !== uid || (stateStat.mode & 0o077)) throw new Error('OMP state directory is not private');
  sessionDir = resuming ? dirname(savedPath) : await mkdtemp(join(stateDir, 'omp-'));
  child = spawn('omp', ['--mode', 'rpc', '--session-dir', sessionDir, '--approval-mode', 'yolo', ...startupArgs], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, PERCH_MANAGED_WORKER: '1' },
  });
  child.stdin.on('error', () => {});
  child.on('error', () => failStartup('Unable to start OMP RPC process'));
  child.on('exit', () => {
    stopped = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      const error = new Error(entry.type === 'prompt' ? 'OMP RPC process exited; delivery status is unknown' : 'OMP RPC process exited');
      if (entry.type === 'prompt') error.deliveryUnknown = true;
      entry.reject(error);
    }
    pending.clear();
    if (active) endTurn(active, { turnId: active.id, status: 'interrupted' });
    if (server?.listening) server.close();
    if (!ready) failStartup('OMP RPC process exited during startup');
  });
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => {
    try {
      if (Buffer.byteLength(line) > 1024 * 1024) throw new Error('OMP RPC frame too large');
      acceptFrame(JSON.parse(line));
    } catch { if (!ready) failStartup('Invalid OMP RPC protocol'); else { stopped = true; child.kill('SIGTERM'); } }
  });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { stopped = true; child?.kill('SIGTERM'); if (server?.listening) server.close(); });
} catch (error) { failStartup(error.message || 'OMP bridge startup failed'); }
