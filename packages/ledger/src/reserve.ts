import { DomainError, type Clock, systemClock } from '@x402-treasury/shared';
import type { Pool, PoolClient } from 'pg';
import { lockBudgetChain } from './ancestor-chain.js';
import { insertLedgerEntry } from './ledger-entries.js';
import { withTransaction } from './tx.js';
import { mapReservationRow, type RawReservationRow, type ReservationRow } from './types.js';

export interface ReserveBudgetParams {
  leafBudgetId: string;
  agentId: string;
  amountMinor: bigint;
  /** How long the reservation stays ACTIVE before the expiry sweep releases it. */
  ttlSeconds: number;
  clock?: Clock;
}

/**
 * Atomically reserves `amountMinor` against `leafBudgetId` AND every
 * ancestor budget on its path (task -> agent -> org), or fails the whole
 * operation with `INSUFFICIENT_BUDGET` if any level lacks capacity. This
 * is the operation the mandatory concurrency test exercises directly: see
 * docs/ARCHITECTURE.md §4.4.
 */
export async function reserveBudget(
  pool: Pool,
  params: ReserveBudgetParams,
): Promise<ReservationRow> {
  const clock = params.clock ?? systemClock;
  return withTransaction(pool, async (client) => {
    const chain = await lockBudgetChain(client, params.leafBudgetId);

    for (const budget of chain) {
      if (budget.availableMinor < params.amountMinor) {
        throw new DomainError(
          'INSUFFICIENT_BUDGET',
          `budget "${budget.name}" (${budget.id}) has ${budget.availableMinor} minor units available, ` +
            `requested ${params.amountMinor}`,
          {
            details: {
              budgetId: budget.id,
              availableMinor: budget.availableMinor.toString(),
              requestedMinor: params.amountMinor.toString(),
            },
          },
        );
      }
    }

    const expiresAt = new Date(clock.now().getTime() + params.ttlSeconds * 1000);
    const { rows: reservationRows } = await client.query<RawReservationRow>(
      `INSERT INTO reservations (leaf_budget_id, agent_id, amount_minor, status, expires_at)
       VALUES ($1, $2, $3, 'ACTIVE', $4)
       RETURNING *`,
      [params.leafBudgetId, params.agentId, params.amountMinor.toString(), expiresAt.toISOString()],
    );
    const reservationRow = reservationRows[0];
    if (!reservationRow) throw new Error('reservation insert returned no row');
    const reservation = mapReservationRow(reservationRow);

    const ledgerTransactionId = crypto.randomUUID();
    for (const budget of chain) {
      const newAvailable = budget.availableMinor - params.amountMinor;
      const newReserved = budget.reservedMinor + params.amountMinor;
      await client.query(
        'UPDATE budgets SET available_minor = $1, reserved_minor = $2 WHERE id = $3',
        [newAvailable.toString(), newReserved.toString(), budget.id],
      );
      await insertLedgerEntry(client, {
        ledgerTransactionId,
        budgetId: budget.id,
        entryType: 'RESERVE',
        amountMinor: -params.amountMinor,
        balanceAfterMinor: newAvailable,
        reservationId: reservation.id,
      });
    }

    return reservation;
  });
}

/** Locks and returns a single reservation row by id, or throws NOT_FOUND. */
export async function getReservationForUpdate(
  client: PoolClient,
  reservationId: string,
): Promise<ReservationRow> {
  const { rows } = await client.query<RawReservationRow>(
    'SELECT * FROM reservations WHERE id = $1 FOR UPDATE',
    [reservationId],
  );
  const row = rows[0];
  if (!row) throw new DomainError('NOT_FOUND', `reservation ${reservationId} not found`);
  return mapReservationRow(row);
}
