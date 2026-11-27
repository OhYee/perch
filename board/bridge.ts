import { createServer, type Server } from 'node:net';
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { mutationSummary, perchWorkerBoardPrompt, runBoardCommand, withBoard } from './runtime.ts';
import type { Actor, Command, Role } from './store.ts';

/**
 * Worker -> board write channel.
 *
 * Perch workers are separate provider processes (omp, agy, codex, claude) that cannot open the root session's
 * board. They reach it through `perch board <op>` over a private unix socket served by the owning session. Every
 * request is authenticated by a per-worker capability token and executed with a `worker` actor, so BoardStore's
 * existing rules (assigned item only, current attempt, independent reviewer, no manager ops) apply unchanged.
 */

export type BoardGrant = { root: string; item: string; role: Role; worker?: string };

const WORKER_OPS = new Set(['snapshot', 'progress', 'submit', 'approve', 'reject', 'decide', 'note_decision', 'replace']);
const ITEM_OPS = new Set(['progress', 'submit', 'approve', 'reject']);
const MAX_REQUEST_BYTES = 256 * 1024;

export function boardBridgeDirectory(uid: number): string {
  return `/tmp/agent-session-${uid}`;
}

function ensurePrivateDirectory(dir: string, uid: number): void {
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (error: unknown) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
  }
  const info = lstatSync(dir);
  if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o077) !== 0) {
    throw new Error('Private board bridge directory is unavailable');
  }
}

function pickCommand(grant: BoardGrant, request: Record<string, unknown>): Command {
  const op = String(request.op);
  if (typeof request.item === 'string' && request.item !== grant.item) {
    throw new Error(`item must be ${grant.item}; workers can only update their own board item`);
  }
  const command: Command = { op };
  if (ITEM_OPS.has(op)) command.item = grant.item;
  if (typeof request.text === 'string') command.text = request.text;
  if (typeof request.title === 'string') command.title = request.title;
  if (typeof request.decision === 'string') command.decision = request.decision;
  if (typeof request.handoff === 'boolean') command.handoff = request.handoff;
  if (typeof request.revision === 'number') command.revision = request.revision;
  if (request.target === 'same' || request.target === 'pool') command.target = request.target;
  if (Array.isArray(request.items) && request.items.every(entry => typeof entry === 'string')) {
    command.items = request.items as string[];
  }
  if ((op === 'decide' || op === 'replace') && command.items === undefined) command.items = [grant.item];
  return command;
}

export function handleBoardRequest(grants: Map<string, BoardGrant>, request: unknown): { ok: true; result: unknown } | { ok: false; error: string } {
  try {
    if (!request || typeof request !== 'object') throw new Error('invalid request');
    const req = request as Record<string, unknown>;
    const grant = typeof req.token === 'string' ? grants.get(req.token) : undefined;
    if (!grant) throw new Error('invalid or expired board token');
    if (!grant.worker || !grant.item) throw new Error('board token is not bound to a worker yet; retry in a few seconds');
    const op = typeof req.op === 'string' ? req.op : '';
    if (!WORKER_OPS.has(op)) {
      throw new Error(`board op "${op}" is not available to workers (allowed: ${[...WORKER_OPS].join(', ')})`);
    }
    // The live binding is authoritative (the item can change after a rebind); grant.item only gates readiness.
    const binding = withBoard(grant.root, store => store.bindingForWorker(grant.worker!), false);
    if (!binding) throw new Error('worker has no current board binding (item was released or reassigned)');
    const current: BoardGrant = { ...grant, item: binding.item, role: binding.role };
    if (op === 'snapshot') {
      const text = perchWorkerBoardPrompt(current.root, current.item, current.role);
      if (!text) throw new Error('board item is unavailable');
      return { ok: true, result: { text } };
    }
    const actor: Actor = { kind: 'worker', id: grant.worker, attempt: binding.attempt };
    const command = pickCommand(current, req);
    const snapshot = runBoardCommand(grant.root, actor, command);
    return { ok: true, result: mutationSummary(snapshot, command) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function createBoardBridge(uid: number) {
  const grants = new Map<string, BoardGrant>();
  let server: Server | undefined;
  let socketPath: string | undefined;
  let starting: Promise<string> | undefined;
  let closed = false;

  function start(): Promise<string> {
    return new Promise((resolve, reject) => {
      const dir = boardBridgeDirectory(uid);
      try { ensurePrivateDirectory(dir, uid); } catch (error) { reject(error); return; }
      const path = join(dir, `board-${randomBytes(12).toString('hex')}.sock`);
      const srv = createServer(socket => {
        socket.setEncoding('utf8');
        socket.setTimeout(30000, () => socket.destroy());
        socket.on('error', () => {});
        let data = '';
        socket.on('data', chunk => {
          data += chunk;
          if (Buffer.byteLength(data) > MAX_REQUEST_BYTES) {
            socket.removeAllListeners('data');
            socket.end(JSON.stringify({ ok: false, error: `request too large (max ${MAX_REQUEST_BYTES / 1024} KiB)` }) + '\n');
            return;
          }
          const end = data.indexOf('\n');
          if (end < 0) return;
          socket.removeAllListeners('data');
          let response: ReturnType<typeof handleBoardRequest>;
          try { response = handleBoardRequest(grants, JSON.parse(data.slice(0, end))); }
          catch { response = { ok: false, error: 'invalid request' }; }
          socket.end(JSON.stringify(response) + '\n');
        });
      });
      srv.once('error', reject);
      srv.listen(path, () => {
        if (closed) {
          srv.close();
          try { unlinkSync(path); } catch {}
          reject(new Error('board bridge closed'));
          return;
        }
        try { chmodSync(path, 0o600); } catch (error) { srv.close(); reject(error); return; }
        server = srv;
        socketPath = path;
        resolve(path);
      });
    });
  }

  return {
    async ensure(): Promise<string> {
      closed = false;
      if (socketPath) return socketPath;
      starting ??= start().finally(() => { starting = undefined; });
      return starting;
    },
    mint(root: string, item: string, role: Role): string {
      const token = randomBytes(24).toString('hex');
      grants.set(token, { root, item, role });
      return token;
    },
    bind(token: string, worker: string, item?: string): void {
      const grant = grants.get(token);
      if (!grant) return;
      grant.worker = worker;
      if (item) grant.item = item;
    },
    rebind(oldWorker: string, newWorker: string): void {
      for (const grant of grants.values()) if (grant.worker === oldWorker) grant.worker = newWorker;
    },
    revoke(token: string): void {
      grants.delete(token);
    },
    close(): void {
      closed = true;
      grants.clear();
      const path = socketPath;
      socketPath = undefined;
      try { server?.close(); } catch {}
      server = undefined;
      if (path) { try { unlinkSync(path); } catch {} }
    },
  };
}
