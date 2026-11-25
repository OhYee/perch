import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync } from 'node:fs';
import { access, lstat, mkdir, open, readFile, readlink, readdir, realpath, rename, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { processes } from './processes.mjs';
import { entry } from '../portable-runtime.mjs';

const exec = promisify(execFile);
const uid = process.getuid();
const nativeIdentityUnavailable = 'AGY native session identity is unavailable; the current conversation could not be verified';
const nativeHistoryUnavailable = 'AGY native history is unavailable: the current transcript could not be verified';
const nativeInputUnavailable = 'AGY native input is unavailable: the status line does not prove the editor can accept input safely';
const callbackRefused = 'AGY status line callback refused: expected the fixed command in a live native TUI';
const hookCallbackRefused = 'AGY hook callback refused: expected a hook invoked by a live native TUI';
const storageUnavailable = 'AGY status line callback refused: private report storage unavailable';
const hintOnly = 'AGY native sessions are report-only; use the original terminal';
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const conversationId = new RegExp(`^${uuid}$`, 'u');
const nativeId = new RegExp(`^agy:native-([1-9]\\d{0,9})\\.([0-9a-f]{16})-${uuid}$`, 'u');
const receiptName = /^pid-([1-9]\d{0,9})\.json$/u;
const reportLimit = 4096;
const transcriptLimit = 32 * 1024 * 1024;
const observeMs = 850;
const statuses = new Set(['unknown', 'idle', 'running', 'blocked', 'failed']);
const hookEvents = new Set(['SessionStart', 'PreInvocation', 'Stop']);
const processId = /^agy:pid-([1-9]\d{0,9})$/u;
const withValue = new Set(['--add-dir', '--agent', '--conversation', '--effort', '--log-file', '--mode', '--model', '--prompt-interactive', '--resume', '--settings', '-i', '-r']);
const switches = new Set(['--continue', '--dangerously-skip-permissions', '--sandbox', '-c']);
const userRequestTag = /<USER_REQUEST>\r?\n?([\s\S]*?)\r?\n?<\/USER_REQUEST>/u;

function interactiveArgs(argv) {
  if (!Array.isArray(argv) || !argv.length || argv.some(arg => typeof arg !== 'string')) return false;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    const equals = arg.indexOf('=');
    const flag = equals < 0 ? arg : arg.slice(0, equals);
    if (switches.has(flag) && (equals < 0 || ['true', 'false'].includes(arg.slice(equals + 1)))) continue;
    if (!withValue.has(flag)) return false;
    const value = equals < 0 ? argv[++i] : arg.slice(equals + 1);
    if (!value || (equals < 0 && value.startsWith('-'))) return false;
  }
  return true;
}

function onTTY(tty) { return !!tty && tty !== '?' && tty !== '??' && tty !== '-'; }

function interactive(row) {
  return Number.isSafeInteger(row.pid) && row.pid > 0 && row.isAgy === true && onTTY(row.tty)
    && typeof row.birth === 'string' && row.birth && interactiveArgs(row.argv);
}

async function command(file, argv) {
  return (await exec(file, argv, { timeout: 1500, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } })).stdout;
}

async function selectedExecutable(name) {
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    const path = resolve(directory, name);
    try { await access(path, constants.X_OK); } catch { continue; }
    // 相对 PATH 项不具备稳定身份，不能跳过它再归因给后面的安装。
    return isAbsolute(directory) ? path : null;
  }
  return null;
}

async function installation() {
  const path = await selectedExecutable('agy');
  if (path) {
    try {
      const exe = await realpath(path);
      const info = await stat(exe, { bigint: true });
      if (info.isFile() && !(info.mode & 0o022n)) return { info, names: [...new Set([path, exe, 'agy'])].sort((a, b) => b.length - a.length) };
    } catch { /* 无法确认 PATH 上选定的安装，不回退到其他副本。 */ }
  }
  return null;
}

