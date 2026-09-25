import { createDb, runMigrations, schema } from '@x402-treasury/db';
import { TreasuryClient } from './client.js';
import { bold, check, cyan, dim, green, heading, kv, rule, yellow } from './format.js';
import { startProcess, stopAll, type ManagedProcess } from './processes.js';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://treasury_app:treasury@localhost:5432/treasury_dev';
const MIGRATOR_DATABASE_URL = process.env['MIGRATOR_DATABASE_URL'] ?? DATABASE_URL;

const API_PORT = 3900;
const PROVIDER_A_PORT = 4901;
const PROVIDER_B_PORT = 4902;
const API_URL = `http://127.0.0.1:${API_PORT}`;

async function seedRealisticMetrics(providerIds: { a: string; b: string; c: string }): Promise<void> {
  const { db, pool } = createDb({ connectionString: DATABASE_URL });
  const samples: Array<{ providerId: string; latency: number; success: boolean }> = [
    ...Array.from({ length: 20 }, () => ({ providerId: providerIds.a, latency: 1400 + Math.round(Math.random() * 200), success: true })),
    ...Array.from({ length: 20 }, () => ({ providerId: providerIds.b, latency: 280 + Math.round(Math.random() * 60), success: Math.random() < 0.995 })),
    ...Array.from({ length: 20 }, () => ({ providerId: providerIds.c, latency: 640 + Math.round(Math.random() * 80), success: Math.random() < 0.981 })),
  ];
  for (const s of samples) {
    await db.insert(schema.providerMetrics).values({
      providerId: s.providerId,
      observedPriceMinor: 0n,
      observedLatencyMs: s.latency,
      observedSuccess: s.success,
    });
  }
  await pool.end();
}

