import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, realpath, stat, unlink } from 'node:fs/promises';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { launchBridge } from './launch.mjs';

export const MiB = 1024 * 1024;
export const protocolVersion = 1;
export const admissionMs = 10000;
export const maxWaitMs = 86400000;
// JSON 可把 1 MiB 的原文扩展到 6 MiB；IPC 限额须包含转义后的正文。
export const requestBytes = 6 * MiB + 4096;
export const responseBytes = 32 * MiB;
const uid = process.getuid();
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const handle = new RegExp(`^agy:(${uuid})$`);
const generationId = new RegExp(`^${uuid}$`);
const token = id => typeof id === 'string' && handle.exec(id)?.[1];
export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const opaqueId = value => typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= 4096;
export const validLimit = limit => limit === null || Number.isSafeInteger(limit) && limit > 0;
export const validTimeout = ms => ms === null || Number.isSafeInteger(ms) && ms >= 0 && ms <= maxWaitMs;

export const problems = Object.freeze({
  auth: 'Antigravity CLI authentication required; sign in to agy first',
  launch: 'Cannot launch agy acp',
  startupTimeout: 'Antigravity CLI ACP startup timed out',
  version: 'Unsupported Antigravity CLI ACP protocol version',
  protocol: 'Invalid Antigravity CLI ACP response',
  startup: 'Antigravity CLI could not start the managed session',
  model: 'Requested Antigravity CLI model is unavailable',
  modelMismatch: 'Antigravity CLI did not confirm the requested model',
  busy: 'Antigravity CLI managed session is busy',
  absent: 'Antigravity CLI managed session is no longer running',
  closing: 'Antigravity CLI managed session is closing',
  rejected: 'Antigravity CLI rejected the prompt',
  unknown: 'Antigravity CLI did not confirm the prompt; do not resend',
  stopped: 'Antigravity CLI stopped unexpectedly',
  prompt: 'Antigravity CLI prompt failed',
  refusal: 'Antigravity CLI refused the prompt',
  truncated: 'Antigravity CLI truncated the response',
  socketDir: 'Antigravity CLI managed socket directory is not private to the current user',
  socket: 'Antigravity CLI managed socket is not private to the current user',
  identity: 'Invalid Antigravity CLI managed session identity',
  requestTimeout: 'Antigravity CLI managed request timed out',
  connection: 'Antigravity CLI managed connection failed',
  shutdown: 'Antigravity CLI managed shutdown failed',
  stableId: 'Expected a stable managed Antigravity CLI session ID',
  notSaved: 'No saved managed Antigravity CLI session with this ID',
  invalidSaved: 'Invalid saved managed Antigravity CLI session',
  stateDir: 'Antigravity CLI managed state directory is not private to the current user',
  closed: 'Antigravity CLI managed session is closed; resume it first',
  noLoad: 'Antigravity CLI does not support loading managed sessions',
  load: 'Antigravity CLI could not load the managed session',
  owner: 'Antigravity CLI managed session already has an owner',
  starting: 'Antigravity CLI managed session is starting or closing',
  generation: 'Antigravity CLI managed session generation changed',
  history: 'Antigravity CLI history exceeds the retained window',
  empty: 'Message must not be empty',
  size: 'Message exceeds 1 MiB',
  limit: 'History limit must be a positive integer',
  timeout: 'Invalid wait timeout',
});
export const failure = (reason, unknown = false) => Object.assign(Error(problems[reason]), { reason, deliveryUnknown: unknown });

