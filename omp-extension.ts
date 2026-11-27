import { execFile, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { existsSync, mkdirSync, lstatSync, chmodSync, openSync, writeFileSync, closeSync, realpathSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { systemLanguage } from './locale.mjs';
import { translateDiagnostic } from './diagnostics.mjs';
import { loadPerchConfig, renderPerchSystemPromptWithWarnings, renderRolesTable, type PerchModeConfig, type PerchRoleConfig } from './perch-config.ts';
import { BoardStore, type Command, type ReceiptNotice } from './board/store.ts';
import { createBoardBridge } from './board/bridge.ts';
import { DiscussionFailure, summarizeDiscussion, type DiscussionModelContext } from './board/discussion.ts';
import { startBoardWeb } from './board/web.ts';
import {
  actorFor, awaitSpawn, boardPath, boardView, captureTurn, itemSummary, managerGuidance, mutationSummary, newSpawnToken,
  perchWorkerBoardPrompt, promptSpawnToken, recordPerchWorkerReceipt, recordTurn, rootSession, runBoardCommand, withBoard,
  workerContext, workerDecisionVersion, type CapturedTurn, type SessionContext, type TodoPhase,
} from './board/runtime.ts';

const execFileAsync = promisify(execFile);

const PROVIDERS = new Set(['omp', 'codex', 'claude', 'agy']);
const NATIVE_DEFAULT_PROVIDERS = new Set(['omp', 'agy']);
const PANES = new Set(['right', 'tern', 'tmux', 'herdr']);
const MAX_CLI_STDOUT = 16 * 1024 * 1024;
const MAX_NOTIFICATION_CHARS = 4000;
const MAX_HEARTBEAT_PREVIEW_CHARS = 600;
const DEFAULT_HEARTBEAT_SECONDS = 180;
const DEFAULT_NATIVE_DISCOVER_MS = 40000;
const SEND_BUSY_GRACE_MS = 3000;

type PaneRef = {
  backend: string;
  id: string;
};

type PerchToolParams = {
  op: string;
  role?: string;
  provider?: string;
  id?: string;
  name?: string;
  owned?: boolean;
  native?: boolean;
  cwd?: string;
  model?: string;
  executable?: string;
  pane?: string;
  workspace?: string;
  tab?: string;
  prompt?: string;
  text?: string;
  item?: string;
  boardRole?: 'execute' | 'review';
  notify?: boolean;
  heartbeatSeconds?: number;
  timeout?: number;
  limit?: number;
  all?: boolean;
};

type CliRunResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

type TaskState = 'idle' | 'running' | 'completed' | 'failed' | 'needs_input' | 'interrupted';

type TrackedTask = {
  id: string;
  name?: string;
  role?: string;
  provider?: string;
  mode?: 'managed' | 'native';
  model?: string;
  cwd?: string;
  pane?: PaneRef;
  boardItem?: string;
  boardRoot?: string;
  state: TaskState;
  unhandled: boolean;
  turnSeq: number;
  finishSeq: number;
  startedAt?: number;
  finishedAt?: number;
  acknowledgedAt?: number;
  error?: string;
  heartbeatCount: number;
};

type RetiredWorker = {
  id: string;
  name?: string;
  role?: string;
  provider?: string;
  mode: 'managed' | 'native';
  model?: string;
  cwd?: string;
  boardItem?: string;
  boardRoot?: string;
  retiredAt: number;
};

type WatcherEntry = {
  controller: AbortController;
  generation: number;
  timer?: ReturnType<typeof setInterval>;
};

type LiveOwner = {
  sessionManager: { getSessionId(): string; getSessionFile(): string | undefined };
  getToolByName?(name: string): unknown;
  getTodoPhases?(): TodoPhase[];
};

function resolvePerchInvocation(): [string, string[]] {
  const override = process.env.PERCH_BIN?.trim();
  if (override) return [override, []];
  try {
    const url = import.meta.url;
    if (typeof url === 'string' && url.startsWith('file:')) {
      const cliPath = join(dirname(fileURLToPath(url)), 'cli.mjs');
      if (existsSync(cliPath)) {
        const runtime = /node(?:\.exe)?$/i.test(process.execPath) ? process.execPath : 'node';
        return [runtime, [cliPath]];
      }
    }
  } catch {}
  return ['perch', []];
}

function runPerchCli(
  args: string[],
  options: { input?: string; signal?: AbortSignal; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<CliRunResult> {
  return new Promise((resolve, reject) => {
    const [command, prefix] = resolvePerchInvocation();
    const child = spawn(command, [...prefix, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: options.env ?? process.env,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error: Error | null, result?: CliRunResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(result!);
    };
    const killChild = () => {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGTERM'); } catch {}
      }
    };
    const onAbort = () => {
      killChild();
      finish(Object.assign(new Error('Perch command aborted'), { name: 'AbortError' }));
    };
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        killChild();
        finish(new Error(`Perch command timed out after ${options.timeoutMs}ms`));
      }, options.timeoutMs);
      timer.unref?.();
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (Buffer.byteLength(stdout) + Buffer.byteLength(chunk) > MAX_CLI_STDOUT) {
        killChild();
        finish(new Error('Perch output exceeded size limit'));
        return;
      }
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      if (Buffer.byteLength(stderr) < 256 * 1024) stderr += chunk;
    });
    child.stdin.on('error', () => {});
    child.once('error', error => finish(error));
    child.once('close', (code, signal) => finish(null, { code, signal, stdout, stderr }));
    if (options.input !== undefined) child.stdin.end(options.input, 'utf8');
    else child.stdin.end();
  });
}

function parseJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  return JSON.parse(trimmed);
}

function cliErrorMessage(result: CliRunResult, fallback: string): string {
  const detail = result.stderr.trim() || result.stdout.trim();
  return detail || fallback;
}

function sanitizeName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const cleaned = value.replace(/[\x00-\x1f\x7f-\x9f]/gu, '').trim();
  if (!cleaned) return undefined;
  return cleaned.slice(0, 64);
}

function resolveHeartbeatMs(heartbeatSeconds: number | undefined, config: PerchModeConfig, perchModeEnabled: boolean): number {
  if (heartbeatSeconds !== undefined) {
    if (!Number.isSafeInteger(heartbeatSeconds) || heartbeatSeconds < 0 || heartbeatSeconds > 86400) {
      throw new Error('heartbeatSeconds must be an integer between 0 and 86400');
    }
    return heartbeatSeconds * 1000;
  }
  const envValue = process.env.PERCH_HEARTBEAT_MS?.trim();
  if (envValue !== undefined && envValue !== '') {
    const parsed = Number(envValue);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  if (perchModeEnabled || config.sources.length > 0) {
    return config.heartbeatSeconds * 1000;
  }
  return DEFAULT_HEARTBEAT_SECONDS * 1000;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

function clipText(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: `${text.slice(0, limit)}\n...[truncated; call perch op=history to inspect full output]`, truncated: true };
}

function taskLabel(id: string, task: TrackedTask | undefined): string {
  const meta = [task?.role, task?.provider, task?.model].filter(Boolean).join(' / ');
  const base = task?.name ? `${task.name} (${id})` : id;
  return meta ? `${base} [${meta}]` : base;
}

const MAX_RETIRED_WORKERS = 50;
const CLOSED_SESSION_RE = /Session is closed|Session no longer listed|is no longer running|stopped unexpectedly|No session found|Unknown session|local endpoint unavailable|OMP RPC process (?:exited|unavailable)|会话已关闭|会话已不在列表中|已停止|未找到会话|本地端点不可用|OMP RPC 进程|意外停止/i;

function extractNativeResumeId(provider: string | undefined, id: string): string | undefined {
  const effectiveProvider = provider ?? (id.includes(':') ? id.split(':', 1)[0] : undefined);
  if (effectiveProvider === 'agy') {
    const nativeMatch = /^agy:native-[1-9]\d{0,9}\.[0-9a-f]{16}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(id);
    if (nativeMatch) return nativeMatch[1];
    const directMatch = /^agy:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(id);
    return directMatch?.[1];
  }
  if (effectiveProvider === 'omp') {
    if (id.startsWith('omp:pid-')) return undefined;
    const match = /^omp:([^\s:]+)$/.exec(id);
    return match?.[1];
  }
  return undefined;
}

function isResumableWorker(info: { id: string; provider?: string; mode?: 'native' | 'managed' }): boolean {
  const provider = info.provider ?? (info.id.includes(':') ? info.id.split(':', 1)[0] : undefined);
  if (!provider || !NATIVE_DEFAULT_PROVIDERS.has(provider)) return false;
  if (info.mode === 'native') {
    return !!extractNativeResumeId(provider, info.id);
  }
  // Managed resume (`perch resume`) only supports stable omp/agy conversation IDs (not pid- or codex/claude)
  if (info.id.startsWith('omp:pid-') || info.id.startsWith('agy:pid-')) return false;
  return info.id.startsWith(`${provider}:`) && info.id.length > provider.length + 1;
}

function resolveNativeDiscoverMs(config?: PerchModeConfig): number {
  const raw = process.env.PERCH_NATIVE_DISCOVER_MS?.trim();
  if (raw !== undefined && raw !== '') {
    const parsed = Number(raw);
    if (Number.isSafeInteger(parsed) && parsed >= 100 && parsed <= 120000) return parsed;
  }
  return config?.discoverTimeoutMs ?? DEFAULT_NATIVE_DISCOVER_MS;
}

function canonicalDir(value: string | undefined): string | null {
  if (!value) return null;
  try { return realpathSync(value); } catch { return resolve(value); }
}

function normalizePaneRef(raw: unknown): PaneRef | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as { backend?: unknown; id?: unknown };
  if (typeof obj.backend !== 'string' || !['tern', 'tmux', 'herdr'].includes(obj.backend)) return undefined;
  if (typeof obj.id !== 'string' && typeof obj.id !== 'number') return undefined;
  const id = String(obj.id).trim();
  return id ? { backend: obj.backend, id } : undefined;
}

async function closePaneRef(pane: PaneRef | undefined): Promise<boolean> {
  if (!pane) return false;
  try {
    if (pane.backend === 'tern') {
      await execFileAsync('tern', ['close', pane.id], { timeout: 5000 });
      return true;
    }
    if (pane.backend === 'tmux') {
      await execFileAsync('tmux', ['kill-pane', '-t', pane.id], { timeout: 5000 });
      return true;
    }
    if (pane.backend === 'herdr') {
      await execFileAsync('herdr', ['pane', 'close', pane.id], { timeout: 5000 });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

async function isTernBlockLive(blockId: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('tern', ['ls', '--json'], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 });
    const parsed = JSON.parse(stdout) as { sessions?: Array<{ tabs?: Array<{ blocks?: Array<{ id?: unknown; live?: boolean }> }> }> };
    for (const session of parsed.sessions ?? []) {
      for (const tab of session.tabs ?? []) {
        for (const block of tab.blocks ?? []) {
          if (String(block.id) === blockId && block.live === true) return true;
        }
      }
    }
  } catch {}
  return false;
}

function stageAgyNativePrompt(uid: number, text: string): string {
  const promptDir = join(process.platform === 'darwin' ? '/private/tmp' : '/tmp', `agent-session-agy-prompts-${uid}`);
  try {
    mkdirSync(promptDir, { mode: 0o700 });
  } catch (error: unknown) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
  }
  const info = lstatSync(promptDir);
  if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o077) !== 0) {
    throw new Error('Private prompt staging directory is unavailable');
  }
  const filePath = join(promptDir, `msg-${randomBytes(12).toString('hex')}.md`);
  const fd = openSync(filePath, 'wx', 0o600);
  try {
    writeFileSync(fd, text, 'utf8');
  } finally {
    closeSync(fd);
  }
  return filePath;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function perchCommandLine(): string {
  const [command, prefix] = resolvePerchInvocation();
  return [command, ...prefix].map(shellQuote).join(' ');
}

function buildBoardWorkerGuide(commandLine: string, socket: string, token: string, role: 'execute' | 'review', itemId: string | undefined): string {
  const base = `${commandLine} board <op> --socket ${shellQuote(socket)} --token ${token}`;
  const ops = [
    '  snapshot                         live item, acceptance criteria, handoffs and related decisions',
    '  progress --text "..." [--handoff]   record milestones, confirmed/ruled-out findings, blockers (--handoff keeps it for the next worker)',
    ...(role === 'execute'
      ? ['  submit --text "evidence"          submit for independent review once the acceptance criteria are met']
      : [
        '  approve --text "evidence"         approve the item when it meets the criteria (you cannot review work you executed)',
        '  reject --target same|pool --text "reason"   send it back to the same executor or the pool',
      ]),
    '  decide --title "..." --text "..." record a decision on your item',
  ];
  return [
    '[Session Board access]',
    `You are bound to board item ${itemId ?? '(assigned by the director)'} as ${role}. Read and update it from your shell (works in any provider):`,
    `  ${base}`,
    'Operations (each runs against your own item only; errors are printed and nothing is applied):',
    ...ops,
    'Use it at real milestones and before handoff, not for routine steps. Your final reply is recorded automatically but never submits or approves.',
  ].join('\n');
}

function buildWorkerPrompt(
  rawPrompt: string,
  config: PerchModeConfig,
  roleCfg: PerchRoleConfig | undefined,
  boardContext: string | undefined,
): string {
  const parts: string[] = [];
  if (config.workerPromptPrefix && !rawPrompt.includes(config.workerPromptPrefix.slice(0, 24))) {
    parts.push(config.workerPromptPrefix);
  }
  if (roleCfg) {
    const roleHints: string[] = [];
    if (roleCfg.promptPrefix) roleHints.push(roleCfg.promptPrefix);
    if (roleCfg.write === false) roleHints.push('只读边界：本轮禁止修改源码、配置文件或执行提交/推送。');
    if (roleCfg.constraints) roleHints.push(`角色约束：${roleCfg.constraints}`);
    if (roleHints.length) parts.push(`[Role: ${roleCfg.name}${roleCfg.label ? ` / ${roleCfg.label}` : ''}]\n${roleHints.join('\n')}`);
  }
  if (boardContext) parts.push(boardContext);
  parts.push(rawPrompt);
  return parts.join('\n\n');
}

