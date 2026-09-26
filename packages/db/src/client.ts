import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Database = ReturnType<typeof drizzle<typeof schema>>;

export interface CreateDbOptions {
  connectionString: string;
  /** Max pool connections. Kept small: this is a demo-scale project, not a tuned production pool. */
  max?: number;
}

export function createDb(options: CreateDbOptions): { db: Database; pool: pg.Pool } {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
  });
  const db = drizzle(pool, { schema });
  return { db, pool };
}