export const managedDir = () => join('/tmp', `agent-session-agy-${uid}-${createHash('sha256').update(resolve(homedir())).digest('hex').slice(0, 12)}`);
export const socketPath = id => join(managedDir(), `${token(id)}.sock`);
const stateBase = () => resolve(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'));
export const mode = (info, expected) => info?.uid === uid && (info.mode & 0o7777) === expected;
export async function entry(path) {
  try { return await lstat(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function privateDir(path, reason, create = false, exclusive = false) {
  if (create) await mkdir(path, { mode: 0o700 }).catch(error => {
    if (error.code !== 'EEXIST' || exclusive) throw failure(exclusive && error.code === 'EEXIST' ? 'owner' : reason);
  });
  const info = await entry(path);
  if (!info) return false;
  if (!info.isDirectory() || !mode(info, 0o700)) throw failure(reason);
  return true;
}
export const privateSocketDir = create => privateDir(managedDir(), 'socketDir', create);

export async function sessionDirectory(id, create = false) {
  if (!token(id)) throw failure('stableId');
  const base = stateBase();
  if (create) await mkdir(base, { recursive: true, mode: 0o700 });
  const info = await entry(base);
  if (!info) return;
  if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o022)) throw failure('stateDir');
  const root = join(base, 'agent-session');
  if (!await privateDir(root, 'stateDir', create)) return;
  const agy = join(root, 'agy');
  if (!await privateDir(agy, 'stateDir', create)) return;
  const directory = join(agy, token(id));
  if (await privateDir(directory, 'stateDir', create, create)) return directory;
}

const decoder = new TextDecoder('utf-8', { fatal: true });
const recordBytes = 65536;
async function readRecord(path, reason) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile() || !mode(info, 0o600) || info.size < 1 || info.size > recordBytes) throw failure(reason);
    const buffer = Buffer.allocUnsafe(info.size + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== info.size) throw failure(reason);
    return JSON.parse(decoder.decode(buffer.subarray(0, bytesRead)));
  } catch (error) {
    if (error.code !== 'ENOENT') throw failure(reason);
  } finally { await file?.close(); }
}

// 先写完私有临时文件，再无覆盖发布；调用者只在持有该会话锁时写入。
export async function publishRecord(path, record) {
  const data = JSON.stringify(record);
  if (Buffer.byteLength(data) > recordBytes) throw failure('invalidSaved');
  const temporary = `${path}.${randomUUID()}`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    try { await file.writeFile(data); } finally { await file.close(); }
    await link(temporary, path);
  } finally { await unlink(temporary); }
}

export async function descriptor(id, directory) {
  directory ??= await sessionDirectory(id);
  if (!directory) return;
  const data = await readRecord(join(directory, 'session.json'), 'invalidSaved');
  if (data === undefined) return;
  if (!object(data) || Object.keys(data).length !== 4 || data.version !== 1 || data.handle !== id || !opaqueId(data.sessionId) ||
      typeof data.cwd !== 'string' || !isAbsolute(data.cwd) || data.cwd.includes('\0')) throw failure('invalidSaved');
  return data;
}

export async function ownerRecord(id, directory) {
  directory ??= await sessionDirectory(id);
  if (!directory) return;
  const data = await readRecord(join(directory, 'owner.json'), 'identity');
  if (data === undefined) return;
  if (!object(data) || data.version !== protocolVersion || data.handle !== id ||
      typeof data.generation !== 'string' || !generationId.test(data.generation) ||
      !Number.isSafeInteger(data.group) || data.group <= 1 || data.group > 0x7fffffff) throw failure('identity');
  return data;
}

// 单行按原始字节限长；小帧直接解析，拆帧仅做有界的增量拷贝。
export function readFrames(stream, limit, receive, invalid) {
  let buffer, length = 0, finished = false;
  function fail() { finished = true; invalid(); }
  stream.on('data', chunk => {
    for (let offset = 0; !finished && offset < chunk.length;) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const size = length + end - offset;
      if (size > limit) return fail();
      let line = chunk.subarray(offset, end);
      if (length || newline < 0) {
        if (!buffer || size > buffer.length) {
          const next = Buffer.allocUnsafe(Math.min(limit, Math.max(4096, size, (buffer?.length ?? 0) * 2)));
          if (length) buffer.copy(next, 0, 0, length);
          buffer = next;
        }
        line.copy(buffer, length);
        length = size;
        if (newline < 0) break;
        line = buffer.subarray(0, length);
      }
      let message;
      try { message = JSON.parse(decoder.decode(line)); } catch { return fail(); }
      length = 0;
      if (buffer?.length > 65536) buffer = undefined;
      if (receive(message) === false) finished = true;
      offset = end + 1;
    }
  });
  stream.once('end', () => { if (!finished && length) fail(); });
}

