import { SqliteDatabase as Database } from './sqlite.ts';

export type Actor = { kind: 'main' | 'user' | 'worker'; id: string; attempt?: number };
export type Role = 'execute' | 'review';
export type ItemState = 'unassigned' | 'working' | 'awaiting_review' | 'reviewing' | 'done' | 'cancelled';
export type Command = {
  op: string;
  item?: string;
  parentId?: string | null;
  decision?: string;
  title?: string;
  description?: string;
  criteria?: string;
  text?: string;
  worker?: string;
  role?: Role;
  target?: 'same' | 'pool';
  revision?: number;
  source?: string;
  items?: string[];
  priority?: number;
  handoff?: boolean;
};
export type HistoryEntry = {
  actor: string;
  text: string;
  at: string;
  kind: string;
  attempt?: number;
  stale?: boolean;
};
export type Item = {
  id: string;
  parentId: string | null;
  title: string;
  description: string;
  criteria: string;
  state: ItemState;
  owner: string | null;
  reviewer: string | null;
  attempt: number;
  priority: number;
  source: string | null;
  history: HistoryEntry[];
};
export type Decision = {
  id: string;
  title: string;
  text: string;
  items: string[];
  revision: number;
  read: boolean;
  supersededBy: string | null;
  history: HistoryEntry[];
};
export type Snapshot = { items: Item[]; decisions: Decision[] };
export type WorkerBinding = { item: string; role: Role; attempt: number };
export type WorkerDecision = Pick<Decision, 'id' | 'revision' | 'title' | 'text'>;
export type SpawnStatus = { state: 'pending' | 'committed' | 'failed'; worker?: string; error?: string };
export type ReceiptNotice = { worker: string; key: string; item: string; attempt: number };
export type DiscussionTarget = {
  itemIds: string[];
  decisionId?: string;
  revision?: number;
  snapshot: unknown;
};


type SpawnRow = { token: string; item: string; role: Role; state: SpawnStatus['state']; worker: string | null; error: string | null };

type ItemRow = Omit<Item, 'history'>;
type DecisionRow = Omit<Decision, 'items' | 'read' | 'history'> & { items_json: string; read: number };
type HistoryRow = {
  target: string;
  target_id: string;
  actor: string;
  text: string;
  at: string;
  kind: string;
  attempt: number | null;
  stale: number | null;
};

