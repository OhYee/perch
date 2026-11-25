#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { chmod, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import net from 'node:net';
import { managedDir, privateManagedDir } from './codex.mjs';
import { clientVersion } from '../portable-runtime.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const child = spawn('codex', ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'ignore'] });
const requests = new Map();
const turns = new Map();
const approvals = new Map();
const connections = new Set();
let nextId = 0;
let threadId;
let currentId = null;
let starting = false;
let row;
let server;
let socketPath;
let closing = false;
let shutdownPromise;
let childClosed = false;
let resolveChildClosed;
const childClosedPromise = new Promise(resolve => { resolveChildClosed = resolve; });

function nativeRequest(method, params) {
  if (childClosed || closing) return Promise.reject(new Error('Codex app-server is no longer running'));
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    requests.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => {
      if (!error) return;
      requests.delete(id);
      reject(new Error('Codex app-server write failed; delivery may be unknown'));
    });
  });
}

function rememberTurn(turn) {
  if (!turn || typeof turn.id !== 'string' || !turn.id) throw new Error('Invalid Codex turn');
  let stored = turns.get(turn.id);
  if (!stored) {
    stored = { id: turn.id, status: 'inProgress', items: [] };
    turns.set(turn.id, stored);
  }
  const items = stored.items;
  const previousStatus = stored.status;
  const previousError = stored.error;
  Object.assign(stored, turn);
  if (previousStatus !== 'inProgress' && turn.status === 'inProgress') {
    stored.status = previousStatus;
    stored.error = previousError;
  }
  stored.items = items;
  if (Array.isArray(turn.items)) for (const item of turn.items) rememberItem(stored, item);
  return stored;
}

function rememberItem(turn, item) {
  if (!item || typeof item.id !== 'string') return;
  const index = turn.items.findIndex(previous => previous.id === item.id);
  if (index < 0) turn.items.push(item);
  else turn.items[index] = item;
}

function handleNative(message) {
  if (message.method && Object.hasOwn(message, 'id')) {
    if (message.method === 'currentTime/read') {
      child.stdin.write(JSON.stringify({ id: message.id, result: { currentTimeAt: Math.floor(Date.now() / 1000) } }) + '\n');
      return;
    }
    const params = message.params ?? {};
    const isApproval = /(?:\/requestApproval|^execCommandApproval$|^applyPatchApproval$)/.test(message.method);
    const isInput = message.method === 'mcpServer/elicitation/request' ||
      (message.method === 'item/tool/requestUserInput' && params.isBlocking !== false);
    if ((isApproval || isInput) && (params.threadId ?? params.conversationId) === threadId) {
      approvals.set(message.id, params.turnId ?? currentId);
    }
    return;
  }
  if (Object.hasOwn(message, 'id')) {
    const request = requests.get(message.id);
    if (!request) return;
    requests.delete(message.id);
    if (message.error) request.reject(Object.assign(new Error(`Codex app-server rejected ${message.error.code ?? 'the request'}`), { code: 'CODEX_RPC_REJECTED' }));
    else if (Object.hasOwn(message, 'result')) request.resolve(message.result);
    else request.reject(new Error('Invalid Codex app-server response'));
    return;
  }
  const params = message.params ?? {};
  if (params.threadId !== threadId) return;
  if (message.method === 'turn/started') {
    const turn = rememberTurn(params.turn);
    if (turn.status === 'inProgress') currentId = turn.id;
  } else if (message.method === 'item/completed' && typeof params.turnId === 'string') {
    rememberItem(rememberTurn({ id: params.turnId, status: 'inProgress' }), params.item);
  } else if (message.method === 'turn/completed') {
    const turn = rememberTurn(params.turn);
    if (currentId === turn.id) currentId = null;
    for (const [id, pendingTurn] of approvals) if (pendingTurn === turn.id || pendingTurn === null) approvals.delete(id);
  } else if (message.method === 'serverRequest/resolved') {
    approvals.delete(params.requestId);
  } else if (message.method === 'thread/name/updated' && row) {
    row.title = typeof params.threadName === 'string' ? params.threadName : null;
  }
}

child.stdin.on('error', () => {});
child.on('error', () => {});
child.once('close', () => {
  childClosed = true;
  resolveChildClosed();
  for (const request of requests.values()) request.reject(new Error('Codex app-server exited; delivery may be unknown'));
  requests.clear();
  if (!closing) void shutdown();
});
createInterface({ input: child.stdout }).on('line', line => {
  try { handleNative(JSON.parse(line)); } catch {
    child.kill('SIGTERM');
  }
});

