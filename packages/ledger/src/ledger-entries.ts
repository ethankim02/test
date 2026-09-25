import type { PoolClient } from 'pg';
import type { LedgerEntryType } from './types.js';

export interface InsertLedgerEntryParams {
  ledgerTransactionId: string;
  budgetId: string;
  entryType: LedgerEntryType;
  /**
   * Signed relative to `available_minor` for ALLOCATE/RESERVE/RELEASE/EXPIRE
   * (negative = available decreased, positive = available increased). For
   * CAPTURE, `available_minor` does not change (the amount was already
   * removed from available at RESERVE time) — CAPTURE instead records the
   * positive amount moved from reserved into spent, and `balanceAfterMinor`
   * is still `available_minor` after the entry (unchanged), recorded for
   * audit consistency with every other entry type.
   */
  amountMinor: bigint;
  balanceAfterMinor: bigint;
  reservationId?: string | undefined;
}

export async function insertLedgerEntry(
  client: PoolClient,
  params: InsertLedgerEntryParams,
): Promise<void> {
  await client.query(
    `INSERT INTO ledger_entries
       (ledger_transaction_id, budget_id, entry_type, amount_minor, balance_after_minor, reservation_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      params.ledgerTransactionId,
      params.budgetId,
      params.entryType,
      params.amountMinor.toString(),
      params.balanceAfterMinor.toString(),
      params.reservationId ?? null,
    ],
  );
}