function sameFile(a, b) { return a.dev === b.dev && a.ino === b.ino; }

export function macArgv(args, names) {
  const executable = names.find(name => args === name || args.startsWith(`${name} `));
  if (!executable) return null;
  // ps 会展平 argv；只接受可明确判定为交互启动的形式，空格歧义不猜测。
  return args === executable ? [executable] : [executable, ...args.slice(executable.length + 1).split(' ')];
}

async function macOsInfo(pids) {
  const raw = await command('/bin/ps', ['-ww', '-p', pids.join(','), '-o', 'pid=,ppid=,uid=,pgid=,tpgid=,tty=,stat=,lstart=,args=']).catch(() => '');
  const rows = [];
  for (const line of raw.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(\S+)\s+([A-Za-z]{3} [A-Za-z]{3}\s+\d{1,2} \d\d:\d\d:\d\d \d{4})\s+(.+)$/u.exec(line);
    if (!m || Number(m[3]) !== uid || m[4] !== m[5] || !onTTY(m[6]) || /^[TZ]/u.test(m[7])) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), group: Number(m[4]), tty: m[6], birth: m[8], args: m[9] });
  }
  return rows;
}

function sameMacProcess(a, b) {
  return a && b && a.pid === b.pid && a.ppid === b.ppid && a.birth === b.birth && a.tty === b.tty && a.group === b.group && a.args === b.args;
}

async function macFiles(pids) {
  const data = await command('/usr/sbin/lsof', ['-nP', '-b', '-w', '-a', '-p', pids.join(','), '-d', 'cwd,txt', '-F0fDtin']).catch(() => '');
  const files = new Map();
  let row;
  for (const record of data.split('\0\n')) {
    const fields = record.split('\0');
    const first = fields[0];
    if (/^p\d+$/u.test(first)) {
      const pid = Number(first.slice(1));
      row = { exe: null, cwd: null };
      files.set(pid, row);
    } else if (row && first === 'fcwd' && fields.includes('tDIR')) {
      row.cwd = fields.find(field => field.startsWith('n'))?.slice(1) || null;
    } else if (row && first === 'ftxt' && row.exe === null) {
      // 首个 txt 是进程映像，后续条目可为 dylib 或任意 mmap 文件，不可用。
      const dev = fields.find(field => /^D0x[0-9a-f]+$/iu.test(field));
      const ino = fields.find(field => /^i\d+$/u.test(field));
      row.exe = fields.includes('tREG') && dev && ino ? { dev: BigInt(dev.slice(1)), ino: BigInt(ino.slice(1)) } : false;
    }
  }
  return files;
}

async function macProcesses(pids, install) {
  const before = new Map((await macOsInfo(pids)).filter(row => interactiveArgs(macArgv(row.args, install.names))).map(row => [row.pid, row]));
  if (!before.size) return [];
  const files = await macFiles([...before.keys()]);
  if (!files.size) return [];
  const after = await macOsInfo([...files.keys()]);
  return after.flatMap(row => {
    const file = files.get(row.pid);
    if (!file.exe || !sameFile(file.exe, install.info) || !sameMacProcess(row, before.get(row.pid))) return [];
    const { args, ...identity } = row;
    return [{ ...identity, argv: macArgv(args, install.names), isAgy: true, cwd: file.cwd && isAbsolute(file.cwd) ? file.cwd : null }];
  });
}

async function fixedStatusCommand(args) {
  const match = /^(?:\/bin\/sh|sh) -c (.+) integration agy-statusline && :$/u.exec(args);
  if (!match) return false;
  const word = match[1];
  const path = word === 'perch' ? await selectedExecutable(word) : /^'([^'\u0000-\u001f\u007f]+)'$/u.exec(word)?.[1] ?? (/^[\w./-]+$/u.test(word) ? word : '');
  if (!path || !isAbsolute(path)) return false;
  try { return await realpath(path) === await realpath(entry); } catch { return false; }
}

