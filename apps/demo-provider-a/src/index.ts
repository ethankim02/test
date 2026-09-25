import { createDemoResourceServer, type DemoTier } from '@x402-treasury/x402-adapter';

/**
 * A demo x402-enabled paid resource server. Everything it returns is
 * deterministic, clearly-labeled fake data (`_demo: true` on every
 * response) — never described or usable as real external research data.
 * Payment settlement is via the mock facilitator only; see
 * docs/RESEARCH.md §12 for how a real facilitator would be wired in.
 */
const PORT = Number(process.env['DEMO_PROVIDER_A_PORT'] ?? 4001);
const PAY_TO = process.env['DEMO_PAYTO_ADDRESS'] ?? '0xDemoProviderAPayoutAddress';
const NETWORK = process.env['X402_NETWORK'] ?? 'eip155:84532';

function researchResponse(label: string, query: Record<string, string>): Record<string, unknown> {
  return {
    headline: `Mock research result for "${query['q'] ?? 'AI funding news'}"`,
    source: label,
    findings: [
      'This is deterministic demo data, not a real external API result.',
      `Served by ${label} at ${new Date().toISOString()}.`,
    ],
  };
}

const tiers: DemoTier[] = [
  {
    path: '/research',
    label: 'Provider A (cheap, slow)',
    priceMinor: 10_000n, // $0.01
    latencyMs: 1500,
    successRate: 0.999,
    payTo: PAY_TO,
    network: NETWORK,
    respond: (q) => researchResponse('Provider A (cheap, slow)', q),
  },
  {
    path: '/research-balanced',
    label: 'Provider C (balanced)',
    priceMinor: 15_000n, // $0.015
    latencyMs: 650,
    successRate: 0.95,
    payTo: PAY_TO,
    network: NETWORK,
    respond: (q) => researchResponse('Provider C (balanced)', q),
  },
];

const app = createDemoResourceServer(tiers);
app.log.warn('PAYMENT MODE: MOCK — settlement is simulated, no blockchain is involved.');
await app.listen({ port: PORT, host: '0.0.0.0' });
