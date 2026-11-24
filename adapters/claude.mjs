import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join, basename, isAbsolute } from 'node:path';
import { lstat, open, readdir, readFile, realpath } from 'node:fs/promises';
import net from 'node:net';
import { processes } from './processes.mjs';
import { launchBridge } from './launch.mjs';

const exec = promisify(execFile);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sessionStates = new Set(['idle', 'running', 'blocked', 'failed', 'stopped']);
const sessionStatus = value => sessionStates.has(value) ? value : 'unknown';
export const bridgeDir = `/tmp/agent-session-claude-${process.getuid()}`;

export function terminalSafeText(text) {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

export function trackPending(pending, id, socket, text) {
  pending.set(id, { socket, text });
  socket.once('close', () => pending.delete(id));
}

export async function privateBridgeDir() {
  try {
    const s = await lstat(bridgeDir);
    return s.isDirectory() && s.uid === process.getuid() && (s.mode & 0o077) === 0;
  } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}

export function request(id, payload, timeout = 65000) {
  if (!uuid.test(id)) throw new Error('Invalid Claude session ID');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(join(bridgeDir, `${id}.sock`));
    socket.setEncoding('utf8');
    let data = '';
    let settled = false;
    let sent = false;
    const failure = (message, unknown = sent && payload.op === 'send') => {
      const error = new Error(message);
      if (unknown) error.deliveryUnknown = true;
      return error;
    };
    const finish = (err, value) => {
      if (settled) return;
      settled = true; socket.destroy();
      err ? reject(err) : resolve(value);
    };
    socket.setTimeout(timeout === null ? 0 : timeout, () => finish(failure('Claude bridge timed out; delivery status is unknown')));
    socket.on('connect', () => { sent = true; socket.write(`${JSON.stringify(payload)}\n`); });
    socket.on('error', () => finish(failure('Claude bridge unavailable; delivery status may be unknown')));
    socket.on('end', () => finish(failure('Claude bridge closed without acknowledgment; delivery status is unknown')));
    socket.on('data', chunk => {
      data += chunk;
      if (data.length > 16 * 1024 * 1024) return finish(failure('Claude bridge response too large'));
      const pos = data.indexOf('\n');
      if (pos < 0) return;
      try {
        const result = JSON.parse(data.slice(0, pos));
        if (result.error && !result.status) finish(failure(result.error, result.deliveryUnknown === true || (payload.op === 'send' && /delivery status is unknown/i.test(result.error)))); else finish(null, result);
      } catch { finish(failure('Invalid Claude bridge response')); }
    });
  });
}