function formatNotification(
  id: string,
  status: string,
  task: TrackedTask | undefined,
  errorText: string | undefined,
  replyText: string | undefined,
  receiptRecorded = false,
): string {
  const lines = [
    '[Perch async update]',
    `Session: ${taskLabel(id, task)}${task?.turnSeq ? ` (turn #${task.turnSeq})` : ''}`,
    `Status: ${status}${errorText ? ` — ${errorText}` : ''}`,
  ];
  if (task?.boardItem) {
    lines.push(receiptRecorded
      ? `Board item: ${task.boardItem} (receipt recorded; inspect item & acceptance criteria before submitting/approving)`
      : `Board item: ${task.boardItem} (receipt not recorded; check current board binding before updating status)`);
  }
  if (replyText) {
    const clipped = clipText(replyText, MAX_NOTIFICATION_CHARS);
    lines.push('Latest assistant reply:', clipped.text);
  }
  const ref = task?.name ?? id;
  lines.push(`Action: inspect this result, report to the user, and either reuse this worker (perch op=send id="${ref}") to preserve context or close it (perch op=close id="${ref}") when done.`);
  return lines.join('\n');
}

function formatHeartbeat(
  id: string,
  task: TrackedTask | undefined,
  elapsedMs: number,
  heartbeatCount: number,
  replyPreview: string | undefined,
): string {
  const lines = [
    '[Perch heartbeat]',
    `Session: ${taskLabel(id, task)}`,
    `Status: still running (elapsed ${formatDuration(elapsedMs)}, check #${heartbeatCount})`,
    'Action: inspect with perch op=history or op=wait(timeout=0), or close with op=close if stuck.',
  ];
  if (replyPreview) {
    lines.push('Latest visible assistant output:', clipText(replyPreview, MAX_HEARTBEAT_PREVIEW_CHARS).text);
  }
  return lines.join('\n');
}

function formatLedger(activeTasks: TrackedTask[], now: number): string {
  const rows = activeTasks.map(task => {
    const label = taskLabel(task.id, task);
    const boardTag = task.boardItem ? ` [board:${task.boardItem}]` : '';
    const turnTag = task.turnSeq ? `turn #${task.turnSeq}, ` : '';
    if (task.state === 'running') {
      const elapsed = task.startedAt !== undefined ? `elapsed ${formatDuration(now - task.startedAt)}` : 'starting';
      return `- ${label}${boardTag}: running (${turnTag}${elapsed})`;
    }
    const err = task.error ? ` — ${task.error}` : '';
    const flag = task.unhandled ? ' [UNHANDLED — inspect/report via perch history|send|close]' : '';
    return `- ${label}${boardTag}: ${task.state}${err}${flag}`;
  });
  return [
    '[Perch active task ledger]',
    ...rows,
    'Track every running or UNHANDLED task above; do not drop dispatched work.',
  ].join('\n');
}

function formatWorkspaceView(allTasks: TrackedTask[], resumableRetired: RetiredWorker[], now: number): string {
  const lines: string[] = ['[Perch workspace view]'];
  if (allTasks.length) {
    lines.push('Open workers (live panes/sessions):');
    for (const task of allTasks) {
      const label = taskLabel(task.id, task);
      const paneTag = task.pane ? ` [pane:${task.pane.backend}:${task.pane.id}]` : '';
      const boardTag = task.boardItem ? ` [board:${task.boardItem}]` : '';
      const ref = task.name ?? task.id;
      const openKind = task.pane ? 'open pane' : 'open session';
      if (task.state === 'running') {
        const turnTag = task.turnSeq ? `turn #${task.turnSeq}, ` : '';
        const elapsed = task.startedAt !== undefined ? `elapsed ${formatDuration(now - task.startedAt)}` : 'starting';
        lines.push(`- ${label}${paneTag}${boardTag}: running (${turnTag}${elapsed})`);
      } else if (task.unhandled) {
        const err = task.error ? ` — ${task.error}` : '';
        lines.push(`- ${label}${paneTag}${boardTag}: ${task.state}${err} [UNHANDLED — inspect/report, then send or close]`);
      } else if (task.finishedAt === undefined) {
        lines.push(`- ${label}${paneTag}${boardTag}: ready (${openKind} — send via perch op=send id="${ref}" or close via perch op=close id="${ref}")`);
      } else {
        const idleBase = Math.max(task.finishedAt, task.acknowledgedAt ?? 0);
        const idleFor = formatDuration(now - idleBase);
        const statusWord = task.state === 'completed' || task.state === 'idle' ? 'finished' : task.state;
        const err = task.error ? ` — ${task.error}` : '';
        lines.push(`- ${label}${paneTag}${boardTag}: idle (${statusWord} ${idleFor} ago${err}; ${openKind} — reuse via perch op=send id="${ref}" or close via perch op=close id="${ref}")`);
      }
    }
  }
  const recentResumable = resumableRetired.slice(-8);
  if (recentResumable.length) {
    const names = recentResumable.map(r => `${r.name ?? r.id}${r.role ? ` [${r.role}]` : ''}`).join(', ');
    lines.push(`Closed resumable workers (auto-resumes on perch op=send id="<name>"): ${names}`);
  }
  lines.push('Track running/UNHANDLED work above; close idle open panes/sessions you no longer need (you can always auto-resume them later via perch op=send).');
  return lines.join('\n');
}

function discussionText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap(part => part && typeof part === 'object' && (part as { type?: string }).type === 'text' && typeof (part as { text?: unknown }).text === 'string'
    ? [(part as { text: string }).text]
    : []).join('\n');
}

function safeSessionFile(ctx: ExtensionContext | undefined): string | undefined {
  try {
    const sm = ctx?.sessionManager as { getSessionFile?: () => string | undefined } | undefined;
    const file = sm?.getSessionFile?.();
    return typeof file === 'string' && file.endsWith('.jsonl') ? file : undefined;
  } catch {
    return undefined;
  }
}

// Loaded explicitly or through the user's opt-in OMP integration.
type CommandCompletion = { value: string; label: string; description?: string };

const PERCH_SUBCOMMANDS: CommandCompletion[] = [
  { value: 'on', label: 'on', description: 'Enable /perch orchestration mode' },
  { value: 'off', label: 'off', description: 'Disable /perch mode and restore default tools' },
  { value: 'toggle', label: 'toggle', description: 'Toggle /perch mode' },
  { value: 'status', label: 'status', description: 'Show tracked workers' },
  { value: 'roles', label: 'roles', description: 'Show configured roles' },
  { value: 'close', label: 'close', description: 'Close worker panes: close <name> | all' },
];

/** Argument completions for `/perch`: subcommands, then worker names after `close`. Free-form prompts get none. */
export function completePerchCommand(
  prefix: string,
  workers: Iterable<{ id: string; name?: string; state?: string }>,
): CommandCompletion[] | null {
  const close = /^close\s+(\S*)$/.exec(prefix);
  if (close) {
    const typed = close[1] ?? '';
    const options: CommandCompletion[] = [{ value: 'all', label: 'all', description: 'Close every tracked worker pane' }];
    const seen = new Set(['all']);
    for (const worker of workers) {
      const key = worker.name || worker.id;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      options.push({ value: key, label: key, description: worker.state ? `worker · ${worker.state}` : 'worker' });
    }
    const matches = options.filter(option => option.value.startsWith(typed));
    return matches.length ? matches.map(option => ({ ...option, value: `close ${option.value}` })) : null;
  }
  if (/\s/.test(prefix)) return null;
  const matches = PERCH_SUBCOMMANDS.filter(option => option.value.startsWith(prefix));
  return matches.length ? matches : null;
}

