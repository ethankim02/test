import type { Clock } from '@x402-treasury/shared';
import { systemClock } from '@x402-treasury/shared';
import type { Pool } from 'pg';
import { transitionPaymentIntent } from './payment-intents.js';
import { captureReservation, releaseReservation } from './settle-reservation.js';

export interface ReconciliationOutcome {
  paymentIntentId: string;
  resolution: 'REPAIRED' | 'MARKED_FOR_REVIEW' | 'CONFIRMED_SETTLED' | 'CONFIRMED_FAILED';
  detail: string;
}

/**
 * A minimal authoritative settlement lookup. The mock adapter (used in
 * CI/tests) can answer definitively from its own in-memory ledger; a real
 * facilitator-backed adapter would re-query `/verify` or chain state for
 * the tx hash. Reconciliation depends only on this interface, never on a
 * concrete adapter, so it stays testable without any real x402 plumbing.
 */
export interface SettlementOracle {
  /** Returns the authoritative outcome for a SETTLING/RECONCILIATION_REQUIRED intent, or 'UNKNOWN' if it cannot be determined right now. */
  lookup(paymentIntentId: string): Promise<'SETTLED' | 'FAILED' | 'UNKNOWN'>;
}

async function recordReconciliation(
  pool: Pool,
  paymentIntentId: string,
  previousState: string,
  resolution: ReconciliationOutcome['resolution'],
  detail: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO reconciliation_records (payment_intent_id, previous_state, resolution, detail) VALUES ($1, $2, $3, $4)`,
    [paymentIntentId, previousState, resolution, detail],
  );
}

/**
 * Scans for the two patterns of uncertain payment state described in
 * docs/ARCHITECTURE.md §7:
 *
 * 1. Intents stuck in RECONCILIATION_REQUIRED (facilitator returned
 *    settlement_pending, or a client-side timeout while awaiting
 *    settlement) — resolved by asking the settlement oracle.
 * 2. Intents that reached FAILED but whose reservation is still ACTIVE
 *    (crash between the state transition and the reservation release) —
 *    repaired by releasing the reservation now.
 *
 * Every outcome is recorded in `reconciliation_records`, never silently
 * applied — see task principle H / the project's "never silently mutate
 * financial state" rule.
 */
export async function runReconciliation(
  pool: Pool,
  oracle: SettlementOracle,
  clock: Clock = systemClock,
): Promise<ReconciliationOutcome[]> {
  const outcomes: ReconciliationOutcome[] = [];

  // Pattern 1: uncertain settlement outcome.
  const { rows: uncertain } = await pool.query<{ id: string }>(
    `SELECT id FROM payment_intents WHERE state = 'RECONCILIATION_REQUIRED'`,
  );
  for (const { id } of uncertain) {
    const result = await oracle.lookup(id);
    if (result === 'UNKNOWN') {
      await recordReconciliation(pool, id, 'RECONCILIATION_REQUIRED', 'MARKED_FOR_REVIEW', 'settlement oracle could not determine outcome');
      outcomes.push({ paymentIntentId: id, resolution: 'MARKED_FOR_REVIEW', detail: 'settlement oracle could not determine outcome' });
      continue;
    }
    // Each step below is its own transaction (transitionPaymentIntent and
    // capture/releaseReservation each open one via `pool`) rather than one
    // nested transaction spanning both — the reservation/budget-chain
    // locks and the payment_intents row lock are acquired by separate
    // connections, and serializing them into separate short transactions
    // avoids holding the intent row locked while a second connection does
    // unrelated work.
    const intent = await transitionPaymentIntent(pool, id, result === 'SETTLED' ? 'SETTLED' : 'FAILED', {
      reason: `reconciliation: oracle reported ${result}`,
    });
    if (intent.reservationId) {
      if (result === 'SETTLED') {
        await captureReservation(pool, intent.reservationId, clock);
      } else {
        await releaseReservation(pool, intent.reservationId, clock);
        await transitionPaymentIntent(pool, id, 'RESERVATION_RELEASED', {
          reason: 'reconciliation: released reservation after confirmed failure',
        });
      }
    }
    const resolution = result === 'SETTLED' ? 'CONFIRMED_SETTLED' : 'CONFIRMED_FAILED';
    await recordReconciliation(pool, id, 'RECONCILIATION_REQUIRED', resolution, `settlement oracle reported ${result}`);
    outcomes.push({ paymentIntentId: id, resolution, detail: `settlement oracle reported ${result}` });
  }

  // Pattern 2: decided FAILED but the reservation was never confirmed released
  // (process crash between the two writes).
  const { rows: staleFailed } = await pool.query<{ id: string; reservation_id: string }>(
    `SELECT pi.id, pi.reservation_id
     FROM payment_intents pi
     JOIN reservations r ON r.id = pi.reservation_id
     WHERE pi.state = 'FAILED' AND r.status = 'ACTIVE'`,
  );
  for (const row of staleFailed) {
    await releaseReservation(pool, row.reservation_id, clock);
    await transitionPaymentIntent(pool, row.id, 'RESERVATION_RELEASED', {
      reason: 'reconciliation: repaired orphaned ACTIVE reservation on a FAILED intent',
    });
    await recordReconciliation(
      pool,
      row.id,
      'FAILED',
      'REPAIRED',
      `reservation ${row.reservation_id} was still ACTIVE after intent failed; released it`,
    );
    outcomes.push({
      paymentIntentId: row.id,
      resolution: 'REPAIRED',
      detail: `reservation ${row.reservation_id} was still ACTIVE after intent failed; released it`,
    });
  }

  return outcomes;
}
