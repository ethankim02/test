import type { Pool, PoolClient } from 'pg';

/**
 * Runs `fn` inside a single Postgres transaction, committing on success and
 * rolling back on any thrown error. Every ledger operation in this package
 * (reserve/capture/release/expire) is one call to this — the atomicity of
 * "check invariant, then mutate" depends on it.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      // rollback failure is logged by the caller via the original error; the
      // connection will be discarded by pg's pool on release after an error.
    });
    throw err;
  } finally {
    client.release();
  }
}
