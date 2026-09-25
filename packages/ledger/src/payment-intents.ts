import { DomainError } from '@x402-treasury/shared';
import type { Pool, PoolClient } from 'pg';
import { assertLegalTransition, type PaymentIntentState } from './state-machine.js';
import { withTransaction } from './tx.js';

export interface PaymentIntentRow {
  id: string;
  orgId: string;
  agentId: string;
  sessionBudgetId: string;
  providerId: string;
  reservationId: string | null;
  idempotencyKeyId: string | null;
  routingDecisionId: string | null;
  amountMinor: bigint;
  asset: string;
  network: string;
  state: PaymentIntentState;
  failureReason: string | null;
  settlementTxHash: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface RawPaymentIntentRow {
  id: string;
  org_id: string;
  agent_id: string;
  session_budget_id: string;
  provider_id: string;
  reservation_id: string | null;
  idempotency_key_id: string | null;
  routing_decision_id: string | null;
  amount_minor: string;
  asset: string;
  network: string;
  state: PaymentIntentState;
  failure_reason: string | null;
  settlement_tx_hash: string | null;
  created_at: Date;
  updated_at: Date;
}

function mapRow(r: RawPaymentIntentRow): PaymentIntentRow {
  return {
    id: r.id,
    orgId: r.org_id,
    agentId: r.agent_id,
    sessionBudgetId: r.session_budget_id,
    providerId: r.provider_id,
    reservationId: r.reservation_id,
    idempotencyKeyId: r.idempotency_key_id,
    routingDecisionId: r.routing_decision_id,
    amountMinor: BigInt(r.amount_minor),
    asset: r.asset,
    network: r.network,
    state: r.state,
    failureReason: r.failure_reason,
    settlementTxHash: r.settlement_tx_hash,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface CreatePaymentIntentParams {
  orgId: string;
  agentId: string;
  sessionBudgetId: string;
  providerId: string;
  amountMinor: bigint;
  asset?: string;
  network: string;
  idempotencyKeyId?: string | undefined;
}

/** Creates a payment intent in CREATED state. Does not evaluate policy or reserve funds. */
export async function createPaymentIntent(pool: Pool, params: CreatePaymentIntentParams): Promise<PaymentIntentRow> {
  const { rows } = await pool.query<RawPaymentIntentRow>(
    `INSERT INTO payment_intents
       (org_id, agent_id, session_budget_id, provider_id, amount_minor, asset, network, state, idempotency_key_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'CREATED', $8)
     RETURNING *`,
    [
      params.orgId,
      params.agentId,
      params.sessionBudgetId,
      params.providerId,
      params.amountMinor.toString(),
      params.asset ?? 'USDC',
      params.network,
      params.idempotencyKeyId ?? null,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('payment intent insert returned no row');
  const intent = mapRow(row);
  await pool.query(`INSERT INTO payment_state_transitions (payment_intent_id, from_state, to_state) VALUES ($1, NULL, 'CREATED')`, [
    intent.id,
  ]);
  return intent;
}

export async function getPaymentIntent(pool: Pool, id: string): Promise<PaymentIntentRow> {
  const { rows } = await pool.query<RawPaymentIntentRow>('SELECT * FROM payment_intents WHERE id = $1', [id]);
  const row = rows[0];
  if (!row) throw new DomainError('NOT_FOUND', `payment intent ${id} not found`);
  return mapRow(row);
}

export interface TransitionOptions {
  reason?: string;
  /** Extra columns to set atomically with the transition, e.g. reservationId, settlementTxHash. */
  patch?: Partial<
    Pick<PaymentIntentRow, 'reservationId' | 'routingDecisionId' | 'failureReason' | 'settlementTxHash'>
  >;
}

/**
 * Validates and applies a state transition inside one transaction, writing
 * the corresponding `payment_state_transitions` audit row. Callers that
 * need the transition to happen atomically with a ledger effect (e.g.
 * APPROVED -> RESERVED alongside the reservation insert) should pass an
 * existing `client` from their own `withTransaction` block instead of
 * letting this open its own.
 */
export async function transitionPaymentIntent(
  poolOrClient: Pool | PoolClient,
  id: string,
  toState: PaymentIntentState,
  options: TransitionOptions = {},
): Promise<PaymentIntentRow> {
  const run = async (client: PoolClient | Pool): Promise<PaymentIntentRow> => {
    const { rows } = await client.query<RawPaymentIntentRow>(
      'SELECT * FROM payment_intents WHERE id = $1 FOR UPDATE',
      [id],
    );
    const row = rows[0];
    if (!row) throw new DomainError('NOT_FOUND', `payment intent ${id} not found`);
    const current = mapRow(row);

    assertLegalTransition(current.state, toState);

    const patch = options.patch ?? {};
    const { rows: updatedRows } = await client.query<RawPaymentIntentRow>(
      `UPDATE payment_intents
       SET state = $1,
           reservation_id = COALESCE($2, reservation_id),
           routing_decision_id = COALESCE($3, routing_decision_id),
           failure_reason = COALESCE($4, failure_reason),
           settlement_tx_hash = COALESCE($5, settlement_tx_hash),
           updated_at = now()
       WHERE id = $6
       RETURNING *`,
      [
        toState,
        patch.reservationId ?? null,
        patch.routingDecisionId ?? null,
        patch.failureReason ?? null,
        patch.settlementTxHash ?? null,
        id,
      ],
    );
    const updatedRow = updatedRows[0];
    if (!updatedRow) throw new Error('payment intent update returned no row');

    await client.query(
      'INSERT INTO payment_state_transitions (payment_intent_id, from_state, to_state, reason) VALUES ($1, $2, $3, $4)',
      [id, current.state, toState, options.reason ?? null],
    );

    return mapRow(updatedRow);
  };

  // Duck-type: a PoolClient has `release`, a Pool doesn't.
  if ('release' in poolOrClient) {
    return run(poolOrClient);
  }
  return withTransaction(poolOrClient, (client) => run(client));
}
