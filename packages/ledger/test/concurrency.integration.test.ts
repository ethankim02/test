import { DomainError } from '@x402-treasury/shared';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getBudget } from '../src/read.js';
import { reserveBudget } from '../src/reserve.js';
import { resetTestDatabase, setupTestDatabase } from './setup.js';
import { createTestHierarchy } from './helpers.js';

/**
 * Mandatory scenario (task spec §10 / §40 Scenario C): budget remaining
 * $1.00, ten independent, genuinely concurrent requests for $0.50 each.
 * Exactly two may succeed; the other eight must fail deterministically
 * with INSUFFICIENT_BUDGET; the budget must never go negative. This is
 * the test that proves the `SELECT ... FOR UPDATE` root-to-leaf locking
 * strategy in docs/ARCHITECTURE.md §4.4 actually holds under real
 * concurrent load against real Postgres — not simulated, not mocked.
 */
describe('concurrent reservations against a shared budget', () => {
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

  it('allows exactly 2 of 10 concurrent $0.50 reservations against a $1.00 budget, never going negative', async () => {
    const { sessionBudget } = await createTestHierarchy(pool, {
      org: 100_000_000n,
      agent: 20_000_000n,
      session: 1_000_000n, // $1.00
    });

    const attempts = Array.from({ length: 10 }, () =>
      reserveBudget(pool, {
        leafBudgetId: sessionBudget.id,
        agentId: sessionBudget.agentId!,
        amountMinor: 500_000n, // $0.50
        ttlSeconds: 60,
      }),
    );

    const results = await Promise.allSettled(attempts);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(2);
    expect(rejected).toHaveLength(8);

    for (const r of rejected) {
      if (r.status !== 'rejected') continue;
      expect(r.reason).toBeInstanceOf(DomainError);
      expect((r.reason as DomainError).code).toBe('INSUFFICIENT_BUDGET');
    }

    const finalBudget = await getBudget(pool, sessionBudget.id);
    expect(finalBudget.availableMinor).toBe(0n);
    expect(finalBudget.reservedMinor).toBe(1_000_000n);
    expect(finalBudget.spentMinor).toBe(0n);
    // The invariant the DB CHECK constraint also enforces, re-verified at the app level:
    expect(finalBudget.availableMinor + finalBudget.reservedMinor + finalBudget.spentMinor).toBe(
      finalBudget.allocatedMinor,
    );
    expect(finalBudget.availableMinor).toBeGreaterThanOrEqual(0n);
  });

  it('also enforces the invariant at every ancestor level simultaneously', async () => {
    // Two sibling sessions under the same agent, agent budget too small for both to fully succeed.
    const {
      agentBudget,
      sessionBudget: sessionA,
      orgBudget,
    } = await createTestHierarchy(pool, {
      org: 100_000_000n,
      agent: 1_000_000n, // $1.00 — the actual binding constraint
      session: 1_000_000n, // each session individually allows $1.00
    });

    const { rows: sessionBRows } = await pool.query<{ id: string }>(
      `INSERT INTO budgets (org_id, agent_id, parent_budget_id, scope, name, period, allocated_minor, available_minor)
       VALUES ($1, $2, $3, 'SESSION', 'Session B', 'TOTAL', 1000000, 1000000) RETURNING id`,
      [sessionA.orgId, sessionA.agentId, agentBudget.id],
    );
    const sessionBId = sessionBRows[0]!.id;

    const [resultA, resultB] = await Promise.allSettled([
      reserveBudget(pool, {
        leafBudgetId: sessionA.id,
        agentId: sessionA.agentId!,
        amountMinor: 700_000n,
        ttlSeconds: 60,
      }),
      reserveBudget(pool, {
        leafBudgetId: sessionBId,
        agentId: sessionA.agentId!,
        amountMinor: 700_000n,
        ttlSeconds: 60,
      }),
    ]);

    const outcomes = [resultA.status, resultB.status];
    // Both can't succeed ($0.70 + $0.70 > $1.00 agent-level capacity), so at least one must fail.
    expect(outcomes.includes('rejected')).toBe(true);

    const finalAgent = await getBudget(pool, agentBudget.id);
    expect(finalAgent.availableMinor).toBeGreaterThanOrEqual(0n);
    expect(finalAgent.availableMinor + finalAgent.reservedMinor + finalAgent.spentMinor).toBe(
      finalAgent.allocatedMinor,
    );

    const finalOrg = await getBudget(pool, orgBudget.id);
    expect(finalOrg.availableMinor).toBeGreaterThanOrEqual(0n);
  });
});
