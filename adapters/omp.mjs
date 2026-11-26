import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, lstat, open, readdir, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { connect } from 'node:net';
import { basename, dirname, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { processes } from './processes.mjs';
import { launchBridge } from './launch.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);
const directory = `/tmp/agent-session-${process.getuid?.()}`;
const unavailable = 'OMP session has not enabled the local Perch extension';
const statuses = new Set(['idle', 'running', 'blocked', 'failed', 'stopped']);
const status = value => statuses.has(value) ? value : 'unknown';

async function request(path, body) {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let bytes = 0;
    let chunks = [];
    let done = false;
    let submitted = false;
    const unknown = message => {
      const error = new Error(`${message}; delivery status is unknown; do not retry automatically`);
      error.deliveryUnknown = true;
      return error;
    };
    const finish = (error, result) => {
      if (done) return;
      done = true;
      socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    const timeout = body.op === 'send' ? 120000 : body.op === 'wait' ? (body.timeoutMs === null ? 0 : body.timeoutMs + 5000) : 3000;
    socket.setTimeout(timeout, () => finish(body.op === 'send' && submitted ? unknown('OMP delivery timed out') : new Error('OMP local endpoint timed out')));
    socket.on('error', () => finish(body.op === 'send' && submitted ? unknown('OMP transport failed') : new Error('OMP local endpoint unavailable')));
    socket.on('connect', () => { submitted = true; socket.write(JSON.stringify(body) + '\n'); });
    socket.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024 + 4096) return finish(body.op === 'send' ? unknown('OMP response too large') : new Error('OMP response too large'));
      chunks.push(chunk);
      const data = Buffer.concat(chunks);
      const end = data.indexOf(10);
      if (end < 0) return;
      try {
        const result = JSON.parse(data.subarray(0, end).toString('utf8'));
        if (typeof result?.ok !== 'boolean') return finish(body.op === 'send' ? unknown('Invalid OMP response') : new Error('Invalid OMP response'));
        if (result?.ok !== true) {
          const error = new Error(typeof result?.error === 'string' && result.error.length <= 512 ? result.error : 'OMP session rejected the request or changed identity');
          if (body.op === 'send' && result?.deliveryUnknown === true) error.deliveryUnknown = true;
          return finish(error);
        }
        finish(null, result);
      } catch { finish(body.op === 'send' ? unknown('Invalid OMP response') : new Error('Invalid OMP response')); }
    });
    socket.on('end', () => finish(body.op === 'send' && submitted ? unknown('Incomplete OMP response') : new Error('Incomplete OMP response')));
  });
}

async function endpoints(live) {
  let names;
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) return [];
    names = await readdir(directory);
  } catch { return []; }
  return (await Promise.all(names.map(async name => {
    const match = /^(\d+)-[a-f0-9]{32}\.sock$/.exec(name);
    if (!match || !live.has(Number(match[1]))) return null;
    const path = join(directory, name);
    try {
      const stat = await lstat(path);
      if (!stat.isSocket() || stat.uid !== process.getuid() || (stat.mode & 0o077)) return null;
      const info = await request(path, { op: 'info' });
      if (info.pid !== Number(match[1]) || typeof info.sessionId !== 'string' || !info.sessionId || !new RegExp(`^omp:${info.pid}:[a-f0-9]{32}$`).test(info.id) || typeof info.cwd !== 'string') return null;
      return { id: `omp:${info.sessionId}`, _runtimeId: info.id, provider: 'omp', pid: info.pid, cwd: info.cwd, title: typeof info.title === 'string' && info.title ? info.title : undefined, status: status(info.status), send: true, history: true, historyMode: 'live', wait: info.waitIdle === true || info.managed === true, close: info.managed === true, _path: path, _sessionId: info.sessionId };
    } catch { return null; }
  }))).filter(Boolean);
}