// 实测简单命令被 shell exec 优化成 agy 的直接子进程；只接受留下固定 argv
// 的 sh -c。即使如此也只是状态报告，不是读聊天或代替用户操作的授权。
async function inspectStatusSource() {
  if (process.platform !== 'darwin' || !fstatSync(0).isFIFO()) return undefined;
  const shellPid = process.ppid;
  const [shell] = await macOsInfo([shellPid]);
  if (!shell || !await fixedStatusCommand(shell.args)) return undefined;
  const [files, shells, next] = await Promise.all([
    macFiles([shellPid]),
    Promise.all(['/bin/sh', '/bin/bash'].map(path => stat(path, { bigint: true }).catch(() => null))),
    macOsInfo([shellPid, shell.ppid]),
  ]);
  const exe = files.get(shellPid)?.exe;
  const tui = next.find(row => row.pid === shell.ppid);
  if (!exe || !shells.some(file => file && sameFile(file, exe)) || process.ppid !== shellPid
    || !sameMacProcess(shell, next.find(row => row.pid === shellPid)) || !tui || shell.tty !== tui.tty || shell.group !== tui.group) return undefined;
  return tui;
}

function linuxStat(text) {
  const fields = text.slice(text.lastIndexOf(') ') + 2).trim().split(/\s+/u);
  const [state, ppid, pgid, , tty, tpgid] = fields;
  if (/^[TZ]/u.test(state) || tty === '0' || pgid !== tpgid || !/^\d+$/u.test(fields[19])) return null;
  return { ppid: Number(ppid), tty, ticks: fields[19] };
}

async function linuxProcess({ pid, tty }, boot, install) {
  const dir = `/proc/${pid}`;
  try {
    const before = linuxStat(await readFile(join(dir, 'stat'), 'utf8'));
    if (!before || Number((await stat(dir)).uid) !== uid) return null;
    const [exe, raw, cwd] = await Promise.all([
      stat(join(dir, 'exe'), { bigint: true }),
      readFile(join(dir, 'cmdline'), 'utf8'),
      readlink(join(dir, 'cwd')).catch(() => null),
    ]);
    if (!sameFile(exe, install.info) || !raw.endsWith('\0')) return null;
    const argv = raw.slice(0, -1).split('\0');
    if (!interactiveArgs(argv)) return null;
    const after = linuxStat(await readFile(join(dir, 'stat'), 'utf8'));
    const currentExe = await stat(join(dir, 'exe'), { bigint: true });
    if (!after || after.ticks !== before.ticks || after.tty !== before.tty || after.ppid !== before.ppid || !sameFile(exe, currentExe)) return null;
    return { pid, ppid: after.ppid, tty, birth: `${boot}:${after.ticks}:${after.tty}`, argv, isAgy: true, cwd: cwd && isAbsolute(cwd) ? cwd : null };
  } catch { return null; }
}

async function inspectProcesses(pid) {
  const install = await installation();
  if (!install) return [];
  if (process.platform === 'darwin' && pid !== undefined) return macProcesses([pid], install);
  const candidates = pid !== undefined ? [] : (await processes().catch(() => []))
    .filter(row => onTTY(row.tty) && macArgv(row.args, install.names));
  if (process.platform === 'darwin') return candidates.length ? macProcesses(candidates.map(row => row.pid), install) : [];
  if (process.platform === 'linux') {
    const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8').catch(() => '')).trim();
    if (!boot) return [];
    if (pid !== undefined) {
      const tty = (await command('/bin/ps', ['-p', String(pid), '-o', 'tty=']).catch(() => '')).trim();
      if (!onTTY(tty)) return [];
      const row = await linuxProcess({ pid, tty }, boot, install);
      return row ? [row] : [];
    }
    return (await Promise.all(candidates.map(row => linuxProcess(row, boot, install)))).filter(Boolean);
  }
  return [];
}

