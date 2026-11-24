import { createServer, type Server } from 'node:net';
import { mkdirSync, lstatSync, chmodSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { systemLanguage } from './locale.mjs';
import { translateDiagnostic } from './diagnostics.mjs';

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
  const admissions = new Set<Promise<void>>();

  function sessionStatus(ctx: ExtensionContext): 'running' | 'idle' | 'unknown' {
    const idle = ctx.isIdle();
    const queued = ctx.hasPendingMessages();
    const jobs = ctx.getAsyncJobSnapshot?.();
    if (admissions.size || idle === false || queued === true || jobs?.running?.length || jobs?.delivery?.queued) return 'running';
    return idle === true && queued === false ? 'idle' : 'unknown';
  }

  function activate(ctx: ExtensionContext) {
    current = ctx;
    identity = randomBytes(16).toString('hex');
  }
  function pause() { current = undefined; identity = ''; }
  async function pauseAndDrain() {
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

  pi.on('session_start', async (_event, ctx) => {
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
    server?.close();
    try { unlinkSync(path); } catch {}
  });
}