async function collabHosts(live) {
  try {
    const { stdout } = await exec('omp', ['collab', 'list', '--json'], { timeout: 4000, maxBuffer: 4 * 1024 * 1024 });
    const data = JSON.parse(stdout);
    if (data.version !== 1 || !Array.isArray(data.hosts)) return [];
    return data.hosts.flatMap(host => {
      if (!Number.isSafeInteger(host.pid) || !live.has(host.pid) || typeof host.instanceId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(host.instanceId) || !Number.isSafeInteger(host.generation) || typeof host.sessionId !== 'string' || !host.sessionId || typeof host.cwd !== 'string') return [];
      return [{ id: `omp:${host.sessionId}`, provider: 'omp', pid: host.pid, cwd: host.cwd, title: typeof host.sessionName === 'string' && host.sessionName ? host.sessionName : undefined, status: status(host.status), send: false, history: false, sendReason: unavailable, historyReason: unavailable, _sessionId: host.sessionId }];
    });
  } catch { return []; }
}

const uuid = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const leaseName = new RegExp(`^(${uuid})\\.lock$`);
const journalName = new RegExp(`_(${uuid})\\.jsonl$`);
const owners = join(process.env.XDG_STATE_HOME || join(homedir(), '.omp'), process.env.XDG_STATE_HOME ? 'omp/run/session-owners' : 'run/session-owners');

async function journalHeader(path, sessionId) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid()) return;
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const prefix = buffer.subarray(0, bytesRead);
    const firstEnd = prefix.indexOf(10);
    if (firstEnd < 0) return;
    const first = JSON.parse(prefix.subarray(0, firstEnd).toString('utf8'));
    let header = first;
    let slot;
    if (first.type === 'title') {
      if (firstEnd !== 255 || first.v !== 1 || typeof first.title !== 'string' || typeof first.updatedAt !== 'string' || typeof first.pad !== 'string' || (first.source !== undefined && !['auto', 'user'].includes(first.source))) return;
      slot = first;
      const secondEnd = prefix.indexOf(10, firstEnd + 1);
      if (secondEnd < 0) return;
      header = JSON.parse(prefix.subarray(firstEnd + 1, secondEnd).toString('utf8'));
    }
    if (header.type !== 'session' || typeof header.id !== 'string' || header.id.toLowerCase() !== sessionId) return;
    const title = slot ? slot.title : header.title;
    return { cwd: header.cwd, title: typeof title === 'string' && title ? title : undefined };
  } catch {
    return undefined;
  } finally {
    await file?.close().catch(() => {});
  }
}

export async function readJournalTitle(path, sessionId) {
  return (await journalHeader(path, sessionId))?.title;
}

// The journal already contains the native ID and original cwd. No second ID or registry.
export async function savedSession(id) {
  const match = new RegExp(`^omp:(${uuid})$`).exec(id);
  if (!match) return;
  const sessionId = match[1];
  const root = join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'agent-session');
  const stat = await lstat(root).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!stat) return;
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw Error('OMP state directory is not private');
  let found;
  for (const dir of await readdir(root, { withFileTypes: true })) {
    if (!dir.isDirectory() || !dir.name.startsWith('omp-')) continue;
    const parent = join(root, dir.name);
    for (const file of await readdir(parent, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(`_${sessionId}.jsonl`)) continue;
      const path = join(parent, file.name);
      const header = await journalHeader(path, sessionId);
      if (!header || typeof header.cwd !== 'string' || !isAbsolute(header.cwd) || found) throw Error('Ambiguous or invalid saved OMP session');
      found = { id, cwd: header.cwd, _sessionId: sessionId, _journal: path, history: true, historyMode: 'archived' };
    }
  }
  return found;
}

export async function resume(id) {
  if (!new RegExp(`^omp:${uuid}$`).test(id)) throw Error('Expected a stable OMP conversation ID');
  const live = async () => {
    const matches = (await list()).filter(row => row.id === id);
    if (matches.length > 1) throw Error('Ambiguous or invalid saved OMP session');
    return matches[0];
  };
  const running = await live();
  if (running) return running;
  const saved = await savedSession(id);
  if (!saved) throw Error('No saved managed OMP conversation with this ID');
  // An OS-backed SQLite write lock serializes launches across CLIs and is
  // released on process death. No session mapping or application data is stored.
  const { DatabaseSync } = await import('node:sqlite');
  const lock = new DatabaseSync(join(dirname(saved._journal), 'resume.lock'));
  try {
    const deadline = Date.now() + 30000;
    for (;;) {
      try { lock.exec('BEGIN IMMEDIATE'); break; }
      catch (error) {
        const busy = error.errcode === 5 || (typeof error.errno === 'number' && (error.errno & 0xff) === 5) ||
          (typeof error.code === 'string' && (error.code === 'SQLITE_BUSY' || error.code.startsWith('SQLITE_BUSY_')));
        if (!busy || Date.now() >= deadline) throw error;
        await delay(100);
      }
    }
    const winner = await live();
    if (winner) return winner;
    return await launchBridge(new URL('./omp-rpc-bridge.mjs', import.meta.url), {
      cwd: saved.cwd, args: ['--resume', saved._journal, saved._sessionId],
    });
  } finally { lock.close(); }
}

