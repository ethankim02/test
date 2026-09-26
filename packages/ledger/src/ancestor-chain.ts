import { DomainError } from '@x402-treasury/shared';
import type { PoolClient } from 'pg';
import { mapBudgetRow, type BudgetRow, type RawBudgetRow } from './types.js';

/**
 * Returns the ancestor chain of `leafBudgetId`, ROOT FIRST, LEAF LAST. This
 * is a read-only lookup (no locking) — see `lockBudgetChain` for the
 * locked version used by mutating operations. Kept separate so callers
 * that only need to *read* budget hierarchy (e.g. the API's session
 * summary endpoint) don't pay for or hold row locks.
 */
export async function getAncestorChainIds(
  client: PoolClient,
  leafBudgetId: string,
): Promise<string[]> {
  const { rows } = await client.query<{ id: string; depth: number }>(
    `WITH RECURSIVE chain AS (
       SELECT id, parent_budget_id, 0 AS depth FROM budgets WHERE id = $1
       UNION ALL
       SELECT b.id, b.parent_budget_id, c.depth + 1
       FROM budgets b
       JOIN chain c ON b.id = c.parent_budget_id
     )
     SELECT id, depth FROM chain ORDER BY depth DESC`,
    [leafBudgetId],
  );
  if (rows.length === 0) {
    throw new DomainError('NOT_FOUND', `budget ${leafBudgetId} not found`);
  }
  return rows.map((r) => r.id);
}

/**
 * Locks every budget on the ancestor path of `leafBudgetId`, ROOT FIRST,
 * inside the caller's transaction (`client` must already be inside
 * BEGIN...COMMIT — see tx.ts), and returns them root-first.
 *
 * The root-first order is what makes this deadlock-free: any two
 * concurrent transactions that touch overlapping paths in this budget tree
 * (e.g. two sibling sessions under the same agent) always lock their
 * shared ancestors (agent, org) in the same relative order before either
 * one reaches a row the other doesn't also need. See docs/ARCHITECTURE.md
 * §4.4 and docs/DECISIONS.md ADR-005.
 *
 * Locks are acquired one row at a time (not a single `WHERE id = ANY(...)`
 * query) specifically so the acquisition order is exactly the order this
 * function iterates, not whatever order the query planner happens to pick.
 */
export async function lockBudgetChain(
  client: PoolClient,
  leafBudgetId: string,
): Promise<BudgetRow[]> {
  const ids = await getAncestorChainIds(client, leafBudgetId);
  const locked: BudgetRow[] = [];
  for (const id of ids) {
    const { rows } = await client.query<RawBudgetRow>(
      'SELECT * FROM budgets WHERE id = $1 FOR UPDATE',
      [id],
    );
    const row = rows[0];
    if (!row) {
      throw new DomainError('NOT_FOUND', `budget ${id} disappeared mid-transaction`);
    }
    locked.push(mapBudgetRow(row));
  }
  return locked;
}
