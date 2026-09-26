import { runMigrations } from '@x402-treasury/db';
import pg from 'pg';

const MIGRATOR_URL =
  process.env.MIGRATOR_DATABASE_URL ??
  'postgresql://treasury_migrator:treasury@localhost:5432/treasury_test';
const APP_URL =
  process.env.DATABASE_URL ?? 'postgresql://treasury_app:treasury@localhost:5432/treasury_test';

export async function setupTestDatabase(): Promise<{ pool: pg.Pool }> {
  await runMigrations(MIGRATOR_URL);
  const pool = new pg.Pool({ connectionString: APP_URL });
  return { pool };
}

/**
 * Truncates every domain table between tests (fast: this schema is small).
 * Runs as the migrator so it isn't blocked by the app role's restricted
 * grants (TRUNCATE isn't part of what treasury_app needs at runtime).
 */
export async function resetTestDatabase(): Promise<void> {
  const client = new pg.Client({ connectionString: MIGRATOR_URL });
  await client.connect();
  try {
    await client.query(`
      TRUNCATE TABLE
        reconciliation_records,
        payment_state_transitions,
        payment_intents,
        routing_decisions,
        idempotency_keys,
        policies,
        provider_metrics,
        providers,
        ledger_entries,
        reservations,
        budgets,
        api_keys,
        agents,
        organizations
      RESTART IDENTITY CASCADE
    `);
  } finally {
    await client.end();
  }
}