function isOmpExecutable(comm) {
  if (typeof comm !== 'string' || !comm) return false;
  if (basename(comm) === 'omp') return true;
  // Tern-managed OMP installs versioned binaries under .../omp/versions/<ver>
  return /(?:^|\/)omp\/versions\/[0-9][0-9A-Za-z.+-]*$/.test(comm);
}

export function isInteractiveOmp(p) {
  if (!isOmpExecutable(p.comm) || !p.tty || p.tty === '?' || p.tty === '??') return false;
  let args = p.args.trim();
  const executable = args === p.comm || args.startsWith(`${p.comm} `) ? p.comm : args === 'omp' || args.startsWith('omp ') ? 'omp' : null;
  if (!executable) return false;
  args = args.slice(executable.length).trim();
  if (!args) return true;
  const flags = new Set(['--offline', '--no-lsp', '--no-pty', '--no-tools', '--no-judge', '--no-spotlight', '--no-extensions', '--no-skills', '--no-rules', '--no-context-files', '--no-session', '--no-title', '--continue', '-c', '--advisor', '--allow-home', '--prewalk', '--no-prewalk', '--auto-approve', '--hide-thinking']);
  const values = new Set(['--model', '--smol', '--slow', '--plan', '--provider', '--profile', '--cwd', '--session-dir', '--extension', '-e', '--hook', '--config', '--add-dir', '--models', '--thinking', '--approval-mode', '--resume', '-r', '--restore', '--service-tier']);
  const tokens = args.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (flags.has(token)) continue;
    const [key, ...rest] = token.split('=');
    if (!values.has(key)) return false;
    if (rest.length) { if (!rest.join('=')) return false; }
    else if (!tokens[++i] || tokens[i].startsWith('-')) return false;
  }
  return true;
}

