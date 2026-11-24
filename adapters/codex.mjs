import { createHash } from 'node:crypto';
import { lstat, readlink, realpath, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import net from 'node:net';
import WebSocket from 'ws';
import { processes } from './processes.mjs';
import { launchBridge } from './launch.mjs';
import { clientVersion } from '../portable-runtime.mjs';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nonInteractive = /(?:^|\s)(?:exec|e|review|login|logout|mcp|plugin|app-server|remote-control|app|completion|update|doctor|sandbox|debug|apply|queue|archive|delete|migrate-rollouts|migrate-nfs-db|unarchive|fork|cloud|exec-server|features|help|agents)(?:\s|$)/;
const unavailable = 'This CLI process cannot be unambiguously associated with a loaded Codex thread on the shared app-server.';

// ps does not preserve argument boundaries; ambiguous command lines are omitted.
export function isInteractive(p) {
  if (basename(p.comm) !== 'codex' || !p.tty || p.tty === '?' || p.tty === '??') return false;
  const args = p.args.replace(/^\S+/, '');
  if (nonInteractive.test(args) || /(?:^|\s)(?:--help|-h|--version|-V)(?:\s|$)/.test(args)) return false;
  return true;
}


async function socketPath() {
  const home = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'));
  const alias = join(home, 'app-server-control', 'app-server-control.sock');
  let link;
  let parent;
  try {
    parent = await realpath(dirname(alias));
    link = await readlink(alias);
  } catch (error) {
    if (error.code === 'ENOENT') throw Object.assign(new Error('Codex app-server is not running'), { code: 'CODEX_SERVER_ABSENT' });
    throw new Error('Cannot verify Codex app-server socket');
  }
  const expected = createHash('sha256').update(join(parent, basename(alias))).digest('hex');
  if (!link.startsWith('/') || basename(link) !== expected) throw new Error('Untrusted Codex app-server socket alias');
  if (/[:?#%\\\s]/.test(link)) throw new Error('Unsupported characters in Codex socket path');
  let aliasInfo, dirInfo, socketInfo;
  try {
    aliasInfo = await lstat(alias);
    if (!aliasInfo.isSymbolicLink() || aliasInfo.uid !== process.getuid()) throw new Error('Codex app-server socket is not private to the current user');
    dirInfo = await lstat(dirname(link));
    if (!dirInfo.isDirectory() || dirInfo.uid !== process.getuid() || (dirInfo.mode & 0o777) !== 0o700) {
      throw new Error('Codex app-server socket is not private to the current user');
    }
    socketInfo = await lstat(link);
  } catch (error) {
    if (error.code === 'ENOENT') throw Object.assign(new Error('Codex app-server is not running'), { code: 'CODEX_SERVER_ABSENT' });
    throw error;
  }
  if (!socketInfo.isSocket() || socketInfo.uid !== process.getuid() || (socketInfo.mode & 0o077) !== 0) {
    throw new Error('Codex app-server socket is not private to the current user');
  }
  return link;
}

async function rpc(operation, timeoutMs = 10000) {
  const socket = await socketPath();
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws+unix:${socket}:/`, { perMessageDeflate: false, maxPayload: 32 * 1024 * 1024 });
    let finished = false;
    let opened = false;
    let pending;
    let nextId = 1;
    const timer = setTimeout(() => finish(Object.assign(new Error('Codex app-server request timed out; delivery may be unknown'), { code: 'CODEX_RPC_TIMEOUT' })), timeoutMs);
    function finish(error, value) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      ws.terminate();
      error ? reject(error) : resolve(value);
    }
    function request(method, params) {
      return new Promise((ok, fail) => {
        const id = nextId++;
        pending = { id, ok, fail };
        ws.send(JSON.stringify({ id, method, params }), error => {
          if (error) finish(new Error('Codex app-server write failed; delivery may be unknown'));
        });
      });
    }
    ws.on('error', error => {
      const absent = !opened && ['ENOENT', 'ECONNREFUSED'].includes(error.code);
      finish(Object.assign(new Error(absent ? 'Codex app-server is not running' : 'Codex app-server connection failed; delivery may be unknown'), absent ? { code: 'CODEX_SERVER_ABSENT' } : {}));
    });
    ws.on('close', () => finish(new Error('Codex app-server connection closed; delivery may be unknown')));
    ws.on('message', data => {
      let message;
      try { message = JSON.parse(data.toString()); } catch { finish(new Error('Invalid Codex app-server response')); return; }
      if (!pending || message.id !== pending.id) return;
      const current = pending;
      pending = null;
      if (message.error) current.fail(Object.assign(new Error(`Codex app-server rejected ${message.error.code ?? 'the request'}`), { code: 'CODEX_RPC_REJECTED' }));
      else if ('result' in message) current.ok(message.result);
      else current.fail(new Error('Invalid Codex app-server response'));
    });
    ws.on('open', () => {
      opened = true;
      (async () => {
        await request('initialize', { clientInfo: { name: 'agent-session', version: clientVersion }, capabilities: { experimentalApi: true } });
        ws.send(JSON.stringify({ method: 'initialized', params: {} }));
        const value = await operation(request);
        finish(null, value);
      })().catch(error => finish(error));
    });
  });
}

async function loadedIds(request) {
  const ids = [];
  let cursor = null;
  const cursors = new Set();
  do {
    const result = await request('thread/loaded/list', { cursor });
    if (!Array.isArray(result?.data) || result.data.some(id => !uuid.test(id))) throw new Error('Invalid loaded thread list');
    ids.push(...result.data);
    cursor = result.nextCursor ?? null;
    if (cursor && cursors.has(cursor)) throw new Error('Repeated Codex pagination cursor');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return ids;
}

async function readThread(request, id, includeTurns) {
  const result = await request('thread/read', { threadId: id, includeTurns });
  const thread = result?.thread;
  if (thread?.id !== id) throw new Error('Invalid Codex thread response');
  return thread;
}

function isCliOrigin(thread) {
  return thread.source === 'cli' || (thread.source === 'vscode' && thread.originator === 'codex-tui');
}

function isLoadedCli(thread) {
  return isCliOrigin(thread) && ['idle', 'active', 'systemError'].includes(thread.status?.type);
}

function threadStatus(status) {
  if (status?.type === 'idle') return 'idle';
  if (status?.type === 'systemError') return 'failed';
  if (status?.type === 'active') {
    const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
    return flags.includes('waitingOnApproval') || flags.includes('waitingOnUserInput') ? 'blocked' : 'running';
  }
  return 'unknown';
}

async function checkedThread(request, id, includeTurns) {
  if (!(await loadedIds(request)).includes(id)) throw new Error('Codex thread is no longer loaded');
  const thread = await readThread(request, id, includeTurns);
  if (!isLoadedCli(thread)) throw new Error('Codex thread is not a loaded CLI thread');
  return thread;
}

export function managedDir() {
  const home = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'));
  const hash = createHash('sha256').update(home).digest('hex').slice(0, 12);
  return join('/tmp', `agent-session-codex-${process.getuid()}-${hash}`);
}

export async function privateManagedDir() {
  let info;
  try { info = await lstat(managedDir()); } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700) {
    throw new Error('Codex managed socket directory is not private to the current user');
  }
  return true;
}

async function managedRequest(session, method, params = {}, timeoutMs = 10000) {
  requireManaged(session);
  const socketPath = join(managedDir(), `${session._threadId}.sock`);
  if (!session._managed || session._socket !== socketPath) throw new Error('Not a managed Codex session');
  if (!await privateManagedDir()) throw Object.assign(new Error('Codex managed session is no longer running'), { code: 'CODEX_SERVER_ABSENT' });
  let info;
  try { info = await lstat(socketPath); } catch (error) {
    if (error.code === 'ENOENT') throw Object.assign(new Error('Codex managed session is no longer running'), { code: 'CODEX_SERVER_ABSENT' });
    throw error;
  }
  if (!info.isSocket() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
    throw new Error('Codex managed socket is not private to the current user');
  }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let data = '';
    let finished = false;
    let sent = false;
    function finish(error, value) {
      if (finished) return;
      finished = true;
      socket.destroy();
      if (error && method === 'send' && sent) error.deliveryUnknown = true;
      error ? reject(error) : resolve(value);
    }
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs, () => finish(Object.assign(new Error('Codex managed request timed out; delivery may be unknown'), { code: 'CODEX_RPC_TIMEOUT' })));
    socket.on('connect', () => {
      sent = true;
      socket.write(JSON.stringify({ method, params }) + '\n');
    });
    socket.on('error', error => {
      const absent = ['ENOENT', 'ECONNREFUSED'].includes(error.code);
      finish(Object.assign(new Error(absent ? 'Codex managed session is no longer running' : 'Codex managed connection failed; delivery may be unknown'), absent ? { code: 'CODEX_SERVER_ABSENT' } : {}));
    });
    socket.on('end', () => finish(new Error('Codex managed connection closed; delivery may be unknown')));
    socket.on('data', chunk => {
      data += chunk;
      if (data.length > 32 * 1024 * 1024) return finish(new Error('Codex managed response is too large'));
      const end = data.indexOf('\n');
      if (end < 0) return;
      let response;
      try { response = JSON.parse(data.slice(0, end)); } catch { return finish(new Error('Invalid Codex managed response')); }
      if (response.error) {
        sent = false;
        finish(Object.assign(new Error(response.error), response.deliveryUnknown ? { deliveryUnknown: true } : {}));
      }
      else if (Object.hasOwn(response, 'result')) finish(null, response.result);
      else finish(new Error('Invalid Codex managed response'));
    });
  });
}

export async function lookupBridge(id) {
  const threadId = typeof id === 'string' && id.startsWith('codex:') ? id.slice(6) : '';
  if (!uuid.test(threadId)) return null;
  const session = { id, _threadId: threadId, _managed: true, _socket: join(managedDir(), `${threadId}.sock`) };
  try {
    const row = await managedRequest(session, 'info', {}, 1000);
    if (row?.id !== id || row._threadId !== threadId || row._socket !== session._socket || row._managed !== true) {
      throw new Error('Invalid Codex managed session identity');
    }
    return { ...row, wait: row._protocolVersion === 2,
      status: ['idle', 'running', 'blocked', 'failed', 'stopped', 'unknown'].includes(row.status) ? row.status : 'unknown' };
  } catch (error) {
    if (error.code === 'CODEX_SERVER_ABSENT') return null;
    throw error;
  }
}

async function managedSessions() {
  if (!await privateManagedDir()) return [];
  const sessions = [];
  for (const name of await readdir(managedDir())) {
    const id = name.endsWith('.sock') ? name.slice(0, -5) : '';
    if (!uuid.test(id)) continue;
    const row = await lookupBridge(`codex:${id}`);
    if (row) sessions.push(row);
  }
  return sessions;
}

export async function list() {
  const all = await processes();
  const terminals = all.filter(isInteractive);
  let threads = [];
  try {
    threads = await rpc(async request => {
      const found = [];
      for (const id of await loadedIds(request)) {
        const thread = await readThread(request, id, false);
        if (isCliOrigin(thread)) found.push(thread);
      }
      return found;
    });
  } catch (error) {
    if (error.code !== 'CODEX_SERVER_ABSENT') throw error;
  }
  const loaded = threads.map(thread => ({
    id: `codex:${thread.id}`, provider: 'codex', pid: null, cwd: thread.cwd ?? null, title: typeof thread.name === 'string' ? thread.name : null,
    send: true, history: true, wait: true, close: false, historyMode: 'live', status: threadStatus(thread.status), _threadId: thread.id,
  }));
  const processHints = terminals.map(p => ({
    id: `codex:pid-${p.pid}`, provider: 'codex', kind: 'process', pid: p.pid, cwd: null, send: false, history: false, wait: false, close: false,
    sendReason: unavailable, historyReason: unavailable, status: 'unknown',
  }));
  return [...loaded, ...await managedSessions(), ...processHints];
}

function requireManaged(session) {
  if (!session || !uuid.test(session._threadId ?? '') || session.id !== `codex:${session._threadId}`) throw new Error(unavailable);
}

export async function send(session, text) {
  requireManaged(session);
  if (typeof text !== 'string' || !text.trim()) throw new Error('Message must not be empty');
  if (session._managed) return managedRequest(session, 'send', { text });
  let submitted = false;
  try {
    return await rpc(async request => {
      await checkedThread(request, session._threadId, false);
      // turn/start resolves the existing in-memory thread; queue/add can persist to an unloaded one.
      submitted = true;
      const result = await request('turn/start', { threadId: session._threadId, input: [{ type: 'text', text, text_elements: [] }] });
      if (typeof result?.turn?.id !== 'string' || !result.turn.id) throw new Error('Codex did not confirm accepting the turn');
      return { turnId: result.turn.id };
    });
  } catch (error) {
    if (submitted && error.code !== 'CODEX_RPC_REJECTED') error.deliveryUnknown = true;
    throw error;
  }
}

export function messagesFromThread(thread, limit) {
  const messages = [];
  for (const turn of thread.turns ?? []) {
    for (const item of turn.items ?? []) {
      if (item.type === 'userMessage') {
        const text = (item.content ?? []).filter(c => c.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n');
        if (text) messages.push({ role: 'user', text });
      } else if (item.type === 'agentMessage' && typeof item.text === 'string' && item.text) {
        messages.push({ role: 'assistant', text: item.text });
      }
    }
  }
  return limit === Infinity ? messages : messages.slice(-limit);
}

export async function history(session, limit) {
  requireManaged(session);
  if (!(limit === Infinity || Number.isSafeInteger(limit) && limit > 0)) throw new Error('History limit must be a positive integer');
  if (session._managed) return messagesFromThread(await managedRequest(session, 'history'), limit);
  return rpc(async request => messagesFromThread(await checkedThread(request, session._threadId, true), limit));
}

export async function start({ cwd, model, executable } = {}) {
  if (executable !== undefined) throw new Error('A custom executable is supported only for Claude');
  const env = process.env.CODEX_HOME ? { ...process.env, CODEX_HOME: resolve(process.env.CODEX_HOME) } : process.env;
  return launchBridge(new URL('./codex-bridge.mjs', import.meta.url), { cwd, env, args: [model ?? ''] });
}

export async function waitIdle(session, timeoutMs = null) {
  requireManaged(session);
  if (session._managed && session._protocolVersion !== 2) throw new Error('This Codex bridge does not support waiting for session idle');
  if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) throw new Error('Invalid wait timeout');
  const deadline = timeoutMs === null ? null : Date.now() + timeoutMs;
  let first = true;
  for (;;) {
    const requestTimeout = first || deadline === null ? 10000 : Math.min(10000, Math.max(1, deadline - Date.now()));
    first = false;
    let snapshot;
    try {
      if (session._managed) snapshot = await managedRequest(session, 'idle', {}, requestTimeout);
      else snapshot = await rpc(async request => {
        let thread = await checkedThread(request, session._threadId, false);
        if (thread.status.type === 'idle') {
          thread = await readThread(request, session._threadId, true);
          if (!isLoadedCli(thread)) throw new Error('Codex thread is not a loaded CLI thread');
          if (!Array.isArray(thread.turns)) throw new Error('Invalid Codex turn history');
        }
        const flags = thread.status.type === 'active' ? thread.status.activeFlags ?? [] : [];
        return {
          active: thread.status.type === 'active',
          pending: flags.includes('waitingOnApproval') || flags.includes('waitingOnUserInput'),
          systemError: thread.status.type === 'systemError',
          turn: thread.turns?.at(-1) ?? null,
        };
      }, requestTimeout);
    } catch (error) {
      if (error.code === 'CODEX_RPC_TIMEOUT' && deadline !== null && Date.now() >= deadline) return { status: 'timeout' };
      throw error;
    }
    if (snapshot.systemError) return { status: 'failed', error: 'Codex thread reported a system error' };
    if (snapshot.active) {
      if (snapshot.pending) return { status: 'needs_input' };
    } else if (!snapshot.turn || snapshot.turn.status === 'completed') {
      return { status: 'completed' };
    } else if (snapshot.turn.status === 'failed' || snapshot.turn.status === 'interrupted') {
      const result = { status: snapshot.turn.status };
      if (typeof snapshot.turn.error?.message === 'string') result.error = snapshot.turn.error.message;
      return result;
    } else if (snapshot.turn.status !== 'inProgress') {
      throw new Error('Unknown Codex turn status');
    }
    if (deadline !== null && Date.now() >= deadline) return { status: 'timeout' };
    await new Promise(resolve => setTimeout(resolve, deadline === null ? 200 : Math.min(200, Math.max(0, deadline - Date.now()))));
  }
}

export async function close(session) {
  requireManaged(session);
  if (!session._managed || session.close !== true) throw new Error('Only managed Codex sessions can be closed');
  await managedRequest(session, 'close');
}