async function transcriptPath(id) {
  if (!uuid.test(id)) return null;
  const root = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
  let dirs;
  try { dirs = await readdir(root, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  const paths = [];
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const path = join(root, dir.name, `${id}.jsonl`);
    try { if ((await lstat(path)).isFile()) paths.push(path); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return paths.length === 1 ? paths[0] : null;
}

async function officialSessions() {
  let stdout;
  try {
    ({ stdout } = await exec('claude', ['agents', '--json'], { timeout: 10000, maxBuffer: 8 * 1024 * 1024 }));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error('Claude session registry unavailable');
  }
  let value;
  try { value = JSON.parse(stdout); } catch { throw new Error('Invalid Claude session registry response'); }
  if (!Array.isArray(value)) throw new Error('Invalid Claude session registry response');
  return value;
}

async function bridgeSession(id, procs) {
  try {
    const meta = await request(id, { op: 'info' }, 1000);
    const child = procs.find(p => p.pid === meta.pid && p.ppid === meta.bridgePid);
    const parent = procs.find(p => p.pid === meta.bridgePid);
    if (!parent || !parent.args.includes('claude-bridge.mjs')) return null;
    // Linux comm names a thread, not necessarily the executable that hosts the bridge.
    const executable = process.platform === 'linux' ? await realpath(`/proc/${parent.pid}/exe`) : parent.comm;
    const bridge = ['node', 'nodejs'].includes(basename(executable));
    const managed = meta.managed === true && bridge && parent.args.includes('--managed');
    if (!bridge || meta.id !== id || typeof meta.cwd !== 'string' ||
        (!managed && (!child || basename(child.comm) !== 'claude' || !child.args.includes(`--session-id ${meta.id}`)))) return null;
    const status = meta.running === false ? 'stopped' : sessionStatus(meta.status);
    return { id: `claude:${meta.id}`, provider: 'claude', pid: meta.pid, cwd: meta.cwd, status, send: meta.running !== false, history: true, historyMode: 'live', wait: !!managed && meta.protocolVersion === 2, close: !!managed, _bridge: true, ...(managed ? { _managed: true } : {}) };
  } catch { return null; }
}

export async function lookupBridge(id) {
  if (typeof id !== 'string' || !id.startsWith('claude:') || !uuid.test(id.slice(7)) || !await privateBridgeDir()) return null;
  return bridgeSession(id.slice(7), await processes());
}

export async function list() {
  const [native, procs] = await Promise.all([officialSessions(), processes()]);
  const sessions = [];
  if (await privateBridgeDir()) {
    for (const name of await readdir(bridgeDir)) {
      const m = /^([0-9a-f-]{36})\.sock$/i.exec(name);
      if (!m || !uuid.test(m[1])) continue;
      const session = await bridgeSession(m[1], procs);
      if (session) sessions.push(session);
    }
  }
  return mergeNativeSessions(sessions, native);
}

export async function mergeNativeSessions(sessions, native) {
  for (const entry of native) {
    if (!entry || typeof entry.sessionId !== 'string' || !uuid.test(entry.sessionId) || typeof entry.cwd !== 'string' || native.filter(other => other?.sessionId === entry.sessionId).length !== 1) continue;
    const title = typeof entry.name === 'string' ? entry.name : null;
    const status = sessionStatus(entry.state);
    const existing = sessions.find(s => s.id === `claude:${entry.sessionId}`);
    if (existing) {
      existing.title = title;
      if (!existing.status || existing.status === 'unknown') existing.status = status;
      continue;
    }
    const path = await transcriptPath(entry.sessionId);
    sessions.push({ id: `claude:${entry.sessionId}`, provider: 'claude', pid: null, cwd: entry.cwd, title, status, send: false, history: !!path, ...(path ? { historyMode: 'persisted' } : {}),
      sendReason: 'Claude does not expose programmatic input for this session; attach is interactive.',
      ...(!path ? { historyReason: 'No unambiguous local transcript found.' } : {}), _transcript: path });
  }
  return sessions;
}

export async function validateNativeExecutable(executable) {
  if (typeof executable !== 'string' || !isAbsolute(executable)) {
    throw new Error('Pass the absolute path to the trusted native Claude executable, not a wrapper.');
  }
  const binary = await realpath(executable);
  const file = await open(binary, 'r');
  const magic = Buffer.alloc(4);
  try { await file.read(magic, 0, 4, 0); } finally { await file.close(); }
  if (!['cffaedfe', 'feedfacf', 'cafebabe', 'bebafeca', '7f454c46'].includes(magic.toString('hex'))) {
    throw new Error('Claude executable must be a native binary, not a script or wrapper.');
  }
  return binary;
}

export async function start({ cwd, model, executable }) {
  if (typeof executable !== 'string' || !isAbsolute(executable)) {
    throw new Error('Pass the absolute path to the trusted native Claude executable, not a wrapper.');
  }
  const args = [executable, '--managed'];
  if (model !== undefined && model !== null) args.push('--model', model);
  return launchBridge(new URL('./claude-bridge.mjs', import.meta.url), { cwd, args });
}

export async function send(session, text) {
  if (!session?._bridge || !session.send || typeof text !== 'string' || !text.length) throw new Error('Claude session does not support sending');
  const id = session.id?.slice('claude:'.length);
  const current = session._managed ? session : await lookupBridge(session.id);
  if (!current || current.pid !== session.pid) throw new Error('Claude session is no longer available');
  const response = await request(id, { op: 'send', text });
  if (!response.accepted) {
    const error = new Error('Claude did not acknowledge delivery');
    error.deliveryUnknown = true;
    throw error;
  }
}

export async function waitIdle(session, timeoutMs) {
  if (!session?._managed || !session.wait || !session.id?.startsWith('claude:')) throw new Error('Claude session does not support waiting');
  if (timeoutMs !== null && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2147480000)) throw new Error('Invalid wait timeout');
  const requestTimeout = timeoutMs === null ? null : Math.min(timeoutMs + 5000, 2147483647);
  const result = await request(session.id.slice(7), { op: 'waitIdle', timeoutMs }, requestTimeout);
  if (!['completed', 'timeout', 'needs_input', 'failed', 'interrupted'].includes(result.status) ||
      (result.error !== undefined && typeof result.error !== 'string')) throw new Error('Invalid Claude wait response');
  return { status: result.status, ...(result.error !== undefined ? { error: result.error } : {}) };
}

export async function close(session) {
  if (!session?._managed || !session.close || !session.id?.startsWith('claude:')) throw new Error('Claude session does not support closing');
  await request(session.id.slice(7), { op: 'close' });
}

export async function history(session, limit) {
  if (!(limit === Infinity || Number.isSafeInteger(limit) && limit > 0)) throw new Error('Invalid history limit');
  if (!session?.history || !session.id?.startsWith('claude:')) throw new Error('Claude history unavailable');
  const id = session.id.slice(7);
  if (!uuid.test(id)) throw new Error('Invalid Claude session ID');
  const current = session._bridge ? await lookupBridge(session.id) : (await list()).find(s => s.id === session.id && s.history);
  if (!current || (session._bridge && current.pid !== session.pid)) throw new Error('Claude session is no longer available');
  if (current._bridge) return (await request(id, { op: 'history', limit: limit === Infinity ? null : limit })).messages;
  return parseTranscript(await readFile(current._transcript, 'utf8'), limit, id);
}

export function parseTranscript(content, limit, id) {
  const messages = [];
  for (const line of content.split('\n')) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (!event || event.sessionId !== id || (event.type !== 'user' && event.type !== 'assistant') || event.isSidechain || event.isMeta || event.isCompactSummary || event.isVisibleInTranscriptOnly || event.message?.role !== event.type) continue;
    const value = event.message.content;
    const text = typeof value === 'string' ? value : Array.isArray(value) ? value.filter(x => x?.type === 'text' && typeof x.text === 'string').map(x => x.text).join('\n') : '';
    const injected = /^\s*<(?:local-command-stdout|local-command-caveat|command-name|command-message|command-args|ide_opened_file|ide_selection|task-notification|agent-notification)(?:\s|>)/i.test(text)
      || /^\s*<system-reminder(?:\s[^>]*)?>[\s\S]*<\/system-reminder>\s*$/i.test(text);
    if (text && !(event.type === 'user' && injected)) messages.push({ role: event.type, text });
  }
  return limit === Infinity ? messages : messages.slice(-limit);
}
