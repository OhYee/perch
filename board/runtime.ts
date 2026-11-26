import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { BoardStore, shortItemTitle, type Actor, type Command, type Item, type Snapshot, type WorkerDecision } from './store.ts';

type SessionEntry = {
  type: string;
  id: string;
  message?: { role: string; content?: unknown; errorMessage?: string; stopReason?: string };
};

export type SessionContext = {
  agent?: { kind?: 'main' | 'sub'; id?: string };
  sessionManager: {
    getSessionFile(): string | undefined;
    getHeader?(): { parentSession?: string } | null;
    getBranch(): readonly SessionEntry[];
  };
};

export type TodoPhase = { name: string; tasks: { content: string; status: string }[] };
export type CapturedTurn = { root: string; worker: string; attempt?: number; priorMessages: Set<string> };

const marker = 'omp-board-spawn:';

function parentHeader(path: string): { parentSession?: string } {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(4096);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bufferText = '';
    let bytesRead = 0;
    let firstLine = true;
    while (bytesRead < 65536) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      bytesRead += count;
      bufferText += decoder.decode(buffer.subarray(0, count), { stream: true });
      let end: number;
      while ((end = bufferText.indexOf('\n')) >= 0) {
        const value: unknown = JSON.parse(bufferText.slice(0, end));
        bufferText = bufferText.slice(end + 1);
        if (!value || typeof value !== 'object' || !('type' in value)) throw new Error('Invalid session header.');
        if (firstLine && value.type === 'title') {
          if (!('v' in value) || value.v !== 1 || !('title' in value) || typeof value.title !== 'string'
            || !('updatedAt' in value) || typeof value.updatedAt !== 'string' || !('pad' in value) || typeof value.pad !== 'string'
            || ('source' in value && value.source !== 'user' && value.source !== 'auto')) {
            throw new Error('Invalid session title slot.');
          }
          firstLine = false;
          continue;
        }
        if (value.type !== 'session') throw new Error('Invalid session header.');
        if ('parentSession' in value && typeof value.parentSession === 'string') return { parentSession: value.parentSession };
        return {};
      }
    }
    throw new Error('Cannot read session header');
  } finally {
    closeSync(fd);
  }
}

/** Root identity comes from OMP's transcript lineage, not its cwd or global main ID. */
export function rootSession(ctx: SessionContext): string {
  const file = ctx.sessionManager.getSessionFile();
  if (!file || !isAbsolute(file) || !file.endsWith('.jsonl')) throw new Error('Board requires a persisted OMP session.');
  let current = resolve(file);
  if (ctx.agent?.kind !== 'sub') return current;
  let header = ctx.sessionManager.getHeader?.();
  for (let depth = 0; depth < 32; depth++) {
    const parent = header?.parentSession;
    if (!parent || !isAbsolute(parent) || !parent.endsWith('.jsonl')) {
      if (current === resolve(file)) throw new Error('Child session has no persisted parent session.');
      return current;
    }
    const next = resolve(parent);
    if (dirname(current) !== next.slice(0, -6)) {
      if (current === resolve(file)) throw new Error('Child session is outside its parent artifacts directory.');
      return current;
    }
    current = next;
    header = parentHeader(current);
  }
  throw new Error('Session ancestry is too deep.');
}

export function boardPath(root: string): string {
  if (!isAbsolute(root) || !root.endsWith('.jsonl')) throw new Error('Invalid root session file.');
  return join(root.slice(0, -6), 'board.sqlite');
}

export function withBoard<T>(root: string, fn: (store: BoardStore) => T, create = true): T | undefined {
  const path = boardPath(root);
  if (!create && !existsSync(path)) return undefined;
  if (create) mkdirSync(dirname(path), { recursive: true });
  const store = new BoardStore(path);
  try { return fn(store); } finally { store.close(); }
}

export function workerIsDirectChild(ctx: SessionContext, root: string): boolean {
  const file = ctx.sessionManager.getSessionFile();
  const id = ctx.agent?.id;
  return ctx.agent?.kind === 'sub' && !!id && !!file && resolve(file) === join(root.slice(0, -6), `${id}.jsonl`)
    && ctx.sessionManager.getHeader?.()?.parentSession === root;
}

