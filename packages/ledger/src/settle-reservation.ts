import { DomainError, type Clock, systemClock } from '@x402-treasury/shared';
import type { Pool } from 'pg';
import { lockBudgetChain } from './ancestor-chain.js';
import { getReservationForUpdate } from './reserve.js';
import { insertLedgerEntry } from './ledger-entries.js';
import { withTransaction } from './tx.js';
import type { ReservationRow, ReservationStatus } from './types.js';

export type SettleKind = 'CAPTURE' | 'RELEASE' | 'EXPIRE';

const RESULT_STATUS: Record<SettleKind, ReservationStatus> = {
  CAPTURE: 'CONSUMED',
  RELEASE: 'RELEASED',
  EXPIRE: 'EXPIRED',
};

/**
 * Shared implementation behind `captureReservation`, `releaseReservation`,
 * and the expiry sweep. All three do the same thing structurally: lock the
 * reservation, verify it's still ACTIVE (never double-settle), lock its
 * budget ancestor chain, and fan the effect out to every level — the same
 * hierarchy-wide consumption model reservation itself uses (see
 * docs/ARCHITECTURE.md §4.3). CAPTURE moves reserved -> spent; RELEASE and
 * EXPIRE both move reserved -> available and differ only in the audit
 * label, distinguishing "returned because settlement failed / was
 * released" from "returned because nobody consumed it in time".
 */
export async function settleReservation(
  pool: Pool,
  reservationId: string,
  kind: SettleKind,
  clock: Clock = systemClock,
): Promise<ReservationRow> {
  return withTransaction(pool, async (client) => {
    const reservation = await getReservationForUpdate(client, reservationId);

    if (reservation.status !== 'ACTIVE') {
      throw new DomainError(
        'RESERVATION_NOT_ACTIVE',
        `reservation ${reservationId} is ${reservation.status}, cannot ${kind.toLowerCase()} it`,
        { details: { reservationId, currentStatus: reservation.status, attempted: kind } },
      );
    }

    const chain = await lockBudgetChain(client, reservation.leafBudgetId);
    const ledgerTransactionId = crypto.randomUUID();

    for (const budget of chain) {
      const newReserved = budget.reservedMinor - reservation.amountMinor;
      if (kind === 'CAPTURE') {
        const newSpent = budget.spentMinor + reservation.amountMinor;
        await client.query('UPDATE budgets SET reserved_minor = $1, spent_minor = $2 WHERE id = $3', [
          newReserved.toString(),
          newSpent.toString(),
          budget.id,
        ]);
        await insertLedgerEntry(client, {
          ledgerTransactionId,
          budgetId: budget.id,
          entryType: 'CAPTURE',
          amountMinor: reservation.amountMinor,
          balanceAfterMinor: budget.availableMinor, // unchanged by capture
          reservationId: reservation.id,
        });
      } else {
        const newAvailable = budget.availableMinor + reservation.amountMinor;
        await client.query('UPDATE budgets SET reserved_minor = $1, available_minor = $2 WHERE id = $3', [
          newReserved.toString(),
          newAvailable.toString(),
          budget.id,
        ]);
        await insertLedgerEntry(client, {
          ledgerTransactionId,
          budgetId: budget.id,
          entryType: kind, // RELEASE | EXPIRE
          amountMinor: reservation.amountMinor,
          balanceAfterMinor: newAvailable,
          reservationId: reservation.id,
        });
      }
    }

    const nowIso = clock.now().toISOString();
    await client.query('UPDATE reservations SET status = $1, updated_at = $2 WHERE id = $3', [
      RESULT_STATUS[kind],
      nowIso,
      reservation.id,
    ]);

    return { ...reservation, status: RESULT_STATUS[kind] };
  });
}

export const captureReservation = (pool: Pool, reservationId: string, clock?: Clock) =>
  settleReservation(pool, reservationId, 'CAPTURE', clock);

export const releaseReservation = (pool: Pool, reservationId: string, clock?: Clock) =>
  settleReservation(pool, reservationId, 'RELEASE', clock);
