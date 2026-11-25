import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { existsSync, mkdirSync, lstatSync, chmodSync, realpathSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { systemLanguage } from './locale.mjs';
import { translateDiagnostic } from './diagnostics.mjs';

const PROVIDERS = new Set(['omp', 'codex', 'claude', 'agy']);
const NATIVE_DEFAULT_PROVIDERS = new Set(['omp', 'agy']);
const PANES = new Set(['right', 'tern', 'tmux', 'herdr']);
const MAX_CLI_STDOUT = 16 * 1024 * 1024;
const MAX_NOTIFICATION_CHARS = 4000;
const MAX_HEARTBEAT_PREVIEW_CHARS = 600;
const DEFAULT_HEARTBEAT_SECONDS = 180;
const DEFAULT_NATIVE_DISCOVER_MS = 15000;

type PerchToolParams = {
  op: string;
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
  provider?: string;
  mode?: 'managed' | 'native';
  model?: string;
  cwd?: string;
  state: TaskState;
  unhandled: boolean;
  finishSeq: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  heartbeatCount: number;
};

type WatcherEntry = {
  controller: AbortController;
  generation: number;
  timer?: ReturnType<typeof setInterval>;
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

function resolveHeartbeatMs(heartbeatSeconds: number | undefined): number {
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
  const meta = [task?.provider, task?.model].filter(Boolean).join(' / ');
  const base = task?.name ? `${task.name} (${id})` : id;
  return meta ? `${base} [${meta}]` : base;
}

function resolveNativeDiscoverMs(): number {
  const raw = process.env.PERCH_NATIVE_DISCOVER_MS?.trim();
  if (raw !== undefined && raw !== '') {
    const parsed = Number(raw);
    if (Number.isSafeInteger(parsed) && parsed >= 100 && parsed <= 60000) return parsed;
  }
  return DEFAULT_NATIVE_DISCOVER_MS;
}

function canonicalDir(value: string | undefined): string | null {
  if (!value) return null;
  try { return realpathSync(value); } catch { return resolve(value); }
}

function formatNotification(
  id: string,
  status: string,
  task: TrackedTask | undefined,
  errorText: string | undefined,
  replyText: string | undefined,
): string {
  const lines = [
    '[Perch async update]',
    `Session: ${taskLabel(id, task)}`,
    `Status: ${status}${errorText ? ` — ${errorText}` : ''}`,
  ];
  if (replyText) {
    const clipped = clipText(replyText, MAX_NOTIFICATION_CHARS);
    lines.push('Latest assistant reply:', clipped.text);
  }
  lines.push('Action: inspect this result, update the user with your current status/decision tables, and proceed with the next step (or call perch op=close for managed sessions when finished).');
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
    if (task.state === 'running') {
      const elapsed = task.startedAt !== undefined ? ` (elapsed ${formatDuration(now - task.startedAt)})` : '';
      return `- ${label}: running${elapsed}`;
    }
    const err = task.error ? ` — ${task.error}` : '';
    const flag = task.unhandled ? ' [UNHANDLED — inspect/report via perch history|send|close]' : '';
    return `- ${label}: ${task.state}${err}${flag}`;
  });
  return [
    '[Perch active task ledger]',
    ...rows,
    'Track every running or UNHANDLED task above; do not drop dispatched work.',
  ].join('\n');
}

