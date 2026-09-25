import { DomainError } from '@x402-treasury/shared';
import { getPaymentIntent, runReconciliation } from '@x402-treasury/ledger';
import type { PaymentRail } from '@x402-treasury/x402-adapter';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { authenticate, requireAgentMatch } from '../auth.js';
import { canonicalRequestHash } from '../fingerprint.js';
import { executePayment } from '../payment-flow.js';
import { createMockSettlementOracle } from '../oracle.js';

const CreatePaymentIntentSchema = z.object({
  agentId: z.string().uuid(),
  sessionId: z.string().uuid(),
  providerId: z.string().uuid(),
  simulateUncertainSettlement: z.boolean().optional(),
});

export function registerPaymentRoutes(app: FastifyInstance, pool: Pool, adapter: PaymentRail): void {
  app.post('/payments/intents', async (request, reply) => {
    const auth = await authenticate(pool, request);
    const body = CreatePaymentIntentSchema.parse(request.body);
    requireAgentMatch(auth, body.agentId);

    const idempotencyKey = request.headers['idempotency-key'];
    if (!idempotencyKey || Array.isArray(idempotencyKey)) {
      throw new DomainError('VALIDATION_ERROR', 'the Idempotency-Key header is required for POST /payments/intents');
    }

    // Provider lookup happens inside executePayment, AFTER the idempotency
    // claim — so a conflicting retry (same key, different body) is caught
    // as IDEMPOTENCY_CONFLICT even if the body also references a bogus
    // providerId, rather than a misleading NOT_FOUND masking the real
    // conflict.
    const result = await executePayment(pool, adapter, {
      orgId: auth.orgId,
      agentId: body.agentId,
      sessionBudgetId: body.sessionId,
      providerId: body.providerId,
      idempotencyKey,
      requestHash: canonicalRequestHash(body),
      simulateUncertainSettlement: body.simulateUncertainSettlement,
    });

    reply.status(result.httpStatus).send(result.body);
  });

  app.get('/payments/intents/:id', async (request, reply) => {
    await authenticate(pool, request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const intent = await getPaymentIntent(pool, id);
    const { rows: transitions } = await pool.query(
      'SELECT from_state, to_state, reason, created_at FROM payment_state_transitions WHERE payment_intent_id = $1 ORDER BY created_at',
      [id],
    );
    reply.send({
      id: intent.id,
      state: intent.state,
      amountMinor: intent.amountMinor.toString(),
      asset: intent.asset,
      network: intent.network,
      providerId: intent.providerId,
      sessionBudgetId: intent.sessionBudgetId,
      settlementTxHash: intent.settlementTxHash,
      failureReason: intent.failureReason,
      transitions,
    });
  });

  app.get('/ledger', async (request, reply) => {
    const auth = await authenticate(pool, request);
    const { rows } = await pool.query(
      `SELECT le.* FROM ledger_entries le JOIN budgets b ON b.id = le.budget_id
       WHERE b.org_id = $1 ORDER BY le.created_at DESC LIMIT 200`,
      [auth.orgId],
    );
    reply.send({ entries: rows });
  });

  app.get('/sessions/:id/ledger', async (request, reply) => {
    await authenticate(pool, request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { rows } = await pool.query(
      'SELECT * FROM ledger_entries WHERE budget_id = $1 ORDER BY created_at DESC LIMIT 200',
      [id],
    );
    reply.send({ entries: rows });
  });

  app.post('/reconciliation/run', async (request, reply) => {
    await authenticate(pool, request);
    const outcomes = await runReconciliation(pool, createMockSettlementOracle(pool));
    reply.send({ outcomes });
  });
}
