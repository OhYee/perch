import { createRequire } from 'node:module';

export type StatementResult = { changes: number };

export type SqliteStatement = {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): StatementResult;
};

export type SqliteTransaction<T> = {
  (): T;
  deferred(): T;
  immediate(): T;
};

type RawBunDb = {
  exec(sql: string): void;
  query(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number | bigint };
  };
  transaction<T>(fn: () => T): SqliteTransaction<T>;
  close(): void;
};

type RawNodeDb = {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number | bigint };
  };
  close(): void;
};

const localRequire = createRequire(import.meta.url);
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

function toPlainRow(row: unknown): unknown {
  return row && typeof row === 'object' ? { ...(row as Record<string, unknown>) } : row;
}

/**
 * Dual-runtime SQLite wrapper: uses `bun:sqlite` inside OMP (Bun) and
 * `node:sqlite` (`DatabaseSync`) under Node 22+ without any static Bun import.
 */
export class SqliteDatabase {
  private readonly bunDb?: RawBunDb;
  private readonly nodeDb?: RawNodeDb;
  private txDepth = 0;

  constructor(path: string, options?: { create?: boolean; strict?: boolean }) {
    if (isBun) {
      const mod = localRequire('bun:sqlite') as { Database: new (p: string, opts?: { create?: boolean; strict?: boolean }) => RawBunDb };
      this.bunDb = new mod.Database(path, options ?? { create: true, strict: true });
    } else {
      const mod = localRequire('node:sqlite') as { DatabaseSync: new (p: string) => RawNodeDb };
      this.nodeDb = new mod.DatabaseSync(path);
    }
  }

  exec(sql: string): void {
    if (this.bunDb) this.bunDb.exec(sql);
    else this.nodeDb!.exec(sql);
  }

  query(sql: string): SqliteStatement {
    if (this.bunDb) {
      const stmt = this.bunDb.query(sql);
      return {
        get: (...params: unknown[]) => stmt.get(...params) ?? null,
        all: (...params: unknown[]) => stmt.all(...params),
        run: (...params: unknown[]) => ({ changes: Number(stmt.run(...params).changes) }),
      };
    }
    const stmt = this.nodeDb!.prepare(sql);
    return {
      get: (...params: unknown[]) => {
        const row = stmt.get(...params);
        return row === undefined ? null : toPlainRow(row);
      },
      all: (...params: unknown[]) => stmt.all(...params).map(toPlainRow),
      run: (...params: unknown[]) => ({ changes: Number(stmt.run(...params).changes) }),
    };
  }

  transaction<T>(fn: () => T): SqliteTransaction<T> {
    if (this.bunDb) {
      return this.bunDb.transaction(fn);
    }
    const runTx = (mode: 'DEFERRED' | 'IMMEDIATE'): T => {
      const db = this.nodeDb!;
      const nested = this.txDepth > 0;
      const savepoint = nested ? `sp_${this.txDepth}` : '';
      db.exec(nested ? `SAVEPOINT ${savepoint}` : `BEGIN ${mode}`);
      this.txDepth++;
      try {
        const result = fn();
        this.txDepth--;
        db.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT');
        return result;
      } catch (error) {
        this.txDepth--;
        try {
          if (nested) {
            db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
            db.exec(`RELEASE SAVEPOINT ${savepoint}`);
          } else {
            db.exec('ROLLBACK');
          }
        } catch {}
        throw error;
      }
    };
    const callable = (() => runTx('DEFERRED')) as SqliteTransaction<T>;
    callable.deferred = () => runTx('DEFERRED');
    callable.immediate = () => runTx('IMMEDIATE');
    return callable;
  }

  close(): void {
    if (this.bunDb) this.bunDb.close();
    else this.nodeDb!.close();
  }
}
