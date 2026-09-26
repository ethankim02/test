import { createDemoResourceServer, type DemoTier } from '@x402-treasury/x402-adapter';

/**
 * Second demo provider: same capability as demo-provider-a, priced
 * higher but with lower latency — exists specifically so the router
 * (packages/router) has a real tradeoff to demonstrate. All response
 * data is deterministic and clearly fake (`_demo: true`).
 */
const PORT = Number(process.env['DEMO_PROVIDER_B_PORT'] ?? 4002);
const PAY_TO = process.env['DEMO_PAYTO_ADDRESS'] ?? '0xDemoProviderBPayoutAddress';
const NETWORK = process.env['X402_NETWORK'] ?? 'eip155:84532';

const tiers: DemoTier[] = [
  {
    path: '/research',
    label: 'Provider B (expensive, fast)',
    priceMinor: 30_000n, // $0.03
    latencyMs: 300,
    successRate: 0.995,
    payTo: PAY_TO,
    network: NETWORK,
    respond: (q) => ({
      headline: `Mock research result for "${q['q'] ?? 'AI funding news'}"`,
      source: 'Provider B (expensive, fast)',
      findings: [
        'This is deterministic demo data, not a real external API result.',
        `Served by Provider B (expensive, fast) at ${new Date().toISOString()}.`,
      ],
    }),
  },
];

const app = createDemoResourceServer(tiers);
app.log.warn('PAYMENT MODE: MOCK — settlement is simulated, no blockchain is involved.');
await app.listen({ port: PORT, host: '0.0.0.0' });
