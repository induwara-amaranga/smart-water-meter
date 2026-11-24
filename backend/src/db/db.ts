import { mkdirSync } from 'node:fs';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';

/**
 * Minimal database interface implemented by node-postgres (production) and
 * PGlite (zero-setup development and tests). Both run real PostgreSQL SQL.
 */
export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = any>(sql: string, params?: unknown[]): Promise<T | undefined>;
  exec(sql: string): Promise<void>;
  /** Run fn in a transaction. Use only the db passed to fn inside it. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly kind: 'postgres' | 'pglite';
}

// Return bigint/count columns as numbers (values here stay far below 2^53).
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

class PgDb implements Db {
  readonly kind = 'postgres' as const;
  constructor(
    private readonly runner: pg.Pool | pg.PoolClient,
    private readonly pool?: pg.Pool,
  ) {}

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.runner.query(sql, params as any[]);
    return res.rows as T[];
  }

  async one<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return (await this.query<T>(sql, params))[0];
  }

  async exec(sql: string): Promise<void> {
    await this.runner.query(sql);
  }

  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    if (!this.pool) return fn(this); // already inside a transaction
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(new PgDb(client));
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }
}

type PGliteLike = Pick<PGlite, 'query' | 'exec'> & Partial<Pick<PGlite, 'transaction' | 'close'>>;

function normalize(row: Record<string, unknown>) {
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'bigint') row[k] = Number(v);
  }
  return row;
}

class PgliteDb implements Db {
  readonly kind = 'pglite' as const;
  constructor(private readonly runner: PGliteLike) {}

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.runner.query<Record<string, unknown>>(sql, params as any[], {
      parsers: { 1700: (v: string) => Number(v), 20: (v: string) => Number(v) },
    });
    return res.rows.map(normalize) as T[];
  }

  async one<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return (await this.query<T>(sql, params))[0];
  }

  async exec(sql: string): Promise<void> {
    await this.runner.exec(sql);
  }

  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    if (!this.runner.transaction) return fn(this);
    return this.runner.transaction((t) => fn(new PgliteDb(t as unknown as PGliteLike)));
  }

  async close(): Promise<void> {
    await this.runner.close?.();
  }
}

/** Connect to PostgreSQL if a URL is given, otherwise open PGlite (dir, or memory when dir is "memory"). */
export async function openDb(databaseUrl: string, pgliteDir: string, ssl = false): Promise<Db> {
  if (databaseUrl) {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 10, ssl: ssl ? { rejectUnauthorized: false } : undefined });
    await pool.query('select 1');
    return new PgDb(pool, pool);
  }
  if (pgliteDir !== 'memory') mkdirSync(pgliteDir, { recursive: true });
  const lite = await PGlite.create(pgliteDir === 'memory' ? undefined : pgliteDir);
  return new PgliteDb(lite);
}
