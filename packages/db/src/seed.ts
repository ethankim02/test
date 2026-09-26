import { hashApiKey } from '@x402-treasury/shared';
import { eq } from 'drizzle-orm';
import { pathToFileURL } from 'node:url';
import { createDb } from './client.js';
import * as schema from './schema.js';

/**
 * Seeds one demo organization matching the hierarchy example in the
 * project spec: an org treasury, a Research Agent and Coding Agent under
 * it, a delegated sub-agent under Research Agent, three demo search
 * providers with different price/latency/reliability characteristics, and
 * a starter policy set. Idempotent: safe to re-run against a fresh or
 * already-seeded database (checks for the org by name first).
 */
export async function seed(connectionString: string): Promise<{ orgId: string; apiKey: string }> {
  const { db, pool } = createDb({ connectionString });
  try {
    const existing = await db
      .select()
      .from(schema.organizations)
      .where(eq(schema.organizations.name, 'Acme Research'))
      .limit(1);
    if (existing.length > 0 && existing[0]) {
      console.log('already seeded (org "Acme Research" exists); skipping');
      return { orgId: existing[0].id, apiKey: '(not re-printed — see original seed output)' };
    }

    const [org] = await db
      .insert(schema.organizations)
      .values({ name: 'Acme Research' })
      .returning();
    if (!org) throw new Error('failed to insert organization');

    const orgBudgetAllocated = 100_000_000n; // $100.00 USDC
    const [orgBudget] = await db
      .insert(schema.budgets)
      .values({
        orgId: org.id,
        agentId: null,
        parentBudgetId: null,
        scope: 'ORG',
        name: 'Org Treasury',
        period: 'DAILY',
        allocatedMinor: orgBudgetAllocated,
        availableMinor: orgBudgetAllocated,
      })
      .returning();
    if (!orgBudget) throw new Error('failed to insert org budget');

    const [researchAgent] = await db
      .insert(schema.agents)
      .values({ orgId: org.id, name: 'Research Agent' })
      .returning();
    const [codingAgent] = await db
      .insert(schema.agents)
      .values({ orgId: org.id, name: 'Coding Agent' })
      .returning();
    if (!researchAgent || !codingAgent) throw new Error('failed to insert agents');

    const [subAgent] = await db
      .insert(schema.agents)
      .values({ orgId: org.id, parentAgentId: researchAgent.id, name: 'Web Search Sub-Agent' })
      .returning();
    if (!subAgent) throw new Error('failed to insert sub-agent');

    const researchAllocated = 20_000_000n; // $20.00/day
    const [researchBudget] = await db
      .insert(schema.budgets)
      .values({
        orgId: org.id,
        agentId: researchAgent.id,
        parentBudgetId: orgBudget.id,
        scope: 'AGENT',
        name: 'Research Agent Daily Budget',
        period: 'DAILY',
        allocatedMinor: researchAllocated,
        availableMinor: researchAllocated,
      })
      .returning();

    const codingAllocated = 30_000_000n; // $30.00/day
    await db.insert(schema.budgets).values({
      orgId: org.id,
      agentId: codingAgent.id,
      parentBudgetId: orgBudget.id,
      scope: 'AGENT',
      name: 'Coding Agent Daily Budget',
      period: 'DAILY',
      allocatedMinor: codingAllocated,
      availableMinor: codingAllocated,
    });

    if (!researchBudget) throw new Error('failed to insert research budget');

    // Demo providers — matching docs/DEMO.md: same capability, different
    // price/latency/reliability, to demonstrate routing.
    const [providerA] = await db
      .insert(schema.providers)
      .values({
        orgId: org.id,
        name: 'Demo Research Provider A (cheap, slow)',
        baseUrl: 'http://localhost:4001',
        resourcePath: '/research',
        category: 'search',
        network: 'eip155:84532',
        configuredPriceMinor: 10_000n, // $0.01
        trustStatus: 'TRUSTED',
      })
      .returning();
    const [providerB] = await db
      .insert(schema.providers)
      .values({
        orgId: org.id,
        name: 'Demo Research Provider B (expensive, fast)',
        baseUrl: 'http://localhost:4002',
        resourcePath: '/research',
        category: 'search',
        network: 'eip155:84532',
        configuredPriceMinor: 30_000n, // $0.03
        trustStatus: 'TRUSTED',
      })
      .returning();
    const [providerC] = await db
      .insert(schema.providers)
      .values({
        orgId: org.id,
        name: 'Demo Research Provider C (balanced)',
        baseUrl: 'http://localhost:4001',
        resourcePath: '/research-balanced',
        category: 'search',
        network: 'eip155:84532',
        configuredPriceMinor: 15_000n, // $0.015
        trustStatus: 'KNOWN',
      })
      .returning();

    if (!providerA || !providerB || !providerC) throw new Error('failed to insert providers');

    await db.insert(schema.providerMetrics).values([
      {
        providerId: providerA.id,
        observedPriceMinor: 10_000n,
        observedLatencyMs: 1420,
        observedSuccess: true,
      },
      {
        providerId: providerA.id,
        observedPriceMinor: 10_000n,
        observedLatencyMs: 1510,
        observedSuccess: true,
      },
      {
        providerId: providerB.id,
        observedPriceMinor: 30_000n,
        observedLatencyMs: 281,
        observedSuccess: true,
      },
      {
        providerId: providerB.id,
        observedPriceMinor: 30_000n,
        observedLatencyMs: 305,
        observedSuccess: true,
      },
      {
        providerId: providerC.id,
        observedPriceMinor: 15_000n,
        observedLatencyMs: 650,
        observedSuccess: true,
      },
      {
        providerId: providerC.id,
        observedPriceMinor: 15_000n,
        observedLatencyMs: 690,
        observedSuccess: false,
      },
    ]);

    await db.insert(schema.policies).values([
      {
        orgId: org.id,
        scope: 'ORG',
        ruleType: 'PER_TRANSACTION_LIMIT',
        params: { maxAmountMinor: '500000' }, // $0.50
      },
      {
        orgId: org.id,
        scope: 'ORG',
        ruleType: 'UNKNOWN_PROVIDER_LIMIT',
        params: { maxAmountMinor: '50000' }, // $0.05
      },
      {
        orgId: org.id,
        scope: 'ORG',
        ruleType: 'CATEGORY_DAILY_LIMIT',
        params: { category: 'search', maxAmountMinor: '5000000' }, // $5.00/day
      },
      {
        orgId: org.id,
        scope: 'ORG',
        ruleType: 'CATEGORY_DAILY_LIMIT',
        params: { category: 'data', maxAmountMinor: '10000000' }, // $10.00/day
      },
      {
        orgId: org.id,
        scope: 'ORG',
        ruleType: 'DUPLICATE_PAYMENT_WINDOW',
        params: { windowSeconds: 5 },
      },
    ]);

    const apiKey = `sk_demo_${crypto.randomUUID().replace(/-/g, '')}`;
    await db.insert(schema.apiKeys).values({
      orgId: org.id,
      agentId: null,
      keyHash: hashApiKey(apiKey),
      label: 'Demo org key (from seed script)',
    });

    console.log('Seeded organization "Acme Research"');
    console.log(`  org id: ${org.id}`);
    console.log(`  research agent id: ${researchAgent.id}`);
    console.log(`  coding agent id: ${codingAgent.id}`);
    console.log(`  sub-agent id: ${subAgent.id}`);
    console.log(`  providers: A=${providerA.id} B=${providerB.id} C=${providerC.id}`);
    console.log(`  API key (save this — shown once): ${apiKey}`);

    return { orgId: org.id, apiKey };
  } finally {
    await pool.end();
  }
}

// pathToFileURL (not a raw `file://${...}` template) is required for this
// comparison to work on Windows, where argv[1] uses backslashes and a drive
// letter that don't match import.meta.url's URL-encoded forward-slash form.
const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  await seed(connectionString);
}
