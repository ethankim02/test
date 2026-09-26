import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { allocateBudget } from '../src/allocate.js';
import { getBudget } from '../src/read.js';
import { reserveBudget } from '../src/reserve.js';
import { createTestHierarchy } from './helpers.js';
import { resetTestDatabase, setupTestDatabase } from './setup.js';

/**
 * Scenario G and the delegation requirements from task spec §15. Delegated
 * budgets are not a separate mechanism from the budget hierarchy already
 * proven in concurrency/reservation tests — a "delegation" is just another
 * budget node whose parent is another agent's budget. The same
 * SELECT...FOR UPDATE ancestor-chain reservation enforces both "cannot
 * exceed own delegated ceiling" (the CHECK invariant on the child's own
 * row) and "cannot exceed what the parent actually has left" (the
 * ancestor-chain check) simultaneously.
 */
describe('delegated agent budgets', () => {
  let pool: Pool;

  beforeAll(async () => {
    ({ pool } = await setupTestDatabase());
  });
  afterEach(async () => {
    await resetTestDatabase();
  });
  afterAll(async () => {
    await pool.end();
  });

  it('Scenario G: a child cannot spend more than its delegated amount even if the parent has capacity', async () => {
    const { orgId, agentId, agentBudget } = await createTestHierarchy(pool, {
      org: 100_000_000n,
      agent: 10_000_000n, // parent (Research Agent) has $10 today
      session: 0n, // unused in this test
    });

    const { rows: subAgentRows } = await pool.query<{ id: string }>(
      "INSERT INTO agents (org_id, parent_agent_id, name) VALUES ($1, $2, 'Sub-Agent') RETURNING id",
      [orgId, agentId],
    );
    const subAgentId = subAgentRows[0]!.id;

    const delegatedBudget = await allocateBudget(pool, {
      orgId,
      agentId: subAgentId,
      parentBudgetId: agentBudget.id,
      scope: 'AGENT',
      name: 'Delegated Sub-Agent Budget',
      period: 'TOTAL',
      allocatedMinor: 2_000_000n, // $2.00 delegated, well under the parent's $10 available
    });

    // Spending exactly the delegated amount succeeds.
    await reserveBudget(pool, {
      leafBudgetId: delegatedBudget.id,
      agentId: subAgentId,
      amountMinor: 2_000_000n,
      ttlSeconds: 60,
    });

    // One more minor unit — $2.000001 — must fail, even though the parent
    // agent budget still has $8 available.
    await expect(
      reserveBudget(pool, {
        leafBudgetId: delegatedBudget.id,
        agentId: subAgentId,
        amountMinor: 1n,
        ttlSeconds: 60,
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_BUDGET' });

    const parentAfter = await getBudget(pool, agentBudget.id);
    expect(parentAfter.availableMinor).toBe(8_000_000n); // only the $2 the child actually spent was consumed
  });

  it('supports nested delegation: org -> agent -> sub-agent -> task, debiting all four levels on spend', async () => {
    const { orgId, agentId, orgBudget, agentBudget } = await createTestHierarchy(pool, {
      org: 100_000_000n,
      agent: 20_000_000n,
      session: 0n,
    });
    const { rows: subAgentRows } = await pool.query<{ id: string }>(
      "INSERT INTO agents (org_id, parent_agent_id, name) VALUES ($1, $2, 'Sub-Agent') RETURNING id",
      [orgId, agentId],
    );
    const subAgentId = subAgentRows[0]!.id;
    const subAgentBudget = await allocateBudget(pool, {
      orgId,
      agentId: subAgentId,
      parentBudgetId: agentBudget.id,
      scope: 'AGENT',
      name: 'Sub-Agent Budget',
      period: 'TOTAL',
      allocatedMinor: 5_000_000n,
    });
    const taskBudget = await allocateBudget(pool, {
      orgId,
      agentId: subAgentId,
      parentBudgetId: subAgentBudget.id,
      scope: 'SESSION',
      name: 'Task Budget',
      period: 'TOTAL',
      allocatedMinor: 1_000_000n,
    });

    await reserveBudget(pool, {
      leafBudgetId: taskBudget.id,
      agentId: subAgentId,
      amountMinor: 300_000n,
      ttlSeconds: 60,
    });

    for (const [budget, expectedAvailable] of [
      [taskBudget, 700_000n],
      [subAgentBudget, 4_700_000n],
      [agentBudget, 19_700_000n],
      [orgBudget, 99_700_000n],
    ] as const) {
      const fresh = await getBudget(pool, budget.id);
      expect(fresh.availableMinor).toBe(expectedAvailable);
      expect(fresh.reservedMinor).toBe(300_000n);
    }
  });

  it('cannot allocate a budget under a parent that does not exist (no dangling references, so no cycles)', async () => {
    const { orgId } = await createTestHierarchy(pool, { org: 1_000_000n, agent: 0n, session: 0n });
    await expect(
      allocateBudget(pool, {
        orgId,
        scope: 'SESSION',
        name: 'Orphan',
        period: 'TOTAL',
        allocatedMinor: 100n,
        parentBudgetId: '00000000-0000-0000-0000-000000000000',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('the database itself refuses a budget cycle even if attempted directly via SQL', async () => {
    const { orgBudget, agentBudget } = await createTestHierarchy(pool, {
      org: 1_000_000n,
      agent: 500_000n,
      session: 0n,
    });

    // Attempt to make the org root's parent point at its own descendant —
    // this would only be reachable if a future re-parenting API existed;
    // the trigger from migrations/0002_budget_cycle_guard.sql must still
    // reject it as a last line of defense.
    await expect(
      pool.query('UPDATE budgets SET parent_budget_id = $1 WHERE id = $2', [
        agentBudget.id,
        orgBudget.id,
      ]),
    ).rejects.toThrow(/cycle/i);
  });
});