async function leaseSessions(candidates) {
  if (!candidates.length) return [];
  try {
    const ownerPath = await realpath(owners);
    let stdout;
    try {
      ({ stdout } = await exec('lsof', ['-n', '-P', '-Fpfn', '-p', candidates.map(p => p.pid).join(',')], { timeout: 5000, maxBuffer: 16 * 1024 * 1024 }));
    } catch (error) {
      if (typeof error.stdout !== 'string' || !error.stdout) throw error;
      stdout = error.stdout;
    }
    const seen = new Map();
    const cwds = new Map();
    let pid;
    let fd;
    for (const line of stdout.split('\n')) {
      if (line[0] === 'p') { pid = Number(line.slice(1)); fd = undefined; continue; }
      if (line[0] === 'f') { fd = line.slice(1); continue; }
      if (line[0] !== 'n' || !Number.isSafeInteger(pid)) continue;
      const path = line.slice(1);
      if (fd === 'cwd' && isAbsolute(path)) cwds.set(pid, path);
      const name = basename(path);
      const lease = path.startsWith(`${ownerPath}/`) && path === join(ownerPath, name) ? leaseName.exec(name) : null;
      const journal = isAbsolute(path) ? journalName.exec(name) : null;
      if (!lease && !journal) continue;
      const id = (lease || journal)[1].toLowerCase();
      const key = `${pid}:${id}`;
      const value = seen.get(key) || { pid, id, lease: false, journals: new Set() };
      if (lease) value.lease = true;
      else value.journals.add(path);
      seen.set(key, value);
    }
    const rows = [...seen.values()].filter(row => row.lease);
    const missing = new Set(rows.filter(row => row.journals.size === 0).map(row => row.id));
    if (missing.size) {
      const root = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.omp/agent'), 'sessions');
      const scan = async dir => {
        let entries;
        try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
        return entries;
      };
      const entries = await scan(root);
      const dirs = entries.filter(entry => entry.isDirectory()).map(entry => join(root, entry.name));
      for (const dir of [root, ...dirs]) {
        const files = dir === root ? entries : await scan(dir);
        for (const file of files) {
          if (!file.isFile()) continue;
          const match = journalName.exec(file.name);
          if (!match || !missing.has(match[1].toLowerCase())) continue;
          const id = match[1].toLowerCase();
          for (const row of rows) if (row.id === id && missing.has(row.id)) row.journals.add(join(dir, file.name));
        }
      }
    }
    const bound = rows.filter(row => row.journals.size === 1);
    if (!bound.length) return [];
    const ids = [...new Set(bound.map(row => row.id))];
    const result = JSON.parse((await exec('omp', ['session', 'lease', '--json', '--', ...ids], { timeout: 5000, maxBuffer: 1024 * 1024 })).stdout);
    if (!Array.isArray(result.held)) return [];
    const held = new Set(result.held);
    const counts = new Map();
    for (const row of bound) counts.set(row.id, (counts.get(row.id) || 0) + 1);
    return await Promise.all(bound.filter(row => held.has(row.id) && counts.get(row.id) === 1).map(async row => {
      const journal = [...row.journals][0];
      return {
        id: `omp:${row.id}`, provider: 'omp', pid: row.pid, cwd: cwds.get(row.pid) || null,
        title: await readJournalTitle(journal, row.id), status: 'unknown',
        send: false, history: true, historyMode: 'persisted', sendReason: unavailable,
        _sessionId: row.id, _journal: journal,
      };
    }));
  } catch { return []; }
}

async function persistedHistory(session, limit) {
  const candidates = (await processes()).filter(p => p.pid === session.pid && isOmpExecutable(p.comm));
  const before = (await leaseSessions(candidates)).find(row => row.id === session.id && row._journal === session._journal);
  if (!before) throw new Error('OMP session identity or lease changed');
  const stat = await lstat(before._journal);
  if (!stat.isFile() || stat.uid !== process.getuid() || stat.size > 32 * 1024 * 1024) throw new Error('OMP persisted history unavailable');
  const text = await readFile(before._journal, 'utf8');
  return parsePersistedHistory(text, session._sessionId, limit, async () => {
    const after = (await leaseSessions(candidates)).find(row => row.id === session.id && row._journal === session._journal);
    if (!after) throw new Error('OMP session identity or lease changed');
  });
}

export async function parsePersistedHistory(text, sessionId, limit, confirmLease) {
  if (text && !text.endsWith('\n')) throw new Error('OMP journal has an incomplete entry');
  const entries = new Map();
  let header;
  let leaf;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { throw new Error('Invalid OMP journal'); }
    if (row.type === 'session') { if (header) throw new Error('Ambiguous OMP journal'); header = row; continue; }
    if (row.type === 'title') continue;
    if (typeof row.id !== 'string' || (row.parentId !== null && typeof row.parentId !== 'string') || entries.has(row.id)) throw new Error('Invalid OMP journal entry');
    entries.set(row.id, row);
    if (row.type === 'message' && ['user', 'assistant'].includes(row.message?.role)) leaf = row.id;
  }
  if (!header || typeof header.id !== 'string' || header.id.toLowerCase() !== sessionId) throw new Error('OMP journal identity changed');
  const messages = [];
  const visited = new Set();
  while (leaf != null) {
    if (visited.has(leaf) || !entries.has(leaf)) throw new Error('Invalid OMP journal branch');
    visited.add(leaf);
    const row = entries.get(leaf);
    if (row.type === 'message' && ['user', 'assistant'].includes(row.message?.role)) {
      const content = row.message.content;
      const value = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('') : '';
      if (value) messages.push({ role: row.message.role, text: value });
    }
    leaf = row.parentId;
  }
  await confirmLease?.();
  messages.reverse();
  return limit === Infinity ? messages : messages.slice(-limit);
}