export function actorFor(ctx: SessionContext, root: string, attempt?: number): Actor {
  if (ctx.agent?.kind !== 'sub') return { kind: 'main', id: 'main' };
  if (!workerIsDirectChild(ctx, root)) throw new Error('Only a direct child of this board may modify it.');
  if (attempt === undefined) throw new Error('Worker has no board assignment for this turn.');
  return { kind: 'worker', id: ctx.agent.id!, attempt };
}

export function spawnMarker(token: string): string { return `${marker}${token}`; }
export function promptSpawnToken(prompt: string): string | undefined {
  return prompt.match(/(?:^|\n)omp-board-spawn:([0-9a-f-]{36})(?:\n|$)/)?.[1];
}
export function newSpawnToken(): string { return randomUUID(); }

export async function awaitSpawn(root: string, token: string, worker: string, timeoutMs = 20_000): Promise<void> {
  const path = boardPath(root);
  if (!existsSync(path)) throw new Error('Board spawn reservation is unavailable.');
  const store = new BoardStore(path);
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const spawn = store.getSpawn(token);
      if (!spawn) throw new Error('Board spawn reservation is unavailable.');
      if (spawn.state === 'failed') throw new Error(`Board spawn failed: ${spawn.error ?? 'unknown error'}`);
      if (spawn.state === 'committed') {
        if (spawn.worker !== worker) throw new Error('Board spawn identity does not match this child.');
        return;
      }
      const { promise, resolve: done } = Promise.withResolvers<void>();
      setTimeout(done, 25);
      await promise;
    }
    throw new Error('Timed out waiting for board spawn to commit.');
  } finally { store.close(); }
}

