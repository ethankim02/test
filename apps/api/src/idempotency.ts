import { DomainError } from '@x402-treasury/shared';
import type { Pool } from 'pg';

export interface IdempotencyClaim {
  id: string;
  isNew: boolean;
  paymentIntentId: string | null;
  responseBody: unknown;
}

/**
 * Atomically claims an (agentId, key) pair via a unique-constraint race:
 * the first `INSERT ... ON CONFLICT DO NOTHING` to succeed is the winner
 * and proceeds to actually run the payment flow; every other caller
 * (including true concurrent retries) reads back the winner's row. A
 * different request body under the same key is rejected outright rather
 * than silently reusing the old response. See ADR-006.
 */
export async function claimIdempotencyKey(
  pool: Pool,
  agentId: string,
  key: string,
  requestHash: string,
): Promise<IdempotencyClaim> {
  const inserted = await pool.query<{
    id: string;
    payment_intent_id: string | null;
    response_body: unknown;
  }>(
    `INSERT INTO idempotency_keys (agent_id, key, request_hash, expires_at)
     VALUES ($1, $2, $3, now() + interval '24 hours')
     ON CONFLICT (agent_id, key) DO NOTHING
     RETURNING id, payment_intent_id, response_body`,
    [agentId, key, requestHash],
  );
  const insertedRow = inserted.rows[0];
  if (insertedRow) {
    return {
      id: insertedRow.id,
      isNew: true,
      paymentIntentId: insertedRow.payment_intent_id,
      responseBody: insertedRow.response_body,
    };
  }

  const { rows } = await pool.query<{
    id: string;
    request_hash: string;
    payment_intent_id: string | null;
    response_body: unknown;
  }>(
    'SELECT id, request_hash, payment_intent_id, response_body FROM idempotency_keys WHERE agent_id = $1 AND key = $2',
    [agentId, key],
  );
  const existing = rows[0];
  if (!existing) {
    throw new Error(
      'idempotency key disappeared between insert conflict and read — this should be impossible',
    );
  }
  if (existing.request_hash !== requestHash) {
    throw new DomainError(
      'IDEMPOTENCY_CONFLICT',
      'this Idempotency-Key was already used with a different request payload',
      {
        details: { idempotencyKeyId: existing.id },
      },
    );
  }
  return {
    id: existing.id,
    isNew: false,
    paymentIntentId: existing.payment_intent_id,
    responseBody: existing.response_body,
  };
}

export async function attachPaymentIntent(
  pool: Pool,
  idempotencyKeyId: string,
  paymentIntentId: string,
): Promise<void> {
  await pool.query('UPDATE idempotency_keys SET payment_intent_id = $1 WHERE id = $2', [
    paymentIntentId,
    idempotencyKeyId,
  ]);
}

export async function completeIdempotencyKey(
  pool: Pool,
  idempotencyKeyId: string,
  responseBody: unknown,
): Promise<void> {
  await pool.query(
    `UPDATE idempotency_keys SET status = 'COMPLETED', response_body = $1 WHERE id = $2`,
    [JSON.stringify(responseBody), idempotencyKeyId],
  );
}