export function mergeSessions(local, leased, native) {
  const known = [...local];
  const liveWithTitles = new Set(local.filter(row => row.title));
  for (const session of [...leased, ...native]) {
    const existing = known.find(row => row.pid === session.pid && row._sessionId.toLowerCase() === session._sessionId.toLowerCase());
    if (!existing) known.push(session);
    else {
      if (session.title && (!existing.title || (native.includes(session) && !liveWithTitles.has(existing)))) existing.title = session.title;
      if (status(existing.status) === 'unknown' && status(session.status) !== 'unknown') existing.status = session.status;
    }
  }
  return known;
}

export async function list() {
  const snapshot = await processes();
  const live = new Set(snapshot.map(p => p.pid));
  const candidates = snapshot.filter(isInteractiveOmp);
  const ompProcesses = snapshot.filter(p => isOmpExecutable(p.comm));
  const [discovered, native, leased] = await Promise.all([endpoints(live), collabHosts(live), leaseSessions(ompProcesses)]);
  const local = discovered.filter(row => row.close || !discovered.some(other => other.close && other.pid === row.pid && other._sessionId.toLowerCase() === row._sessionId.toLowerCase()));
  const known = mergeSessions(local, leased, native);
  for (const p of candidates) {
    if (!known.some(row => row.pid === p.pid)) known.push({ id: `omp:pid-${p.pid}`, kind: 'process', provider: 'omp', pid: p.pid, cwd: null, status: 'unknown', send: false, history: false, sendReason: unavailable, historyReason: 'Current session identity is unavailable; enable the local extension' });
  }
  return known;
}

export async function start({ cwd, model, executable, providerArgs = [] }) {
  if (executable !== undefined) throw new Error('OMP does not support an executable override');
  const args = [];
  if (model !== undefined) {
    if (typeof model !== 'string' || !model.trim() || model.startsWith('-') || /[\x00-\x1f\x7f-\x9f]/u.test(model)) throw new Error('Invalid OMP model');
    args.push('--model', model);
  }
  // Managed sessions own the RPC transport, approval handling and session identity.
  // Only forward value-taking options known not to replace that contract.
  for (let i = 0; i < providerArgs.length; i++) {
    const match = /^(-e|--extension|--thinking)(?:=([\s\S]*))?$/u.exec(providerArgs[i]);
    if (!match) throw new Error('Unsupported managed OMP argument; use --native for unrestricted provider arguments');
    const value = match[2] ?? providerArgs[++i];
    if (!value || value.startsWith('-')) throw new Error('Expected a value for the managed OMP argument');
  }
  args.push(...providerArgs);
  return launchBridge(new URL('./omp-rpc-bridge.mjs', import.meta.url), { cwd, args });
}
async function legacyNativeTui(pid) {
  const processInfo = (await processes()).find(row => row.pid === pid);
  if (!processInfo || !processInfo.tty || ['?', '??'].includes(processInfo.tty)) return false;
  let executable;
  for (const directory of (process.env.PATH ?? '/usr/bin:/bin').split(':')) {
    try {
      const candidate = join(directory || '.', 'omp');
      await access(candidate, constants.X_OK);
      executable = await realpath(candidate);
      break;
    } catch {}
  }
  if (!executable) return false;
  if (process.platform === 'linux') {
    const binary = await realpath(`/proc/${pid}/exe`).catch(() => null);
    if (binary !== executable) return false;
    const cmdline = await readFile(`/proc/${pid}/cmdline`).catch(() => null);
    if (!cmdline) return false;
    const args = cmdline.toString('utf8').split('\0');
    if (args.pop() !== '' || !args.length) return false;
    args.shift();
    if (args[0] === '--model') {
      if (!args[1] || args[1].startsWith('-') || /\s/u.test(args[1])) return false;
      args.splice(0, 2);
    }
    return args.length === 0 || (args[0] === '--' && args.length <= 2 && !/[\x00-\x1f\x7f-\x9f]/u.test(args[1] ?? ''));
  }
  if (process.platform !== 'darwin') return false;
  const [{ stdout: comm }, { stdout: command }] = await Promise.all([
    exec('/bin/ps', ['-ww', '-p', String(pid), '-o', 'comm=']),
    exec('/bin/ps', ['-ww', '-p', String(pid), '-o', 'args=']),
  ]);
  const program = comm.trim();
  const args = command.trimEnd();
  if (!isAbsolute(program) || await realpath(program).catch(() => null) !== executable ||
      (args !== program && !args.startsWith(`${program} `))) return false;
  const rest = args.slice(program.length);
  return /^(?: --model [^\s-][^\s]*)?(?: --(?: [^\x00-\x1f\x7f-\x9f]*)?)?$/.test(rest);
}