function processRow(row) {
  return { id: `agy:pid-${row.pid}`, _agy: 'process', kind: 'process', provider: 'agy', pid: row.pid, cwd: row.cwd ?? null, title: null,
    status: 'unknown', send: false, history: false, wait: false, close: false, sendReason: nativeIdentityUnavailable, historyReason: nativeHistoryUnavailable };
}

export function nativeReceiptDirectory() {
  const scope = createHash('sha256').update(resolve(homedir())).digest('hex').slice(0, 16);
  return join(process.platform === 'darwin' ? '/private/tmp' : '/tmp', `agent-session-agy-native-${uid}-${scope}`);
}

function pidFrom(match) {
  const pid = Number(match?.[1]);
  return pid > 0 && pid <= 2147483647 ? pid : undefined;
}

function generation(row) {
  return createHash('sha256').update(`${row.pid}\0${row.birth}\0${row.tty}`).digest('hex').slice(0, 16);
}

async function privateReceiptDirectory(path) {
  const file = await lstat(path);
  if (!file.isDirectory() || file.uid !== uid || (file.mode & 0o7777) !== 0o700) throw new Error(storageUnavailable);
  return file;
}

function privateReceipt(file) {
  return file.isFile() && file.uid === uid && file.nlink === 1 && (file.mode & 0o7777) === 0o600 && file.size > 0 && file.size < reportLimit;
}

function safeTitle(value) {
  return typeof value === 'string' && value.length <= 256 && value.trim() && !/[\x00-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]/u.test(value) ? value : null;
}

async function parentPid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return 0;
  if (process.platform === 'darwin') {
    const raw = (await command('/bin/ps', ['-p', String(pid), '-o', 'uid=,ppid=']).catch(() => '')).trim();
    const match = /^(\d+)\s+(\d+)$/u.exec(raw);
    return match && Number(match[1]) === uid ? Number(match[2]) : 0;
  }
  if (process.platform === 'linux') {
    try {
      const dir = `/proc/${pid}`;
      if (Number((await stat(dir)).uid) !== uid) return 0;
      const text = await readFile(join(dir, 'stat'), 'utf8');
      const fields = text.slice(text.lastIndexOf(') ') + 2).trim().split(/\s+/u);
      const ppid = Number(fields[1]);
      return Number.isSafeInteger(ppid) && ppid > 0 ? ppid : 0;
    } catch { return 0; }
  }
  return 0;
}

async function inspectHookSourceWith(inspect) {
  let candidate = process.ppid;
  for (let hop = 0; hop < 4 && candidate > 1; hop++) {
    const rows = await inspect(candidate).catch(() => []);
    const match = rows.find(row => interactive(row) && row.pid === candidate);
    if (match) return match;
    candidate = await parentPid(candidate);
  }
  return undefined;
}

function validTranscriptPath(id, candidate) {
  if (typeof id !== 'string' || !conversationId.test(id) || typeof candidate !== 'string' || !isAbsolute(candidate)) return null;
  const gemini = join(resolve(homedir()), '.gemini');
  for (const app of ['antigravity-cli', 'antigravity', 'antigravity-ide']) {
    const expected = join(gemini, app, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
    if (candidate === expected) return expected;
  }
  return null;
}

async function sameDirectory(a, b) {
  if (!a || !b || typeof a !== 'string' || typeof b !== 'string' || !isAbsolute(a) || !isAbsolute(b)) return false;
  if (a === b) return true;
  try {
    return await realpath(a) === await realpath(b);
  } catch {
    return false;
  }
}

export function parseAgyTranscript(text, limit = 20) {
  const messages = [];
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || typeof entry !== 'object') continue;
    if (entry.type === 'USER_INPUT' && entry.source === 'USER_EXPLICIT' && typeof entry.content === 'string') {
      const match = userRequestTag.exec(entry.content);
      const body = (match ? match[1] : entry.content).trim();
      if (body) messages.push({ role: 'user', text: body });
    } else if (entry.type === 'PLANNER_RESPONSE' && typeof entry.content === 'string') {
      const body = entry.content.trim();
      if (body) messages.push({ role: 'assistant', text: body });
    }
  }
  return Number.isFinite(limit) ? messages.slice(-limit) : messages;
}