export function captureTurn(ctx: SessionContext): CapturedTurn | undefined {
  if (ctx.agent?.kind !== 'sub' || !ctx.agent.id) return undefined;
  const root = rootSession(ctx);
  if (!workerIsDirectChild(ctx, root) || !existsSync(boardPath(root))) return undefined;
  const attempt = withBoard(root, store => store.bindingForWorker(ctx.agent!.id!)?.attempt, false);
  const priorMessages = new Set(ctx.sessionManager.getBranch().filter(e => e.type === 'message' && e.message?.role === 'assistant').map(e => e.id));
  return { root, worker: ctx.agent.id, attempt, priorMessages };
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function summarizeDecisions(decisions: WorkerDecision[]) {
  return decisions.map(({ id, title, text }, index) =>
    index < 8 ? { id, title, text: clip(text, 1000) } : { id, title });
}

function decisionVersion(decisions: WorkerDecision[]): string {
  return createHash('sha256').update(JSON.stringify(decisions.map(({ id, title, text }) => [id, title, text]))).digest('hex');
}

export function workerDecisionSummary(store: BoardStore, worker: string) {
  return summarizeDecisions(store.workerDecisions(worker));
}

export function workerDecisionVersion(store: BoardStore, worker: string): string {
  return decisionVersion(store.workerDecisions(worker));
}

export function workerContext(root: string, worker: string): { text: string; attempt: number; decisions: string } | undefined {
  return withBoard(root, store => {
    const binding = store.bindingForWorker(worker);
    if (!binding) return undefined;
    const item = store.workerItem(worker);
    if (!item) throw new Error('Board binding refers to a missing item.');
    const effectiveDecisions = store.workerDecisions(worker);
    const decisions = summarizeDecisions(effectiveDecisions);
    const recent = item.history.map(({ kind, actor, attempt, text }) => ({ kind, actor, attempt, text: clip(text, 800) }));
    const assigned = binding.role === 'execute' ? item.state === 'working' && item.owner === worker : item.state === 'reviewing' && item.reviewer === worker;
    const actions = assigned
      ? binding.role === 'execute' ? 'When Board writes are permitted, submit with evidence when ready for review.' : 'When Board writes are permitted, approve or reject with evidence.'
      : 'This binding is not currently assigned; do not submit, approve, or change the item.';
    const current = { id: item.id, parentId: item.parentId, title: item.title, description: item.description, criteria: clip(item.criteria, 1200), state: item.state, owner: item.owner, reviewer: item.reviewer, attempt: item.attempt };
    return {
      attempt: binding.attempt,
      decisions: decisionVersion(effectiveDecisions),
      text: `Shared board item ${item.id}; your role is ${binding.role}. ${actions} Follow higher-priority and explicit task tool restrictions, including instructions not to use tools; do not call Board if forbidden. If permitted, at important milestones, blockers and before handoff, record useful findings confirmed or ruled out, evidence and next steps with board op=progress and item=${item.id}; set handoff=true when the next worker must retain them. Do not post routine investigation steps. If Board writes are forbidden or unavailable, report relevant facts through permitted channels and do not claim they were recorded. Your final reply is recorded automatically but never submits or approves. Current item, acceptance criteria, handoff evidence and effective related decisions (at most eight bodies are clipped; remaining IDs and titles are listed; use board op=snapshot with a decision ID for full details):\n${JSON.stringify({ item: current, recent, decisions })}`,
    };
  }, false);
}

/** Compact board context block injected into external perch worker prompts. */
export function perchWorkerBoardPrompt(root: string, itemId: string, role: 'execute' | 'review'): string | undefined {
  return withBoard(root, store => {
    const snap = store.snapshot();
    const item = snap.items.find(entry => entry.id === itemId);
    if (!item) return undefined;
    const decisions = snap.decisions
      .filter(d => d.supersededBy === null && (!d.items.length || d.items.includes(itemId)))
      .sort((a, b) => Number(b.items.includes(itemId)) - Number(a.items.includes(itemId)));
    const related = summarizeDecisions(decisions.map(({ id, revision, title, text }) => ({ id, revision, title, text })));
    const recent = item.history
      .filter(h => h.kind === 'handoff' || h.kind === 'submit' || h.kind === 'reject' || h.kind === 'discussion')
      .slice(-6)
      .map(({ kind, actor, attempt, text }) => ({ kind, actor, attempt, text: clip(text, 600) }));
    const payload = {
      item: {
        id: item.id,
        title: item.title,
        criteria: clip(item.criteria, 1200),
        state: item.state,
        role,
        attempt: item.attempt,
      },
      ...(recent.length ? { recent } : {}),
      ...(related.length ? { decisions: related } : {}),
    };
    return `[Session Board Context]\n${JSON.stringify(payload)}`;
  }, false);
}

export function recordPerchWorkerReceipt(root: string, worker: string, key: string, output: string, attempt?: number): boolean {
  if (!output.trim()) return false;
  return withBoard(root, store => {
    const binding = store.bindingForWorker(worker);
    if (!binding) return false;
    store.receipt(worker, key, output, attempt ?? binding.attempt);
    return true;
  }, false) ?? false;
}

export function recordTurn(ctx: SessionContext, turn: CapturedTurn): boolean {
  if (!workerIsDirectChild(ctx, turn.root) || ctx.agent?.id !== turn.worker) throw new Error('Worker session changed before its receipt.');
  const branch = ctx.sessionManager.getBranch();
  const entry = [...branch].reverse().find(e => e.type === 'message' && e.message?.role === 'assistant' && !turn.priorMessages.has(e.id));
  if (!entry) return false;
  const message = entry.message;
  if (!message) return false;
  const text = Array.isArray(message.content)
    ? message.content.flatMap((part: unknown) => {
        if (!part || typeof part !== 'object' || !('type' in part) || part.type !== 'text' || !('text' in part) || typeof part.text !== 'string') return [];
        return [part.text];
      }).join('\n').trim()
    : '';
  if (!text && !message.errorMessage) return false;
  const output = text || `Worker failed: ${message.errorMessage}`;
  return withBoard(turn.root, store => {
    const binding = store.bindingForWorker(turn.worker);
    if (!binding) return false;
    store.receipt(turn.worker, `assistant:${entry.id}`, output, turn.attempt ?? binding.attempt);
    return true;
  }, false) ?? false;
}

export function promoteTodo(store: BoardStore, phases: readonly TodoPhase[], task: string, phase: string | undefined, criteria: string): Item {
  if (!task || !criteria?.trim()) throw new Error('Todo promotion requires verbatim task and acceptance criteria.');
  const matches = phases.flatMap(group => group.tasks.filter(item => item.content === task && (phase === undefined || group.name === phase)).map(item => ({ phase: group.name, item })));
  if (matches.length !== 1) throw new Error(matches.length ? 'Todo is ambiguous; specify its phase.' : 'Todo not found in the current session.');
  const source = `todo:${createHash('sha256').update(JSON.stringify([matches[0].phase, matches[0].item.content])).digest('hex')}`;
  const snapshot = store.apply({ kind: 'main', id: 'main' }, { op: 'create', title: shortItemTitle(matches[0].item.content), description: matches[0].item.content, criteria, source });
  const item = snapshot.items.find(entry => entry.source === source);
  if (!item) throw new Error('Promoted todo is missing from the board.');
  return item;
}

export function runBoardCommand(root: string, actor: Actor, cmd: Command): Snapshot {
  return withBoard(root, store => cmd.op === 'snapshot' ? store.snapshot() : store.apply(actor, cmd))!;
}

export function itemSummary(item: Item) {
  return { id: item.id, parentId: item.parentId, title: item.title, state: item.state, owner: item.owner, reviewer: item.reviewer, attempt: item.attempt, priority: item.priority };
}

export function boardView(snapshot: Snapshot, item?: string, decision?: string) {
  if (item && decision) throw new Error('Choose item or decision, not both.');
  if (item) {
    const found = snapshot.items.find(entry => entry.id === item);
    if (!found) throw new Error('item not found');
    return { item: found };
  }
  if (decision) {
    const found = snapshot.decisions.find(entry => entry.id === decision);
    if (!found) throw new Error('decision not found');
    return { decision: found };
  }
  return {
    items: snapshot.items.map(itemSummary),
    decisions: snapshot.decisions.map(({ id, title, revision, read, supersededBy }) => ({ id, title, revision, read, supersededBy })),
  };
}

export function mutationSummary(snapshot: Snapshot, command: Command) {
  if (command.op === 'create') {
    const item = command.source ? snapshot.items.find(entry => entry.source === command.source) : snapshot.items.at(-1);
    if (!item) throw new Error('Created item is missing from the board.');
    return { item: itemSummary(item) };
  }
  if (command.item && !['decide', 'replace', 'note_decision', 'read'].includes(command.op)) {
    const item = snapshot.items.find(entry => entry.id === command.item);
    if (!item) throw new Error('Changed item is missing from the board.');
    return { item: itemSummary(item) };
  }
  const decision = command.op === 'decide' || command.op === 'replace'
    ? snapshot.decisions.at(-1) : snapshot.decisions.find(entry => entry.id === command.decision);
  if (!decision) throw new Error('Changed decision is missing from the board.');
  return { decision: { id: decision.id, title: decision.title, revision: decision.revision, read: decision.read, supersededBy: decision.supersededBy } };
}

export function managerGuidance(snapshot: Snapshot): string {
  const pending = snapshot.items.filter(item => item.state === 'unassigned' || item.state === 'awaiting_review');
  const summary = pending.slice(0, 5).map(item => ({ id: item.id, state: item.state, title: item.title.slice(0, 120) }));
  return `Use board op=snapshot for a concise list, or specify item or decision for details; ${pending.length} item(s) need an owner or reviewer: ${JSON.stringify(summary)}. When a worker returns, inspect its board item, existing acceptance criteria and evidence. Do not invent missing criteria. If the work is not submitted, assess the evidence and arrange the next action. A worker return is evidence only, not submission or approval. For submitted work, arrange independent review; an executor cannot review their own work. Perch starts without an item automatically create and bind a board item when board autoCreate is enabled; their acceptance criteria are not inferred. Use board op=edit to add known criteria, or bind an existing item with perch op=start item and boardRole (execute or review). Native todo remains separate; use board op=todos and op=promote to explicitly promote a real todo with criteria, or op=create for other work. Assign main's own work with op=assign. Decisions are effective immediately; unread means attention, not a blocking approval. Identity and permissions are enforced by the board, not prompts.`;
}