async function shutdown(except) {
  if (shutdownPromise) return shutdownPromise;
  closing = true;
  shutdownPromise = (async () => {
    if (server?.listening) server.close();
    for (const connection of connections) if (connection !== except) connection.destroy();
    if (!childClosed) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      timer.unref();
      await childClosedPromise;
      clearTimeout(timer);
    }
    if (socketPath) await unlink(socketPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  })();
  return shutdownPromise;
}

async function handleClient(message) {
  if (closing) throw new Error('Codex managed session is closing');
  if (message.method === 'info') {
    const pending = currentId && [...approvals.values()].some(id => id === currentId || id === null);
    return { ...row, status: pending ? 'blocked' : starting || currentId ? 'running' : 'idle' };
  }
  if (message.method === 'history') return { turns: [...turns.values()] };
  if (message.method === 'idle') {
    const turn = turns.get(currentId ?? [...turns.keys()].at(-1)) ?? null;
    const pending = currentId && [...approvals.values()].some(id => id === currentId || id === null);
    return { active: starting || !!currentId, pending: !!pending, turn };
  }
  if (message.method !== 'send') throw new Error('Unsupported Codex managed request');
  const text = message.params?.text;
  if (typeof text !== 'string' || !text.trim()) throw new Error('Message must not be empty');
  if (starting || currentId) throw new Error('Codex session is busy');
  starting = true;
  try {
    const result = await nativeRequest('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] });
    const turn = rememberTurn(result?.turn);
    if (turn.status === 'inProgress') currentId = turn.id;
    return { turnId: turn.id };
  } catch (error) {
    if (error.code !== 'CODEX_RPC_REJECTED') error.deliveryUnknown = true;
    throw error;
  } finally {
    starting = false;
  }
}

function accept(socket) {
  connections.add(socket);
  socket.on('close', () => connections.delete(socket));
  socket.on('error', () => {});
  socket.setEncoding('utf8');
  socket.setTimeout(30000, () => socket.destroy());
  let input = '';
  let handled = false;
  socket.on('data', chunk => {
    if (handled) return;
    input += chunk;
    if (input.length > 2 * 1024 * 1024) return socket.destroy();
    const end = input.indexOf('\n');
    if (end < 0) return;
    handled = true;
    let message;
    try { message = JSON.parse(input.slice(0, end)); } catch { socket.end(JSON.stringify({ error: 'Invalid Codex managed request' }) + '\n'); return; }
    if (message?.method === 'close') {
      shutdown(socket).then(() => socket.end(JSON.stringify({ result: true }) + '\n'), () => socket.end(JSON.stringify({ error: 'Codex managed shutdown failed' }) + '\n'));
      return;
    }
    handleClient(message).then(result => socket.end(JSON.stringify({ result }) + '\n'), error => socket.end(JSON.stringify({ error: error.message, deliveryUnknown: error.deliveryUnknown === true }) + '\n'));
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void shutdown(); });

try {
  await mkdir(managedDir(), { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  await privateManagedDir();
  await nativeRequest('initialize', { clientInfo: { name: 'agent-session', version: clientVersion }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  const params = { cwd: process.cwd(), approvalPolicy: 'never', sandbox: 'danger-full-access' };
  if (process.argv[2]) params.model = process.argv[2];
  const started = await nativeRequest('thread/start', params);
  const thread = started?.thread;
  if (!uuid.test(thread?.id ?? '')) throw new Error('Invalid Codex thread identity');
  threadId = thread.id;
  socketPath = join(managedDir(), `${threadId}.sock`);
  row = { id: `codex:${threadId}`, provider: 'codex', pid: child.pid, cwd: thread.cwd ?? process.cwd(), title: typeof thread.name === 'string' ? thread.name : null,
    send: true, history: true, wait: true, close: true, historyMode: 'live', _threadId: threadId, _managed: true, _socket: socketPath, _protocolVersion: 2 };
  server = net.createServer(accept);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await chmod(socketPath, 0o600);
  if (childClosed) throw new Error('Codex app-server exited during startup');
  if (process.send) process.send({ ready: true, session: row });
} catch {
  await shutdown().catch(() => {});
  if (process.send && process.connected) process.send({ ready: false, error: 'Could not start the private Codex app-server' });
  process.exitCode = 1;
}