function reportFrom(input, row, observedAt) {
  const id = input?.conversation_id;
  const transcript = validTranscriptPath(id, input?.transcript_path);
  const valid = transcript !== null && input.product === 'antigravity' && input.version === '1.5.16'
    && id === input.session_id && row.cwd && input.cwd === row.cwd;
  const nativeState = valid && input.agent_state;
  const status = !valid ? 'unknown' : input.tool_confirmation_pending === true ? 'blocked'
    : nativeState === 'idle' ? 'idle' : ['working', 'tool_use'].includes(nativeState) ? 'running'
      : nativeState === 'error' ? 'failed' : 'unknown';
  return { version: 1, source: 'statusline', pid: row.pid, generation: generation(row), tty: row.tty, observedAt,
    conversation: valid ? id : null, title: valid ? safeTitle(input.conversation_title) : null, status };
}

async function hookReportFrom(input, row, observedAt) {
  const id = input?.conversationId;
  const transcriptPath = validTranscriptPath(id, input?.transcriptPath);
  const event = input?.hookEventName;
  const cwdOk = row.cwd && await sameDirectory(input?.cwd, row.cwd);
  const valid = transcriptPath !== null && hookEvents.has(event) && cwdOk;
  const status = !valid ? 'unknown'
    : event === 'PreInvocation' ? 'running'
      : event === 'Stop' && input?.fullyIdle === false ? 'running'
        : 'idle';
  return {
    version: 1,
    source: 'hook',
    pid: row.pid,
    generation: generation(row),
    tty: row.tty,
    observedAt,
    conversation: valid ? id : null,
    transcriptPath: valid ? transcriptPath : null,
    title: valid ? safeTitle(input?.conversationTitle) : null,
    status,
    _event: valid ? event : null,
  };
}

async function readReceipt(directory, pid) {
  try {
    const path = join(directory, `pid-${pid}.json`);
    const before = await lstat(path);
    if (!privateReceipt(before)) return null;
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!privateReceipt(info) || !sameFile(before, info) || info.size !== before.size) return null;
      const buffer = Buffer.allocUnsafe(info.size + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead !== info.size) return null;
      const report = JSON.parse(buffer.toString('utf8', 0, bytesRead));
      const source = report?.source === undefined ? 'statusline' : report.source;
      if (report?.version !== 1 || report.pid !== pid || typeof report.tty !== 'string'
        || !['statusline', 'hook'].includes(source)
        || typeof report.generation !== 'string' || !/^[0-9a-f]{16}$/u.test(report.generation)
        || !Number.isSafeInteger(report.observedAt) || report.observedAt > Date.now() || report.observedAt > Math.ceil(info.mtimeMs)
        || (report.conversation !== null && (typeof report.conversation !== 'string' || !conversationId.test(report.conversation)))
        || !statuses.has(report.status)) return null;
      if (source === 'hook') {
        if (report.conversation !== null && !validTranscriptPath(report.conversation, report.transcriptPath)) return null;
        if (report.turnSeq !== undefined && (!Number.isSafeInteger(report.turnSeq) || report.turnSeq < 0)) return null;
      }
      return { ...report, source };
    } finally { await file.close(); }
  } catch { return null; }
}

