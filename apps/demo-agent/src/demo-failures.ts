import { runMigrations } from '@x402-treasury/db';
import { TreasuryClient } from './client.js';
import { bold, dim, green, heading, red, rule, yellow } from './format.js';
import { startProcess, stopAll, type ManagedProcess } from './processes.js';

/**
 * Deterministic demonstrations of the failure paths from task spec §23 —
 * every one of these is a REAL request against the REAL running Treasury
 * API and REAL demo providers, not a canned example.
 */

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://treasury_app:treasury@localhost:5432/treasury_dev';
const MIGRATOR_DATABASE_URL = process.env['MIGRATOR_DATABASE_URL'] ?? DATABASE_URL;

const API_PORT = 3901;
const PROVIDER_A_PORT = 4903;
const PROVIDER_B_PORT = 4904;
const API_URL = `http://127.0.0.1:${API_PORT}`;

interface DemoOrgSetup {
  client: TreasuryClient;
  agentId: string;
  providerA: { id: string };
  providerConcurrency: { id: string };
}

async function setUpOrg(): Promise<DemoOrgSetup> {
  const anon = new TreasuryClient({ baseUrl: API_URL });
  const org = (await anon.post('/organizations', { name: 'Failure Demo Org', dailyBudget: '100.00' })).body;
  const client = anon.withApiKey(org['apiKey'] as string);
  const agent = (await client.post('/agents', { name: 'Demo Agent', dailyBudget: '20.00' })).body;
  const providerA = (
    await client.post('/providers', {
      name: 'Provider A',
      baseUrl: `http://127.0.0.1:${PROVIDER_A_PORT}`,
      resourcePath: '/research',
      category: 'search',
      network: 'eip155:84532',
      configuredPrice: '0.010',
      trustStatus: 'TRUSTED',
    })
  ).body;
  const providerConcurrency = (
    await client.post('/providers', {
      name: 'Provider A ($0.50 fixture)',
      baseUrl: `http://127.0.0.1:${PROVIDER_A_PORT}`,
      resourcePath: '/concurrency-test',
      category: 'search',
      network: 'eip155:84532',
      configuredPrice: '0.500',
      trustStatus: 'TRUSTED',
    })
  ).body;
  return {
    client,
    agentId: agent['id'] as string,
    providerA: providerA as { id: string },
    providerConcurrency: providerConcurrency as { id: string },
  };
}

async function demoBudgetExceeded(client: TreasuryClient, agentId: string, providerId: string): Promise<void> {
  heading('A. Budget exceeded');
  const session = (await client.post('/sessions', { agentId, name: 'Tiny budget', budget: '0.02' })).body;
  console.log(`Session budget: $${session['allocated']}, resource price: $0.010`);
  const resp = await client.post(
    '/payments/intents',
    { agentId, sessionId: session['id'], providerId },
    { 'idempotency-key': crypto.randomUUID() },
  );
  console.log(`HTTP ${resp.status}, decision=${resp.body['decision']}`);
  const ok = resp.status === 200; // $0.02 >= $0.01, so this one should actually succeed — demonstrate the blocked case below with an even smaller budget
  console.log(ok ? green('(expected: this one fits, succeeds)') : red('unexpected'));

  const tinySession = (await client.post('/sessions', { agentId, name: 'Too tiny', budget: '0.005' })).body;
  const blockedResp = await client.post(
    '/payments/intents',
    { agentId, sessionId: tinySession['id'], providerId },
    { 'idempotency-key': crypto.randomUUID() },
  );
  console.log(`HTTP ${blockedResp.status}, decision=${blockedResp.body['decision']}, reasons=${JSON.stringify(blockedResp.body['reasonCodes'])}`);
  console.log(blockedResp.status === 402 ? green('✓ blocked as expected, no funds reserved') : red('✗ unexpected result'));
}

async function demoDuplicateRetry(client: TreasuryClient, agentId: string, providerId: string): Promise<void> {
  heading('B. Duplicate retry (same Idempotency-Key sent 5 times)');
  const session = (await client.post('/sessions', { agentId, name: 'Duplicate retry demo', budget: '1.00' })).body;
  const key = crypto.randomUUID();
  const ids = new Set<string>();
  for (let i = 1; i <= 5; i++) {
    const resp = await client.post('/payments/intents', { agentId, sessionId: session['id'], providerId }, { 'idempotency-key': key });
    ids.add(resp.body['paymentIntentId'] as string);
    console.log(`  attempt ${i}: HTTP ${resp.status}, paymentIntentId=${resp.body['paymentIntentId']}, replay=${Boolean(resp.body['idempotentReplay'])}`);
  }
  console.log(ids.size === 1 ? green(`✓ one logical payment intent across 5 retries (${[...ids][0]})`) : red(`✗ got ${ids.size} distinct intents`));
}