async function main(): Promise<void> {
  console.log(bold('x402 Treasury Demo'));
  rule();
  console.log(dim('Starting Treasury API and two demo x402-enabled providers as real local processes...'));

  await runMigrations(MIGRATOR_DATABASE_URL);

  const processes: ManagedProcess[] = [];
  try {
    processes.push(
      await startProcess('api', 'apps/api/src/index.ts', API_PORT, {
        DATABASE_URL,
        API_PORT: String(API_PORT),
        API_LOG_LEVEL: 'silent',
      }),
    );
    processes.push(
      await startProcess('demo-provider-a', 'apps/demo-provider-a/src/index.ts', PROVIDER_A_PORT, {
        DEMO_PROVIDER_A_PORT: String(PROVIDER_A_PORT),
      }),
    );
    processes.push(
      await startProcess('demo-provider-b', 'apps/demo-provider-b/src/index.ts', PROVIDER_B_PORT, {
        DEMO_PROVIDER_B_PORT: String(PROVIDER_B_PORT),
      }),
    );

    const anon = new TreasuryClient({ baseUrl: API_URL });

    const org = (await anon.post('/organizations', { name: 'Acme Research (demo)', dailyBudget: '100.00' })).body;
    const client = anon.withApiKey(org['apiKey'] as string);

    const agent = (await client.post('/agents', { name: 'Research Agent', dailyBudget: '20.00' })).body;
    const session = (
      await client.post('/sessions', { agentId: agent['id'], name: 'Research API demonstration', budget: '1.00' })
    ).body;

    await client.post('/policies', { scope: 'ORG', ruleType: 'PER_TRANSACTION_LIMIT', params: { maxAmountMinor: '500000' } });
    await client.post('/policies', { scope: 'ORG', ruleType: 'UNKNOWN_PROVIDER_LIMIT', params: { maxAmountMinor: '50000' } });
    await client.post('/policies', { scope: 'ORG', ruleType: 'DUPLICATE_PAYMENT_WINDOW', params: { windowSeconds: 5 } });

    const providerA = (
      await client.post('/providers', {
        name: 'Provider A (cheap, slow)',
        baseUrl: `http://127.0.0.1:${PROVIDER_A_PORT}`,
        resourcePath: '/research',
        category: 'search',
        network: 'eip155:84532',
        configuredPrice: '0.010',
        trustStatus: 'TRUSTED',
      })
    ).body;
    const providerB = (
      await client.post('/providers', {
        name: 'Provider B (expensive, fast)',
        baseUrl: `http://127.0.0.1:${PROVIDER_B_PORT}`,
        resourcePath: '/research',
        category: 'search',
        network: 'eip155:84532',
        configuredPrice: '0.030',
        trustStatus: 'TRUSTED',
      })
    ).body;
    const providerC = (
      await client.post('/providers', {
        name: 'Provider C (balanced)',
        baseUrl: `http://127.0.0.1:${PROVIDER_A_PORT}`,
        resourcePath: '/research-balanced',
        category: 'search',
        network: 'eip155:84532',
        configuredPrice: '0.015',
        trustStatus: 'KNOWN',
      })
    ).body;
    await client.post('/policies', {
      scope: 'ORG',
      ruleType: 'PROVIDER_ALLOWLIST',
      params: { providerIds: [providerA['id'], providerB['id'], providerC['id']] },
    });

    await seedRealisticMetrics({ a: providerA['id'] as string, b: providerB['id'] as string, c: providerC['id'] as string });

    console.log();
    heading('Task');
    console.log('Research API demonstration');
    console.log();
    kv('Session budget:', `$${session['allocated']} USDC`);

    console.log();
    heading('Providers discovered: 3');
    const routing = (
      await client.post('/routes/evaluate', {
        category: 'search',
        objective: 'balanced',
        sessionBudgetId: session['id'],
      })
    ).body;
    for (const s of routing['scored'] as Array<{ provider: { name: string; priceMinor: string; latencyMs: number; successRate: number }; score: number }>) {
      const p = s.provider;
      console.log(
        `${p.name.padEnd(32)} $${(Number(p.priceMinor) / 1_000_000).toFixed(3)} | ${String(p.latencyMs).padStart(4)}ms | ${(p.successRate * 100).toFixed(1)}% | score=${s.score.toFixed(4)}`,
      );
    }

    console.log();
    heading('Routing');
    const selected = routing['selected'] as { id: string; name: string };
    console.log(`Selected: ${cyan(selected.name)}`);
    console.log(dim('Reason: lowest balanced score (price 0.4 / latency 0.3 / reliability 0.3) — see docs/ROUTING.md'));

    console.log();
    heading('Payment');
    const idempotencyKey = crypto.randomUUID();
    const paymentResp = await client.post(
      '/payments/intents',
      { agentId: agent['id'], sessionId: session['id'], providerId: selected.id },
      { 'idempotency-key': idempotencyKey },
    );
    const payment = paymentResp.body;

    console.log('Policy checks');
    for (const ruleEval of (payment['evaluatedRules'] as Array<{ ruleType: string; verdict: string }>) ?? []) {
      check(ruleEval.verdict === 'ALLOW', ruleEval.ruleType);
    }

    console.log();
    heading('Result');
    console.log(`HTTP ${paymentResp.status}`);

    if (payment['decision'] === 'ALLOW') {
      console.log(green(`Payment settled (mock): ${payment['settlement'] && (payment['settlement'] as { transactionHash: string }).transactionHash}`));
      console.log();
      heading('Budget');
      const budget = payment['sessionBudget'] as { allocated: string; spent: string; reserved: string; available: string };
      kv('Allocated', `$${budget.allocated}`);
      kv('Spent', `$${budget.spent}`);
      kv('Reserved', `$${budget.reserved}`);
      kv('Available', `$${budget.available}`);
      console.log();
      console.log(dim('Resource (mock data): ') + JSON.stringify(payment['resource']));
    } else {
      console.log(yellow(`Payment was not settled: ${payment['decision']} — ${JSON.stringify(payment['reasonCodes'])}`));
    }

    console.log();
    rule();
    console.log(dim('PAYMENT MODE: MOCK — no real blockchain settlement occurred. See docs/RESEARCH.md §12 for Base Sepolia.'));
    rule();
  } finally {
    stopAll(processes);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
