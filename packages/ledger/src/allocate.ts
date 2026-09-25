import { DomainError } from '@x402-treasury/shared';
import type { Pool } from 'pg';
import { insertLedgerEntry } from './ledger-entries.js';
import { withTransaction } from './tx.js';
import {
  mapBudgetRow,
  type BudgetPeriod,
  type BudgetRow,
  type BudgetScope,
  type RawBudgetRow,
} from './types.js';

export interface AllocateBudgetParams {
  orgId: string;
  agentId?: string | undefined;
  parentBudgetId?: string | undefined;
  scope: BudgetScope;
  name: string;
  period: BudgetPeriod;
  allocatedMinor: bigint;
  asset?: string;
  expiresAt?: Date | undefined;
}

/**
 * Creates a new budget node (org root, an agent's daily budget, or a
 * session budget) with a single ALLOCATE ledger entry. Deliberately does
 * NOT touch the parent's reserved/available counters — allocation sets a
 * ceiling, it doesn't move capacity out of the parent. See
 * docs/ARCHITECTURE.md §4.3 and ADR-004 for why, and §3 for why this
 * can never introduce a cycle (a child always names an already-existing
 * parent id; there is no re-parenting operation).
 */
export async function allocateBudget(pool: Pool, params: AllocateBudgetParams): Promise<BudgetRow> {
  if (params.allocatedMinor < 0n) {
    throw new DomainError('VALIDATION_ERROR', 'allocatedMinor must be >= 0');
  }
  return withTransaction(pool, async (client) => {
    if (params.parentBudgetId) {
      const { rows } = await client.query('SELECT id FROM budgets WHERE id = $1', [
        params.parentBudgetId,
      ]);
      if (rows.length === 0) {
        throw new DomainError('NOT_FOUND', `parent budget ${params.parentBudgetId} not found`);
      }
    }

    const { rows } = await client.query<RawBudgetRow>(
      `INSERT INTO budgets
         (org_id, agent_id, parent_budget_id, scope, name, period, asset, allocated_minor, available_minor, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9)
       RETURNING *`,
      [
        params.orgId,
        params.agentId ?? null,
        params.parentBudgetId ?? null,
        params.scope,
        params.name,
        params.period,
        params.asset ?? 'USDC',
        params.allocatedMinor.toString(),
        params.expiresAt?.toISOString() ?? null,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('budget insert returned no row');
    const budget = mapBudgetRow(row);

    await insertLedgerEntry(client, {
      ledgerTransactionId: crypto.randomUUID(),
      budgetId: budget.id,
      entryType: 'ALLOCATE',
      amountMinor: params.allocatedMinor,
      balanceAfterMinor: params.allocatedMinor,
    });

    return budget;
  });
}
