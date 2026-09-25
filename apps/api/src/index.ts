import { MockX402Adapter } from '@x402-treasury/x402-adapter';
import pg from 'pg';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const adapter = new MockX402Adapter();

const app = buildApp({ pool, adapter, logger: { level: config.API_LOG_LEVEL } });

app.log.warn(
  'PAYMENT MODE: MOCK — no real blockchain settlement. See docs/RESEARCH.md §12 for how to run against Base Sepolia.',
);

try {
  await app.listen({ port: config.API_PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

async function shutdown(): Promise<void> {
  await app.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