export default function (pi: ExtensionAPI) {
  const uid = process.getuid?.();
  if (uid === undefined) return;
  const dir = `/tmp/agent-session-${uid}`;
  const name = `${process.pid}-${randomBytes(16).toString('hex')}.sock`;
  const path = join(dir, name);
  let current: ExtensionContext | undefined;
  let identity = '';
  let server: Server | undefined;
  let stopping = false;
  let sessionEpoch = 0;
  let watcherGeneration = 0;
  let finishCounter = 0;
  let pendingLedgerAck: Map<string, number> | undefined;
  // Guard native OMP `send -> wait` race until agent loop flips isIdle() or emits agent_end.
  let sendSeq = 0;
  let agentEndSeq = 0;
  let pendingSendUntil = 0;

  // /perch mode state
  let perchModeEnabled = false;
  let savedToolsBeforePerch: string[] | undefined;

  // Session board state (merged from omp-vibe-spawn)
  let turn: CapturedTurn | undefined;
  let decisionVersion: string | undefined;
  let mainRoot: string | undefined;
  let previousRoot: string | undefined;
  let unsubscribeRegistry: (() => void) | undefined;
  let decisionWatch: { root: string; store: BoardStore; version: number } | undefined;
  let receiptContext: { root: string; sessionId: string; owner?: LiveOwner; notices: ReceiptNotice[] } | undefined;
  let web: { root: string; sessionId: string; owner?: LiveOwner; store: BoardStore; server: { url: string; close(): void } } | undefined;
  const discussionProcessing = new Map<string, { again: boolean }>();

  const admissions = new Set<Promise<void>>();
  const ownedSessions = new Set<string>();
  const tasks = new Map<string, TrackedTask>();
  const retiredWorkers = new Map<string, RetiredWorker>();
  const boardBridge = createBoardBridge(uid);
  const roleReviewers = new Map<string, string>();
  const reviewsInFlight = new Set<string>();
  const reviewControllers = new Set<AbortController>();
  const lastReviewedHash = new Map<string, string>();
  let lastUserPrompt = '';
  let lastAssistantText = '';
  let reviewSkipNext = false;
  const warnedPromptMessages = new Set<string>();
  const watchers = new Map<string, WatcherEntry>();
  const inFlightSends = new Set<string>();
  const nativeLaunchChains = new Map<string, Promise<void>>();
  const rightPaneStack: Array<{ id: string; sessionId: string }> = [];
  let idleReaperTimer: ReturnType<typeof setInterval> | undefined;
  let reapingIdle = false;

  const isManagedWorker = process.env.PERCH_MANAGED_WORKER === '1';

  const anyPi = pi as unknown as {
    pi?: { AgentRegistry?: { global(): { get(id: string): { session?: unknown } | undefined; onChange(cb: (ev: { type: string; ref: { kind: string; id: string; status: string; sessionFile?: string } }) => void): () => void } } };
    arktype?: (schema: Record<string, unknown>) => unknown;
    registerTool?: (tool: Record<string, unknown>) => void;
    registerCommand?: (name: string, def: Record<string, unknown>) => void;
    getActiveTools?: () => string[];
    setActiveTools?: (names: string[]) => Promise<void>;
    appendEntry?: (customType: string, data?: unknown) => void;
    sendMessage?: (message: Record<string, unknown>, options?: Record<string, unknown>) => void;
    sendUserMessage?: (content: string, options?: Record<string, unknown>) => Promise<void>;
    getSessionName?: () => string | undefined;
    exec?: (cmd: string, args: string[], opts?: { timeout?: number }) => Promise<{ code: number }>;
  };

  function isSubAgent(ctx: ExtensionContext | undefined): boolean {
    return (ctx as unknown as { agent?: { kind?: string } } | undefined)?.agent?.kind === 'sub';
  }

  function currentAgentId(ctx: ExtensionContext | undefined): string {
    return (ctx as unknown as { agent?: { id?: string } } | undefined)?.agent?.id ?? 'main';
  }

  function liveOwner(ctx: ExtensionContext): LiveOwner | undefined {
    try {
      const reg = anyPi.pi?.AgentRegistry?.global?.();
      return reg?.get(currentAgentId(ctx))?.session as LiveOwner | undefined;
    } catch {
      return undefined;
    }
  }

  function closeWeb() {
    if (!web) return;
    try { web.server.close(); } catch {}
    try { web.store.close(); } catch {}
    web = undefined;
  }

  function closeDecisionWatch() {
    try { decisionWatch?.store.close(); } catch {}
    decisionWatch = undefined;
  }

  function watchDecisions(root: string) {
    if (decisionWatch?.root === root) return;
    closeDecisionWatch();
    const store = new BoardStore(boardPath(root));
    decisionWatch = { root, store, version: store.dataVersion() };
  }

  function recoverBoard(root: string | undefined, reason: string) {
    if (root?.endsWith('.jsonl')) {
      try { withBoard(root, store => store.failPendingSpawns(reason), false); } catch {}
    }
  }

  function updatePerchUi(ctx?: ExtensionContext) {
    const target = ctx ?? current;
    if (!target || isManagedWorker || isSubAgent(target)) return;
    const ui = (target as unknown as { hasUI?: boolean; ui?: { setStatus?: (key: string, text: string | undefined) => void } }).ui;
    if (!ui || typeof ui.setStatus !== 'function') return;
    const running = [...tasks.values()].filter(t => t.state === 'running');
    const unhandled = [...tasks.values()].filter(t => t.unhandled && t.state !== 'running');
    if (!perchModeEnabled && !running.length && !unhandled.length) {
      ui.setStatus('perch', undefined);
      return;
    }
    const parts: string[] = [];
    if (perchModeEnabled) parts.push('perch');
    if (running.length) parts.push(`${running.length} running`);
    if (unhandled.length) parts.push(`${unhandled.length} done`);
    ui.setStatus('perch', parts.join(' · '));
  }

  function restorePerchModeFromBranch(ctx: ExtensionContext, config: PerchModeConfig): boolean {
    if (isManagedWorker || isSubAgent(ctx)) return false;
    try {
      const branch = ctx.sessionManager.getBranch() as Array<{ type?: string; customType?: string; data?: { enabled?: unknown } }>;
      for (let i = branch.length - 1; i >= 0; i--) {
        const entry = branch[i];
        if (entry?.type === 'custom' && entry.customType === 'perch-mode' && typeof entry.data?.enabled === 'boolean') {
          return entry.data.enabled;
        }
      }
    } catch {}
    return ctx.mode === 'tui' && config.default === true;
  }

  async function syncPerchTools(ctx: ExtensionContext, config: PerchModeConfig): Promise<void> {
    if (isManagedWorker || isSubAgent(ctx)) return;
    if (typeof anyPi.getActiveTools !== 'function' || typeof anyPi.setActiveTools !== 'function') return;
    const active = anyPi.getActiveTools();
    if (perchModeEnabled) {
      if (!savedToolsBeforePerch) savedToolsBeforePerch = [...active];
      const basePool = [...new Set([...savedToolsBeforePerch, ...active])];
      const disabled = new Set(config.disableTools);
      let next: string[];
      if (config.allowTools !== undefined) {
        const allowed = new Set(config.allowTools);
        next = basePool.filter(tool => allowed.has(tool) && !disabled.has(tool));
      } else {
        next = basePool.filter(tool => !disabled.has(tool));
      }
      if (!disabled.has('perch') && !next.includes('perch')) next.push('perch');
      if (config.board.enabled && !disabled.has('board') && !next.includes('board')) next.push('board');
      if (next.length !== active.length || next.some((t, i) => t !== active[i])) {
        await anyPi.setActiveTools(next);
      }
      return;
    }
    if (savedToolsBeforePerch) {
      const restore = savedToolsBeforePerch;
      savedToolsBeforePerch = undefined;
      await anyPi.setActiveTools(restore);
    }
  }

  function stopIdleReaper() {
    if (idleReaperTimer) {
      clearInterval(idleReaperTimer);
      idleReaperTimer = undefined;
    }
  }

  async function reapIdleWorkers(idleCloseSeconds: number): Promise<void> {
    if (stopping || !perchModeEnabled || idleCloseSeconds <= 0 || reapingIdle) return;
    reapingIdle = true;
    try {
      const thresholdMs = idleCloseSeconds * 1000;
      const isEligible = (task: TrackedTask | undefined): boolean => {
        if (!task || stopping || !perchModeEnabled) return false;
        if (task.state === 'running' || task.unhandled) return false;
        if (inFlightSends.has(task.id) || watchers.has(task.id)) return false;
        if (task.finishedAt === undefined) return false;
        const idleSince = Math.max(task.finishedAt, task.acknowledgedAt ?? 0);
        return Date.now() - idleSince >= thresholdMs;
      };
      const candidates = [...tasks.values()].filter(isEligible).map(task => task.id);
      for (const id of candidates) {
        if (!isEligible(tasks.get(id))) continue;
        await closeTrackedWorker(id).catch(() => {});
      }
    } finally {
      reapingIdle = false;
    }
  }

  function syncIdleReaper(ctx: ExtensionContext, config: PerchModeConfig) {
    stopIdleReaper();
    if (stopping || !perchModeEnabled || config.idleCloseSeconds <= 0 || isManagedWorker || isSubAgent(ctx)) return;
    const intervalMs = Math.max(1000, Math.min(30000, Math.floor((config.idleCloseSeconds * 1000) / 2)));
    idleReaperTimer = setInterval(() => {
      if (stopping || !perchModeEnabled) {
        stopIdleReaper();
        return;
      }
      const latest = loadPerchConfig({ cwd: ctx.cwd });
      if (latest.idleCloseSeconds <= 0) {
        stopIdleReaper();
        return;
      }
      void reapIdleWorkers(latest.idleCloseSeconds);
    }, intervalMs);
    idleReaperTimer.unref?.();
  }

  async function setPerchMode(ctx: ExtensionContext, enabled: boolean, persist: boolean): Promise<PerchModeConfig> {
    const config = loadPerchConfig({ cwd: ctx.cwd });
    perchModeEnabled = enabled;
    if (persist && typeof anyPi.appendEntry === 'function') {
      try { anyPi.appendEntry('perch-mode', { enabled }); } catch {}
    }
    await syncPerchTools(ctx, config);
    syncIdleReaper(ctx, config);
    updatePerchUi(ctx);
    return config;
  }

  // Native pane launches share ONE global chain (not per-provider): the right-side stack target is global,
  // so concurrent omp + agy starts must not both see an empty stack and each split the main pane horizontally.
  async function withNativeLaunchLock<T>(_provider: string, fn: () => Promise<T>): Promise<T> {
    const lockKey = 'native-pane-layout';
    const previous = nativeLaunchChains.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const next = previous.then(() => gate);
    nativeLaunchChains.set(lockKey, next);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (nativeLaunchChains.get(lockKey) === next) nativeLaunchChains.delete(lockKey);
    }
  }

  async function findLiveRightStackTarget(): Promise<string | undefined> {
    for (let i = rightPaneStack.length - 1; i >= 0; i--) {
      const candidate = rightPaneStack[i];
      if (await isTernBlockLive(candidate.id)) return candidate.id;
      rightPaneStack.splice(i, 1);
    }
    return undefined;
  }

  function removePaneFromStack(sessionId: string) {
    for (let i = rightPaneStack.length - 1; i >= 0; i--) {
      if (rightPaneStack[i].sessionId === sessionId) rightPaneStack.splice(i, 1);
    }
  }

  async function deliverPrompt(
    id: string,
    message: string,
    options: { signal?: AbortSignal; notify: boolean; heartbeatMs: number; name?: string },
  ): Promise<{ accepted: boolean | null; running?: boolean; notify: boolean; warning?: string }> {
    inFlightSends.add(id);
    try {
      const result = await runPerchCli(['send', id, '--stdin', '--json'], {
        input: message,
        signal: options.signal,
        timeoutMs: 120000,
      });
      if (result.code === 0) {
        const prevTurn = tasks.get(id)?.turnSeq ?? 0;
        ensureTask(id, {
          ...(options.name ? { name: options.name } : {}),
          state: 'running',
          unhandled: false,
          turnSeq: prevTurn + 1,
          startedAt: Date.now(),
          finishedAt: undefined,
          acknowledgedAt: undefined,
          error: undefined,
          heartbeatCount: 0,
        });
        if (options.notify) startWatcher(id, options.heartbeatMs);
        else cancelWatcher(id);
        updatePerchUi();
        return { accepted: true, notify: options.notify };
      }
      let parsed: { accepted?: boolean | null } | undefined;
      try { parsed = parseJson(result.stdout) as { accepted?: boolean | null } | undefined; } catch {}
      if (parsed?.accepted === null) {
        const probe = await runPerchCli(['wait', id, '--timeout', '0', '--json'], {
          signal: options.signal,
          timeoutMs: 5000,
        }).catch(() => undefined);
        let probeJson: { status?: string } | undefined;
        try { probeJson = probe ? parseJson(probe.stdout) as { status?: string } | undefined : undefined; } catch {}
        if (probeJson?.status === 'timeout') {
          const prevTurn = tasks.get(id)?.turnSeq ?? 0;
          ensureTask(id, {
            ...(options.name ? { name: options.name } : {}),
            state: 'running',
            unhandled: false,
            turnSeq: prevTurn + 1,
            startedAt: Date.now(),
            finishedAt: undefined,
            acknowledgedAt: undefined,
            error: undefined,
            heartbeatCount: 0,
          });
          if (options.notify) startWatcher(id, options.heartbeatMs);
          else cancelWatcher(id);
          updatePerchUi();
          return {
            accepted: null,
            running: true,
            notify: options.notify,
            warning: 'Delivery confirmation timed out, but the worker is running; async watcher attached. Do not resend.',
          };
        }
      }
      throw new Error(cliErrorMessage(result, 'perch send failed'));
    } finally {
      inFlightSends.delete(id);
    }
  }

  async function listProviderSessions(provider: string, signal?: AbortSignal): Promise<Array<Record<string, unknown>>> {
    const res = await runPerchCli(['list', '--provider', provider, '--json'], { signal, timeoutMs: 10000 });
    if (res.code !== 0) return [];
    try {
      const parsed = parseJson(res.stdout);
      return Array.isArray(parsed) ? parsed as Array<Record<string, unknown>> : [];
    } catch {
      return [];
    }
  }

  async function waitForNewNativeSession(
    provider: string,
    cwd: string,
    beforeIds: Set<string>,
    discoverMs: number,
    signal?: AbortSignal,
    options?: { expectedResumeId?: string; allowTaskId?: string },
  ): Promise<string | undefined> {
    const targetCwd = canonicalDir(cwd);
    const deadline = Date.now() + discoverMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw Object.assign(new Error('Perch command aborted'), { name: 'AbortError' });
      const rows = await listProviderSessions(provider, signal);
      const candidates = rows.filter(row => {
        const id = typeof row?.id === 'string' ? row.id : '';
        return id && !beforeIds.has(id) && (!tasks.has(id) || id === options?.allowTaskId) && row.kind === 'session' && row.send === true;
      });
      if (options?.expectedResumeId) {
        const byResume = candidates.find(row => {
          const id = typeof row.id === 'string' ? row.id : '';
          return id === `${provider}:${options.expectedResumeId}` || extractNativeResumeId(provider, id) === options.expectedResumeId;
        });
        if (byResume && typeof byResume.id === 'string') return byResume.id;
      } else {
        const exact = candidates.find(row => {
          const rowCwd = typeof row.cwd === 'string' ? canonicalDir(row.cwd) : null;
          return rowCwd && targetCwd && rowCwd === targetCwd;
        });
        if (exact && typeof exact.id === 'string') return exact.id;
        if (candidates.length === 1 && typeof candidates[0].id === 'string') return candidates[0].id;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await delay(Math.min(250, remaining), undefined, { signal }).catch(() => {});
    }
    return undefined;
  }

  function sessionStatus(ctx: ExtensionContext): 'running' | 'idle' | 'unknown' {
    const idle = ctx.isIdle();
    const queued = ctx.hasPendingMessages();
    const jobs = ctx.getAsyncJobSnapshot?.();
    if (idle === false) pendingSendUntil = 0;
    const sendGraceActive = sendSeq > agentEndSeq && Date.now() < pendingSendUntil;
    if (admissions.size || watchers.size || sendGraceActive || idle === false || queued === true || jobs?.running?.length || jobs?.delivery?.queued) return 'running';
    return idle === true && queued === false ? 'idle' : 'unknown';
  }

  function ensureTask(id: string, patch?: Partial<TrackedTask>): TrackedTask {
    let task = tasks.get(id);
    if (!task) {
      task = {
        id,
        provider: id.includes(':') ? id.split(':', 1)[0] : undefined,
        state: 'idle',
        unhandled: false,
        turnSeq: 0,
        finishSeq: 0,
        heartbeatCount: 0,
      };
      tasks.set(id, task);
    }
    if (patch) Object.assign(task, patch);
    return task;
  }

  function cancelWatcher(id: string) {
    const existing = watchers.get(id);
    if (!existing) return;
    watchers.delete(id);
    if (existing.timer) clearInterval(existing.timer);
    existing.controller.abort();
  }

  function cancelAllWatchers() {
    for (const [id, entry] of watchers) {
      watchers.delete(id);
      if (entry.timer) clearInterval(entry.timer);
      entry.controller.abort();
    }
  }

  function pushAgentEvent(customType: string, content: string, details: Record<string, unknown>) {
    if (typeof anyPi.sendMessage === 'function') {
      anyPi.sendMessage(
        { customType, content, display: true, attribution: 'agent', details },
        { triggerTurn: true, deliverAs: 'followUp' },
      );
      return;
    }
    if (typeof anyPi.sendUserMessage === 'function') {
      void anyPi.sendUserMessage(content, { deliverAs: 'followUp' }).catch(() => {});
    }
  }

  async function readLatestAssistantReply(id: string, signal: AbortSignal, timeoutMs: number): Promise<string | undefined> {
    try {
      const historyResult = await runPerchCli(['history', id, '--limit', '4', '--json'], { signal, timeoutMs });
      if (historyResult.code !== 0) return undefined;
      const messages = parseJson(historyResult.stdout);
      if (!Array.isArray(messages)) return undefined;
      const lastAssistant = [...messages].reverse().find(
        entry => entry && typeof entry === 'object' && (entry as { role?: string }).role === 'assistant' && typeof (entry as { text?: string }).text === 'string',
      ) as { text: string } | undefined;
      return lastAssistant?.text.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  function deliverAsyncNotification(
    id: string,
    status: string,
    task: TrackedTask | undefined,
    errorText: string | undefined,
    replyText: string | undefined,
    receiptRecorded = false,
  ) {
    const content = formatNotification(id, status, task, errorText, replyText, receiptRecorded);
    pushAgentEvent('perch-worker-event', content, {
      id,
      status,
      ...(task?.name ? { name: task.name } : {}),
      ...(task?.role ? { role: task.role } : {}),
      ...(task?.provider ? { provider: task.provider } : {}),
      ...(task?.model ? { model: task.model } : {}),
      ...(task?.boardItem ? { boardItem: task.boardItem } : {}),
      ...(errorText ? { error: errorText } : {}),
    });
  }

  function startWatcher(id: string, heartbeatMs: number) {
    cancelWatcher(id);
    const controller = new AbortController();
    const generation = ++watcherGeneration;
    const epoch = sessionEpoch;
    const expectedTurnSeq = tasks.get(id)?.turnSeq ?? 0;
    const entry: WatcherEntry = { controller, generation };
    if (heartbeatMs > 0) {
      let ticking = false;
      entry.timer = setInterval(() => {
        if (ticking || stopping || controller.signal.aborted || epoch !== sessionEpoch) return;
        const currentEntry = watchers.get(id);
        if (!currentEntry || currentEntry.generation !== generation) return;
        const task = tasks.get(id);
        if (!task || task.state !== 'running' || task.turnSeq !== expectedTurnSeq) return;
        ticking = true;
        void (async () => {
          try {
            const preview = await readLatestAssistantReply(id, controller.signal, 3000);
            if (stopping || controller.signal.aborted || epoch !== sessionEpoch) return;
            if (watchers.get(id)?.generation !== generation || task.state !== 'running' || task.turnSeq !== expectedTurnSeq) return;
            task.heartbeatCount += 1;
            const elapsedMs = task.startedAt !== undefined ? Date.now() - task.startedAt : heartbeatMs * task.heartbeatCount;
            const content = formatHeartbeat(id, task, elapsedMs, task.heartbeatCount, preview);
            pushAgentEvent('perch-worker-heartbeat', content, {
              id,
              status: 'running',
              heartbeatCount: task.heartbeatCount,
              elapsedSeconds: Math.floor(elapsedMs / 1000),
              ...(task.name ? { name: task.name } : {}),
              ...(task.provider ? { provider: task.provider } : {}),
              ...(task.model ? { model: task.model } : {}),
            });
          } finally {
            ticking = false;
          }
        })();
      }, heartbeatMs);
      entry.timer.unref?.();
    }
    watchers.set(id, entry);
    void (async () => {
      try {
        const result = await runPerchCli(['wait', id, '--json'], { signal: controller.signal });
        if (stopping || controller.signal.aborted || epoch !== sessionEpoch) return;
        let parsed: { status?: string; error?: string } | undefined;
        try { parsed = parseJson(result.stdout) as { status?: string; error?: string } | undefined; } catch {}
        const status: TaskState = parsed?.status && ['completed', 'failed', 'needs_input', 'interrupted'].includes(parsed.status)
          ? parsed.status as TaskState
          : result.code === 0 ? 'completed' : result.code === 3 ? 'needs_input' : 'failed';
        const errorText = typeof parsed?.error === 'string'
          ? parsed.error
          : status === 'failed' ? cliErrorMessage(result, 'Perch wait failed') : undefined;
        const replyText = ['completed', 'failed', 'needs_input'].includes(status)
          ? await readLatestAssistantReply(id, controller.signal, 5000)
          : undefined;
        if (watchers.get(id)?.generation === generation) {
          if (entry.timer) clearInterval(entry.timer);
          watchers.delete(id);
        }
        if (stopping || controller.signal.aborted || epoch !== sessionEpoch) return;
        if ((tasks.get(id)?.turnSeq ?? 0) !== expectedTurnSeq) return;
        const task = ensureTask(id, {
          state: status,
          unhandled: true,
          finishSeq: ++finishCounter,
          finishedAt: Date.now(),
          acknowledgedAt: undefined,
          error: errorText,
        });
        let receiptRecorded = false;
        if (task.boardRoot && task.boardItem) {
          const receiptBody = replyText || (errorText ? `Worker ${status}: ${errorText}` : `Worker ${status}.`);
          try {
            receiptRecorded = recordPerchWorkerReceipt(task.boardRoot, id, `perch:${task.finishSeq}`, receiptBody);
          } catch {}
        }
        updatePerchUi();
        deliverAsyncNotification(id, status, task, errorText, replyText, receiptRecorded);
      } catch (error) {
        if (watchers.get(id)?.generation === generation) {
          if (entry.timer) clearInterval(entry.timer);
          watchers.delete(id);
        }
        if (stopping || controller.signal.aborted || epoch !== sessionEpoch) return;
        if ((tasks.get(id)?.turnSeq ?? 0) !== expectedTurnSeq) return;
        const message = error instanceof Error ? error.message : String(error);
        const task = ensureTask(id, {
          state: 'failed',
          unhandled: true,
          finishSeq: ++finishCounter,
          finishedAt: Date.now(),
          error: message,
        });
        let receiptRecorded = false;
        if (task.boardRoot && task.boardItem) {
          try {
            receiptRecorded = recordPerchWorkerReceipt(task.boardRoot, id, `perch:${task.finishSeq}`, `Worker failed: ${message}`);
          } catch {}
        }
        updatePerchUi();
        deliverAsyncNotification(id, 'failed', task, message, undefined, receiptRecorded);
      }
    })();
  }

  function retireTask(task: TrackedTask) {
    if (task.name) {
      for (const [oldId, old] of retiredWorkers) {
        if (old.name === task.name && oldId !== task.id) retiredWorkers.delete(oldId);
      }
    }
    const inferredProvider = task.provider ?? (task.id.includes(':') ? task.id.split(':', 1)[0] : undefined);
    const inferredMode: 'managed' | 'native' = task.mode ?? (task.pane || task.id.startsWith('agy:native-') ? 'native' : 'managed');
    retiredWorkers.delete(task.id);
    retiredWorkers.set(task.id, {
      id: task.id,
      name: task.name,
      role: task.role,
      provider: inferredProvider,
      mode: inferredMode,
      model: task.model,
      cwd: task.cwd,
      boardItem: task.boardItem,
      boardRoot: task.boardRoot,
      retiredAt: Date.now(),
    });
    while (retiredWorkers.size > MAX_RETIRED_WORKERS) {
      const oldest = retiredWorkers.keys().next().value;
      if (oldest === undefined) break;
      retiredWorkers.delete(oldest);
    }
  }

  function evictRetiredByName(name: string | undefined) {
    if (!name) return;
    for (const [oldId, old] of retiredWorkers) {
      if (old.name === name) retiredWorkers.delete(oldId);
    }
  }

  function rebindBoardForRevivedWorker(boardRoot: string | undefined, oldWorkerId: string, newWorkerId: string): string | undefined {
    if (!boardRoot) return undefined;
    try {
      const reboundItem = withBoard(boardRoot, store => store.rebindWorker(oldWorkerId, newWorkerId), false);
      if (reboundItem) boardBridge.rebind(oldWorkerId, newWorkerId);
      return reboundItem;
    } catch {
      return undefined;
    }
  }

  function resolveWorkerTarget(idOrName: string): { id: string; task?: TrackedTask; retired?: RetiredWorker } {
    const directTask = tasks.get(idOrName);
    if (directTask) return { id: directTask.id, task: directTask };
    let matchedTask: TrackedTask | undefined;
    for (const task of tasks.values()) {
      if (task.name === idOrName) matchedTask = task;
    }
    if (matchedTask) return { id: matchedTask.id, task: matchedTask };

    const directRetired = retiredWorkers.get(idOrName);
    if (directRetired) return { id: directRetired.id, retired: directRetired };
    let matchedRetired: RetiredWorker | undefined;
    for (const retired of retiredWorkers.values()) {
      if (retired.name === idOrName) matchedRetired = retired;
    }
    if (matchedRetired) return { id: matchedRetired.id, retired: matchedRetired };

    return { id: idOrName };
  }

  async function reviveWorkerAndDeliver(
    ref: {
      id: string;
      name?: string;
      role?: string;
      provider?: string;
      mode?: 'native' | 'managed';
      model?: string;
      cwd?: string;
      boardItem?: string;
      boardRoot?: string;
    },
    message: string,
    ctx: ExtensionContext,
    config: PerchModeConfig,
    options: { signal?: AbortSignal; notify: boolean; heartbeatMs: number; name?: string },
  ): Promise<Record<string, unknown>> {
    const provider = ref.provider ?? (ref.id.includes(':') ? ref.id.split(':', 1)[0] : undefined);
    const effectiveName = options.name ?? ref.name;

    if (ref.mode === 'native') {
      const resumeId = extractNativeResumeId(provider, ref.id);
      if (!resumeId || !provider || !NATIVE_DEFAULT_PROVIDERS.has(provider)) {
        throw new Error(`Cannot auto-resume native ${provider ?? 'worker'} session ${ref.id}: resumable conversation ID is unavailable. Start a new worker with op=start.`);
      }
      const cwd = ref.cwd || ctx.cwd;
      const agyInlinePrompt = provider === 'agy'
        ? `请阅读并严格执行该文件中的完整指令:${stageAgyNativePrompt(uid, message)}`
        : undefined;
      const discoverMs = resolveNativeDiscoverMs(config);

      const revived = await withNativeLaunchLock(provider, async () => {
        // Re-check inside lock in case a concurrent send already revived this worker
        const existingLive = [...tasks.values()].find(t => {
          if (t.id === ref.id) return false;
          if (t.mode !== 'native' || t.provider !== provider) return false;
          return extractNativeResumeId(provider, t.id) === resumeId;
        });
        if (existingLive) {
          return { id: existingLive.id, started: { pane: existingLive.pane }, promptAlreadyDelivered: false, alreadyRevived: true };
        }

        // Clean up any dead/stale pane from a crashed live task before finding a stack target
        const staleTask = tasks.get(ref.id);
        if (staleTask?.pane) {
          await closePaneRef(staleTask.pane);
          removePaneFromStack(ref.id);
        }

        const beforeRows = await listProviderSessions(provider, options.signal);
        const beforeIds = new Set(
          beforeRows
            .filter(r => r?.kind === 'session' && r?.send === true && typeof r?.id === 'string')
            .map(r => r.id as string),
        );
        const nativeArgs = ['start', provider];
        if (agyInlinePrompt !== undefined) nativeArgs.push(agyInlinePrompt);
        nativeArgs.push('--native', '--pane', 'right', '--resume', resumeId, '--cwd', cwd, '--json');
        if (config.layout === 'stack') {
          const stackTarget = await findLiveRightStackTarget();
          if (stackTarget) {
            nativeArgs.push('--split', 'down', '--target', stackTarget);
          }
        }
        if (ref.model) nativeArgs.push('--model', ref.model);
        const childEnv = provider === 'omp'
          ? { ...process.env, PERCH_MANAGED_WORKER: '1' }
          : process.env;
        const startedResult = await runPerchCli(nativeArgs, { signal: options.signal, timeoutMs: 45000, env: childEnv });
        if (startedResult.code !== 0) {
          throw new Error(cliErrorMessage(startedResult, `Failed to auto-resume native ${provider} worker ${ref.id}`));
        }
        const started = parseJson(startedResult.stdout) as { provider?: string; mode?: string; pane?: unknown };
        const paneRef = normalizePaneRef(started.pane);

        let discoveredId: string | undefined;
        try {
          discoveredId = await waitForNewNativeSession(provider, cwd, beforeIds, discoverMs, options.signal, {
            expectedResumeId: resumeId,
            allowTaskId: ref.id,
          });
        } catch (error) {
          await closePaneRef(paneRef);
          throw error;
        }
        if (!discoveredId) {
          await closePaneRef(paneRef);
          throw new Error(`Auto-resumed native ${provider} pane opened, but no controllable session registered in time (${Math.round(discoverMs / 1000)}s). Orphan pane closed.`);
        }

        // Only replace old task/retired entries AFTER discovery succeeds
        cancelWatcher(ref.id);
        if (discoveredId !== ref.id) tasks.delete(ref.id);
        retiredWorkers.delete(ref.id);
        evictRetiredByName(effectiveName);
        removePaneFromStack(ref.id);

        if (paneRef?.backend === 'tern') {
          rightPaneStack.push({ id: paneRef.id, sessionId: discoveredId });
        }
        const reboundItem = ref.boardItem
          ? rebindBoardForRevivedWorker(ref.boardRoot, ref.id, discoveredId)
          : undefined;
        ensureTask(discoveredId, {
          ...(effectiveName ? { name: effectiveName } : {}),
          ...(ref.role ? { role: ref.role } : {}),
          provider,
          mode: 'native',
          ...(ref.model ? { model: ref.model } : {}),
          cwd,
          ...(paneRef ? { pane: paneRef } : {}),
          boardItem: reboundItem,
          boardRoot: reboundItem ? ref.boardRoot : undefined,
          state: agyInlinePrompt !== undefined ? 'running' : 'idle',
          unhandled: false,
          ...(agyInlinePrompt !== undefined
            ? { turnSeq: (tasks.get(discoveredId)?.turnSeq ?? 0) + 1, startedAt: Date.now(), finishedAt: undefined, acknowledgedAt: undefined }
            : { finishedAt: undefined, acknowledgedAt: undefined }),
          error: undefined,
          heartbeatCount: 0,
        });
        updatePerchUi(ctx);
        return { id: discoveredId, started, reboundItem, promptAlreadyDelivered: agyInlinePrompt !== undefined, alreadyRevived: false };
      });

      if (revived.promptAlreadyDelivered) {
        if (options.notify) startWatcher(revived.id, options.heartbeatMs);
        return {
          id: revived.id,
          ...(revived.id !== ref.id ? { previousId: ref.id } : {}),
          ...(effectiveName ? { name: effectiveName } : {}),
          ...(ref.role ? { role: ref.role } : {}),
          ...(revived.reboundItem ? { boardItem: revived.reboundItem } : {}),
          provider,
          mode: 'native',
          pane: revived.started.pane,
          autoResumed: true,
          accepted: true,
          notify: options.notify,
        };
      }

      const delivered = await deliverPrompt(revived.id, message, {
        signal: options.signal,
        notify: options.notify,
        heartbeatMs: options.heartbeatMs,
        name: effectiveName,
      });
      return {
        id: revived.id,
        ...(revived.id !== ref.id ? { previousId: ref.id } : {}),
        ...(effectiveName ? { name: effectiveName } : {}),
        ...(ref.role ? { role: ref.role } : {}),
        ...(revived.reboundItem ? { boardItem: revived.reboundItem } : {}),
        provider,
        mode: 'native',
        pane: revived.started.pane,
        autoResumed: true,
        ...delivered,
      };
    }

    // Managed worker auto-resume via `perch resume <id> --json`
    const resumedResult = await runPerchCli(['resume', ref.id, '--json'], { signal: options.signal, timeoutMs: 45000 });
    if (resumedResult.code !== 0) {
      throw new Error(cliErrorMessage(resumedResult, `Failed to auto-resume worker ${ref.id}`));
    }
    const resumed = parseJson(resumedResult.stdout) as { id?: string; provider?: string } | undefined;
    const targetId = resumed?.id || ref.id;
    retiredWorkers.delete(ref.id);
    retiredWorkers.delete(targetId);
    evictRetiredByName(effectiveName);
    ownedSessions.add(targetId);
    const reboundItem = ref.boardItem
      ? rebindBoardForRevivedWorker(ref.boardRoot, ref.id, targetId)
      : undefined;
    ensureTask(targetId, {
      ...(effectiveName ? { name: effectiveName } : {}),
      ...(ref.role ? { role: ref.role } : {}),
      provider: resumed?.provider ?? provider,
      mode: 'managed',
      ...(ref.model ? { model: ref.model } : {}),
      ...(ref.cwd ? { cwd: ref.cwd } : {}),
      boardItem: reboundItem,
      boardRoot: reboundItem ? ref.boardRoot : undefined,
      state: 'idle',
      unhandled: false,
      finishedAt: undefined,
      acknowledgedAt: undefined,
      error: undefined,
    });
    updatePerchUi(ctx);
    const delivered = await deliverPrompt(targetId, message, {
      signal: options.signal,
      notify: options.notify,
      heartbeatMs: options.heartbeatMs,
      name: effectiveName,
    });
    return {
      id: targetId,
      ...(targetId !== ref.id ? { previousId: ref.id } : {}),
      ...(effectiveName ? { name: effectiveName } : {}),
      ...(ref.role ? { role: ref.role } : {}),
      ...(reboundItem ? { boardItem: reboundItem } : {}),
      mode: 'managed',
      autoResumed: true,
      ...delivered,
    };
  }

  async function closeTrackedWorker(id: string, signal?: AbortSignal): Promise<{ id: string; closed: boolean; paneClosed?: boolean }> {
    const task = tasks.get(id);
    if (!task && retiredWorkers.has(id)) {
      return { id, closed: true };
    }
    cancelWatcher(id);
    ownedSessions.delete(id);
    tasks.delete(id);
    removePaneFromStack(id);
    if (task) retireTask(task);
    if (task?.boardRoot) {
      try {
        withBoard(task.boardRoot, store => store.releaseWorker(id, 'Perch worker closed.'), false);
      } catch {}
    }
    updatePerchUi();
    if (task?.mode === 'native' || task?.pane) {
      const paneClosed = await closePaneRef(task?.pane);
      return { id, closed: true, paneClosed };
    }
    const result = await runPerchCli(['close', id, '--json'], { signal, timeoutMs: 15000 });
    if (result.code !== 0) throw new Error(cliErrorMessage(result, 'perch close failed'));
    return (parseJson(result.stdout) as { id: string; closed: boolean } | undefined) ?? { id, closed: true };
  }

  async function ensureToolActiveInVibe(ctx: ExtensionContext) {
    if (isManagedWorker || isSubAgent(ctx)) return;
    const anyCtx = ctx as unknown as {
      sessionModes?: { getState?: () => { vibe?: { status?: string } } };
    };
    if (anyCtx.sessionModes?.getState?.()?.vibe?.status !== 'active') return;
    if (typeof anyPi.getActiveTools !== 'function' || typeof anyPi.setActiveTools !== 'function') return;
    const active = anyPi.getActiveTools();
    const toAdd = ['perch', 'board'].filter(tool => !active.includes(tool));
    if (toAdd.length) await anyPi.setActiveTools([...new Set([...active, ...toAdd])]);
  }

  function activate(ctx: ExtensionContext) {
    current = ctx;
    identity = randomBytes(16).toString('hex');
  }
  function pause() { current = undefined; identity = ''; }
  async function pauseAndDrain() {
    sessionEpoch++;
    pendingLedgerAck = undefined;
    cancelAllWatchers();
    for (const controller of reviewControllers) controller.abort();
    reviewControllers.clear();
    pause();
    await Promise.allSettled(admissions);
  }

  // ---- Role reviewers: perch.roles.<name>.reviewMode = turn | agent-end ----
  function assistantText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .flatMap(part => part && typeof part === 'object' && (part as { type?: string }).type === 'text' && typeof (part as { text?: unknown }).text === 'string'
        ? [(part as { text: string }).text] : [])
      .join('\n');
  }

  async function runRoleReview(ctx: ExtensionContext, config: PerchModeConfig, role: PerchRoleConfig, replyText: string, epoch: number) {
    const controller = new AbortController();
    reviewControllers.add(controller);
    try {
      const prompt = [
        `[Perch review request — role: ${role.name}${role.label ? ` / ${role.label}` : ''}]`,
        'You are a reviewer, not the director. Review ONLY the director reply below through this lens: '
          + `${role.capabilities ?? role.label ?? role.name}.`,
        ...(role.constraints ? [`Constraints: ${role.constraints}`] : []),
        ...(role.reviewPrompt ? [`Review criteria:\n${role.reviewPrompt}`] : []),
        'Do not modify files, run commands, or add facts. If no change is needed, reply with exactly: OK',
        'Otherwise reply with concise, concrete suggestions the director can apply directly (at most about 1200 characters).',
        '',
        '[User request]',
        clipText(lastUserPrompt || '(unavailable)', 2000).text,
        '',
        '[Director reply to review]',
        clipText(replyText, 12000).text,
      ].join('\n');

      const send = (target: string) => runPerchCli(['send', target, '--stdin', '--json'], { input: prompt, signal: controller.signal, timeoutMs: 120000 });
      let id = roleReviewers.get(role.name);
      let sent = id ? await send(id) : undefined;
      if (!id || !sent || sent.code !== 0) {
        const args = ['start', role.provider, '--cwd', ctx.cwd, '--json'];
        if (role.model) args.push('--model', role.model);
        const started = await runPerchCli(args, { signal: controller.signal, timeoutMs: 45000 });
        if (started.code !== 0) throw new Error(cliErrorMessage(started, 'review session start failed'));
        const parsed = parseJson(started.stdout) as { id?: string } | undefined;
        if (!parsed?.id) throw new Error('review session start did not return an ID');
        id = parsed.id;
        roleReviewers.set(role.name, id);
        ownedSessions.add(id);
        sent = await send(id);
        if (sent.code !== 0) throw new Error(cliErrorMessage(sent, 'review send failed'));
      }
      const waited = await runPerchCli(['wait', id, '--json'], { signal: controller.signal, timeoutMs: 600000 });
      let status: string | undefined;
      try { status = (parseJson(waited.stdout) as { status?: string } | undefined)?.status; } catch {}
      if (stopping || controller.signal.aborted || epoch !== sessionEpoch || (status !== undefined && status !== 'completed')) return;
      const reply = (await readLatestAssistantReply(id, controller.signal, 5000))?.trim();
      if (stopping || controller.signal.aborted || epoch !== sessionEpoch) return;
      if (!reply || /^OK[.!。]?$/i.test(reply)) return;
      reviewSkipNext = true;
      const clipped = clipText(reply, MAX_NOTIFICATION_CHARS);
      pushAgentEvent('perch-review-note', [
        `[Perch review: ${role.name}] (${role.reviewMode})`,
        'Reviewer suggestions for your last reply:',
        clipped.text,
        'Action: apply the suggestions that improve the reply (expression and structure only; keep facts and evidence unchanged). Then output ONLY the complete revised reply for the user — do not mention this review, the reviewer, or what you changed. Ignore suggestions you disagree with.',
      ].join('\n'), { role: role.name, mode: role.reviewMode, reviewer: id });
    } catch (error) {
      if (stopping || controller.signal.aborted) return;
      const warning = `Perch review by ${role.name} failed: ${error instanceof Error ? error.message : String(error)}`;
      if (!warnedPromptMessages.has(warning)) {
        warnedPromptMessages.add(warning);
        ctx.ui?.notify?.(warning, 'warning');
      }
    } finally {
      reviewControllers.delete(controller);
    }
  }

  async function maybeReviewReply(ctx: ExtensionContext, mode: 'turn' | 'agent-end', replyText: string) {
    if (stopping || !perchModeEnabled || isManagedWorker || isSubAgent(ctx)) return;
    const text = replyText.trim();
    if (!text) return;
    const config = loadPerchConfig({ cwd: ctx.cwd });
    const roles = Object.values(config.roles).filter(role => role.reviewMode === mode);
    if (!roles.length) return;
    if (reviewSkipNext) {
      // This reply answers a review note; do not review the revision again.
      reviewSkipNext = false;
      return;
    }
    const epoch = sessionEpoch;
    for (const role of roles) {
      if (text.length < (role.reviewMinChars ?? 0)) continue;
      if (reviewsInFlight.has(role.name)) continue;
      const hash = createHash('sha256').update(`${role.name}\0${text}`).digest('hex');
      if (lastReviewedHash.get(role.name) === hash) continue;
      lastReviewedHash.set(role.name, hash);
      reviewsInFlight.add(role.name);
      void runRoleReview(ctx, config, role, text, epoch).finally(() => reviewsInFlight.delete(role.name));
    }
  }

  pi.registerCommand('perch-reconnect', {
    description: translateDiagnostic('Reconnect the local Perch bridge after a cancelled session transition', systemLanguage()),
    handler: async (_args, ctx) => {
      if (stopping || !server?.listening || admissions.size) return;
      activate(ctx);
      if (ctx.hasUI) ctx.ui.notify(translateDiagnostic('Perch bridge reconnected', systemLanguage()), 'info');
    },
  });

  if (!isManagedWorker && typeof anyPi.registerCommand === 'function') {
    anyPi.registerCommand('perch', {
      description: 'Toggle /perch orchestration mode, inspect workers/roles, or close worker panes',
      getArgumentCompletions: (prefix: string) => completePerchCommand(prefix, tasks.values()),
      handler: async (rawArgs: string | undefined, ctx: ExtensionContext) => {
        if (isSubAgent(ctx)) throw new Error('/perch is only available in the main session.');
        const trimmed = (rawArgs ?? '').trim();
        const [sub, ...rest] = trimmed ? trimmed.split(/\s+/) : [''];
        const argRest = rest.join(' ').trim();

        if (!sub || sub === 'toggle') {
          const next = !perchModeEnabled;
          const config = await setPerchMode(ctx, next, true);
          const roleCount = Object.keys(config.roles).length;
          if (ctx.hasUI) {
            ctx.ui.notify(
              next
                ? `Perch mode ON (${roleCount} roles, layout=${config.layout}, board=${config.board.enabled ? 'on' : 'off'})`
                : 'Perch mode OFF (restored default tools)',
              'info',
            );
          }
          return;
        }
        if (sub === 'on' || sub === 'off') {
          const next = sub === 'on';
          const config = await setPerchMode(ctx, next, true);
          if (ctx.hasUI) {
            ctx.ui.notify(
              next
                ? `Perch mode ON (${Object.keys(config.roles).length} roles, layout=${config.layout})`
                : 'Perch mode OFF (restored default tools)',
              'info',
            );
          }
          return;
        }
        if (sub === 'roles') {
          const config = loadPerchConfig({ cwd: ctx.cwd });
          const table = renderRolesTable(config.roles);
          if (ctx.hasUI) {
            ctx.ui.notify(table || 'No perch.roles configured in config.yml', 'info');
          }
          return;
        }
        if (sub === 'status') {
          const now = Date.now();
          const lines = [`Perch mode: ${perchModeEnabled ? 'ON' : 'OFF'}`];
          if (!tasks.size) {
            lines.push('No tracked workers.');
          } else {
            for (const task of tasks.values()) {
              const elapsed = task.startedAt !== undefined
                ? formatDuration((task.state === 'running' ? now : (task.finishedAt ?? now)) - task.startedAt)
                : '-';
              const paneText = task.pane ? ` pane=${task.pane.backend}:${task.pane.id}` : '';
              const boardText = task.boardItem ? ` board=${task.boardItem}` : '';
              lines.push(`- ${taskLabel(task.id, task)}: ${task.state} (${elapsed})${paneText}${boardText}`);
            }
          }
          if (ctx.hasUI) ctx.ui.notify(lines.join('\n'), 'info');
          return;
        }
        if (sub === 'close') {
          const target = argRest || 'all';
          const matches = target === 'all'
            ? [...tasks.keys()]
            : [...tasks.values()].filter(t => t.id === target || t.name === target).map(t => t.id);
          if (!matches.length) {
            if (ctx.hasUI) ctx.ui.notify(`No tracked worker matching "${target}".`, 'warning');
            return;
          }
          const results = await Promise.allSettled(matches.map(id => closeTrackedWorker(id)));
          const closed = results.filter(r => r.status === 'fulfilled').length;
          if (ctx.hasUI) ctx.ui.notify(`Closed ${closed}/${matches.length} worker(s).`, 'info');
          return;
        }
        // `/perch <task prompt>`: enable mode and immediately send prompt to director.
        if (!perchModeEnabled) {
          await setPerchMode(ctx, true, true);
        }
        if (typeof anyPi.sendUserMessage === 'function') {
          await anyPi.sendUserMessage(trimmed);
        }
      },
    });

    anyPi.registerCommand('board', {
      description: 'Open this session’s shared board',
      handler: async (_args: string | undefined, ctx: ExtensionContext) => {
        if (isSubAgent(ctx) || !ctx.hasUI) throw new Error('/board is available in the owning interactive session.');
        const root = rootSession(ctx as unknown as SessionContext);
        const owner = liveOwner(ctx);
        if (owner && owner.sessionManager.getSessionFile() !== root) throw new Error('Board owner session is unavailable.');
        const sessionId = owner?.sessionManager.getSessionId() ?? ctx.sessionManager.getSessionId();
        if (web && (web.root !== root || web.sessionId !== sessionId || web.owner !== owner)) closeWeb();
        if (!web) {
          mkdirSync(dirname(boardPath(root)), { recursive: true });
          const store = new BoardStore(boardPath(root));
          try {
            const webServer = await startBoardWeb(store, (message, target) => {
              const currentOwner = liveOwner(ctx);
              if (web?.server !== webServer || (owner && currentOwner !== owner) ||
                  safeSessionFile(ctx) !== root || ctx.sessionManager.getSessionId() !== sessionId) {
                throw new Error('The board’s owning session is no longer active.');
              }
              const token = newSpawnToken();
              store.reserveDiscussion(token, target);
              void anyPi.sendUserMessage?.(`${message}\n\nomp-board-discussion:${token}`);
            }, () => ({ id: sessionId, name: anyPi.getSessionName?.() }));
            web = { root, sessionId, owner, store, server: webServer };
          } catch (error) {
            store.close();
            throw error;
          }
        }
        const ui = (ctx as unknown as { ui?: { setStatus?: (k: string, v: string | undefined) => void; notify?: (m: string, l?: string) => void } }).ui;
        ui?.setStatus?.('board', web.server.url);
        ui?.notify?.(`Board: ${web.server.url}`, 'info');
        const ternPane = process.env.TERN_PANE;
        if (ternPane && /^\d+$/.test(ternPane) && Number.isSafeInteger(Number(ternPane))) {
          try {
            const operation = JSON.stringify({ op: 'open', owner: Number(ternPane), url: web.server.url, how: 'beside' });
            if (typeof anyPi.exec === 'function') {
              if ((await anyPi.exec('tern', ['browser', operation, '--timeout', '3'], { timeout: 5000 })).code === 0) return;
            } else {
              await execFileAsync('tern', ['browser', operation, '--timeout', '3'], { timeout: 5000 });
              return;
            }
          } catch {}
        }
        const opener = process.platform === 'darwin' ? ['open'] :
          process.platform === 'linux' ? ['xdg-open'] :
          process.platform === 'win32' ? ['rundll32.exe', 'url.dll,FileProtocolHandler'] : undefined;
        try {
          if (!opener) throw new Error('Browser opener unavailable');
          if (typeof anyPi.exec === 'function') {
            if ((await anyPi.exec(opener[0], [...opener.slice(1), web.server.url], { timeout: 5000 })).code !== 0) {
              throw new Error('Browser opener unavailable');
            }
          } else {
            await execFileAsync(opener[0], [...opener.slice(1), web.server.url], { timeout: 5000 });
          }
        } catch {
          ui?.notify?.('Could not open the browser automatically; use the board link shown above.', 'warning');
        }
      },
    });
  }

  if (!isManagedWorker && typeof anyPi.registerTool === 'function' && typeof anyPi.arktype === 'function') {
    const type = anyPi.arktype;

    anyPi.registerTool({
      name: 'board',
      label: 'Session Board',
      approval: 'write',
      loadMode: 'essential',
      strict: true,
      description: 'Inspect and update this root session’s shared work items and decisions.\nCommon ops & exact params:\n- snapshot: list items/decisions (optional item or decision ID for details)\n- create: title (<=80 chars), description, criteria (optional parentId)\n- edit: item, optional title/description/criteria/priority\n- assign: item, worker, role ("execute" | "review")\n- progress: item, text (set handoff=true for durable findings/blockers/next steps)\n- submit / approve / release / cancel: item, text\n- reject: item, target ("same" | "pool"), text\n- decide: title, text (optional items[]) — NOTE: decision body uses "text", NOT "decision"!\n- note_decision: decision (ID), revision, text\n- replace: decision (ID), revision, title, text (optional items[])',
      parameters: type({
        op: 'string > 0',
        'item?': 'string',
        'parentId?': 'string | null',
        'decision?': 'string',
        'title?': 'string',
        'description?': 'string',
        'criteria?': 'string',
        'text?': 'string',
        'worker?': 'string',
        'role?': "'execute' | 'review'",
        'target?': "'same' | 'pool'",
        'revision?': 'number',
        'source?': 'string',
        'items?': 'string[]',
        'priority?': 'number',
        'handoff?': 'boolean',
        'task?': 'string',
        'phase?': 'string',
      }),
      async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _update: unknown, ctx: ExtensionContext) {
        const root = rootSession(ctx as unknown as SessionContext);
        if (params.op === 'todos' || params.op === 'promote') {
          if (isSubAgent(ctx)) throw new Error('Only the main session can access its native todos.');
          const owner = liveOwner(ctx);
          if (!owner || owner.sessionManager.getSessionFile() !== root || typeof owner.getTodoPhases !== 'function') {
            throw new Error('Native session todos are unavailable.');
          }
          const phases = owner.getTodoPhases();
          const result = params.op === 'todos'
            ? phases
            : withBoard(root, store => ({
                item: itemSummary(promoteTodo(store, phases, String(params.task ?? ''), typeof params.phase === 'string' ? params.phase : undefined, String(params.criteria ?? ''))),
              }));
          return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
        }
        const { task: _task, phase: _phase, ...command } = params;
        if (params.op === 'snapshot') {
          const result = withBoard(root, store => boardView(
            store.snapshot(),
            typeof params.item === 'string' ? params.item : undefined,
            typeof params.decision === 'string' ? params.decision : undefined,
          ));
          return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
        }
        if (isSubAgent(ctx) && (!turn || turn.root !== root || turn.worker !== currentAgentId(ctx))) {
          throw new Error('Worker has no board assignment for this turn.');
        }
        if (params.op === 'decide' && !(typeof params.text === 'string' && params.text.trim()) && typeof params.decision === 'string' && params.decision.trim()) {
          throw new Error('board op=decide requires "title" and "text" (use "text" for the decision body, not "decision").');
        }
        const result = mutationSummary(
          runBoardCommand(root, actorFor(ctx as unknown as SessionContext, root, turn?.attempt), command as Command),
          command as Command,
        );
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      },
    });

    anyPi.registerTool({
      name: 'perch',
      label: 'Perch',
      approval: 'exec',
      loadMode: 'essential',
      strict: true,
      description: 'Delegate work to Perch worker agents (agy, omp, codex, claude). Common ops:\n1) start: pass role (from perch.roles) or provider, short name, and prompt (optional item+boardRole for session board).\n2) send: reuse an existing worker by short name OR session id — if the worker stopped/closed, send automatically resumes its conversation and delivers text!\n3) list: inspect owned workers (including recently stopped resumable workers).\n4) history: read a worker\'s replies by name or id.\n5) close: close a finished worker by name or id.\nAlways rely on automatic [Perch async update] notifications instead of waiting/polling loops.',
      parameters: type({
        op: "'list' | 'start' | 'send' | 'wait' | 'history' | 'resume' | 'close'",
        'role?': 'string > 0',
        'provider?': "'omp' | 'codex' | 'claude' | 'agy'",
        'id?': 'string > 0',
        'name?': 'string > 0',
        'owned?': 'boolean',
        'native?': 'boolean',
        'cwd?': 'string > 0',
        'model?': 'string > 0',
        'executable?': 'string > 0',
        'pane?': "'right' | 'tern' | 'tmux' | 'herdr'",
        'workspace?': 'string > 0',
        'tab?': 'string > 0',
        'prompt?': 'string > 0',
        'text?': 'string > 0',
        'item?': 'string > 0',
        'boardRole?': "'execute' | 'review'",
        'notify?': 'boolean',
        'heartbeatSeconds?': 'number',
        'timeout?': 'number',
        'limit?': 'number',
        'all?': 'boolean',
      }),
      async execute(_toolCallId: string, params: PerchToolParams, signal: AbortSignal | undefined, _update: unknown, ctx: ExtensionContext) {
        if (isSubAgent(ctx)) {
          throw new Error('perch tool is only available in the main orchestrator session, not inside subagents.');
        }
        const config = loadPerchConfig({ cwd: params.cwd || ctx.cwd });
        const emit = (details: unknown) => ({
          content: [{ type: 'text', text: JSON.stringify(details) }],
          details,
        });
        if (params.op === 'list') {
          const args = ['list', '--json'];
          if (params.provider) {
            if (!PROVIDERS.has(params.provider)) throw new Error(`Unsupported provider: ${params.provider}`);
            args.push('--provider', params.provider);
          }
          const result = await runPerchCli(args, { signal, timeoutMs: 15000 });
          if (result.code !== 0) throw new Error(cliErrorMessage(result, 'perch list failed'));
          const liveRows = (parseJson(result.stdout) ?? []) as Array<Record<string, unknown>>;
          const liveById = new Map(liveRows.filter(r => typeof r?.id === 'string').map(r => [r.id as string, r]));
          const now = Date.now();
          const showOwned = params.owned ?? perchModeEnabled;
          if (showOwned) {
            const ownedIds = new Set([...ownedSessions, ...tasks.keys()]);
            const rows: Array<Record<string, unknown>> = [];
            for (const id of ownedIds) {
              const task = tasks.get(id);
              const live = liveById.get(id);
              const provider = task?.provider ?? (typeof live?.provider === 'string' ? live.provider : id.split(':', 1)[0]);
              if (params.provider && provider !== params.provider) continue;
              const elapsedSeconds = task?.startedAt !== undefined
                ? Math.max(0, Math.floor(((task.state === 'running' ? now : (task.finishedAt ?? now)) - task.startedAt) / 1000))
                : undefined;
              const liveStatus = typeof live?.status === 'string' ? live.status : 'stopped';
              rows.push({
                id,
                ...(task?.name ? { name: task.name } : {}),
                ...(task?.role ? { role: task.role } : {}),
                provider,
                ...(task?.model ? { model: task.model } : {}),
                ...(task?.mode ? { mode: task.mode } : {}),
                ...(task?.pane ? { pane: task.pane } : {}),
                ...(task?.boardItem ? { boardItem: task.boardItem } : {}),
                state: task?.state ?? liveStatus,
                unhandled: task?.unhandled ?? false,
                liveStatus,
                ...(liveStatus === 'stopped' ? { resumable: isResumableWorker({ id, provider, mode: task?.mode }) } : {}),
                ...(elapsedSeconds !== undefined ? { elapsedSeconds } : {}),
                ...(task?.error ? { error: task.error } : {}),
                cwd: task?.cwd ?? (typeof live?.cwd === 'string' ? live.cwd : null),
              });
            }
            for (const retired of retiredWorkers.values()) {
              if (ownedIds.has(retired.id)) continue;
              const provider = retired.provider ?? (retired.id.includes(':') ? retired.id.split(':', 1)[0] : undefined);
              if (params.provider && provider !== params.provider) continue;
              rows.push({
                id: retired.id,
                ...(retired.name ? { name: retired.name } : {}),
                ...(retired.role ? { role: retired.role } : {}),
                ...(provider ? { provider } : {}),
                ...(retired.model ? { model: retired.model } : {}),
                ...(retired.mode ? { mode: retired.mode } : {}),
                ...(retired.boardItem ? { boardItem: retired.boardItem } : {}),
                state: 'stopped',
                unhandled: false,
                liveStatus: 'stopped',
                resumable: isResumableWorker(retired),
                cwd: retired.cwd ?? null,
              });
            }
            return emit(rows);
          }
          const enriched = liveRows.map(row => {
            const id = typeof row?.id === 'string' ? row.id : '';
            const task = id ? tasks.get(id) : undefined;
            if (!id || (!ownedSessions.has(id) && !task)) return row;
            return {
              ...row,
              owned: true,
              ...(task?.name ? { name: task.name } : {}),
              ...(task?.role ? { role: task.role } : {}),
              ...(task?.boardItem ? { boardItem: task.boardItem } : {}),
              ...(task?.unhandled ? { unhandled: true } : {}),
            };
          });
          return emit(enriched);
        }
        if (params.op === 'start') {
          let roleCfg: PerchRoleConfig | undefined;
          if (params.role !== undefined) {
            roleCfg = config.roles[params.role];
            if (!roleCfg) {
              const known = Object.keys(config.roles);
              throw new Error(`Unknown perch role "${params.role}".${known.length ? ` Configured roles: ${known.join(', ')}` : ' No perch.roles configured in config.yml.'}`);
            }
          }
          const provider = params.provider ?? roleCfg?.provider;
          if (!provider || !PROVIDERS.has(provider)) {
            throw new Error('perch start requires provider (agy, omp, codex, or claude) or a configured role');
          }
          const model = params.model ?? roleCfg?.model;
          if (params.prompt !== undefined && !params.prompt.trim()) throw new Error('prompt must not be empty');
          if ((params.item !== undefined) !== (params.boardRole !== undefined)) {
            throw new Error('Binding a board item requires both item and boardRole (execute or review).');
          }

          const heartbeatMs = resolveHeartbeatMs(params.heartbeatSeconds, config, perchModeEnabled);
          const taskName = sanitizeName(params.name);
          const cwd = params.cwd || ctx.cwd;
          const defaultNative = ctx.mode === 'tui' && NATIVE_DEFAULT_PROVIDERS.has(provider);
          const useNative = params.native !== undefined
            ? params.native
            : roleCfg?.native !== undefined
              ? (ctx.mode === 'tui' ? roleCfg.native : false)
              : config.native !== undefined
                ? (ctx.mode === 'tui' ? config.native : false)
                : defaultNative;

          // Optional / automatic session board binding
          const boardRoot = safeSessionFile(ctx);
          const shouldBindBoard = !!boardRoot && (
            params.item !== undefined ||
            (config.board.enabled && config.board.autoCreate && (perchModeEnabled || existsSync(boardPath(boardRoot))))
          );
          let boardToken: string | undefined;
          let reservedItemId: string | undefined;
          let boardContextPrompt: string | undefined;
          if (shouldBindBoard && boardRoot) {
            boardToken = newSpawnToken();
            if (params.item !== undefined && params.boardRole !== undefined) {
              withBoard(boardRoot, store => store.beginSpawn(boardToken!, params.item!, params.boardRole!));
              reservedItemId = params.item;
              boardContextPrompt = perchWorkerBoardPrompt(boardRoot, reservedItemId, params.boardRole);
            } else {
              const brief = params.prompt?.split('\n').map(line => line.trim()).find(Boolean);
              const title = [taskName, roleCfg?.label ?? roleCfg?.name, brief].filter(Boolean).join(': ') || `Perch ${provider} worker`;
              withBoard(boardRoot, store => store.beginAutomaticSpawn(boardToken!, title, params.prompt ?? title));
              reservedItemId = withBoard(boardRoot, store => {
                const snap = store.snapshot();
                // automatic pending spawn is hidden from snapshot; read via getSpawn/items directly
                return snap.items.find(i => i.source === `spawn:${boardToken}`)?.id;
              }, false);
            }
          }

          let boardGrantToken: string | undefined;
          if (shouldBindBoard && boardRoot) {
            try {
              const boardRole = params.boardRole ?? 'execute';
              const socket = await boardBridge.ensure();
              boardGrantToken = boardBridge.mint(boardRoot, reservedItemId ?? '', boardRole);
              boardContextPrompt = [
                boardContextPrompt,
                buildBoardWorkerGuide(perchCommandLine(), socket, boardGrantToken, boardRole, reservedItemId),
              ].filter(Boolean).join('\n\n');
            } catch (error) {
              boardGrantToken = undefined;
              const warning = `Perch board access is unavailable for this worker: ${error instanceof Error ? error.message : String(error)}`;
              if (!warnedPromptMessages.has(warning)) {
                warnedPromptMessages.add(warning);
                ctx.ui?.notify?.(warning, 'warning');
              }
            }
          }

          const failBoardReservation = (reason: string) => {
            if (boardGrantToken) boardBridge.revoke(boardGrantToken);
            if (boardToken && boardRoot) {
              try {
                withBoard(boardRoot, store => {
                  if (store.getSpawn(boardToken!)?.state === 'pending') store.failSpawn(boardToken!, reason);
                }, false);
              } catch {}
            }
          };

          const commitBoardReservation = (workerId: string): string | undefined => {
            if (!boardToken || !boardRoot) return undefined;
            withBoard(boardRoot, store => store.commitSpawn(boardToken!, workerId));
            const bound = withBoard(boardRoot, store => store.bindingForWorker(workerId)?.item, false) ?? reservedItemId;
            if (boardGrantToken) boardBridge.bind(boardGrantToken, workerId, bound);
            return bound;
          };

          const effectivePrompt = params.prompt !== undefined
            ? buildWorkerPrompt(params.prompt, config, roleCfg, boardContextPrompt)
            : undefined;

          try {
            if (useNative) {
              const pane = params.pane ?? 'right';
              if (!PANES.has(pane)) throw new Error(`Unsupported pane: ${pane}`);
              const agyInlineLaunchPrompt = provider === 'agy' && effectivePrompt !== undefined
                ? `请阅读并严格执行该文件中的完整指令:${stageAgyNativePrompt(uid, effectivePrompt)}`
                : undefined;
              const discoverMs = resolveNativeDiscoverMs(config);
              const nativeResult = await withNativeLaunchLock(provider, async () => {
                const beforeRows = await listProviderSessions(provider, signal);
                const beforeIds = new Set(
                  beforeRows
                    .filter(r => r?.kind === 'session' && r?.send === true && typeof r?.id === 'string')
                    .map(r => r.id as string),
                );
                const nativeArgs = ['start', provider];
                if (agyInlineLaunchPrompt !== undefined) nativeArgs.push(agyInlineLaunchPrompt);
                nativeArgs.push('--native', '--pane', pane, '--cwd', cwd, '--json');
                if (pane === 'right' && config.layout === 'stack' && !params.workspace && !params.tab) {
                  const stackTarget = await findLiveRightStackTarget();
                  if (stackTarget) {
                    nativeArgs.push('--split', 'down', '--target', stackTarget);
                  }
                }
                if (model) nativeArgs.push('--model', model);
                if (params.executable) nativeArgs.push('--executable', params.executable);
                if (params.workspace) nativeArgs.push('--workspace', params.workspace);
                if (params.tab) nativeArgs.push('--tab', params.tab);
                const childEnv = provider === 'omp'
                  ? { ...process.env, PERCH_MANAGED_WORKER: '1' }
                  : process.env;
                const startedResult = await runPerchCli(nativeArgs, { signal, timeoutMs: 45000, env: childEnv });
                if (startedResult.code !== 0) {
                  if (params.native === undefined && roleCfg?.native === undefined) return { fallback: true as const };
                  throw new Error(cliErrorMessage(startedResult, 'perch start --native failed'));
                }
                const started = parseJson(startedResult.stdout) as { provider?: string; mode?: string; pane?: unknown };
                const paneRef = normalizePaneRef(started.pane);
                if (provider === 'agy' && agyInlineLaunchPrompt === undefined) {
                  return { fallback: false as const, id: undefined, started, paneRef, promptAlreadyDelivered: false };
                }
                let discoveredId: string | undefined;
                try {
                  discoveredId = await waitForNewNativeSession(provider, cwd, beforeIds, discoverMs, signal);
                } catch (error) {
                  await closePaneRef(paneRef);
                  throw error;
                }
                if (!discoveredId) {
                  // Clean up orphan pane on discovery timeout so it does not litter the terminal.
                  await closePaneRef(paneRef);
                  throw new Error(`Native ${provider} pane opened, but no controllable session registered in time (${Math.round(discoverMs / 1000)}s). Orphan pane closed. Ensure perch integration install ${provider} is active, or retry with native=false.`);
                }
                evictRetiredByName(taskName);
                if (paneRef?.backend === 'tern') {
                  rightPaneStack.push({ id: paneRef.id, sessionId: discoveredId });
                }
                const boundItem = commitBoardReservation(discoveredId);
                ensureTask(discoveredId, {
                  ...(taskName ? { name: taskName } : {}),
                  ...(roleCfg ? { role: roleCfg.name } : {}),
                  provider,
                  mode: 'native',
                  ...(model ? { model } : {}),
                  cwd,
                  ...(paneRef ? { pane: paneRef } : {}),
                  ...(boundItem ? { boardItem: boundItem, boardRoot } : {}),
                  state: agyInlineLaunchPrompt !== undefined ? 'running' : 'idle',
                  unhandled: false,
                  ...(agyInlineLaunchPrompt !== undefined ? { turnSeq: 1, startedAt: Date.now(), finishedAt: undefined } : {}),
                  error: undefined,
                  heartbeatCount: 0,
                });
                updatePerchUi(ctx);
                return {
                  fallback: false as const,
                  id: discoveredId,
                  started,
                  paneRef,
                  boardItem: boundItem,
                  promptAlreadyDelivered: agyInlineLaunchPrompt !== undefined,
                };
              });

              if (!nativeResult.fallback) {
                const { id, started, boardItem, promptAlreadyDelivered } = nativeResult;
                if (!id) {
                  failBoardReservation('Native session started without initial prompt or session ID.');
                  return emit({
                    provider,
                    mode: 'native',
                    pane: started.pane,
                    ...(taskName ? { name: taskName } : {}),
                    ...(roleCfg ? { role: roleCfg.name } : {}),
                  });
                }
                if (promptAlreadyDelivered) {
                  const shouldNotify = params.notify !== false;
                  if (shouldNotify) startWatcher(id, heartbeatMs);
                  return emit({
                    id,
                    provider,
                    mode: 'native',
                    pane: started.pane,
                    ...(taskName ? { name: taskName } : {}),
                    ...(roleCfg ? { role: roleCfg.name } : {}),
                    ...(boardItem ? { boardItem } : {}),
                    accepted: true,
                    notify: shouldNotify,
                  });
                }
                if (effectivePrompt !== undefined) {
                  const delivered = await deliverPrompt(id, effectivePrompt, {
                    signal,
                    notify: params.notify !== false,
                    heartbeatMs,
                    name: taskName,
                  });
                  return emit({
                    id,
                    provider,
                    mode: 'native',
                    pane: started.pane,
                    ...(taskName ? { name: taskName } : {}),
                    ...(roleCfg ? { role: roleCfg.name } : {}),
                    ...(boardItem ? { boardItem } : {}),
                    ...delivered,
                  });
                }
                return emit({
                  id,
                  provider,
                  mode: 'native',
                  pane: started.pane,
                  ...(taskName ? { name: taskName } : {}),
                  ...(roleCfg ? { role: roleCfg.name } : {}),
                  ...(boardItem ? { boardItem } : {}),
                });
              }
            }

            const args = ['start', provider, '--cwd', cwd, '--json'];
            if (model) args.push('--model', model);
            if (params.executable) args.push('--executable', params.executable);
            if (params.pane) {
              if (!PANES.has(params.pane)) throw new Error(`Unsupported pane: ${params.pane}`);
              args.push('--pane', params.pane);
            }
            if (params.workspace) args.push('--workspace', params.workspace);
            if (params.tab) args.push('--tab', params.tab);
            const startedResult = await runPerchCli(args, { signal, timeoutMs: 45000 });
            if (startedResult.code !== 0) throw new Error(cliErrorMessage(startedResult, 'perch start failed'));
            const started = parseJson(startedResult.stdout) as { id?: string; provider?: string; pane?: unknown };
            if (!started?.id) throw new Error('perch start did not return a session ID');
            const boundItem = commitBoardReservation(started.id);
            evictRetiredByName(taskName);
            ownedSessions.add(started.id);
            ensureTask(started.id, {
              ...(taskName ? { name: taskName } : {}),
              ...(roleCfg ? { role: roleCfg.name } : {}),
              provider,
              mode: 'managed',
              ...(model ? { model } : {}),
              cwd,
              ...(boundItem ? { boardItem: boundItem, boardRoot } : {}),
              state: 'idle',
              unhandled: false,
              error: undefined,
              heartbeatCount: 0,
            });
            updatePerchUi(ctx);
            if (effectivePrompt !== undefined) {
              const delivered = await deliverPrompt(started.id, effectivePrompt, {
                signal,
                notify: params.notify !== false,
                heartbeatMs,
                name: taskName,
              }).catch(error => {
                throw new Error(`Session ${started.id} started, but initial send failed: ${error instanceof Error ? error.message : String(error)}`);
              });
              return emit({
                ...started,
                ...(taskName ? { name: taskName } : {}),
                ...(roleCfg ? { role: roleCfg.name } : {}),
                ...(boundItem ? { boardItem: boundItem } : {}),
                ...delivered,
              });
            }
            return emit({
              ...started,
              ...(taskName ? { name: taskName } : {}),
              ...(roleCfg ? { role: roleCfg.name } : {}),
              ...(boundItem ? { boardItem: boundItem } : {}),
            });
          } catch (error) {
            failBoardReservation(error instanceof Error ? error.message : String(error));
            throw error;
          }
        }
        const rawTarget = params.id ?? params.name;
        if (!rawTarget) throw new Error(`perch ${params.op} requires id or name`);
        const resolved = resolveWorkerTarget(rawTarget);
        const targetId = resolved.id;

        if (params.op === 'send') {
          const message = params.text ?? params.prompt;
          if (!message || !message.trim()) throw new Error('perch send requires non-empty text');
          const heartbeatMs = resolveHeartbeatMs(params.heartbeatSeconds, config, perchModeEnabled);
          const taskName = sanitizeName(params.name);
          const sendOpts = {
            signal,
            notify: params.notify !== false,
            heartbeatMs,
            name: taskName ?? resolved.task?.name ?? resolved.retired?.name,
          };
          if (resolved.retired && !resolved.task) {
            return emit(await reviveWorkerAndDeliver(resolved.retired, message, ctx, config, sendOpts));
          }
          try {
            const delivered = await deliverPrompt(targetId, message, sendOpts);
            return emit({
              id: targetId,
              ...(sendOpts.name ? { name: sendOpts.name } : {}),
              ...delivered,
            });
          } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            const fallbackRef = resolved.task ?? resolved.retired ?? {
              id: targetId,
              provider: targetId.includes(':') ? targetId.split(':', 1)[0] : undefined,
              mode: (targetId.startsWith('agy:native-') ? 'native' : 'managed') as 'native' | 'managed',
            };
            if (CLOSED_SESSION_RE.test(errMsg) && isResumableWorker(fallbackRef)) {
              return emit(await reviveWorkerAndDeliver(fallbackRef, message, ctx, config, sendOpts));
            }
            throw error;
          }
        }
        if (params.op === 'wait') {
          const forceNonBlocking = perchModeEnabled && (params.timeout === undefined || params.timeout > 0);
          const effectiveTimeout = forceNonBlocking ? 0 : params.timeout;
          const args = ['wait', targetId, '--json'];
          if (effectiveTimeout !== undefined) {
            if (!Number.isSafeInteger(effectiveTimeout) || effectiveTimeout < 0 || effectiveTimeout > 86400) {
              throw new Error('timeout must be an integer between 0 and 86400 seconds');
            }
            args.push('--timeout', String(effectiveTimeout));
          }
          const result = await runPerchCli(args, { signal });
          let parsed: { status?: string; error?: string } | undefined;
          try { parsed = parseJson(result.stdout) as { status?: string; error?: string } | undefined; } catch {}
          if (parsed && typeof parsed === 'object') {
            if (forceNonBlocking && parsed.status === 'timeout') {
              const hasWatcher = watchers.has(targetId);
              return emit({
                id: targetId,
                ...(resolved.task?.name ? { name: resolved.task.name } : {}),
                status: 'running',
                nonBlocking: true,
                watcherAttached: hasWatcher,
                note: hasWatcher
                  ? 'Worker is still running. End your turn and wait for the automatic [Perch async update].'
                  : 'Worker is still running (no async watcher attached; check later with perch op=list or op=history).',
              });
            }
            const task = tasks.get(targetId);
            if (task && typeof parsed.status === 'string' && ['completed', 'failed', 'needs_input', 'interrupted'].includes(parsed.status)) {
              task.state = parsed.status as TaskState;
              task.finishedAt = Date.now();
              if (typeof parsed.error === 'string') task.error = parsed.error;
              updatePerchUi(ctx);
            }
            return emit(parsed);
          }
          throw new Error(cliErrorMessage(result, 'perch wait failed'));
        }
        if (params.op === 'history') {
          const args = ['history', targetId, '--json'];
          if (params.all) args.push('--all');
          else if (params.limit !== undefined) {
            if (!Number.isSafeInteger(params.limit) || params.limit <= 0) throw new Error('limit must be a positive integer');
            args.push('--limit', String(params.limit));
          }
          const result = await runPerchCli(args, { signal, timeoutMs: 15000 });
          if (result.code !== 0) throw new Error(cliErrorMessage(result, 'perch history failed'));
          const task = tasks.get(targetId);
          if (task && task.state !== 'running') {
            if (task.unhandled) task.acknowledgedAt = Date.now();
            task.unhandled = false;
          }
          updatePerchUi(ctx);
          return emit(parseJson(result.stdout) ?? []);
        }
        if (params.op === 'resume') {
          const ref = resolved.retired ?? resolved.task;
          if (ref?.mode === 'native') {
            const msg = params.text ?? params.prompt;
            if (msg && msg.trim()) {
              const heartbeatMs = resolveHeartbeatMs(params.heartbeatSeconds, config, perchModeEnabled);
              return emit(await reviveWorkerAndDeliver(ref, msg, ctx, config, {
                signal,
                notify: params.notify !== false,
                heartbeatMs,
                name: sanitizeName(params.name) ?? ref.name,
              }));
            }
            throw new Error(`To resume native ${ref.provider ?? 'worker'} session ${targetId}, call perch op=send id="${ref.name ?? targetId}" with your next message — it will automatically reopen and resume the conversation.`);
          }
          const result = await runPerchCli(['resume', targetId, '--json'], { signal, timeoutMs: 45000 });
          if (result.code !== 0) throw new Error(cliErrorMessage(result, 'perch resume failed'));
          const resumed = parseJson(result.stdout) as { id?: string; provider?: string };
          if (resumed?.id) {
            retiredWorkers.delete(targetId);
            retiredWorkers.delete(resumed.id);
            evictRetiredByName(ref?.name);
            ownedSessions.add(resumed.id);
            const reboundItem = ref?.boardItem
              ? rebindBoardForRevivedWorker(ref.boardRoot, targetId, resumed.id)
              : undefined;
            ensureTask(resumed.id, {
              ...(ref?.name ? { name: ref.name } : {}),
              ...(ref?.role ? { role: ref.role } : {}),
              provider: resumed.provider ?? resumed.id.split(':', 1)[0],
              mode: 'managed',
              ...(ref?.model ? { model: ref.model } : {}),
              ...(ref?.cwd ? { cwd: ref.cwd } : {}),
              boardItem: reboundItem,
              boardRoot: reboundItem ? ref?.boardRoot : undefined,
              state: 'idle',
              finishedAt: undefined,
              acknowledgedAt: undefined,
            });
            updatePerchUi(ctx);
          }
          return emit(resumed);
        }
        if (params.op === 'close') {
          return emit(await closeTrackedWorker(targetId, signal));
        }
        throw new Error(`Unsupported perch operation: ${params.op}`);
      },
    });
  }

  pi.on('context', (event, ctx) => {
    const existing = Array.isArray((event as { messages?: unknown[] })?.messages) ? (event as { messages: unknown[] }).messages : [];
    const additions: Array<Record<string, unknown>> = [];

    if (isSubAgent(ctx)) {
      if (!turn) {
        try { turn = captureTurn(ctx as unknown as SessionContext); } catch { return; }
      }
      if (!turn) return;
      watchDecisions(turn.root);
      const boardCurrent = workerContext(turn.root, turn.worker);
      if (!boardCurrent) { closeDecisionWatch(); return; }
      decisionVersion ??= boardCurrent.decisions;
      turn.attempt ??= boardCurrent.attempt;
      return {
        messages: [...existing, {
          role: 'custom' as const,
          customType: 'session-board-current',
          content: boardCurrent.text,
          display: false,
          attribution: 'agent' as const,
          timestamp: Date.now(),
        }],
      };
    }

    if (isManagedWorker) return;

    // 1. Perch workspace view (/perch mode) or active task ledger (plain mode)
    const allTasks = [...tasks.values()];
    const active = allTasks.filter(task => task.state === 'running' || task.unhandled);
    const resumableRetired = [...retiredWorkers.values()].filter(r => isResumableWorker(r));
    if (perchModeEnabled && (allTasks.length || resumableRetired.length)) {
      const unhandled = active.filter(task => task.unhandled);
      pendingLedgerAck = unhandled.length ? new Map(unhandled.map(task => [task.id, task.finishSeq])) : undefined;
      additions.push({
        role: 'custom' as const,
        customType: 'perch-task-ledger',
        display: false,
        attribution: 'agent' as const,
        content: formatWorkspaceView(allTasks, resumableRetired, Date.now()),
        timestamp: Date.now(),
      });
    } else if (active.length) {
      const unhandled = active.filter(task => task.unhandled);
      pendingLedgerAck = unhandled.length ? new Map(unhandled.map(task => [task.id, task.finishSeq])) : undefined;
      additions.push({
        role: 'custom' as const,
        customType: 'perch-task-ledger',
        display: false,
        attribution: 'agent' as const,
        content: formatLedger(active, Date.now()),
        timestamp: Date.now(),
      });
    } else {
      pendingLedgerAck = undefined;
    }

    // 2. Session board pending receipt notices
    const file = safeSessionFile(ctx);
    const sessionId = ctx.sessionManager.getSessionId();
    const owner = liveOwner(ctx);
    if (file && file === previousRoot && mainRoot !== file &&
        (!owner || (owner.sessionManager.getSessionFile() === file && owner.sessionManager.getSessionId() === sessionId))) {
      mainRoot = file;
    }
    const root = mainRoot ?? file;
    if (root && file === root && (!owner || (owner.sessionManager.getSessionFile() === root && owner.sessionManager.getSessionId() === sessionId))) {
      const notices = withBoard(root, store => store.pendingReceiptNotices(), false) ?? [];
      if (notices.length) {
        receiptContext = { root, sessionId, owner, notices };
        const items = [...new Map(notices.map(({ item, attempt }) => [item, { item, attempt }])).values()];
        additions.push({
          role: 'custom' as const,
          customType: 'session-board-receipts',
          display: false,
          attribution: 'agent' as const,
          content: `Board recorded worker returns for these items and attempts: ${JSON.stringify(items)}. Inspect each current item and its evidence; a return does not mean submission or approval.`,
          timestamp: Date.now(),
        });
      } else {
        receiptContext = undefined;
      }
    } else {
      receiptContext = undefined;
    }

    // In /perch mode, strip any stale eager-task-prelude injected before /perch was toggled on.
    const baseMessages = perchModeEnabled
      ? existing.filter(m => !(m && typeof m === 'object' && (m as { customType?: string }).customType === 'eager-task-prelude'))
      : existing;

    if (!additions.length && baseMessages.length === existing.length) return;
    return { messages: [...baseMessages, ...additions] };
  });

  pi.on('message_end', (event, ctx) => {
    if (isManagedWorker || isSubAgent(ctx)) return;
    const msg = (event as { message?: { role?: string; stopReason?: string; content?: unknown } })?.message;
    if (msg?.role !== 'assistant') return;

    const replyText = assistantText(msg.content).trim();
    if (replyText) lastAssistantText = replyText;
    if (replyText && (msg.stopReason === 'stop' || msg.stopReason === 'toolUse')) {
      void maybeReviewReply(ctx, 'turn', replyText);
    }

    if (pendingLedgerAck) {
      const delivered = pendingLedgerAck;
      pendingLedgerAck = undefined;
      if (msg.stopReason === 'stop') {
        const ackAt = Date.now();
        for (const [id, seq] of delivered) {
          const task = tasks.get(id);
          if (task && task.finishSeq === seq && task.state !== 'running') {
            if (task.unhandled) task.acknowledgedAt = ackAt;
            task.unhandled = false;
          }
        }
        updatePerchUi(ctx);
      }
    }

    if (receiptContext) {
      const delivered = receiptContext;
      receiptContext = undefined;
      if (msg.stopReason === 'stop' || msg.stopReason === 'toolUse') {
        const owner = liveOwner(ctx);
        const file = safeSessionFile(ctx);
        if ((mainRoot === delivered.root || file === delivered.root) &&
            (!delivered.owner || owner === delivered.owner) &&
            file === delivered.root && ctx.sessionManager.getSessionId() === delivered.sessionId) {
          try { withBoard(delivered.root, store => store.deliverReceiptNotices(() => {}, delivered.notices), false); } catch {}
        }
      }
    }
  });

  pi.on('agent_start', () => {
    pendingSendUntil = 0;
  });

  pi.on('agent_end', async (event, ctx) => {
    agentEndSeq = sendSeq;
    pendingSendUntil = 0;

    if (isSubAgent(ctx)) {
      if ((event as { willContinue?: boolean })?.willContinue || !turn) return;
      try { recordTurn(ctx as unknown as SessionContext, turn); } finally { turn = undefined; decisionVersion = undefined; closeDecisionWatch(); }
      return;
    }
    if (isManagedWorker) return;

    if (!(event as { willContinue?: boolean })?.willContinue && lastAssistantText) {
      const finalReply = lastAssistantText;
      lastAssistantText = '';
      void maybeReviewReply(ctx, 'agent-end', finalReply);
    }

    const root = safeSessionFile(ctx);
    if (!root) return;
    const shouldScan = withBoard(root, store => !!store.activeDiscussion() && !!store.discussionScan(), false);
    if (shouldScan) {
      try {
        const branch = ctx.sessionManager.getBranch() as Array<{ id: string; type: string; message?: { role: string; content?: unknown; stopReason?: string } }>;
        withBoard(root, store => {
          const scan = store.discussionScan();
          if (!scan) return;
          const start = scan.cursor === null ? -1 : branch.findIndex(entry => entry.id === scan.cursor);
          if (scan.cursor !== null && start < 0) throw new Error('Discussion transcript cursor is unavailable');
          let token = scan.token;
          let cursor = scan.cursor;
          let cursorToken = scan.token;
          let users: { id: string; token: string | null }[] = [];
          for (const entry of branch.slice(start + 1)) {
            if (entry.type !== 'message' || !entry.message) continue;
            if (entry.message.role === 'user') {
              const marker = discussionText(entry.message.content).match(/(?:^|\n)omp-board-discussion:([0-9a-f-]{36})(?:\n|$)/)?.[1];
              if (marker) token = store.activateDiscussion(marker) ? marker : null;
              users.push({ id: entry.id, token });
            } else if (entry.message.role === 'assistant' && entry.message.stopReason === 'stop') {
              for (const user of users) {
                if (user.token) store.queueDiscussion(user.token, `${user.id}:${entry.id}`, user.id, entry.id);
              }
              users = [];
              cursor = entry.id;
              cursorToken = token;
            }
          }
          if (cursor && cursor !== scan.cursor) store.advanceDiscussionScan(cursor, cursorToken);
        }, false);
      } catch {
        ctx.ui?.notify?.('Board discussion scan failed (transcript-or-storage); later turns will retry.', 'warning');
      }
    }

    const running = discussionProcessing.get(root);
    if (running) { running.again = true; return; }
    const job = { again: false };
    discussionProcessing.set(root, job);
    const sessionId = ctx.sessionManager.getSessionId();
    const anyCtx = ctx as unknown as { model?: unknown; modelRegistry?: unknown; sessionManager: { getEntries?: () => Array<{ id: string; type: string; message?: { role: string; content?: unknown } }> } };
    const modelContext = {
      model: anyCtx.model,
      modelRegistry: anyCtx.modelRegistry,
      sessionManager: { getSessionId: () => sessionId },
    } as unknown as DiscussionModelContext;
    try {
      do {
        job.again = false;
        const pending = withBoard(root, store => store.pendingDiscussions(), false) ?? [];
        if (!pending.length) break;
        const entries = new Map((anyCtx.sessionManager.getEntries?.() ?? []).map(entry => [entry.id, entry]));
        let failed = false;
        for (const row of pending) {
          if (withBoard(root, store => store.discussionEnded(row.token), false)) {
            withBoard(root, store => store.traceDiscussion('skipped-ended', row.token, row.user_entry, row.assistant_entry), false);
            withBoard(root, store => store.completeDiscussion(row.key), false);
            continue;
          }
          const userEntry = entries.get(row.user_entry);
          const assistantEntry = entries.get(row.assistant_entry);
          if (!userEntry || userEntry.type !== 'message' || userEntry.message?.role !== 'user' ||
              !assistantEntry || assistantEntry.type !== 'message' || assistantEntry.message?.role !== 'assistant') {
            ctx.ui?.notify?.('Board discussion retry is pending: session message references are unavailable.', 'warning');
            withBoard(root, store => store.deferDiscussion(row.key), false);
            continue;
          }
          const activeDisc = withBoard(root, store => store.discussion(row.token), false);
          if (!activeDisc) continue;
          const originalUser = discussionText(userEntry.message.content);
          const initial = /(?:^|\n)omp-board-discussion:[0-9a-f-]{36}(?:\n|$)/.test(originalUser);
          const user = originalUser.replace(/(?:^|\n)omp-board-discussion:[0-9a-f-]{36}(?:\n|$)/, '\n');
          const assistant = discussionText(assistantEntry.message.content);
          if (!user.trim() || !assistant.trim()) {
            ctx.ui?.notify?.('Board discussion retry is pending: session message content is unavailable.', 'warning');
            withBoard(root, store => store.deferDiscussion(row.key), false);
            continue;
          }
          try {
            const result = await summarizeDiscussion(modelContext, activeDisc.target, activeDisc.recent, user, assistant, undefined, initial);
            const recorded = withBoard(root, store => {
              if (!result.related) { if (!initial) store.clearDiscussion(row.token); }
              else if (result.summary) store.archiveDiscussion(row.token, row.key, result.summary);
              store.traceDiscussion(!result.related ? (initial ? 'initial-unrelated' : 'unrelated') :
                result.summary ? 'archived' : 'empty', row.token, row.user_entry, row.assistant_entry);
              store.completeDiscussion(row.key);
              return true;
            }, false);
            if (!recorded) throw new Error('Board is unavailable');
          } catch (error) {
            const reason = error instanceof DiscussionFailure ? `${error.stage}:${error.category}` : 'storage-or-runtime';
            try { withBoard(root, store => store.traceDiscussion(`failure:${reason}`, row.token, row.user_entry, row.assistant_entry), false); } catch {}
            ctx.ui?.notify?.(`Board discussion archive pending (${reason}); it will retry on a later turn.`, 'warning');
            failed = true;
            break;
          }
        }
        if (failed) break;
      } while (job.again && safeSessionFile(ctx) === root);
    } finally {
      discussionProcessing.delete(root);
    }
  });

  pi.on('mode_changed', async (event, ctx) => {
    const state = (event as { state?: { vibe?: { status?: string } } })?.state;
    if (state?.vibe?.status === 'active') await ensureToolActiveInVibe(ctx);
  });

  pi.on('before_agent_start', async (event, ctx) => {
    const ev = event as { reason?: string; prompt?: string; systemPrompt?: string | string[] };
    if (isSubAgent(ctx)) {
      if (ev.reason === 'revive') return;
      const token = promptSpawnToken(ev.prompt ?? '');
      let root: string;
      try { root = rootSession(ctx as unknown as SessionContext); }
      catch (error) {
        if (token) { (ctx as unknown as { abort?: () => void }).abort?.(); throw error; }
        return;
      }
      try {
        if (token) await awaitSpawn(root, token, currentAgentId(ctx));
        turn = captureTurn(ctx as unknown as SessionContext);
        if (!turn) {
          if (token) throw new Error('Board spawn did not start in the expected child session.');
          return;
        }
        watchDecisions(turn.root);
        const boardCurrent = workerContext(turn.root, turn.worker);
        if (!boardCurrent) {
          closeDecisionWatch();
          if (token) throw new Error('Board spawn has no committed binding.');
          return;
        }
        decisionVersion = boardCurrent.decisions;
        turn.attempt ??= boardCurrent.attempt;
        return { message: { customType: 'session-board-work', content: boardCurrent.text, display: false, attribution: 'agent' } };
      } catch (error) {
        if (token) (ctx as unknown as { abort?: () => void }).abort?.();
        throw error;
      }
    }

    await ensureToolActiveInVibe(ctx);
    if (isManagedWorker) return;

    if (typeof ev.prompt === 'string' && ev.reason !== 'revive' && !/^\s*\[Perch /.test(ev.prompt)) {
      lastUserPrompt = ev.prompt;
    }
    lastAssistantText = '';

    const config = loadPerchConfig({ cwd: ctx.cwd });
    if (perchModeEnabled) {
      await syncPerchTools(ctx, config);
      await reapIdleWorkers(config.idleCloseSeconds);
      syncIdleReaper(ctx, config);
    }

    const file = safeSessionFile(ctx);
    if (file && mainRoot !== file && (!mainRoot || file === previousRoot)) {
      const owner = liveOwner(ctx);
      if (!owner || (owner.sessionManager.getSessionFile() === file && owner.sessionManager.getSessionId() === ctx.sessionManager.getSessionId())) {
        mainRoot = file;
      }
    }
    if (file && ev.reason !== 'revive') {
      const token = (ev.prompt ?? '').match(/(?:^|\n)omp-board-discussion:([0-9a-f-]{36})(?:\n|$)/)?.[1];
      const activeDisc = withBoard(file, store => store.activeDiscussion(), false);
      if (token || activeDisc) {
        const branch = ctx.sessionManager.getBranch() as Array<{ id: string; type: string; message?: { role: string; stopReason?: string } }>;
        const userIndex = branch.findLastIndex(entry => entry.type === 'message' && entry.message?.role === 'user');
        const previous = branch.slice(0, userIndex < 0 ? branch.length : userIndex).findLast(entry =>
          entry.type === 'message' && entry.message?.role === 'assistant' && entry.message.stopReason === 'stop');
        withBoard(file, store => {
          store.startDiscussionScan(previous?.id ?? null, activeDisc?.token ?? null);
          if (token) store.activateDiscussion(token);
        }, false);
      }
    }

    let nextSystemPrompt: string[] | undefined;
    if (perchModeEnabled) {
      const base = Array.isArray(ev.systemPrompt) ? ev.systemPrompt : typeof ev.systemPrompt === 'string' ? [ev.systemPrompt] : [];
      const rendered = renderPerchSystemPromptWithWarnings(config, { cwd: ctx.cwd });
      for (const warning of rendered.warnings) {
        if (!warnedPromptMessages.has(warning)) {
          warnedPromptMessages.add(warning);
          ctx.ui?.notify?.(warning, 'warning');
        }
      }
      nextSystemPrompt = [...base, rendered.prompt];
    }

    let boardMessage: { customType: string; content: string; display: boolean; attribution: 'agent' } | undefined;
    const vibeActive = (ctx as unknown as { sessionModes?: { getState?: () => { vibe?: { status?: string } } } })?.sessionModes?.getState?.()?.vibe?.status === 'active';
    if (file && (existsSync(boardPath(file)) || vibeActive || (perchModeEnabled && config.board.enabled))) {
      const snapshot = withBoard(file, store => store.snapshot(), false) ?? { items: [], decisions: [] };
      if (snapshot.items.length || snapshot.decisions.length || vibeActive) {
        boardMessage = {
          customType: 'session-board-guide',
          content: managerGuidance(snapshot),
          display: false,
          attribution: 'agent',
        };
      }
    }

    if (!nextSystemPrompt && !boardMessage) return;
    return {
      ...(nextSystemPrompt ? { systemPrompt: nextSystemPrompt } : {}),
      ...(boardMessage ? { message: boardMessage } : {}),
    };
  });

  pi.on('session_start', async (_event, ctx) => {
    await ensureToolActiveInVibe(ctx);

    if (isSubAgent(ctx)) {
      const anyCtx = ctx as unknown as { setInterval?: (fn: () => void, ms: number) => void };
      anyCtx.setInterval?.(() => {
        if (ctx.isIdle() || !turn || !decisionWatch || decisionWatch.root !== turn.root) return;
        const version = decisionWatch.store.dataVersion();
        if (version === decisionWatch.version) return;
        const decisions = workerDecisionVersion(decisionWatch.store, turn.worker);
        decisionWatch.version = version;
        if (decisionVersion === undefined) { decisionVersion = decisions; return; }
        if (decisionVersion === decisions) return;
        decisionVersion = decisions;
        anyPi.sendMessage?.({
          customType: 'session-board-decisions', display: false, attribution: 'agent',
          content: 'Related effective board decisions changed. If tools are permitted, use board op=snapshot to inspect them and record important confirmed or ruled out findings and next steps with board op=progress and handoff=true. Respect explicit task and higher-priority tool restrictions.',
        }, { deliverAs: 'aside' });
      }, 1000);
    } else if (!isManagedWorker) {
      mainRoot = safeSessionFile(ctx);
      recoverBoard(mainRoot, 'Session restarted before spawn completed.');
      unsubscribeRegistry?.();
      const reg = anyPi.pi?.AgentRegistry?.global?.();
      if (reg && typeof reg.onChange === 'function') {
        unsubscribeRegistry = reg.onChange(event => {
          if (!mainRoot || (event.type !== 'removed' && !(event.type === 'status_changed' && event.ref.status === 'aborted'))) return;
          const ref = event.ref;
          if (ref.kind !== 'sub' || ref.sessionFile !== join(mainRoot.slice(0, -6), `${ref.id}.jsonl`)) return;
          const owner = liveOwner(ctx);
          if (owner && owner.sessionManager.getSessionFile() !== mainRoot) return;
          try {
            withBoard(mainRoot, store => store.releaseWorker(ref.id, 'Worker is no longer available.'), false);
          } catch (error) {
            ctx.ui?.notify?.(`Board could not release unavailable worker ${ref.id}: ${String(error)}`, 'warning');
          }
        });
      }
      const config = loadPerchConfig({ cwd: ctx.cwd });
      perchModeEnabled = restorePerchModeFromBranch(ctx, config);
      await syncPerchTools(ctx, config);
      syncIdleReaper(ctx, config);
      updatePerchUi(ctx);
    }

    if (ctx.mode !== 'tui' && ctx.mode !== 'rpc') return;
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (error: unknown) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') return;
    }
    try {
      const stat = lstatSync(dir);
      if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0) return;
      activate(ctx);
      server = createServer(socket => {
        socket.setEncoding('utf8');
        socket.setTimeout(120000, () => socket.destroy());
        let data = '';
        socket.on('error', () => {});
        socket.on('data', async chunk => {
          data += chunk;
          if (Buffer.byteLength(data) > 1024 * 1024) return socket.destroy();
          const end = data.indexOf('\n');
          if (end < 0) return;
          socket.removeAllListeners('data');
          try {
            const req: unknown = JSON.parse(data.slice(0, end));
            if (!req || typeof req !== 'object' || !('op' in req)) throw new Error('Invalid request');
            if (!current || stopping) throw new Error('Session unavailable');
            const ctx = current;
            const sessionId = ctx.sessionManager.getSessionId();
            if (typeof sessionId !== 'string' || !sessionId) throw new Error('Session identity unavailable');
            const id = `omp:${process.pid}:${identity}`;
            if (req.op === 'info') {
              let title: string | undefined;
              try { title = pi.getSessionName(); } catch {}
              const status = sessionStatus(ctx);
              socket.end(JSON.stringify({ ok: true, id, pid: process.pid, mode: ctx.mode, cwd: ctx.cwd, sessionId, title, status, waitIdle: true }) + '\n');
              return;
            }
            if (!('id' in req) || req.id !== id) throw new Error('Session identity changed');
            if (req.op === 'send') {
              if (!('text' in req) || typeof req.text !== 'string' || !req.text || Buffer.byteLength(req.text) > 512 * 1024) throw new Error('Invalid message');
              sendSeq += 1;
              pendingSendUntil = Date.now() + SEND_BUSY_GRACE_MS;
              const admission = pi.sendUserMessage(req.text, { deliverAs: 'steer' });
              admissions.add(admission);
              try { await admission; }
              catch (error) {
                agentEndSeq = sendSeq;
                pendingSendUntil = 0;
                throw error;
              } finally { admissions.delete(admission); }
              socket.end(JSON.stringify({ ok: true }) + '\n');
              return;
            }
            if (req.op === 'wait') {
              if (!('timeoutMs' in req) || (req.timeoutMs !== null && (typeof req.timeoutMs !== 'number' || !Number.isSafeInteger(req.timeoutMs) || req.timeoutMs < 0 || req.timeoutMs > 2147470000))) throw new Error('Invalid timeout');
              socket.setTimeout(0);
              const deadline = req.timeoutMs === null ? Infinity : Date.now() + req.timeoutMs;
              while (true) {
                if (current !== ctx || stopping || id !== `omp:${process.pid}:${identity}`) throw new Error('Session identity changed');
                if (socket.destroyed) return;
                if (sessionStatus(ctx) === 'idle') {
                  socket.end(JSON.stringify({ ok: true, status: 'completed' }) + '\n');
                  return;
                }
                if (Date.now() >= deadline) {
                  socket.end(JSON.stringify({ ok: true, status: 'timeout' }) + '\n');
                  return;
                }
                await delay(Math.min(50, deadline - Date.now()));
              }
            }
            if (req.op === 'history') {
              if (!('limit' in req) || (req.limit !== null && (typeof req.limit !== 'number' || !Number.isSafeInteger(req.limit) || req.limit <= 0))) throw new Error('Invalid limit');
              const rows = [];
              for (const entry of ctx.sessionManager.getBranch()) {
                if (entry.type !== 'message' || !['user', 'assistant'].includes(entry.message?.role)) continue;
                const content = entry.message.content;
                const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(part => part.type === 'text').map(part => part.text).join('') : '';
                if (text) rows.push({ role: entry.message.role, text });
              }
              const selected = req.limit === null ? rows : rows.slice(-req.limit);
              const response = JSON.stringify({ ok: true, messages: selected });
              if (Buffer.byteLength(response) > 16 * 1024 * 1024) throw new Error('History exceeds response limit');
              socket.end(response + '\n');
              return;
            }
            throw new Error('Unsupported operation');
          } catch {
            socket.end(JSON.stringify({ ok: false, error: 'Request rejected' }) + '\n');
          }
        });
      });
      server.on('error', () => { pause(); });
      server.listen(path, () => { try { chmodSync(path, 0o600); } catch { pause(); server?.close(); } });
    } catch { pause(); }
  });

  pi.on('session_before_switch', async (_event, ctx) => {
    if (!isSubAgent(ctx) && !isManagedWorker) {
      if (mainRoot) previousRoot = mainRoot;
      mainRoot = undefined;
      receiptContext = undefined;
      retiredWorkers.clear();
      warnedPromptMessages.clear();
      stopIdleReaper();
      closeWeb();
      const ui = (ctx as unknown as { ui?: { setStatus?: (k: string, v: string | undefined) => void } }).ui;
      ui?.setStatus?.('board', undefined);
      ui?.setStatus?.('perch', undefined);
    }
    await pauseAndDrain();
  });

  pi.on('session_switch', async (event, ctx) => {
    if (!stopping && server?.listening) activate(ctx);
    if (!isSubAgent(ctx) && !isManagedWorker) {
      receiptContext = undefined;
      mainRoot = safeSessionFile(ctx);
      recoverBoard((event as { previousSessionFile?: string })?.previousSessionFile, 'Session switched before spawn completed.');
      recoverBoard(mainRoot, 'Session resumed before spawn completed.');
      const config = loadPerchConfig({ cwd: ctx.cwd });
      perchModeEnabled = restorePerchModeFromBranch(ctx, config);
      await syncPerchTools(ctx, config);
      syncIdleReaper(ctx, config);
      updatePerchUi(ctx);
    }
  });

  pi.on('session_before_branch', pauseAndDrain);
  pi.on('session_branch', (_event, ctx) => { if (!stopping && server?.listening) activate(ctx); });
  pi.on('session_before_tree', pauseAndDrain);
  pi.on('session_tree', (_event, ctx) => { if (!stopping && server?.listening) activate(ctx); });

  pi.on('session_shutdown', async (_event, ctx) => {
    if (isSubAgent(ctx)) {
      closeDecisionWatch();
      return;
    }
    stopping = true;
    stopIdleReaper();
    await pauseAndDrain();
    mainRoot = undefined;
    previousRoot = undefined;
    receiptContext = undefined;
    closeWeb();
    unsubscribeRegistry?.();
    unsubscribeRegistry = undefined;
    recoverBoard(safeSessionFile(ctx), 'Session shut down before spawn completed.');

    const toClose = [...ownedSessions];
    ownedSessions.clear();
    roleReviewers.clear();
    reviewsInFlight.clear();
    lastReviewedHash.clear();
    tasks.clear();
    retiredWorkers.clear();
    warnedPromptMessages.clear();
    rightPaneStack.length = 0;
    if (toClose.length) {
      await Promise.allSettled(toClose.map(id => runPerchCli(['close', id, '--json'], { timeoutMs: 3000 }).catch(() => {})));
    }
    boardBridge.close();
    server?.close();
    try { unlinkSync(path); } catch {}
  });
}
