import { DomainError } from '@x402-treasury/shared';
import type { Pool } from 'pg';
import {
  mapBudgetRow,
  mapReservationRow,
  type BudgetRow,
  type RawBudgetRow,
  type RawReservationRow,
  type ReservationRow,
} from './types.js';

export async function getBudget(pool: Pool, budgetId: string): Promise<BudgetRow> {
  const { rows } = await pool.query<RawBudgetRow>('SELECT * FROM budgets WHERE id = $1', [
    budgetId,
  ]);
  const row = rows[0];
  if (!row) throw new DomainError('NOT_FOUND', `budget ${budgetId} not found`);
  return mapBudgetRow(row);
}

export async function getReservation(pool: Pool, reservationId: string): Promise<ReservationRow> {
  const { rows } = await pool.query<RawReservationRow>('SELECT * FROM reservations WHERE id = $1', [
    reservationId,
  ]);
  const row = rows[0];
  if (!row) throw new DomainError('NOT_FOUND', `reservation ${reservationId} not found`);
  return mapReservationRow(row);
}

export interface LedgerEntrySummary {
  entryType: string;
  amountMinor: bigint;
  balanceAfterMinor: bigint;
  createdAt: Date;
}

export async function getLedgerHistory(
  pool: Pool,
  budgetId: string,
  limit = 100,
): Promise<LedgerEntrySummary[]> {
  const { rows } = await pool.query<{
    entry_type: string;
    amount_minor: string;
    balance_after_minor: string;
    created_at: Date;
  }>(
    `SELECT entry_type, amount_minor, balance_after_minor, created_at
     FROM ledger_entries WHERE budget_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [budgetId, limit],
  );
  return rows.map((r) => ({
    entryType: r.entry_type,
    amountMinor: BigInt(r.amount_minor),
    balanceAfterMinor: BigInt(r.balance_after_minor),
    createdAt: r.created_at,
  }));
}
