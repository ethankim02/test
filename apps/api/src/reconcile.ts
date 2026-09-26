import { runReconciliation } from '@x402-treasury/ledger';
import pg from 'pg';
import { loadConfig } from './config.js';
import { createMockSettlementOracle } from './oracle.js';

const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });

const outcomes = await runReconciliation(pool, createMockSettlementOracle(pool));

if (outcomes.length === 0) {
  console.log('reconciliation: nothing to do (no uncertain payment states found)');
} else {
  console.log(`reconciliation: resolved ${outcomes.length} payment(s)`);
  for (const outcome of outcomes) {
    console.log(`  ${outcome.paymentIntentId}: ${outcome.resolution} — ${outcome.detail}`);
  }
}

await pool.end();
