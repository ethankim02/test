import Fastify, { type FastifyInstance } from 'fastify';
import { mockSettle } from './mock-facilitator.js';
import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  decodeHeader,
  encodeHeader,
  type PaymentPayloadWire,
  type PaymentRequiredWire,
  type PaymentRequirementsWire,
} from './wire.js';

export interface DemoTier {
  /** Route path this tier is served on, e.g. "/research". */
  path: string;
  /** Human label returned in the resource body, for terminal-output clarity. */
  label: string;
  priceMinor: bigint;
  /** Artificial network latency before responding, in ms — for routing demos. */
  latencyMs: number;
  /** Probability (0..1) the resource is available at all this request. Unreliability is modeled as a 503 BEFORE any payment is requested or taken — this demo never charges for a failed request. */
  successRate: number;
  payTo: string;
  network: string;
  asset?: string;
  /** Deterministic response body generator, given the query string. Marked clearly as demo data — never described as real external data (task §21). */
  respond: (query: Record<string, string>) => Record<string, unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Builds a standalone Fastify app that speaks real x402 v2 HTTP semantics
 * (PAYMENT-REQUIRED / PAYMENT-SIGNATURE headers, real 402 status) for one
 * or more priced "tiers," settling through the mock facilitator
 * (mock-facilitator.ts — NOT a real blockchain). Used by
 * apps/demo-provider-a and apps/demo-provider-b; kept here rather than
 * duplicated in each app because it IS x402 protocol server-side
 * plumbing, the natural sibling of this package's client-side adapter and
 * the mock facilitator it already owns.
 */
export function createDemoResourceServer(tiers: DemoTier[]): FastifyInstance {
  const app = Fastify({ logger: true });

  for (const tier of tiers) {
    const requirements: PaymentRequirementsWire = {
      scheme: 'exact',
      network: tier.network,
      amount: tier.priceMinor.toString(),
      asset: tier.asset ?? 'mock:usdc',
      payTo: tier.payTo,
      maxTimeoutSeconds: 60,
    };

    app.get(tier.path, async (request, reply) => {
      await sleep(tier.latencyMs);

      if (Math.random() > tier.successRate) {
        reply.status(503).send({ error: `${tier.label} is simulating unavailability this request (demo unreliability model)` });
        return;
      }

      const sigHeader = request.headers[PAYMENT_SIGNATURE_HEADER.toLowerCase()];
      if (!sigHeader || Array.isArray(sigHeader)) {
        const required: PaymentRequiredWire = { x402Version: 2, accepts: [requirements] };
        reply.status(402).header(PAYMENT_REQUIRED_HEADER, encodeHeader(required)).send({ error: 'payment required', tier: tier.label });
        return;
      }

      const payload = decodeHeader<PaymentPayloadWire>(sigHeader);
      const settlement = mockSettle(payload, requirements);
      if (!settlement.success) {
        reply.status(402).send({ error: settlement.errorReason });
        return;
      }

      const query = request.query as Record<string, string>;
      reply
        .status(200)
        .header('x-mock-settlement-tx', settlement.transaction!)
        .send({ ...tier.respond(query), _demo: true, _mockPaymentMode: true });
    });
  }

  app.get('/health', async () => ({ status: 'ok', tiers: tiers.map((t) => ({ path: t.path, label: t.label })) }));

  return app;
}
