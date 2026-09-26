import Fastify from 'fastify';
import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server';
import type { Network } from '@x402/core/types';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { paymentMiddleware } from '@x402/fastify';

/**
 * REAL x402 resource server — genuinely protected by the official public
 * x402 facilitator, not the project's in-memory mock. This is the ONE
 * real paid endpoint in the repo, used only to attempt a genuine Base
 * Sepolia settlement (see docs/DEMO.md). Every other demo provider
 * (`src/index.ts`) uses the mock facilitator and settles nothing on-chain.
 *
 * This process never touches a private key: the resource server only
 * needs its own public payout address (`payTo`). The private key
 * belongs to the *payer* (Treasury's RealX402Adapter / demo-agent),
 * supplied there via X402_PAYER_PRIVATE_KEY and never read here.
 */
const PORT = Number(process.env['DEMO_PROVIDER_A_REAL_PORT'] ?? 4011);
const PAY_TO = process.env['X402_REAL_PAYTO_ADDRESS'];
const NETWORK_RAW = process.env['X402_NETWORK'] ?? 'eip155:84532';
const FACILITATOR_URL = process.env['X402_FACILITATOR_URL'] ?? 'https://x402.org/facilitator';
const PRICE = process.env['X402_REAL_PRICE'] ?? '$0.001';

if (!PAY_TO) {
  throw new Error(
    'X402_REAL_PAYTO_ADDRESS is required to start the real x402 provider ' +
      '(the public address that will receive the settled payment). Refusing to start ' +
      'with a placeholder payout address, since that would misdirect real testnet funds.',
  );
}

if (!NETWORK_RAW.includes(':')) {
  throw new Error(
    `X402_NETWORK must be a CAIP-2 network id ("namespace:reference", e.g. "eip155:84532"), got: ${NETWORK_RAW}`,
  );
}
const NETWORK = NETWORK_RAW as Network;

const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const resourceServer = new x402ResourceServer(facilitatorClient).register(
  NETWORK,
  new ExactEvmScheme(),
);

const app = Fastify();

paymentMiddleware(
  app,
  {
    'GET /real/research': {
      accepts: {
        scheme: 'exact',
        price: PRICE,
        network: NETWORK,
        payTo: PAY_TO,
      },
      description: 'Genuine x402-protected demo research endpoint (real Base Sepolia settlement).',
    },
  },
  resourceServer,
);

app.get('/real/research', async () => ({
  headline: 'Real x402 settlement research result',
  source: 'Provider A (real x402 endpoint)',
  _demo: false,
  _real: true,
  servedAt: new Date().toISOString(),
}));

app.log.warn(
  `PAYMENT MODE: REAL — protected by ${FACILITATOR_URL} on ${NETWORK}. ` +
    'A successful GET /real/research settles a genuine on-chain payment. Do not call this ' +
    'from automated tests or CI.',
);
await app.listen({ port: PORT, host: '0.0.0.0' });
