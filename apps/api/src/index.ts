import { MockX402Adapter, RealX402Adapter, type PaymentRail } from '@x402-treasury/x402-adapter';
import pg from 'pg';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });

// Explicitly opt-in only — X402_ADAPTER_MODE defaults to "mock" (loadConfig
// enforces that the two required env vars are set before "real" is even
// reachable here). See docs/DEMO.md "REAL BASE TESTNET x402 DEMO" and
// docs/THREAT_MODEL.md. Never used by CI or either `pnpm demo:*` command.
const adapter: PaymentRail =
  config.X402_ADAPTER_MODE === 'real'
    ? new RealX402Adapter(config.X402_PAYER_PRIVATE_KEY as `0x${string}`, config.X402_NETWORK)
    : new MockX402Adapter();

const app = buildApp({ pool, adapter, logger: { level: config.API_LOG_LEVEL } });

if (config.X402_ADAPTER_MODE === 'real') {
  app.log.warn(
    `PAYMENT MODE: REAL BASE TESTNET (${config.X402_NETWORK}) — settlement is a genuine on-chain testnet transaction via ${config.X402_FACILITATOR_URL}. Testnet funds only; see docs/RESEARCH.md §13.`,
  );
} else {
  app.log.warn(
    'PAYMENT MODE: MOCK — no real blockchain settlement. See docs/DEMO.md "REAL BASE TESTNET x402 DEMO" for how to run against Base Sepolia.',
  );
}

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