function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a nonempty string`);
  return value;
}

const ITEM_TITLE_LIMIT = 80;

export function shortItemTitle(title: string): string {
  const points = Array.from(title);
  return points.length > ITEM_TITLE_LIMIT ? `${points.slice(0, ITEM_TITLE_LIMIT - 1).join('')}…` : title;
}

function itemTitle(value: unknown): string {
  const title = required(value, 'title');
  if (Array.from(title).length > ITEM_TITLE_LIMIT) throw new Error(`item title must be at most ${ITEM_TITLE_LIMIT} Unicode code points`);
  return title;
}

function description(value: unknown): string {
  if (typeof value !== 'string') throw new Error('description must be a string');
  return value;
}

function priority(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error('priority must be a safe integer');
  return value;
}

/** A session-scoped store. Actors are supplied by the trusted runtime, not by a model or browser. */
export class BoardStore {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', criteria TEXT NOT NULL,
        state TEXT NOT NULL, owner TEXT, reviewer TEXT, attempt INTEGER NOT NULL,
        priority INTEGER NOT NULL, source TEXT UNIQUE, parentId TEXT REFERENCES items(id)
      );
      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, text TEXT NOT NULL, items_json TEXT NOT NULL,
        revision INTEGER NOT NULL, read INTEGER NOT NULL, supersededBy TEXT
      );
      CREATE TABLE IF NOT EXISTS bindings (
        id INTEGER PRIMARY KEY, worker TEXT NOT NULL, item TEXT NOT NULL REFERENCES items(id),
        role TEXT NOT NULL, attempt INTEGER NOT NULL, initial_attempt INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS unique_worker_binding ON bindings(worker)
        WHERE worker NOT IN ('main', 'user');
      CREATE INDEX IF NOT EXISTS bindings_item ON bindings(item, worker, role);
      CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY, target TEXT NOT NULL, target_id TEXT NOT NULL, actor TEXT NOT NULL,
        text TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, attempt INTEGER, stale INTEGER
      );
      CREATE INDEX IF NOT EXISTS history_target ON history(target, target_id, id);
      CREATE TABLE IF NOT EXISTS receipts (
        worker TEXT NOT NULL, key TEXT NOT NULL, text TEXT NOT NULL, attempt INTEGER NOT NULL,
        PRIMARY KEY(worker, key)
      );
      CREATE TABLE IF NOT EXISTS receipt_notices (
        worker TEXT NOT NULL, key TEXT NOT NULL,
        PRIMARY KEY(worker, key),
        FOREIGN KEY(worker, key) REFERENCES receipts(worker, key)
      );
      CREATE TABLE IF NOT EXISTS spawns (
        token TEXT PRIMARY KEY, item TEXT NOT NULL REFERENCES items(id), role TEXT NOT NULL,
        state TEXT NOT NULL, worker TEXT, error TEXT
      );
      CREATE TABLE IF NOT EXISTS automatic_spawns (
        token TEXT PRIMARY KEY REFERENCES spawns(token)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS pending_spawn_item ON spawns(item) WHERE state = 'pending';
      CREATE TABLE IF NOT EXISTS discussion_requests (
        token TEXT PRIMARY KEY, target_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS discussion_active (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1), token TEXT NOT NULL REFERENCES discussion_requests(token)
      );
      CREATE TABLE IF NOT EXISTS discussion_turns (
        key TEXT PRIMARY KEY, token TEXT NOT NULL REFERENCES discussion_requests(token), summary TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS discussion_pending (
        key TEXT PRIMARY KEY, token TEXT NOT NULL REFERENCES discussion_requests(token),
        user_entry TEXT NOT NULL, assistant_entry TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS discussion_seen (
        key TEXT PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS discussion_ended (
        token TEXT PRIMARY KEY REFERENCES discussion_requests(token)
      );
      CREATE TABLE IF NOT EXISTS discussion_scan (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1), cursor TEXT, token TEXT
      );
      CREATE TABLE IF NOT EXISTS discussion_trace (
        id INTEGER PRIMARY KEY, at TEXT NOT NULL, stage TEXT NOT NULL,
        token TEXT, user_entry TEXT, assistant_entry TEXT
      );
    `);
    const hasDescription = () => (this.db.query('PRAGMA table_info(items)').all() as { name: string }[])
      .some(column => column.name === 'description');
    if (!hasDescription()) this.db.transaction(() => {
      if (hasDescription()) return;
      this.db.exec("ALTER TABLE items ADD COLUMN description TEXT NOT NULL DEFAULT ''");
      const rows = this.db.query('SELECT id, title FROM items WHERE length(title) > 80 OR instr(title, char(0)) > 0')
        .all() as { id: string; title: string }[];
      const update = this.db.query('UPDATE items SET title = ?, description = ? WHERE id = ?');
      for (const row of rows) {
        const title = shortItemTitle(row.title);
        if (title !== row.title) update.run(title, row.title, row.id);
      }
    }).immediate();
    const hasParentId = () => (this.db.query('PRAGMA table_info(items)').all() as { name: string }[])
      .some(column => column.name === 'parentId');
    if (!hasParentId()) this.db.transaction(() => {
      if (!hasParentId()) this.db.exec('ALTER TABLE items ADD COLUMN parentId TEXT REFERENCES items(id)');
    }).immediate();
  }

  close(): void {
    this.db.close();
  }

  snapshot(): Snapshot {
    return this.db.transaction(() => this.snapshotRows()).deferred();
  }

  private snapshotRows(): Snapshot {
    const entries = this.db.query('SELECT target, target_id, actor, text, at, kind, attempt, stale FROM history ORDER BY id').all() as HistoryRow[];
    const histories = new Map<string, HistoryEntry[]>();
    for (const row of entries) {
      const key = `${row.target}:${row.target_id}`;
      const history = histories.get(key) ?? [];
      const entry: HistoryEntry = { actor: row.actor, text: row.text, at: row.at, kind: row.kind };
      if (row.attempt !== null) entry.attempt = row.attempt;
      if (row.stale !== null) entry.stale = !!row.stale;
      history.push(entry);
      histories.set(key, history);
    }
    const items = (this.db.query(`SELECT * FROM items WHERE NOT EXISTS (
      SELECT 1 FROM spawns JOIN automatic_spawns USING(token)
      WHERE spawns.item = items.id AND spawns.state = 'pending'
    ) ORDER BY rowid`).all() as ItemRow[])
      .map(row => ({ ...row, history: histories.get(`item:${row.id}`) ?? [] }));
    const decisions = (this.db.query('SELECT * FROM decisions ORDER BY rowid').all() as DecisionRow[])
      .map(({ items_json, read, ...row }) => ({
        ...row, items: JSON.parse(items_json) as string[], read: !!read,
        history: histories.get(`decision:${row.id}`) ?? [],
      }));
    return { items, decisions };
  }

  hasWorker(worker: string): boolean {
    return !!this.bindingForWorker(worker);
  }

  bindingForWorker(worker: string): WorkerBinding | undefined {
    if (worker === 'main' || worker === 'user') return undefined;
    return (this.db.query('SELECT item, role, attempt FROM bindings WHERE worker = ?').get(worker) as WorkerBinding | null) ?? undefined;
  }

  dataVersion(): number {
    const row = this.db.query('PRAGMA data_version').get() as { data_version: number };
    return row.data_version;
  }
  reserveDiscussion(token: string, target: DiscussionTarget): void {
    required(token, 'discussion token');
    this.db.transaction(() => {
      for (const id of target.itemIds) this.item(id);
      if (target.decisionId) this.decision(target.decisionId);
      this.db.query('INSERT INTO discussion_requests(token,target_json) VALUES(?,?)').run(token, JSON.stringify(target));
    }).immediate();
  }

  activateDiscussion(token: string): DiscussionTarget | undefined {
    return this.db.transaction(() => {
      const row = this.db.query('SELECT target_json FROM discussion_requests WHERE token = ?').get(token) as { target_json: string } | null;
      if (!row || this.discussionEnded(token)) return undefined;
      this.db.query('INSERT INTO discussion_active(singleton,token) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET token = excluded.token').run(token);
      return JSON.parse(row.target_json) as DiscussionTarget;
    }).immediate();
  }

  activeDiscussion(): { token: string; target: DiscussionTarget; recent: string[] } | undefined {
    const row = this.db.query('SELECT r.token, r.target_json FROM discussion_active a JOIN discussion_requests r ON r.token = a.token WHERE a.singleton = 1')
      .get() as { token: string; target_json: string } | null;
    if (!row) return undefined;
    const recent = this.db.query('SELECT summary FROM discussion_turns WHERE token = ? ORDER BY rowid DESC LIMIT 5').all(row.token) as { summary: string }[];
    return { token: row.token, target: JSON.parse(row.target_json) as DiscussionTarget, recent: recent.reverse().map(entry => entry.summary) };
  }
  discussion(token: string): { token: string; target: DiscussionTarget; recent: string[] } | undefined {
    const row = this.db.query('SELECT token, target_json FROM discussion_requests WHERE token = ?').get(token) as { token: string; target_json: string } | null;
    if (!row) return undefined;
    const recent = this.db.query('SELECT summary FROM discussion_turns WHERE token = ? ORDER BY rowid DESC LIMIT 5').all(token) as { summary: string }[];
    return { token, target: JSON.parse(row.target_json) as DiscussionTarget, recent: recent.reverse().map(entry => entry.summary) };
  }

  startDiscussionScan(cursor: string | null, token: string | null): void {
    this.db.query('INSERT OR IGNORE INTO discussion_scan(singleton,cursor,token) VALUES(1,?,?)').run(cursor, token);
  }

  discussionScan(): { cursor: string | null; token: string | null } | undefined {
    return (this.db.query('SELECT cursor, token FROM discussion_scan WHERE singleton = 1').get() as { cursor: string | null; token: string | null } | null) ?? undefined;
  }

  advanceDiscussionScan(cursor: string, token: string | null): void {
    this.db.query('UPDATE discussion_scan SET cursor = ?, token = ? WHERE singleton = 1').run(cursor, token);
  }

  traceDiscussion(stage: string, token: string, userEntry: string, assistantEntry: string): void {
    this.db.query('INSERT INTO discussion_trace(at,stage,token,user_entry,assistant_entry) VALUES(?,?,?,?,?)')
      .run(new Date().toISOString(), stage, token, userEntry, assistantEntry);
    this.db.query('DELETE FROM discussion_trace WHERE id <= (SELECT MAX(id) - 200 FROM discussion_trace)').run();
  }

  queueDiscussion(token: string, key: string, userEntry: string, assistantEntry: string): void {
    required(key, 'discussion turn');
    required(token, 'discussion token');
    required(userEntry, 'user entry');
    required(assistantEntry, 'assistant entry');
    this.db.transaction(() => {
      if (this.discussionEnded(token)) return;
      if (this.db.query('SELECT 1 FROM discussion_turns WHERE key = ?').get(key)) return;
      const seen = this.db.query('INSERT OR IGNORE INTO discussion_seen(key) VALUES(?)').run(key);
      if (seen.changes) {
        this.db.query('INSERT INTO discussion_pending(key,token,user_entry,assistant_entry) VALUES(?,?,?,?)')
          .run(key, token, userEntry, assistantEntry);
        this.traceDiscussion('queued', token, userEntry, assistantEntry);
      }
    }).immediate();
  }

  pendingDiscussions(): { key: string; token: string; user_entry: string; assistant_entry: string }[] {
    return this.db.query('SELECT key, token, user_entry, assistant_entry FROM discussion_pending ORDER BY rowid LIMIT 3').all() as { key: string; token: string; user_entry: string; assistant_entry: string }[];
  }

  completeDiscussion(key: string): void {
    this.db.query('DELETE FROM discussion_pending WHERE key = ?').run(key);
  }
  deferDiscussion(key: string): void {
    this.db.query('UPDATE discussion_pending SET rowid = (SELECT COALESCE(MAX(rowid), 0) + 1 FROM discussion_pending) WHERE key = ?').run(key);
  }


  discussionEnded(token: string): boolean {
    return !!this.db.query('SELECT 1 FROM discussion_ended WHERE token = ?').get(token);
  }

  clearDiscussion(token: string): void {
    this.db.transaction(() => {
      this.db.query('INSERT OR IGNORE INTO discussion_ended(token) VALUES(?)').run(token);
      this.db.query('DELETE FROM discussion_active WHERE singleton = 1 AND token = ?').run(token);
    }).immediate();
  }


  archiveDiscussion(token: string, key: string, summary: string): void {
    required(key, 'discussion turn');
    required(summary, 'discussion summary');
    this.db.transaction(() => {
      const row = this.db.query('SELECT target_json FROM discussion_requests WHERE token = ?').get(token) as { target_json: string } | null;
      if (!row) throw new Error('discussion target not found');
      const target = JSON.parse(row.target_json) as DiscussionTarget;
      const inserted = this.db.query('INSERT OR IGNORE INTO discussion_turns(key,token,summary) VALUES(?,?,?)').run(key, token, summary);
      if (!inserted.changes) return;
      const origin = target.decisionId ? `decision ${target.decisionId} revision ${target.revision}` : `item ${target.itemIds[0]}`;
      const text = `Discussion (${origin}; clicked snapshot ${JSON.stringify(target.snapshot)}): ${summary}`;
      for (const id of target.itemIds) this.record('item', this.item(id).id, 'main', text, 'discussion');
      if (!target.itemIds.length && target.decisionId) this.record('decision', this.decision(target.decisionId).id, 'main', text, 'discussion');
    }).immediate();
  }


  workerDecisions(worker: string): WorkerDecision[] {
    required(worker, 'worker');
    if (worker === 'main' || worker === 'user') return [];
    return this.db.query(`
      SELECT d.id, d.revision, d.title, d.text
      FROM decisions d JOIN bindings b ON b.worker = ?
      WHERE d.supersededBy IS NULL AND (
        d.items_json = '[]' OR EXISTS (
          SELECT 1 FROM json_each(d.items_json) related WHERE related.value = b.item
        )
      )
      ORDER BY (d.items_json = '[]'), d.rowid
    `).all(worker) as WorkerDecision[];
  }

  workerItem(worker: string): Item | undefined {
    required(worker, 'worker');
    if (worker === 'main' || worker === 'user') return undefined;
    return this.db.transaction(() => {
      const item = this.db.query('SELECT items.* FROM items JOIN bindings ON bindings.item = items.id WHERE bindings.worker = ?')
        .get(worker) as ItemRow | null;
      if (!item) return undefined;
      const entries = this.db.query(`
        SELECT target, target_id, actor, text, at, kind, attempt, stale FROM history
        WHERE target = 'item' AND target_id = ? AND (
          kind = 'progress_handoff' OR
          id IN (SELECT id FROM history WHERE target = 'item' AND target_id = ? AND kind IN ('submit', 'reject') ORDER BY id DESC LIMIT 2) OR
          id IN (SELECT MAX(id) FROM history WHERE target = 'item' AND target_id = ? AND kind = 'progress' GROUP BY attempt, actor)
        )
        ORDER BY id DESC
      `).all(item.id, item.id, item.id) as HistoryRow[];
      const history = entries.reverse().map(row => {
        const entry: HistoryEntry = { actor: row.actor, text: row.text, at: row.at, kind: row.kind };
        if (row.attempt !== null) entry.attempt = row.attempt;
        return entry;
      });
      return { ...item, history };
    }).deferred();
  }

  releaseWorker(worker: string, reason: string): boolean {
    required(worker, 'worker');
    required(reason, 'reason');
    return this.db.transaction(() => {
      const binding = this.bindingForWorker(worker);
      if (!binding) return false;
      const item = this.item(binding.item);
      const active = (binding.role === 'execute' && item.state === 'working' && item.owner === worker) ||
        (binding.role === 'review' && item.state === 'reviewing' && item.reviewer === worker);
      if (!active) return false;
      this.applyCommand({ kind: 'main', id: 'main' }, { op: 'release', item: item.id, text: reason });
      return true;
    }).immediate();
  }

  beginAutomaticSpawn(token: string, title: string, prompt: string): void {
    required(token, 'spawn token');
    required(title, 'title');
    required(prompt, 'prompt');
    this.db.transaction(() => {
      const id = `w-${crypto.randomUUID()}`;
      this.db.query("INSERT INTO items(id,title,description,criteria,state,owner,reviewer,attempt,priority,source) VALUES(?,?,?,'','unassigned',NULL,NULL,0,0,?)")
        .run(id, shortItemTitle(title), prompt, `vibe-spawn:${token}`);
      this.db.query("INSERT INTO spawns(token,item,role,state) VALUES(?,?,'execute','pending')").run(token, id);
      this.db.query('INSERT INTO automatic_spawns(token) VALUES(?)').run(token);
      this.record('item', id, 'main', 'Created from a Vibe dispatch; acceptance criteria were not supplied.', 'create', 0);
    }).immediate();
  }

  private discardAutomaticSpawn(spawn: SpawnRow): boolean {
    if (!this.db.query('SELECT 1 FROM automatic_spawns WHERE token = ?').get(spawn.token)) return false;
    this.db.query('DELETE FROM automatic_spawns WHERE token = ?').run(spawn.token);
    this.db.query('DELETE FROM spawns WHERE token = ?').run(spawn.token);
    this.db.query("DELETE FROM history WHERE target = 'item' AND target_id = ?").run(spawn.item);
    this.db.query('DELETE FROM items WHERE id = ?').run(spawn.item);
    return true;
  }

  beginSpawn(token: string, item: string, role: Role): void {
    required(token, 'spawn token');
    if (role !== 'execute' && role !== 'review') throw new Error('role must be execute or review');
    this.db.transaction(() => {
      const work = this.item(item);
      if (role === 'execute' && work.state !== 'unassigned') throw new Error('item is not unassigned');
      if (role === 'review' && work.state !== 'awaiting_review') throw new Error('item is not awaiting review');
      this.requireNoPendingSpawn(work.id);
      if (this.db.query('SELECT 1 FROM spawns WHERE token = ?').get(token)) throw new Error('spawn token already exists');
      this.db.query("INSERT INTO spawns(token,item,role,state) VALUES(?,?,?,'pending')").run(token, work.id, role);
    }).immediate();
  }

  commitSpawn(token: string, worker: string): void {
    required(token, 'spawn token');
    required(worker, 'worker');
    if (worker === 'main' || worker === 'user') throw new Error('spawned worker cannot use a reserved identity');
    this.db.transaction(() => {
      const spawn = this.db.query('SELECT * FROM spawns WHERE token = ?').get(token) as SpawnRow | null;
      if (!spawn) throw new Error('spawn reservation not found');
      if (spawn.state === 'committed' && spawn.worker === worker) return;
      if (spawn.state !== 'pending') throw new Error('spawn reservation is not pending');
      this.applyCommand({ kind: 'main', id: 'main' }, { op: 'assign', item: spawn.item, worker, role: spawn.role }, token);
      this.db.query("UPDATE spawns SET state = 'committed', worker = ? WHERE token = ?").run(worker, token);
    }).immediate();
  }

  failSpawn(token: string, reason: string): void {
    required(token, 'spawn token');
    required(reason, 'spawn failure reason');
    this.db.transaction(() => {
      const spawn = this.db.query('SELECT * FROM spawns WHERE token = ?').get(token) as SpawnRow | null;
      if (!spawn) throw new Error('spawn reservation not found');
      if (spawn.state === 'failed' && spawn.error === reason) return;
      if (spawn.state !== 'pending') throw new Error('spawn reservation is not pending');
      if (this.discardAutomaticSpawn(spawn)) return;
      const item = this.item(spawn.item);
      this.db.query("UPDATE spawns SET state = 'failed', error = ? WHERE token = ?").run(reason, token);
      this.record('item', item.id, 'main', `Spawn failed: ${reason}`, 'spawn_failed', item.attempt);
    }).immediate();
  }

  failPendingSpawns(reason: string): number {
    required(reason, 'spawn failure reason');
    return this.db.transaction(() => {
      const pending = this.db.query("SELECT * FROM spawns WHERE state = 'pending'").all() as SpawnRow[];
      for (const spawn of pending) {
        if (this.discardAutomaticSpawn(spawn)) continue;
        const item = this.item(spawn.item);
        this.db.query("UPDATE spawns SET state = 'failed', error = ? WHERE token = ?").run(reason, spawn.token);
        this.record('item', item.id, 'main', `Spawn failed: ${reason}`, 'spawn_failed', item.attempt);
      }
      return pending.length;
    }).immediate();
  }

  getSpawn(token: string): SpawnStatus | undefined {
    const spawn = this.db.query('SELECT state, worker, error FROM spawns WHERE token = ?')
      .get(required(token, 'spawn token')) as Pick<SpawnRow, 'state' | 'worker' | 'error'> | null;
    if (!spawn) return undefined;
    const status: SpawnStatus = { state: spawn.state };
    if (spawn.worker !== null) status.worker = spawn.worker;
    if (spawn.error !== null) status.error = spawn.error;
    return status;
  }

  private requireNoPendingSpawn(item: string, allowedToken?: string): void {
    const spawn = this.db.query("SELECT token FROM spawns WHERE item = ? AND state = 'pending'").get(item) as { token: string } | null;
    if (spawn && spawn.token !== allowedToken) throw new Error('item has a pending spawn');
  }

  private item(id: unknown): ItemRow {
    const row = this.db.query('SELECT * FROM items WHERE id = ?').get(required(id, 'item')) as ItemRow | null;
    if (!row) throw new Error('item not found');
    return row;
  }

  private decision(id: unknown): DecisionRow {
    const row = this.db.query('SELECT * FROM decisions WHERE id = ?').get(required(id, 'decision')) as DecisionRow | null;
    if (!row) throw new Error('decision not found');
    return row;
  }

  private record(target: 'item' | 'decision', id: string, actor: string, text: string, kind: string, attempt: number | null = null, stale: boolean | null = null): void {
    this.db.query('INSERT INTO history(target,target_id,actor,text,at,kind,attempt,stale) VALUES(?,?,?,?,?,?,?,?)')
      .run(target, id, actor, text, new Date().toISOString(), kind, attempt, stale === null ? null : Number(stale));
  }

  private requireManager(actor: Actor): void {
    if (actor.kind === 'worker') throw new Error('only main or user may perform this operation');
  }

  private requireCurrentWorker(actor: Actor, item: ItemRow, role?: Role): void {
    if (actor.kind !== 'worker') return;
    if (actor.attempt !== item.attempt) throw new Error('worker turn attempt is missing or stale');
    const executing = item.state === 'working' && item.owner === actor.id;
    const reviewing = item.state === 'reviewing' && item.reviewer === actor.id;
    if ((role === 'execute' && !executing) || (role === 'review' && !reviewing) || (!role && !executing && !reviewing)) {
      throw new Error('worker is not currently assigned to this item and role');
    }
  }

  private requireIndependentReviewer(actor: Actor, item: ItemRow): void {
    const previous = this.db.query("SELECT 1 FROM bindings WHERE item = ? AND worker = ? AND role = 'execute' LIMIT 1")
      .get(item.id, actor.id);
    if (previous) throw new Error('an executor cannot review their own item');
  }

  private decisionItems(value: unknown, actor: Actor): string[] {
    if (value === undefined) value = [];
    if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !id.trim())) {
      throw new Error('items must be an array of item IDs');
    }
    const ids = value as string[];
    if (new Set(ids).size !== ids.length) throw new Error('decision item IDs must be unique');
    if (actor.kind === 'worker' && ids.length === 0) throw new Error('worker decisions require assigned items');
    for (const id of ids) this.requireCurrentWorker(actor, this.item(id));
    return ids;
  }

  private requireRevision(decision: DecisionRow, revision: unknown): void {
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision !== decision.revision) {
      throw new Error('decision revision has changed');
    }
  }

  apply(actor: Actor, cmd: Command): Snapshot {
    if (!actor || !['main', 'user', 'worker'].includes(actor.kind)) throw new Error('invalid actor');
    required(actor.id, 'actor id');
    if ((actor.kind === 'main' && actor.id !== 'main') || (actor.kind === 'user' && actor.id !== 'user') ||
        (actor.kind === 'worker' && (actor.id === 'main' || actor.id === 'user'))) throw new Error('invalid actor identity');
    if (!cmd || typeof cmd !== 'object') throw new Error('invalid command');
    return this.db.transaction(() => {
      this.applyCommand(actor, cmd);
      return this.snapshotRows();
    }).immediate();
  }

  private applyCommand(actor: Actor, cmd: Command, spawnToken?: string): void {
    switch (cmd.op) {
      case 'create': {
        this.requireManager(actor);
        const title = itemTitle(cmd.title);
        const details = cmd.description === undefined ? '' : description(cmd.description);
        const criteria = required(cmd.criteria, 'criteria');
        const source = cmd.source === undefined ? null : required(cmd.source, 'source');
        const rank = cmd.priority === undefined ? 0 : priority(cmd.priority);
        if (source !== null && this.db.query('SELECT id FROM items WHERE source = ?').get(source)) return;
        const parentId = cmd.parentId == null ? null : this.item(cmd.parentId).id;
        if (parentId !== null) this.requireNoPendingSpawn(parentId);
        const id = `w-${crypto.randomUUID()}`;
        this.db.query('INSERT INTO items(id,title,description,criteria,state,owner,reviewer,attempt,priority,source,parentId) VALUES(?,?,?,?,\'unassigned\',NULL,NULL,0,?,?,?)')
          .run(id, title, details, criteria, rank, source, parentId);
        this.record('item', id, actor.id, `Created: ${title}; criteria: ${criteria}`, 'create', 0);
        return;
      }
      case 'edit': {
        this.requireManager(actor);
        if (cmd.parentId != null) throw new Error('parentId cannot be changed');
        const item = this.item(cmd.item);
        this.requireNoPendingSpawn(item.id);
        if (item.state === 'done' || item.state === 'cancelled') throw new Error('cannot edit a closed item');
        if (cmd.title === undefined && cmd.description === undefined && cmd.criteria === undefined && cmd.priority === undefined) throw new Error('no item fields to edit');
        const title = cmd.title === undefined ? item.title : itemTitle(cmd.title);
        const details = cmd.description === undefined ? item.description : description(cmd.description);
        const criteria = cmd.criteria === undefined ? item.criteria : required(cmd.criteria, 'criteria');
        const rank = cmd.priority === undefined ? item.priority : priority(cmd.priority);
        this.db.query('UPDATE items SET title = ?, description = ?, criteria = ?, priority = ? WHERE id = ?').run(title, details, criteria, rank, item.id);
        this.record('item', item.id, actor.id, `Edited: title ${JSON.stringify(item.title)} → ${JSON.stringify(title)}; description ${JSON.stringify(item.description)} → ${JSON.stringify(details)}; criteria ${JSON.stringify(item.criteria)} → ${JSON.stringify(criteria)}; priority ${item.priority} → ${rank}`, 'edit', item.attempt);
        return;
      }
      case 'assign': {
        this.requireManager(actor);
        const item = this.item(cmd.item);
        this.requireNoPendingSpawn(item.id, spawnToken);
        const worker = required(cmd.worker, 'worker');
        if (cmd.role !== 'execute' && cmd.role !== 'review') throw new Error('role must be execute or review');
        if (cmd.role === 'execute' && item.state !== 'unassigned') throw new Error('item is not unassigned');
        if (cmd.role === 'review' && item.state !== 'awaiting_review') throw new Error('item is not awaiting review');
        if (worker !== 'main' && worker !== 'user' && this.hasWorker(worker)) throw new Error('worker ID was already assigned');
        if (cmd.role === 'review') this.requireIndependentReviewer({ kind: worker === 'main' ? 'main' : worker === 'user' ? 'user' : 'worker', id: worker }, item);
        const attempt = cmd.role === 'execute' ? item.attempt + 1 : item.attempt;
        this.db.query('INSERT INTO bindings(worker,item,role,attempt,initial_attempt) VALUES(?,?,?,?,?)')
          .run(worker, item.id, cmd.role, attempt, attempt);
        if (cmd.role === 'execute') {
          this.db.query("UPDATE items SET state = 'working', owner = ?, reviewer = NULL, attempt = ? WHERE id = ?")
            .run(worker, attempt, item.id);
        } else {
          this.db.query("UPDATE items SET state = 'reviewing', reviewer = ? WHERE id = ?").run(worker, item.id);
        }
        this.record('item', item.id, actor.id, `Assigned ${worker} to ${cmd.role}`, 'assign', attempt);
        return;
      }
      case 'progress': {
        const item = this.item(cmd.item);
        if (item.state === 'done' || item.state === 'cancelled') throw new Error('cannot update a closed item');
        this.requireCurrentWorker(actor, item);
        const text = required(cmd.text, 'text');
        if (cmd.handoff !== undefined && typeof cmd.handoff !== 'boolean') throw new Error('handoff must be a boolean');
        this.record('item', item.id, actor.id, `Progress: ${text}`, cmd.handoff ? 'progress_handoff' : 'progress', item.attempt);
        return;
      }
      case 'submit': {
        const item = this.item(cmd.item);
        if (item.state !== 'working') throw new Error('item is not working');
        this.requireCurrentWorker(actor, item, 'execute');
        if (actor.kind === 'main' && item.owner !== actor.id) throw new Error('main must be the assigned executor to submit');
        const text = required(cmd.text, 'evidence');
        this.db.query("UPDATE items SET state = 'awaiting_review', reviewer = NULL WHERE id = ?").run(item.id);
        this.record('item', item.id, actor.id, `Submitted: ${text}`, 'submit', item.attempt);
        return;
      }
      case 'approve':
      case 'reject': {
        const item = this.item(cmd.item);
        if (item.state !== 'reviewing') throw new Error('item is not being reviewed');
        this.requireCurrentWorker(actor, item, 'review');
        if (actor.kind === 'main' && item.reviewer !== actor.id) throw new Error('main must be the assigned reviewer');
        this.requireIndependentReviewer(actor, item);
        const text = required(cmd.text, cmd.op === 'approve' ? 'evidence' : 'reason');
        if (cmd.op === 'approve') {
          this.db.query("UPDATE items SET state = 'done' WHERE id = ?").run(item.id);
          this.record('item', item.id, actor.id, `Approved: ${text}`, 'approve', item.attempt);
          return;
        }
        if (cmd.target !== 'same' && cmd.target !== 'pool') throw new Error('reject target must be same or pool');
        if (cmd.target === 'same') {
          if (!item.owner) throw new Error('there is no executor to resume');
          this.db.query("UPDATE bindings SET attempt = ? WHERE item = ? AND worker = ? AND role = 'execute' AND attempt = ?")
            .run(item.attempt + 1, item.id, item.owner, item.attempt);
          this.db.query("UPDATE items SET state = 'working', reviewer = NULL, attempt = ? WHERE id = ?")
            .run(item.attempt + 1, item.id);
        } else {
          this.db.query("UPDATE items SET state = 'unassigned', owner = NULL, reviewer = NULL WHERE id = ?").run(item.id);
        }
        this.record('item', item.id, actor.id, `Rejected to ${cmd.target}: ${text}`, 'reject', item.attempt);
        return;
      }
      case 'release': {
        this.requireManager(actor);
        const item = this.item(cmd.item);
        const text = required(cmd.text, 'reason');
        if (item.state === 'working') {
          this.db.query("UPDATE items SET state = 'unassigned', owner = NULL WHERE id = ?").run(item.id);
        } else if (item.state === 'reviewing') {
          this.db.query("UPDATE items SET state = 'awaiting_review', reviewer = NULL WHERE id = ?").run(item.id);
        } else throw new Error('item has no active assignment to release');
        this.record('item', item.id, actor.id, `Released: ${text}`, 'release', item.attempt);
        return;
      }
      case 'cancel': {
        this.requireManager(actor);
        const item = this.item(cmd.item);
        this.requireNoPendingSpawn(item.id);
        if (item.state === 'done' || item.state === 'cancelled') throw new Error('item is already closed');
        const text = required(cmd.text, 'reason');
        this.db.query("UPDATE items SET state = 'cancelled', owner = NULL, reviewer = NULL WHERE id = ?").run(item.id);
        this.record('item', item.id, actor.id, `Cancelled: ${text}`, 'cancel', item.attempt);
        return;
      }
      case 'decide': {
        const title = required(cmd.title, 'title');
        const text = required(cmd.text, 'text');
        const items = this.decisionItems(cmd.items, actor);
        const id = `d-${crypto.randomUUID()}`;
        this.db.query('INSERT INTO decisions(id,title,text,items_json,revision,read,supersededBy) VALUES(?,?,?,?,1,0,NULL)')
          .run(id, title, text, JSON.stringify(items));
        this.record('decision', id, actor.id, `Decided: ${title}; ${text}; items: ${JSON.stringify(items)}`, 'decide');
        return;
      }
      case 'note_decision': {
        const decision = this.decision(cmd.decision);
        this.requireRevision(decision, cmd.revision);
        if (actor.kind === 'worker') this.decisionItems(JSON.parse(decision.items_json), actor);
        const text = required(cmd.text, 'text');
        this.db.query('UPDATE decisions SET revision = revision + 1, read = 0 WHERE id = ?').run(decision.id);
        this.record('decision', decision.id, actor.id, `Discussion note: ${text}`, 'note_decision');
        return;
      }
      case 'replace': {
        const decision = this.decision(cmd.decision);
        this.requireRevision(decision, cmd.revision);
        if (decision.supersededBy !== null) throw new Error('decision is already superseded');
        if (actor.kind === 'worker') this.decisionItems(JSON.parse(decision.items_json), actor);
        const title = required(cmd.title, 'title');
        const text = required(cmd.text, 'text');
        const items = this.decisionItems(cmd.items, actor);
        const id = `d-${crypto.randomUUID()}`;
        this.db.query('INSERT INTO decisions(id,title,text,items_json,revision,read,supersededBy) VALUES(?,?,?,?,?,0,NULL)')
          .run(id, title, text, JSON.stringify(items), decision.revision + 1);
        this.db.query('UPDATE decisions SET supersededBy = ?, revision = revision + 1 WHERE id = ?').run(id, decision.id);
        this.record('decision', decision.id, actor.id, `Superseded by ${id}`, 'replace');
        this.record('decision', id, actor.id, `Replaces ${decision.id}: ${title}; ${text}; items: ${JSON.stringify(items)}`, 'decide');
        return;
      }
      case 'read': {
        if (actor.kind !== 'user') throw new Error('only user may mark a decision read');
        const decision = this.decision(cmd.decision);
        this.requireRevision(decision, cmd.revision);
        if (!decision.read) {
          this.db.query('UPDATE decisions SET read = 1, revision = revision + 1 WHERE id = ?').run(decision.id);
          this.record('decision', decision.id, actor.id, 'Marked read', 'read');
        }
        return;
      }
      default:
        throw new Error('unknown board operation');
    }
  }

  receipt(worker: string, key: string, text: string, attempt?: number): void {
    required(worker, 'worker');
    required(key, 'receipt key');
    if (typeof text !== 'string') throw new Error('receipt text must be a string');
    if (attempt !== undefined && (!Number.isSafeInteger(attempt) || attempt < 1)) throw new Error('invalid receipt attempt');
    this.db.transaction(() => {
      const binding = this.bindingForWorker(worker);
      if (!binding) throw new Error('worker has no board binding');
      const prior = this.db.query('SELECT text, attempt FROM receipts WHERE worker = ? AND key = ?').get(worker, key) as { text: string; attempt: number } | null;
      if (prior) {
        if (prior.text !== text || (attempt !== undefined && prior.attempt !== attempt)) throw new Error('receipt key is already used');
        return;
      }
      const receiptAttempt = attempt ?? binding.attempt;
      const first = this.db.query('SELECT initial_attempt FROM bindings WHERE worker = ?')
        .get(worker) as { initial_attempt: number };
      if (receiptAttempt < first.initial_attempt || receiptAttempt > binding.attempt) throw new Error('receipt attempt is outside the worker binding');
      const item = this.item(binding.item);
      const currentHolder = binding.role === 'execute' ? item.owner : item.reviewer;
      const stale = receiptAttempt !== item.attempt || currentHolder !== worker;
      this.db.query('INSERT INTO receipts(worker,key,text,attempt) VALUES(?,?,?,?)').run(worker, key, text, receiptAttempt);
      this.db.query('INSERT INTO receipt_notices(worker,key) VALUES(?,?)').run(worker, key);
      this.record('item', item.id, worker, `${stale ? 'Stale return' : 'Return'} (attempt ${receiptAttempt}): ${text}`, 'receipt', receiptAttempt, stale);
    }).immediate();
  }

  private pendingReceiptRows(): ReceiptNotice[] {
    this.db.query(`DELETE FROM receipt_notices WHERE NOT EXISTS (
      SELECT 1 FROM receipts r JOIN bindings b ON b.worker = r.worker
      JOIN items i ON i.id = b.item
      WHERE r.worker = receipt_notices.worker AND r.key = receipt_notices.key
        AND r.attempt = b.attempt AND r.attempt = i.attempt
        AND ((b.role = 'execute' AND i.owner = b.worker AND i.state IN ('working', 'awaiting_review', 'reviewing', 'done'))
          OR (b.role = 'review' AND i.reviewer = b.worker AND i.state IN ('reviewing', 'done')))
    )`).run();
    return this.db.query(`SELECT n.worker, n.key, b.item, r.attempt
      FROM receipt_notices n JOIN receipts r ON r.worker = n.worker AND r.key = n.key
      JOIN bindings b ON b.worker = r.worker ORDER BY n.rowid LIMIT 100`).all() as ReceiptNotice[];
  }

  pendingReceiptNotices(): ReceiptNotice[] {
    return this.db.transaction(() => this.pendingReceiptRows()).immediate();
  }

  deliverReceiptNotices(deliver: (items: { item: string; attempt: number }[]) => void, selected?: readonly ReceiptNotice[]): boolean {
    return this.db.transaction(() => {
      const pending = this.pendingReceiptRows();
      const keys = selected && new Set(selected.map(({ worker, key }) => JSON.stringify([worker, key])));
      const rows = keys ? pending.filter(({ worker, key }) => keys.has(JSON.stringify([worker, key]))) : pending;
      if (!rows.length) return false;
      const items = [...new Map(rows.map(({ item, attempt }) => [item, { item, attempt }])).values()];
      deliver(items);
      const remove = this.db.query('DELETE FROM receipt_notices WHERE worker = ? AND key = ?');
      for (const row of rows) remove.run(row.worker, row.key);
      return pending.length === 100;
    }).immediate();
  }
}