export async function confirmNativeTui(session) {
  if (session?.provider !== 'omp' || !session.send || session.close || !Number.isSafeInteger(session.pid) ||
      session.id !== `omp:${session._sessionId}` || !new RegExp(`^omp:${session.pid}:[a-f0-9]{32}$`).test(session._runtimeId) ||
      typeof session._sessionId !== 'string' || !session._sessionId ||
      typeof session._path !== 'string' || !new RegExp(`^${session.pid}-[a-f0-9]{32}\\.sock$`).test(basename(session._path)) ||
      session._path !== join(directory, basename(session._path))) throw new Error('OMP native TUI identity unavailable');
  const dir = await lstat(directory);
  const socket = await lstat(session._path);
  if (!dir.isDirectory() || dir.uid !== process.getuid() || (dir.mode & 0o077) ||
      !socket.isSocket() || socket.uid !== process.getuid() || (socket.mode & 0o077)) throw new Error('OMP endpoint unavailable');
  const info = await request(session._path, { op: 'info' });
  if (info.id !== session._runtimeId || info.pid !== session.pid || info.sessionId !== session._sessionId ||
      (info.managed !== undefined && info.managed !== false) ||
      (info.mode !== 'tui' && !(info.mode === undefined && await legacyNativeTui(session.pid)))) {
    throw new Error('OMP native TUI identity changed');
  }
  return info;
}

function runtimeId(session) {
  if (session.id !== `omp:${session._sessionId}` || !session._runtimeId) throw Error('OMP session identity changed');
  return session._runtimeId;
}

export async function send(session, text) {
  if (!session?.send || typeof session._path !== 'string') throw new Error(unavailable);
  if (typeof text !== 'string' || !text || Buffer.byteLength(text) > 512 * 1024) throw new Error('Invalid message');
  await request(session._path, { op: 'send', id: runtimeId(session), text });
}

export async function waitIdle(session, timeoutMs) {
  if (!session?.wait || typeof session._path !== 'string') throw new Error('OMP session does not support waiting');
  if (timeoutMs !== null && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2147470000)) throw new Error('Invalid wait timeout');
  const result = await request(session._path, { op: 'wait', id: runtimeId(session), timeoutMs });
  if (!['completed', 'timeout', 'needs_input', 'failed', 'interrupted'].includes(result.status) || (result.error !== undefined && typeof result.error !== 'string')) throw new Error('Invalid OMP wait response');
  return { status: result.status, ...(result.error !== undefined ? { error: result.error } : {}) };
}

export async function close(session) {
  if (!session?.close || typeof session._path !== 'string') throw new Error('OMP session is not managed by Perch');
  await request(session._path, { op: 'close', id: runtimeId(session) });
}

export async function history(session, limit) {
  if (!session?.history) throw new Error(unavailable);
  if (limit !== Infinity && (!Number.isSafeInteger(limit) || limit <= 0)) throw new Error('Invalid history limit');
  if (session.historyMode === 'persisted') return persistedHistory(session, limit);
  if (session.historyMode === 'archived') {
    const file = await open(session._journal, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== process.getuid() || stat.size > 32 * 1024 * 1024) throw Error('OMP persisted history unavailable');
      return await parsePersistedHistory(await file.readFile('utf8'), session._sessionId, limit);
    } finally { await file.close(); }
  }
  if (typeof session._path !== 'string') throw new Error(unavailable);
  const result = await request(session._path, { op: 'history', id: runtimeId(session), limit: limit === Infinity ? null : limit });
  if (!Array.isArray(result.messages) || result.messages.some(m => !m || !['user', 'assistant'].includes(m.role) || typeof m.text !== 'string')) throw new Error('Invalid OMP history response');
  return result.messages;
}
