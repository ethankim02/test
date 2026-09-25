import { runMigrations } from '@x402-treasury/db';
import { MockX402Adapter } from '@x402-treasury/x402-adapter';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

const MIGRATOR_URL =
  process.env.MIGRATOR_DATABASE_URL ??
  'postgresql://treasury_migrator:treasury@localhost:5432/treasury_test';
const APP_URL =
  process.env.DATABASE_URL ?? 'postgresql://treasury_app:treasury@localhost:5432/treasury_test';

export async function setupTestApp(): Promise<{ app: FastifyInstance; pool: pg.Pool }> {
  await runMigrations(MIGRATOR_URL);
  const pool = new pg.Pool({ connectionString: APP_URL });
  const app = buildApp({ pool, adapter: new MockX402Adapter(), logger: false });
  await app.ready();
  return { app, pool };
}

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