// Loaded explicitly or through the user's opt-in OMP integration.
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
  const admissions = new Set<Promise<void>>();
  const ownedSessions = new Set<string>();
  const tasks = new Map<string, TrackedTask>();
  const watchers = new Map<string, WatcherEntry>();
  const nativeLaunchChains = new Map<string, Promise<void>>();

  async function withNativeLaunchLock<T>(provider: string, fn: () => Promise<T>): Promise<T> {
    const previous = nativeLaunchChains.get(provider) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const next = previous.then(() => gate);
    nativeLaunchChains.set(provider, next);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (nativeLaunchChains.get(provider) === next) nativeLaunchChains.delete(provider);
    }
  }

  async function deliverPrompt(
    id: string,
    message: string,
    options: { signal?: AbortSignal; notify: boolean; heartbeatMs: number; name?: string },
  ): Promise<{ accepted: boolean | null; running?: boolean; notify: boolean; warning?: string }> {
    const result = await runPerchCli(['send', id, '--stdin', '--json'], {
      input: message,
      signal: options.signal,
      timeoutMs: 120000,
    });
    if (result.code === 0) {
      ensureTask(id, {
        ...(options.name ? { name: options.name } : {}),
        state: 'running',
        unhandled: false,
        startedAt: Date.now(),
        finishedAt: undefined,
        error: undefined,
        heartbeatCount: 0,
      });
      if (options.notify) startWatcher(id, options.heartbeatMs);
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
        ensureTask(id, {
          ...(options.name ? { name: options.name } : {}),
          state: 'running',
          unhandled: false,
          startedAt: Date.now(),
          finishedAt: undefined,
          error: undefined,
          heartbeatCount: 0,
        });
        if (options.notify) startWatcher(id, options.heartbeatMs);
        return {
          accepted: null,
          running: true,
          notify: options.notify,
          warning: 'Delivery confirmation timed out, but the worker is running; async watcher attached. Do not resend.',
        };
      }
    }
    throw new Error(cliErrorMessage(result, 'perch send failed'));
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
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const targetCwd = canonicalDir(cwd);
    const deadline = Date.now() + resolveNativeDiscoverMs();
    while (Date.now() < deadline) {
      if (signal?.aborted) throw Object.assign(new Error('Perch command aborted'), { name: 'AbortError' });
      const rows = await listProviderSessions(provider, signal);
      const candidates = rows.filter(row => {
        const id = typeof row?.id === 'string' ? row.id : '';
        return id && !beforeIds.has(id) && !tasks.has(id) && row.kind === 'session' && row.send === true;
      });
      const exact = candidates.find(row => {
        const rowCwd = typeof row.cwd === 'string' ? canonicalDir(row.cwd) : null;
        return rowCwd && targetCwd && rowCwd === targetCwd;
      });
      if (exact && typeof exact.id === 'string') return exact.id;
      if (candidates.length === 1 && typeof candidates[0].id === 'string') return candidates[0].id;
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
    if (admissions.size || watchers.size || idle === false || queued === true || jobs?.running?.length || jobs?.delivery?.queued) return 'running';
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
    const anyPi = pi as unknown as {
      sendMessage?: (message: Record<string, unknown>, options?: Record<string, unknown>) => void;
      sendUserMessage?: (content: string, options?: Record<string, unknown>) => Promise<void>;
    };
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
  ) {
    const content = formatNotification(id, status, task, errorText, replyText);
    pushAgentEvent('perch-worker-event', content, {
      id,
      status,
      ...(task?.name ? { name: task.name } : {}),
      ...(task?.provider ? { provider: task.provider } : {}),
      ...(task?.model ? { model: task.model } : {}),
      ...(errorText ? { error: errorText } : {}),
    });
  }

  function startWatcher(id: string, heartbeatMs: number) {
    cancelWatcher(id);
    const controller = new AbortController();
    const generation = ++watcherGeneration;
    const epoch = sessionEpoch;
    const entry: WatcherEntry = { controller, generation };
    if (heartbeatMs > 0) {
      let ticking = false;
      entry.timer = setInterval(() => {
        if (ticking || stopping || controller.signal.aborted || epoch !== sessionEpoch) return;
        const currentEntry = watchers.get(id);
        if (!currentEntry || currentEntry.generation !== generation) return;
        const task = tasks.get(id);
        if (!task || task.state !== 'running') return;
        ticking = true;
        void (async () => {
          try {
            const preview = await readLatestAssistantReply(id, controller.signal, 3000);
            if (stopping || controller.signal.aborted || epoch !== sessionEpoch) return;
            if (watchers.get(id)?.generation !== generation || task.state !== 'running') return;
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
        if (stopping || controller.signal.aborted || epoch !== sessionEpoch) return;
        if (watchers.get(id)?.generation === generation) {
          if (entry.timer) clearInterval(entry.timer);
          watchers.delete(id);
        }
        const task = ensureTask(id, {
          state: status,
          unhandled: true,
          finishSeq: ++finishCounter,
          finishedAt: Date.now(),
          error: errorText,
        });
        deliverAsyncNotification(id, status, task, errorText, replyText);
      } catch (error) {
        if (watchers.get(id)?.generation === generation) {
          if (entry.timer) clearInterval(entry.timer);
          watchers.delete(id);
        }
        if (stopping || controller.signal.aborted || epoch !== sessionEpoch) return;
        const message = error instanceof Error ? error.message : String(error);
        const task = ensureTask(id, {
          state: 'failed',
          unhandled: true,
          finishSeq: ++finishCounter,
          finishedAt: Date.now(),
          error: message,
        });
        deliverAsyncNotification(id, 'failed', task, message, undefined);
      }
    })();
  }

  const isManagedWorker = process.env.PERCH_MANAGED_WORKER === '1';

  async function ensureToolActiveInVibe(ctx: ExtensionContext) {
    if (isManagedWorker) return;
    const anyCtx = ctx as unknown as {
      agent?: { kind?: string };
      sessionModes?: { getState?: () => { vibe?: { status?: string } } };
    };
    const anyPi = pi as unknown as {
      getActiveTools?: () => string[];
      setActiveTools?: (names: string[]) => Promise<void>;
    };
    if (anyCtx.agent?.kind === 'sub') return;
    if (anyCtx.sessionModes?.getState?.()?.vibe?.status !== 'active') return;
    if (typeof anyPi.getActiveTools !== 'function' || typeof anyPi.setActiveTools !== 'function') return;
    const active = anyPi.getActiveTools();
    if (!active.includes('perch')) await anyPi.setActiveTools([...new Set([...active, 'perch'])]);
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
    pause();
    await Promise.allSettled(admissions);
  }
  pi.registerCommand('perch-reconnect', {
    description: translateDiagnostic('Reconnect the local Perch bridge after a cancelled session transition', systemLanguage()),
    handler: async (_args, ctx) => {
      if (stopping || !server?.listening || admissions.size) return;
      activate(ctx);
      if (ctx.hasUI) ctx.ui.notify(translateDiagnostic('Perch bridge reconnected', systemLanguage()), 'info');
    },
  });

  const anyPi = pi as unknown as {
    registerTool?: (tool: Record<string, unknown>) => void;
    arktype?: (schema: Record<string, unknown>) => unknown;
  };
  if (!isManagedWorker && typeof anyPi.registerTool === 'function' && typeof anyPi.arktype === 'function') {
    const type = anyPi.arktype;
    anyPi.registerTool({
      name: 'perch',
      label: 'Perch',
      approval: 'exec',
      loadMode: 'essential',
      strict: true,
      description: 'Manage local agent sessions (agy, omp, codex, claude) through Perch. Both native and managed starts run in full-access / yolo mode by default. In interactive TUI mode, op=start defaults to native=true with pane=right for omp and agy (opens a live native TUI side pane, discovers its session ID, sends prompt, and attaches async completion pushback); pass native=false for headless managed background sessions. Do NOT block with op=wait(timeout>0) or bash sleep loops — rely on notify=true async updates, op=list(owned=true), and op=wait(timeout=0). If op=send reports busy, the message was rejected (NOT queued); wait until idle before resending.',
      parameters: type({
        op: "'list' | 'start' | 'send' | 'wait' | 'history' | 'resume' | 'close'",
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
        'notify?': 'boolean',
        'heartbeatSeconds?': 'number',
        'timeout?': 'number',
        'limit?': 'number',
        'all?': 'boolean',
      }),
      async execute(_toolCallId: string, params: PerchToolParams, signal: AbortSignal | undefined, _update: unknown, ctx: ExtensionContext) {
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
          if (params.owned) {
            const ownedIds = new Set([...ownedSessions, ...tasks.keys()]);
            const rows = [];
            for (const id of ownedIds) {
              const task = tasks.get(id);
              const live = liveById.get(id);
              const provider = task?.provider ?? (typeof live?.provider === 'string' ? live.provider : id.split(':', 1)[0]);
              if (params.provider && provider !== params.provider) continue;
              const elapsedSeconds = task?.startedAt !== undefined
                ? Math.max(0, Math.floor(((task.state === 'running' ? now : (task.finishedAt ?? now)) - task.startedAt) / 1000))
                : undefined;
              rows.push({
                id,
                ...(task?.name ? { name: task.name } : {}),
                provider,
                ...(task?.model ? { model: task.model } : {}),
                state: task?.state ?? (typeof live?.status === 'string' ? live.status : 'unknown'),
                unhandled: task?.unhandled ?? false,
                liveStatus: typeof live?.status === 'string' ? live.status : 'stopped',
                ...(elapsedSeconds !== undefined ? { elapsedSeconds } : {}),
                ...(task?.error ? { error: task.error } : {}),
                cwd: task?.cwd ?? (typeof live?.cwd === 'string' ? live.cwd : null),
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
              ...(task?.unhandled ? { unhandled: true } : {}),
            };
          });
          return emit(enriched);
        }
        if (params.op === 'start') {
          if (!params.provider || !PROVIDERS.has(params.provider)) {
            throw new Error('perch start requires provider (agy, omp, codex, or claude)');
          }
          if (params.prompt !== undefined && !params.prompt.trim()) throw new Error('prompt must not be empty');
          const heartbeatMs = resolveHeartbeatMs(params.heartbeatSeconds);
          const taskName = sanitizeName(params.name);
          const cwd = params.cwd || ctx.cwd;
          const defaultNative = ctx.mode === 'tui' && NATIVE_DEFAULT_PROVIDERS.has(params.provider);
          const useNative = params.native !== undefined ? params.native : defaultNative;

          if (useNative) {
            const pane = params.pane ?? 'right';
            if (!PANES.has(pane)) throw new Error(`Unsupported pane: ${pane}`);
            const nativeResult = await withNativeLaunchLock(params.provider, async () => {
              const beforeRows = await listProviderSessions(params.provider!, signal);
              const beforeIds = new Set(beforeRows.map(r => r?.id).filter((v): v is string => typeof v === 'string'));
              const nativeArgs = ['start', params.provider!, '--native', '--pane', pane, '--cwd', cwd, '--json'];
              if (params.model) nativeArgs.push('--model', params.model);
              if (params.executable) nativeArgs.push('--executable', params.executable);
              if (params.workspace) nativeArgs.push('--workspace', params.workspace);
              if (params.tab) nativeArgs.push('--tab', params.tab);
              const childEnv = params.provider === 'omp'
                ? { ...process.env, PERCH_MANAGED_WORKER: '1' }
                : process.env;
              const startedResult = await runPerchCli(nativeArgs, { signal, timeoutMs: 45000, env: childEnv });
              if (startedResult.code !== 0) {
                if (params.native === undefined) return { fallback: true as const };
                throw new Error(cliErrorMessage(startedResult, 'perch start --native failed'));
              }
              const started = parseJson(startedResult.stdout) as { provider?: string; mode?: string; pane?: unknown };
              const discoveredId = await waitForNewNativeSession(params.provider!, cwd, beforeIds, signal);
              if (!discoveredId) {
                throw new Error(`Native ${params.provider} pane opened, but no controllable session registered in time. Ensure perch integration install ${params.provider} is active, or retry with native=false.`);
              }
              ensureTask(discoveredId, {
                ...(taskName ? { name: taskName } : {}),
                provider: params.provider,
                mode: 'native',
                ...(params.model ? { model: params.model } : {}),
                cwd,
                state: 'idle',
                unhandled: false,
                error: undefined,
                heartbeatCount: 0,
              });
              return { fallback: false as const, id: discoveredId, started };
            });
            if (!nativeResult.fallback) {
              const { id, started } = nativeResult;
              if (params.prompt !== undefined) {
                const delivered = await deliverPrompt(id, params.prompt, {
                  signal,
                  notify: params.notify !== false,
                  heartbeatMs,
                  name: taskName,
                });
                return emit({
                  id,
                  provider: params.provider,
                  mode: 'native',
                  pane: started.pane,
                  ...(taskName ? { name: taskName } : {}),
                  ...delivered,
                });
              }
              return emit({
                id,
                provider: params.provider,
                mode: 'native',
                pane: started.pane,
                ...(taskName ? { name: taskName } : {}),
              });
            }
          }

          const args = ['start', params.provider, '--cwd', cwd, '--json'];
          if (params.model) args.push('--model', params.model);
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
          ownedSessions.add(started.id);
          ensureTask(started.id, {
            ...(taskName ? { name: taskName } : {}),
            provider: params.provider,
            mode: 'managed',
            ...(params.model ? { model: params.model } : {}),
            cwd,
            state: 'idle',
            unhandled: false,
            error: undefined,
            heartbeatCount: 0,
          });
          if (params.prompt !== undefined) {
            const delivered = await deliverPrompt(started.id, params.prompt, {
              signal,
              notify: params.notify !== false,
              heartbeatMs,
              name: taskName,
            }).catch(error => {
              throw new Error(`Session ${started.id} started, but initial send failed: ${error instanceof Error ? error.message : String(error)}`);
            });
            return emit({ ...started, ...(taskName ? { name: taskName } : {}), ...delivered });
          }
          return emit({ ...started, ...(taskName ? { name: taskName } : {}) });
        }
        if (!params.id) throw new Error(`perch ${params.op} requires id`);
        if (params.op === 'send') {
          const message = params.text ?? params.prompt;
          if (!message || !message.trim()) throw new Error('perch send requires non-empty text');
          const heartbeatMs = resolveHeartbeatMs(params.heartbeatSeconds);
          const taskName = sanitizeName(params.name);
          const delivered = await deliverPrompt(params.id, message, {
            signal,
            notify: params.notify !== false,
            heartbeatMs,
            name: taskName,
          });
          return emit({ id: params.id, ...delivered });
        }
        if (params.op === 'wait') {
          const args = ['wait', params.id, '--json'];
          if (params.timeout !== undefined) {
            if (!Number.isSafeInteger(params.timeout) || params.timeout < 0 || params.timeout > 86400) {
              throw new Error('timeout must be an integer between 0 and 86400 seconds');
            }
            args.push('--timeout', String(params.timeout));
          }
          const result = await runPerchCli(args, { signal });
          let parsed: { status?: string; error?: string } | undefined;
          try { parsed = parseJson(result.stdout) as { status?: string; error?: string } | undefined; } catch {}
          if (parsed && typeof parsed === 'object') {
            const task = tasks.get(params.id);
            if (task && typeof parsed.status === 'string' && ['completed', 'failed', 'needs_input', 'interrupted'].includes(parsed.status)) {
              task.state = parsed.status as TaskState;
              task.finishedAt = Date.now();
              if (typeof parsed.error === 'string') task.error = parsed.error;
            }
            return emit(parsed);
          }
          throw new Error(cliErrorMessage(result, 'perch wait failed'));
        }
        if (params.op === 'history') {
          const args = ['history', params.id, '--json'];
          if (params.all) args.push('--all');
          else if (params.limit !== undefined) {
            if (!Number.isSafeInteger(params.limit) || params.limit <= 0) throw new Error('limit must be a positive integer');
            args.push('--limit', String(params.limit));
          }
          const result = await runPerchCli(args, { signal, timeoutMs: 15000 });
          if (result.code !== 0) throw new Error(cliErrorMessage(result, 'perch history failed'));
          const task = tasks.get(params.id);
          if (task && task.state !== 'running') task.unhandled = false;
          return emit(parseJson(result.stdout) ?? []);
        }
        if (params.op === 'resume') {
          const result = await runPerchCli(['resume', params.id, '--json'], { signal, timeoutMs: 45000 });
          if (result.code !== 0) throw new Error(cliErrorMessage(result, 'perch resume failed'));
          const resumed = parseJson(result.stdout) as { id?: string; provider?: string };
          if (resumed?.id) {
            ownedSessions.add(resumed.id);
            ensureTask(resumed.id, { provider: resumed.provider ?? resumed.id.split(':', 1)[0], state: 'idle' });
          }
          return emit(resumed);
        }
        if (params.op === 'close') {
          cancelWatcher(params.id);
          ownedSessions.delete(params.id);
          tasks.delete(params.id);
          const result = await runPerchCli(['close', params.id, '--json'], { signal, timeoutMs: 15000 });
          if (result.code !== 0) throw new Error(cliErrorMessage(result, 'perch close failed'));
          return emit(parseJson(result.stdout) ?? { id: params.id, closed: true });
        }
        throw new Error(`Unsupported perch operation: ${params.op}`);
      },
    });
  }

  pi.on('context', (event, ctx) => {
    if (isManagedWorker) return;
    const anyCtx = ctx as unknown as { agent?: { kind?: string } };
    if (anyCtx.agent?.kind === 'sub') return;
    const active = [...tasks.values()].filter(task => task.state === 'running' || task.unhandled);
    if (!active.length) {
      pendingLedgerAck = undefined;
      return;
    }
    const unhandled = active.filter(task => task.unhandled);
    pendingLedgerAck = unhandled.length ? new Map(unhandled.map(task => [task.id, task.finishSeq])) : undefined;
    const existing = Array.isArray((event as { messages?: unknown[] })?.messages) ? (event as { messages: unknown[] }).messages : [];
    return {
      messages: [
        ...existing,
        {
          role: 'custom' as const,
          customType: 'perch-task-ledger',
          display: false,
          attribution: 'agent' as const,
          content: formatLedger(active, Date.now()),
          timestamp: Date.now(),
        },
      ],
    };
  });

  pi.on('message_end', (event, ctx) => {
    if (isManagedWorker || !pendingLedgerAck) return;
    const anyCtx = ctx as unknown as { agent?: { kind?: string } };
    if (anyCtx.agent?.kind === 'sub') return;
    const msg = (event as { message?: { role?: string; stopReason?: string } })?.message;
    if (msg?.role !== 'assistant') return;
    const delivered = pendingLedgerAck;
    pendingLedgerAck = undefined;
    if (msg.stopReason !== 'stop') return;
    for (const [id, seq] of delivered) {
      const task = tasks.get(id);
      if (task && task.finishSeq === seq && task.state !== 'running') {
        task.unhandled = false;
      }
    }
  });

  pi.on('mode_changed', async (event, ctx) => {
    const state = (event as { state?: { vibe?: { status?: string } } })?.state;
    if (state?.vibe?.status === 'active') await ensureToolActiveInVibe(ctx);
  });
  pi.on('before_agent_start', async (_event, ctx) => {
    await ensureToolActiveInVibe(ctx);
  });

  pi.on('session_start', async (_event, ctx) => {
    await ensureToolActiveInVibe(ctx);
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
              const admission = pi.sendUserMessage(req.text, { deliverAs: 'steer' });
              admissions.add(admission);
              try { await admission; } finally { admissions.delete(admission); }
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
  pi.on('session_before_switch', pauseAndDrain);
  pi.on('session_switch', (_event, ctx) => { if (!stopping && server?.listening) activate(ctx); });
  pi.on('session_before_branch', pauseAndDrain);
  pi.on('session_branch', (_event, ctx) => { if (!stopping && server?.listening) activate(ctx); });
  pi.on('session_before_tree', pauseAndDrain);
  pi.on('session_tree', (_event, ctx) => { if (!stopping && server?.listening) activate(ctx); });
  pi.on('session_shutdown', async () => {
    stopping = true;
    await pauseAndDrain();
    const toClose = [...ownedSessions];
    ownedSessions.clear();
    tasks.clear();
    if (toClose.length) {
      await Promise.allSettled(toClose.map(id => runPerchCli(['close', id, '--json'], { timeoutMs: 3000 }).catch(() => {})));
    }
    server?.close();
    try { unlinkSync(path); } catch {}
  });
}
