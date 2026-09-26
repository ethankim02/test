import type { PaymentRail } from '@x402-treasury/x402-adapter';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { registerErrorHandler } from './errors.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerPaymentRoutes } from './routes/payments.js';
import { registerRoutingRoutes } from './routes/routing.js';

export interface BuildAppOptions {
  pool: Pool;
  adapter: PaymentRail;
  logger?: boolean | Record<string, unknown>;
}

/**
 * Builds (but does not start listening) a Fastify instance with every
 * route registered. Separated from `index.ts` so integration tests can
 * exercise the whole API in-process via `app.inject()` — real Postgres,
 * no HTTP server, no port binding.
 */
export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true });

  registerErrorHandler(app);
  registerAdminRoutes(app, options.pool);
  registerPaymentRoutes(app, options.pool, options.adapter);
  registerRoutingRoutes(app, options.pool);

  app.get('/health', async () => ({ status: 'ok' }));

  return app;
}
