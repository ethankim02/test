import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createPaymentIntent,
  getPaymentIntent,
  transitionPaymentIntent,
} from '../src/payment-intents.js';
import { runReconciliation, type SettlementOracle } from '../src/reconciliation.js';
import { getBudget, getReservation } from '../src/read.js';
import { reserveBudget } from '../src/reserve.js';
import { createTestHierarchy } from './helpers.js';
import { resetTestDatabase, setupTestDatabase } from './setup.js';

async function setUpIntent(pool: Pool) {
  const { orgId, sessionBudget } = await createTestHierarchy(pool, {
    org: 100_000_000n,
    agent: 10_000_000n,
    session: 1_000_000n,
  });
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO providers (org_id, name, base_url, resource_path, category, network, trust_status)
     VALUES ($1, 'P', 'http://localhost:4001', '/x', 'search', 'eip155:84532', 'TRUSTED') RETURNING id`,
    [orgId],
  );
  const providerId = rows[0]!.id;
  const intent = await createPaymentIntent(pool, {
    orgId,
    agentId: sessionBudget.agentId!,
    sessionBudgetId: sessionBudget.id,
    providerId,
    amountMinor: 50_000n,
    network: 'eip155:84532',
  });
  const reservation = await reserveBudget(pool, {
    leafBudgetId: sessionBudget.id,
    agentId: sessionBudget.agentId!,
    amountMinor: 50_000n,
    ttlSeconds: 60,
  });
  await transitionPaymentIntent(pool, intent.id, 'POLICY_EVALUATING');
  await transitionPaymentIntent(pool, intent.id, 'APPROVED');
  await transitionPaymentIntent(pool, intent.id, 'RESERVED', {
    patch: { reservationId: reservation.id },
  });
  await transitionPaymentIntent(pool, intent.id, 'PAYMENT_PREPARED');
  await transitionPaymentIntent(pool, intent.id, 'VERIFYING');
  await transitionPaymentIntent(pool, intent.id, 'SETTLING');
  return { intent, reservation, sessionBudget };
}

describe('reconciliation', () => {
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

  it('Scenario H (settled): resolves RECONCILIATION_REQUIRED to SETTLED when the oracle confirms', async () => {
    const { intent } = await setUpIntent(pool);
    await transitionPaymentIntent(pool, intent.id, 'RECONCILIATION_REQUIRED', {
      reason: 'facilitator returned settlement_pending',
    });

    const oracle: SettlementOracle = { lookup: async () => 'SETTLED' };
    const outcomes = await runReconciliation(pool, oracle);

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      paymentIntentId: intent.id,
      resolution: 'CONFIRMED_SETTLED',
    });
    expect((await getPaymentIntent(pool, intent.id)).state).toBe('SETTLED');
  });

  it('Scenario H (failed): resolves to FAILED and releases the reservation', async () => {
    const { intent, reservation, sessionBudget } = await setUpIntent(pool);
    await transitionPaymentIntent(pool, intent.id, 'RECONCILIATION_REQUIRED');

    const oracle: SettlementOracle = { lookup: async () => 'FAILED' };
    const outcomes = await runReconciliation(pool, oracle);

    expect(outcomes[0]).toMatchObject({
      paymentIntentId: intent.id,
      resolution: 'CONFIRMED_FAILED',
    });
    expect((await getPaymentIntent(pool, intent.id)).state).toBe('RESERVATION_RELEASED');
    expect((await getReservation(pool, reservation.id)).status).toBe('RELEASED');

    const budget = await getBudget(pool, sessionBudget.id);
    expect(budget.availableMinor).toBe(1_000_000n); // fully returned
  });

  it('Scenario H (ambiguous): marks for review and does not guess when the oracle cannot say', async () => {
    const { intent, reservation } = await setUpIntent(pool);
    await transitionPaymentIntent(pool, intent.id, 'RECONCILIATION_REQUIRED');

    const oracle: SettlementOracle = { lookup: async () => 'UNKNOWN' };
    const outcomes = await runReconciliation(pool, oracle);

    expect(outcomes[0]?.resolution).toBe('MARKED_FOR_REVIEW');
    // State must be untouched — no guessing.
    expect((await getPaymentIntent(pool, intent.id)).state).toBe('RECONCILIATION_REQUIRED');
    expect((await getReservation(pool, reservation.id)).status).toBe('ACTIVE');
  });

  it('repairs an orphaned ACTIVE reservation left behind by a crash after FAILED was recorded', async () => {
    const { intent, reservation, sessionBudget } = await setUpIntent(pool);
    // Simulate a crash: the intent was marked FAILED but the process died
    // before releaseReservation ran.
    await transitionPaymentIntent(pool, intent.id, 'FAILED', {
      reason: 'simulated crash before release',
    });

    const oracle: SettlementOracle = { lookup: async () => 'UNKNOWN' }; // irrelevant to this pattern
    const outcomes = await runReconciliation(pool, oracle);

    const repaired = outcomes.find((o) => o.paymentIntentId === intent.id);
    expect(repaired?.resolution).toBe('REPAIRED');
    expect((await getReservation(pool, reservation.id)).status).toBe('RELEASED');
    expect((await getPaymentIntent(pool, intent.id)).state).toBe('RESERVATION_RELEASED');

    const budget = await getBudget(pool, sessionBudget.id);
    expect(budget.availableMinor).toBe(1_000_000n);
  });

  it('records an audit row in reconciliation_records for every outcome', async () => {
    const { intent } = await setUpIntent(pool);
    await transitionPaymentIntent(pool, intent.id, 'RECONCILIATION_REQUIRED');
    await runReconciliation(pool, { lookup: async () => 'SETTLED' });

    const { rows } = await pool.query(
      'SELECT * FROM reconciliation_records WHERE payment_intent_id = $1',
      [intent.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      resolution: 'CONFIRMED_SETTLED',
      previous_state: 'RECONCILIATION_REQUIRED',
    });
  });
});