const statuses = new Set(['idle', 'running', 'blocked', 'failed', 'stopped']);
const waitStatuses = new Set(['completed', 'timeout', 'needs_input', 'failed', 'interrupted']);
const waitErrors = new Set([problems.stopped, problems.protocol, problems.prompt, problems.refusal, problems.truncated]);
const historyRoles = new Set(['user', 'assistant']);
const launchURL = new URL('./agy-acp-bridge.mjs', import.meta.url);

async function request(id, method, params, expectedGeneration) {
  if (!await privateSocketDir()) throw failure('absent');
  const path = socketPath(id);
  const info = await entry(path);
  if (!info) throw failure('absent');
  if (!info.isSocket() || !mode(info, 0o600)) throw failure('socket');
  const owner = await ownerRecord(id);
  if (!owner) throw failure('absent');
  const { generation } = owner;
  if (expectedGeneration !== undefined && expectedGeneration !== generation) throw failure('generation');
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let sent = false;
    let done = false;
    let timer = setTimeout(() => finish('requestTimeout'), 1000);
    function finish(reason, value, unknown = sent) {
      if (done) return false;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (reason) reject(failure(unknown ? 'unknown' : reason, unknown));
      else resolve(value);
      return false;
    }
    const envelope = { version: protocolVersion, id };
    // 先验证对方独立报告的代际；握手前不发送代际或消息正文。
    socket.once('connect', () => socket.write(JSON.stringify({ ...envelope, method: 'info' }) + '\n'));
    socket.once('close', () => finish('connection'));
    socket.once('error', error => finish(['ENOENT', 'ECONNREFUSED'].includes(error.code) ? 'absent' : 'connection'));
    let checked = false;
    readFrames(socket, responseBytes, message => {
      if (!object(message)) return finish('identity');
      if (Object.hasOwn(message, 'error')) {
        if (typeof message.error !== 'string' || !Object.hasOwn(problems, message.error) || Object.hasOwn(message, 'result')) return finish('identity');
        return finish(message.error, undefined, sent && message.deliveryUnknown === true);
      }
      if (!Object.hasOwn(message, 'result')) return finish('identity');
      if (checked) {
        const value = message.result;
        if (method === 'send' && value?.accepted !== true || method === 'close' && value?.closed !== true ||
            method === 'wait' && (!waitStatuses.has(value?.status) || value.error !== undefined && !waitErrors.has(value.error))) return finish('identity');
        return finish(null, value, false);
      }
      const row = message.result;
      if (row?.id !== id || row._agy !== 'managed' || row.provider !== 'agy' || row._socket !== path ||
          row._protocolVersion !== protocolVersion || row._generation !== generation || !statuses.has(row.status) ||
          !Number.isSafeInteger(row.pid) || row.pid <= 0 || typeof row.cwd !== 'string' || !isAbsolute(row.cwd) ||
          !(row.title === null || typeof row.title === 'string') || row.historyMode !== 'live' ||
          row.send !== true || row.history !== true || row.wait !== true || row.close !== true) return finish('identity');
      if (method === 'info') return finish(null, row, false);
      clearTimeout(timer);
      const timeout = method === 'wait' ? params.timeoutMs === null ? null : params.timeoutMs + 3000 : method === 'send' ? admissionMs + 3000 : 10000;
      if (timeout !== null) timer = setTimeout(() => finish('requestTimeout'), timeout);
      checked = true;
      sent = method === 'send';
      socket.write(JSON.stringify({ ...envelope, generation, method, params }) + '\n');
    }, () => finish('identity'));
  });
}

export async function lookupBridge(id) {
  if (!token(id)) return null;
  try { return await request(id, 'info'); }
  catch (error) { if (['absent', 'starting', 'closing', 'generation'].includes(error.reason)) return null; throw error; }
}

