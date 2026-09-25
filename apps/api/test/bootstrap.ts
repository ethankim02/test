import { hashApiKey } from '@x402-treasury/shared';
import type { PaymentRequirementsWire } from '@x402-treasury/x402-adapter';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestProvider } from './test-provider.js';

export interface Bootstrapped {
  orgId: string;
  apiKey: string;
  agentId: string;
  agentKey: string;
  sessionId: string;
  providerId: string;
  providerServer: ReturnType<typeof startTestProvider>['server'];
}

export async function bootstrap(
  app: FastifyInstance,
  pool: Pool,
  opts: { orgDailyBudget?: string; agentDailyBudget?: string; sessionBudget?: string; priceMinor?: string } = {},
): Promise<Bootstrapped> {
  const orgResp = await app.inject({
    method: 'POST',
    url: '/organizations',
    payload: { name: 'Test Org', dailyBudget: opts.orgDailyBudget ?? '100.00' },
  });
  const org = orgResp.json();

  const agentResp = await app.inject({
    method: 'POST',
    url: '/agents',
    headers: { authorization: `Bearer ${org.apiKey}` },
    payload: { name: 'Test Agent', dailyBudget: opts.agentDailyBudget ?? '20.00' },
  });
  const agent = agentResp.json();

  const sessionResp = await app.inject({
    method: 'POST',
    url: '/sessions',
    headers: { authorization: `Bearer ${org.apiKey}` },
    payload: { agentId: agent.id, name: 'Test Session', budget: opts.sessionBudget ?? '1.00' },
  });
  const session = sessionResp.json();

  const requirements: PaymentRequirementsWire = {
    scheme: 'exact',
    network: 'eip155:84532',
    amount: BigInt(opts.priceMinor ?? '30000').toString(),
    asset: 'mock:usdc',
    payTo: '0xprovider',
    maxTimeoutSeconds: 60,
  };
  const { server, baseUrl, resourcePath } = startTestProvider(requirements);

  const providerResp = await app.inject({
    method: 'POST',
    url: '/providers',
    headers: { authorization: `Bearer ${org.apiKey}` },
    payload: {
      name: 'Test Provider',
      baseUrl,
      resourcePath,
      category: 'search',
      network: 'eip155:84532',
      configuredPrice: (Number(opts.priceMinor ?? '30000') / 1_000_000).toString(),
      trustStatus: 'TRUSTED',
    },
  });
  const provider = providerResp.json();

  // Agent-scoped keys aren't issued through a public endpoint in this MVP
  // (see README Roadmap) — inserted directly for the authorization test.
  const agentKey = `sk_agent_${crypto.randomUUID().replace(/-/g, '')}`;
  await pool.query('INSERT INTO api_keys (org_id, agent_id, key_hash, label) VALUES ($1, $2, $3, $4)', [
    org.id,
    agent.id,
    hashApiKey(agentKey),
    'Test agent-scoped key',
  ]);

  return {
    orgId: org.id,
    apiKey: org.apiKey,
    agentId: agent.id,
    agentKey,
    sessionId: session.id,
    providerId: provider.id,
    providerServer: server,
  };
}