async function lockReceipts(directory) {
  // 不同回调可并发；系统进程锁保护“比较上次报告 → 原子替换”，
  // 以免处理较慢的回调在切换或撤销之后覆盖新报告。退出即解锁。
  const path = join(directory, '.publish.lock');
  try { closeSync(openSync(path, 'wx', 0o600)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = await lstat(path);
  if (!info.isFile() || info.uid !== uid || info.nlink !== 1 || (info.mode & 0o7777) !== 0o600) throw new Error(storageUnavailable);
  const { DatabaseSync } = await import('node:sqlite');
  const lock = new DatabaseSync(path);
  try {
    const deadline = performance.now() + 120;
    for (;;) {
      try { lock.exec('BEGIN IMMEDIATE'); return lock; }
      catch (error) {
        const busy = (error.errcode & 0xff) === 5 || (error.errno & 0xff) === 5 || error.code === 'SQLITE_BUSY';
        if (!busy || performance.now() >= deadline) throw error;
        await delay(15);
      }
    }
  } catch (error) { lock.close(); throw error; }
}

async function writeReceipt(report) {
  const { _event, ...incoming } = report;
  let next = incoming;
  const directory = nativeReceiptDirectory();
  const temporary = join(directory, `.report-${randomUUID()}`);
  const path = join(directory, `pid-${next.pid}.json`);
  try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const original = await privateReceiptDirectory(directory);
  const lock = await lockReceipts(directory);
  try {
    const existing = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (existing && !privateReceipt(existing)) throw new Error(storageUnavailable);
    const previous = existing && await readReceipt(directory, next.pid);
    if (previous?.observedAt > next.observedAt) return undefined;
    if (previous?.generation === next.generation) {
      if (previous.observedAt === next.observedAt && previous.conversation !== next.conversation) {
        next = { ...next, conversation: null, transcriptPath: null, title: null, status: 'unknown' };
      }
    }
    if (next.source === 'hook') {
      const sameConv = previous?.generation === next.generation && previous?.conversation !== null && previous?.conversation === next.conversation;
      const prevSeq = sameConv && Number.isSafeInteger(previous.turnSeq) ? previous.turnSeq : 0;
      next = {
        ...next,
        title: next.title ?? (sameConv ? previous.title ?? null : null),
        turnSeq: next.conversation === null ? 0 : (_event === 'PreInvocation' ? prevSeq + 1 : prevSeq),
      };
    } else if (previous?.source === 'hook' && previous.generation === next.generation && next.conversation !== null && previous.conversation === next.conversation) {
      next = {
        ...next,
        source: 'hook',
        transcriptPath: previous.transcriptPath,
        turnSeq: previous.turnSeq ?? 0,
        title: next.title ?? previous.title ?? null,
        status: next.status === 'blocked' ? 'blocked' : previous.status,
      };
    }
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.chmod(0o600);
      await file.writeFile(JSON.stringify(next));
    } finally { await file.close(); }
    if (!sameFile(original, await privateReceiptDirectory(directory))) throw new Error(storageUnavailable);
    await rename(temporary, path);
    return next.conversation;
  } finally {
    try {
      if (sameFile(original, await privateReceiptDirectory(directory))) await unlink(temporary).catch(() => {});
    } finally { lock.close(); }
  }
}

function ownsReport(report, row) {
  return !!report && !!row && report.tty === row.tty && report.generation === generation(row);
}

function sessionRow(row, report) {
  if (report.source === 'hook') {
    return {
      ...processRow(row),
      id: `agy:native-${row.pid}.${report.generation}-${report.conversation}`,
      kind: 'session',
      _agy: 'native',
      _nativeSource: 'hook',
      _transcriptPath: report.transcriptPath,
      _turnSeq: report.turnSeq ?? 0,
      title: safeTitle(report.title),
      status: report.status,
      history: true,
      historyMode: 'persisted',
      historyReason: undefined,
      wait: true,
      send: false,
      sendReason: hintOnly,
    };
  }
  return { ...processRow(row), id: `agy:native-${row.pid}.${report.generation}-${report.conversation}`, kind: 'session', _agy: 'native',
    _nativeSource: 'statusline', title: safeTitle(report.title), status: report.status, sendReason: hintOnly };
}

export function createNativeAdapter({ inspectProcesses: inspect = inspectProcesses, inspectStatusSource: verifySource = inspectStatusSource, inspectHookSource: verifyHookSource } = {}) {
  const canObserveStatus = process.platform === 'darwin' || verifySource !== inspectStatusSource;
  const resolveHookSource = verifyHookSource ?? (() => inspectHookSourceWith(inspect));

  async function currentRows(pid) {
    const rows = (await inspect(pid)).filter(row => interactive(row) && (pid === undefined || row.pid === pid));
    return new Map(rows.map(row => [row.pid, row]));
  }

  async function reportsFor(rows, since, pid) {
    const directory = nativeReceiptDirectory();
    try {
      const original = await privateReceiptDirectory(directory);
      const read = async () => {
        const reports = await Promise.all([...rows.values()].map(async row => {
          const report = await readReceipt(directory, row.pid);
          return ownsReport(report, row) ? report : null;
        }));
        return reports.filter(Boolean);
      };
      let reports = await read();
      if (!reports.length) return new Map();
      // hook 收据按生命周期事件写入（SessionStart / PreInvocation / Stop），空闲期持续有效；
      // 状态行收据没有心跳，只有尚未上报的候选才需要在短窗口内等待新鲜证据。
      const eligible = report => report.source === 'hook' || (canObserveStatus && report.observedAt > since);
      const waiting = new Set(reports.filter(report => report.source !== 'hook' && canObserveStatus && report.observedAt <= since).map(report => report.pid));
      const deadline = performance.now() + observeMs;
      while (waiting.size && performance.now() < deadline) {
        await delay(Math.min(45, Math.max(0, deadline - performance.now())));
        reports = await read();
        for (const report of reports) if (eligible(report)) waiting.delete(report.pid);
      }
      // 等待时进程也可能刚退出；不要把开始检查时的 PID 线索带回去。
      const current = await currentRows(pid);
      for (const key of rows.keys()) {
        if (!current.has(key)) rows.delete(key);
        else rows.set(key, current.get(key));
      }
      reports = await read();
      if (pid !== undefined) {
        // 定向查询只复核实际声明同一对话的其他进程，不搜索 provider 数据。
        const requested = reports.find(report => report.pid === pid && report.conversation && eligible(report));
        if (!requested) return new Map();
        for (const name of await readdir(directory)) {
          const other = pidFrom(receiptName.exec(name));
          if (other === undefined || other === pid) continue;
          const claim = await readReceipt(directory, other);
          if (claim?.conversation !== requested.conversation) continue;
          const owner = (await currentRows(other)).get(other);
          if (owner && ownsReport(claim, owner)) return new Map();
        }
        const latest = await readReceipt(directory, pid);
        // 重复归属检查始终针对同一 UUID。它期间的新刷新可以采用，
        // 但新的对话/代际、撤销或更旧的收据都不能替代已检查的报告。
        if (!ownsReport(latest, rows.get(pid)) || latest.observedAt < requested.observedAt || latest.conversation !== requested.conversation || !eligible(latest)) return new Map();
        reports = [latest];
      }
      if (!sameFile(original, await privateReceiptDirectory(directory))) return new Map();
      const counts = new Map();
      for (const report of reports) if (report.conversation) counts.set(report.conversation, (counts.get(report.conversation) ?? 0) + 1);
      return new Map(reports.filter(report => report.conversation && eligible(report) && counts.get(report.conversation) === 1).map(report => [report.pid, report]));
    } catch { return new Map(); }
  }

  async function lookupNative(id) {
    const since = Date.now();
    const native = nativeId.exec(id);
    const pid = pidFrom(native ?? processId.exec(id));
    if (pid === undefined) return undefined;
    const rows = await currentRows(pid);
    const row = rows.get(pid);
    if (!row || !native) return row && processRow(row);
    if (native[2] !== generation(row)) return undefined;
    const report = (await reportsFor(rows, since, pid)).get(pid);
    if (!report || !rows.has(pid)) return undefined;
    const session = sessionRow(rows.get(pid), report);
    return session.id === id ? session : undefined;
  }

  return {
    async listNative() {
      const since = Date.now();
      const rows = await currentRows();
      if (!rows.size) return [];
      const reports = await reportsFor(rows, since);
      return [...rows.values()].map(row => reports.has(row.pid) ? sessionRow(row, reports.get(row.pid)) : processRow(row));
    },
    lookupNative,
    async recordNativeStatus(input) {
      const observedAt = Date.now();
      const source = await verifySource().catch(() => undefined);
      const pid = typeof source === 'number' ? source : source?.pid;
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647) throw new Error(callbackRefused);
      const row = (await currentRows(pid).catch(() => null))?.get(pid);
      if (!row || (typeof source === 'object' && (source.birth !== row.birth || source.tty !== row.tty || source.group !== row.group || source.ppid !== row.ppid))) throw new Error(callbackRefused);
      const report = reportFrom(input, row, observedAt);
      let conversation;
      try { conversation = await writeReceipt(report); } catch { throw new Error(storageUnavailable); }
      return conversation ? 'Perch: AGY conversation observed' : 'Perch: AGY conversation unavailable';
    },
    async recordNativeHook(input) {
      const observedAt = Date.now();
      const source = await resolveHookSource().catch(() => undefined);
      const pid = typeof source === 'number' ? source : source?.pid;
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647) throw new Error(hookCallbackRefused);
      const row = (await currentRows(pid).catch(() => null))?.get(pid);
      if (!row || (typeof source === 'object' && (source.birth !== row.birth || source.tty !== row.tty || source.ppid !== row.ppid))) throw new Error(hookCallbackRefused);
      const report = await hookReportFrom(input, row, observedAt);
      let conversation;
      try { conversation = await writeReceipt(report); } catch { throw new Error(storageUnavailable); }
      return { conversation: conversation ?? null, status: report.status };
    },
    async historyNative(session, limit = 20) {
      if (limit !== Infinity && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error('Invalid history limit');
      if (session?._agy !== 'native' || session._nativeSource !== 'hook') throw new Error(nativeHistoryUnavailable);
      const live = await lookupNative(session.id);
      if (!live || live._nativeSource !== 'hook' || !live._transcriptPath) throw new Error(nativeHistoryUnavailable);
      let file;
      try {
        file = await open(live._transcriptPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw new Error(nativeHistoryUnavailable);
      }
      try {
        const info = await file.stat();
        if (!info.isFile() || info.uid !== uid || info.size > transcriptLimit) throw new Error(nativeHistoryUnavailable);
        const text = await file.readFile('utf8');
        return parseAgyTranscript(text, limit);
      } finally { await file.close(); }
    },
    async waitNative(session, timeoutMs = null) {
      if (timeoutMs !== null && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0)) throw new Error('Invalid wait timeout');
      if (session?._agy !== 'native' || session._nativeSource !== 'hook') throw new Error(nativeIdentityUnavailable);
      const deadline = timeoutMs === null ? Infinity : performance.now() + timeoutMs;
      for (;;) {
        const current = await lookupNative(session.id);
        if (!current) return { status: 'interrupted', error: 'Antigravity CLI stopped unexpectedly' };
        if (current.status === 'idle') return { status: 'completed' };
        if (current.status === 'blocked') return { status: 'needs_input' };
        if (current.status === 'failed') return { status: 'failed' };
        if (performance.now() >= deadline) return { status: 'timeout' };
        await delay(Math.min(150, Math.max(0, deadline - performance.now())));
      }
    },
    async confirmNativeTui(session) {
      // 真机在 /resume 选择器内仍报告 idle；状态行不授权投递文本、提交或任何具名键。
      throw new Error(session?._agy === 'process' ? nativeIdentityUnavailable : nativeInputUnavailable);
    },
  };
}

export const { listNative, lookupNative, recordNativeStatus, recordNativeHook, historyNative, waitNative, confirmNativeTui } = createNativeAdapter();