export async function listManaged() {
  if (!await privateSocketDir()) return [];
  const rows = [];
  const ids = (await readdir(managedDir())).filter(name => name.endsWith('.sock')).map(name => `agy:${name.slice(0, -5)}`).filter(token);
  for (let i = 0; i < ids.length; i += 16) {
    const results = await Promise.allSettled(ids.slice(i, i + 16).map(lookupBridge));
    for (const result of results) if (result.status === 'fulfilled' && result.value) rows.push(result.value);
  }
  return rows;
}

async function managedRequest(session, method, params) {
  if (session?._agy !== 'managed' || !token(session.id) || session._socket !== socketPath(session.id) ||
      session._protocolVersion !== protocolVersion || typeof session._generation !== 'string' ||
      !generationId.test(session._generation)) throw failure('identity');
  return request(session.id, method, params, session._generation);
}

export async function send(session, text) {
  if (typeof text !== 'string' || !text.trim()) throw failure('empty');
  if (Buffer.byteLength(text) > MiB) throw failure('size');
  return managedRequest(session, 'send', { text });
}

export async function historyManaged(session, limit) {
  if (limit !== Infinity && (limit === null || !validLimit(limit))) throw failure('limit');
  const result = await managedRequest(session, 'history', { limit: limit === Infinity ? null : limit });
  if (!Array.isArray(result) || result.some(message => !historyRoles.has(message?.role) || typeof message?.text !== 'string')) throw failure('identity');
  return result.map(({ role, text }) => ({ role, text }));
}

export async function waitIdle(session, timeoutMs = null) {
  if (!validTimeout(timeoutMs)) throw failure('timeout');
  return managedRequest(session, 'wait', { timeoutMs });
}

export const close = session => managedRequest(session, 'close');

async function workingDirectory(cwd, saved = false) {
  try {
    const path = await realpath(cwd);
    if ((!saved || path === cwd) && (await stat(path)).isDirectory()) return path;
  } catch { /* 与提供方报错一样，不带文件系统诊断。 */ }
  if (saved) throw failure('invalidSaved');
  throw Error('--cwd must be a directory');
}

function launch(cwd, args) {
  const env = { ...process.env, HOME: resolve(homedir()) };
  if (env.XDG_STATE_HOME) env.XDG_STATE_HOME = stateBase();
  return launchBridge(launchURL, { cwd, env, args });
}

export async function start({ cwd = process.cwd(), model, providerArgs = [], executable } = {}) {
  if (providerArgs.length) throw Error('Raw arguments are not supported for agy');
  if (executable !== undefined) throw Error('--executable is only for Claude');
  if (model !== undefined && !opaqueId(model)) throw failure('model');
  return launch(await workingDirectory(cwd), ['new', `agy:${randomUUID()}`, ...(model === undefined ? [] : [model])]);
}

export async function savedSession(id) {
  if (!token(id)) return;
  const saved = await descriptor(id);
  if (!saved) return;
  return { id, provider: 'agy', cwd: saved.cwd, title: null, status: 'stopped', _agy: 'managed',
    send: false, history: false, wait: false, close: false, sendReason: problems.closed, historyReason: problems.closed };
}

export async function resume(id) {
  if (!token(id)) throw failure('stableId');
  const saved = await descriptor(id);
  if (!saved) throw failure('notSaved');
  const cwd = await workingDirectory(saved.cwd, true);
  const live = await lookupBridge(id);
  if (live) return live;
  try { return await launch(cwd, ['load', id]); }
  catch (error) { if (error.message !== problems.starting) throw error; }
  // 锁的竞争方只等现有执行者就绪，不补发 load，也不把请求超时当作失去所有权。
  const deadline = performance.now() + 25000;
  do {
    const winner = await lookupBridge(id);
    if (winner) return winner;
    await delay(100);
  } while (performance.now() < deadline);
  throw failure('owner');
}
