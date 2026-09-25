import type { Pool } from 'pg';
import { allocateBudget } from '../src/allocate.js';
import type { BudgetRow } from '../src/types.js';

export interface TestHierarchy {
  orgId: string;
  agentId: string;
  orgBudget: BudgetRow;
  agentBudget: BudgetRow;
  sessionBudget: BudgetRow;
}

/**
 * Creates a minimal org -> agent -> session budget chain for tests, with
 * the given allocations (all in USDC minor units). Mirrors the hierarchy
 * in docs/ARCHITECTURE.md §3.
 */
export async function createTestHierarchy(
  pool: Pool,
  allocations: { org: bigint; agent: bigint; session: bigint },
): Promise<TestHierarchy> {
  const { rows: orgRows } = await pool.query<{ id: string }>(
    "INSERT INTO organizations (name) VALUES ('Test Org') RETURNING id",
  );
  const orgId = orgRows[0]!.id;

  const { rows: agentRows } = await pool.query<{ id: string }>(
    "INSERT INTO agents (org_id, name) VALUES ($1, 'Test Agent') RETURNING id",
    [orgId],
  );
  const agentId = agentRows[0]!.id;

  const orgBudget = await allocateBudget(pool, {
    orgId,
    scope: 'ORG',
    name: 'Org Treasury',
    period: 'DAILY',
    allocatedMinor: allocations.org,
  });

  const agentBudget = await allocateBudget(pool, {
    orgId,
    agentId,
    parentBudgetId: orgBudget.id,
    scope: 'AGENT',
    name: 'Agent Daily Budget',
    period: 'DAILY',
    allocatedMinor: allocations.agent,
  });

  const sessionBudget = await allocateBudget(pool, {
    orgId,
    agentId,
    parentBudgetId: agentBudget.id,
    scope: 'SESSION',
    name: 'Session Budget',
    period: 'TOTAL',
    allocatedMinor: allocations.session,
  });

  return { orgId, agentId, orgBudget, agentBudget, sessionBudget };
}