async function demoConcurrentSpending(client: TreasuryClient, agentId: string, providerId: string): Promise<void> {
  heading('C. Concurrent spending: budget $1.00, ten concurrent $0.50 requests');
  const session = (await client.post('/sessions', { agentId, name: 'Concurrency demo', budget: '1.00' })).body;
  const attempts = Array.from({ length: 10 }, (_, i) =>
    client.post('/payments/intents', { agentId, sessionId: session['id'], providerId }, { 'idempotency-key': `concurrent-${i}-${crypto.randomUUID()}` }),
  );
  const results = await Promise.all(attempts);
  const succeeded = results.filter((r) => r.status === 200).length;
  const blocked = results.filter((r) => r.status !== 200).length;
  console.log(`  ${succeeded} succeeded, ${blocked} blocked`);
  const finalSession = (await client.get(`/sessions/${session['id']}`)).body;
  console.log(`  final: allocated=$${finalSession['allocated']} spent=$${finalSession['spent']} available=$${finalSession['available']}`);
  console.log(
    succeeded === 2 && finalSession['available'] === '0.000000'
      ? green('✓ exactly 2 of 10 succeeded, budget never went negative')
      : red(`✗ expected exactly 2 successes and $0.00 available, got ${succeeded} successes and $${finalSession['available']} available`),
  );
}

async function demoUncertainSettlement(client: TreasuryClient, agentId: string, providerId: string): Promise<void> {
  heading('D. Settlement failure / uncertain outcome -> reconciliation');
  const session = (await client.post('/sessions', { agentId, name: 'Reconciliation demo', budget: '1.00' })).body;
  const resp = await client.post(
    '/payments/intents',
    { agentId, sessionId: session['id'], providerId, simulateUncertainSettlement: true },
    { 'idempotency-key': crypto.randomUUID() },
  );
  console.log(`  payment HTTP ${resp.status}: state=${resp.body['state']} (${dim('simulated facilitator timeout, for demonstration only')})`);
  let mid = (await client.get(`/sessions/${session['id']}`)).body;
  console.log(`  while uncertain: reserved=$${mid['reserved']} spent=$${mid['spent']}`);

  const reconcileResp = await client.post('/reconciliation/run');
  console.log(`  reconciliation resolved ${(reconcileResp.body['outcomes'] as unknown[]).length} payment(s): ${JSON.stringify(reconcileResp.body['outcomes'])}`);

  mid = (await client.get(`/sessions/${session['id']}`)).body;
  console.log(`  after reconciliation: reserved=$${mid['reserved']} spent=$${mid['spent']}`);
  console.log(mid['spent'] === '0.500000' ? green('✓ reservation correctly captured once reconciliation confirmed settlement') : red('✗ unexpected final balance'));
}

async function main(): Promise<void> {
  console.log(bold('x402 Treasury — Failure Mode Demonstrations'));
  rule();
  await runMigrations(MIGRATOR_DATABASE_URL);

  const processes: ManagedProcess[] = [];
  try {
    processes.push(await startProcess('api', 'apps/api/src/index.ts', API_PORT, { DATABASE_URL, API_PORT: String(API_PORT), API_LOG_LEVEL: 'silent' }));
    processes.push(await startProcess('demo-provider-a', 'apps/demo-provider-a/src/index.ts', PROVIDER_A_PORT, { DEMO_PROVIDER_A_PORT: String(PROVIDER_A_PORT) }));
    processes.push(await startProcess('demo-provider-b', 'apps/demo-provider-b/src/index.ts', PROVIDER_B_PORT, { DEMO_PROVIDER_B_PORT: String(PROVIDER_B_PORT) }));

    const { client, agentId, providerA, providerConcurrency } = await setUpOrg();

    await demoBudgetExceeded(client, agentId, providerA.id);
    await demoDuplicateRetry(client, agentId, providerA.id);
    await demoConcurrentSpending(client, agentId, providerConcurrency.id);
    await demoUncertainSettlement(client, agentId, providerConcurrency.id);

    console.log();
    rule();
    console.log(yellow('PAYMENT MODE: MOCK'), dim('— no real blockchain settlement occurred in any of the above.'));
    rule();
  } finally {
    stopAll(processes);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
