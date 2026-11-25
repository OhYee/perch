import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { existsSync, mkdirSync, lstatSync, chmodSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { systemLanguage } from './locale.mjs';
import { translateDiagnostic } from './diagnostics.mjs';

const PROVIDERS = new Set(['omp', 'codex', 'claude', 'agy']);
const PANES = new Set(['right', 'tern', 'tmux', 'herdr']);
const MAX_CLI_STDOUT = 16 * 1024 * 1024;
const MAX_NOTIFICATION_CHARS = 4000;

type PerchToolParams = {
  op: string;
  provider?: string;
  id?: string;
  cwd?: string;
  model?: string;
  executable?: string;
  pane?: string;
  workspace?: string;
  tab?: string;
  prompt?: string;
  text?: string;
  notify?: boolean;
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

type SessionMeta = {
  provider?: string;
  model?: string;
};

type WatcherEntry = {
  controller: AbortController;
  generation: number;
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
  options: { input?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<CliRunResult> {
  return new Promise((resolve, reject) => {
    const [command, prefix] = resolvePerchInvocation();
    const child = spawn(command, [...prefix, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
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

function clipText(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: `${text.slice(0, limit)}\n...[truncated; call perch op=history to inspect full output]`, truncated: true };
}

function formatNotification(
  id: string,
  status: string,
  meta: SessionMeta | undefined,
  errorText: string | undefined,
  replyText: string | undefined,
): string {
  const tags = [meta?.provider, meta?.model].filter(Boolean).join(' / ');
  const lines = [
    '[Perch async update]',
    `Session: ${id}${tags ? ` (${tags})` : ''}`,
    `Status: ${status}${errorText ? ` — ${errorText}` : ''}`,
  ];
  if (replyText) {
    const clipped = clipText(replyText, MAX_NOTIFICATION_CHARS);
    lines.push('Latest assistant reply:', clipped.text);
  }
  return lines.join('\n');
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
  const admissions = new Set<Promise<void>>();
  const ownedSessions = new Set<string>();
  const sessionMeta = new Map<string, SessionMeta>();
  const watchers = new Map<string, WatcherEntry>();

  function sessionStatus(ctx: ExtensionContext): 'running' | 'idle' | 'unknown' {
    const idle = ctx.isIdle();
    const queued = ctx.hasPendingMessages();
    const jobs = ctx.getAsyncJobSnapshot?.();
    if (admissions.size || watchers.size || idle === false || queued === true || jobs?.running?.length || jobs?.delivery?.queued) return 'running';
    return idle === true && queued === false ? 'idle' : 'unknown';
  }

  function cancelWatcher(id: string) {
    const existing = watchers.get(id);
    if (!existing) return;
    watchers.delete(id);
    existing.controller.abort();
  }

  function cancelAllWatchers() {
    for (const [id, entry] of watchers) {
      watchers.delete(id);
      entry.controller.abort();
    }
  }

  function deliverAsyncNotification(
    id: string,
    status: string,
    meta: SessionMeta | undefined,
    errorText: string | undefined,
    replyText: string | undefined,
  ) {
    const content = formatNotification(id, status, meta, errorText, replyText);
    const anyPi = pi as unknown as {
      sendMessage?: (message: Record<string, unknown>, options?: Record<string, unknown>) => void;
      sendUserMessage?: (content: string, options?: Record<string, unknown>) => Promise<void>;
    };
    if (typeof anyPi.sendMessage === 'function') {
      anyPi.sendMessage(
        {
          customType: 'perch-worker-event',
          content,
          display: true,
          attribution: 'agent',
          details: { id, status, ...(meta ?? {}), ...(errorText ? { error: errorText } : {}) },
        },
        { triggerTurn: true, deliverAs: 'followUp' },
      );
      return;
    }
    if (typeof anyPi.sendUserMessage === 'function') {
      void anyPi.sendUserMessage(content, { deliverAs: 'followUp' }).catch(() => {});
    }
  }

  function startWatcher(id: string) {
    cancelWatcher(id);
    const controller = new AbortController();
    const generation = ++watcherGeneration;
    const epoch = sessionEpoch;
    watchers.set(id, { controller, generation });
    void (async () => {
      try {
        const result = await runPerchCli(['wait', id, '--json'], { signal: controller.signal });
        if (stopping || controller.signal.aborted || epoch !== sessionEpoch) return;
        let parsed: { status?: string; error?: string } | undefined;
        try { parsed = parseJson(result.stdout) as { status?: string; error?: string } | undefined; } catch {}
        const status = typeof parsed?.status === 'string'
          ? parsed.status
          : result.code === 0 ? 'completed' : result.code === 3 ? 'needs_input' : 'failed';
        const errorText = typeof parsed?.error === 'string'
          ? parsed.error
          : status === 'failed' ? cliErrorMessage(result, 'Perch wait failed') : undefined;
        let replyText: string | undefined;
        if (['completed', 'failed', 'needs_input'].includes(status)) {
          try {
            const historyResult = await runPerchCli(['history', id, '--limit', '4', '--json'], {
              signal: controller.signal,
              timeoutMs: 5000,
            });
            if (historyResult.code === 0) {
              const messages = parseJson(historyResult.stdout);
              if (Array.isArray(messages)) {
                const lastAssistant = [...messages].reverse().find(
                  entry => entry && typeof entry === 'object' && (entry as { role?: string }).role === 'assistant' && typeof (entry as { text?: string }).text === 'string',
                ) as { text: string } | undefined;
                if (lastAssistant?.text.trim()) replyText = lastAssistant.text.trim();
              }
            }
          } catch {}
        }
        if (stopping || controller.signal.aborted || epoch !== sessionEpoch) return;
        if (watchers.get(id)?.generation === generation) watchers.delete(id);
        deliverAsyncNotification(id, status, sessionMeta.get(id), errorText, replyText);
      } catch (error) {
        if (watchers.get(id)?.generation === generation) watchers.delete(id);
        if (stopping || controller.signal.aborted || epoch !== sessionEpoch) return;
        const message = error instanceof Error ? error.message : String(error);
        deliverAsyncNotification(id, 'failed', sessionMeta.get(id), message, undefined);
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
      description: 'Manage local agent sessions (agy, omp, codex, claude) through Perch. Managed sessions run in full-access / yolo mode. Supports op=list, start (optionally with prompt to send immediately), send (async notification enabled by default via notify=true), wait, history, resume, and close. When notify=true (default), Perch watches the turn in the background and asynchronously posts a follow-up update with status and latest reply once done.',
      parameters: type({
        op: "'list' | 'start' | 'send' | 'wait' | 'history' | 'resume' | 'close'",
        'provider?': "'omp' | 'codex' | 'claude' | 'agy'",
        'id?': 'string > 0',
        'cwd?': 'string > 0',
        'model?': 'string > 0',
        'executable?': 'string > 0',
        'pane?': "'right' | 'tern' | 'tmux' | 'herdr'",
        'workspace?': 'string > 0',
        'tab?': 'string > 0',
        'prompt?': 'string > 0',
        'text?': 'string > 0',
        'notify?': 'boolean',
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
          return emit(parseJson(result.stdout) ?? []);
        }
        if (params.op === 'start') {
          if (!params.provider || !PROVIDERS.has(params.provider)) {
            throw new Error('perch start requires provider (agy, omp, codex, or claude)');
          }
          const args = ['start', params.provider, '--cwd', params.cwd || ctx.cwd, '--json'];
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
          sessionMeta.set(started.id, { provider: params.provider, ...(params.model ? { model: params.model } : {}) });
          if (params.prompt !== undefined) {
            if (!params.prompt.trim()) throw new Error('prompt must not be empty');
            const sentResult = await runPerchCli(['send', started.id, '--stdin', '--json'], {
              input: params.prompt,
              signal,
              timeoutMs: 120000,
            });
            if (sentResult.code !== 0) {
              throw new Error(`Session ${started.id} started, but initial send failed: ${cliErrorMessage(sentResult, 'perch send failed')}`);
            }
            const shouldNotify = params.notify !== false;
            if (shouldNotify) startWatcher(started.id);
            return emit({ ...started, accepted: true, notify: shouldNotify });
          }
          return emit(started);
        }
        if (!params.id) throw new Error(`perch ${params.op} requires id`);
        if (params.op === 'send') {
          const message = params.text ?? params.prompt;
          if (!message || !message.trim()) throw new Error('perch send requires non-empty text');
          const result = await runPerchCli(['send', params.id, '--stdin', '--json'], {
            input: message,
            signal,
            timeoutMs: 120000,
          });
          if (result.code !== 0) throw new Error(cliErrorMessage(result, 'perch send failed'));
          const shouldNotify = params.notify !== false;
          if (shouldNotify) startWatcher(params.id);
          return emit({ id: params.id, accepted: true, notify: shouldNotify });
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
          let parsed: unknown;
          try { parsed = parseJson(result.stdout); } catch {}
          if (parsed && typeof parsed === 'object') return emit(parsed);
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
          return emit(parseJson(result.stdout) ?? []);
        }
        if (params.op === 'resume') {
          const result = await runPerchCli(['resume', params.id, '--json'], { signal, timeoutMs: 45000 });
          if (result.code !== 0) throw new Error(cliErrorMessage(result, 'perch resume failed'));
          const resumed = parseJson(result.stdout) as { id?: string };
          if (resumed?.id) ownedSessions.add(resumed.id);
          return emit(resumed);
        }
        if (params.op === 'close') {
          cancelWatcher(params.id);
          ownedSessions.delete(params.id);
          sessionMeta.delete(params.id);
          const result = await runPerchCli(['close', params.id, '--json'], { signal, timeoutMs: 15000 });
          if (result.code !== 0) throw new Error(cliErrorMessage(result, 'perch close failed'));
          return emit(parseJson(result.stdout) ?? { id: params.id, closed: true });
        }
        throw new Error(`Unsupported perch operation: ${params.op}`);
      },
    });
  }

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
    sessionMeta.clear();
    if (toClose.length) {
      await Promise.allSettled(toClose.map(id => runPerchCli(['close', id, '--json'], { timeoutMs: 3000 }).catch(() => {})));
    }
    server?.close();
    try { unlinkSync(path); } catch {}
  });
}
