import type { DomainError } from '@x402-treasury/shared';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sweepExpiredReservations } from '../src/expire-sweep.js';
import { createPaymentIntent, getPaymentIntent, transitionPaymentIntent } from '../src/payment-intents.js';
import { getBudget, getReservation } from '../src/read.js';
import { reserveBudget } from '../src/reserve.js';
import { captureReservation, releaseReservation } from '../src/settle-reservation.js';
import { createTestHierarchy } from './helpers.js';
import { resetTestDatabase, setupTestDatabase } from './setup.js';

describe('reservation lifecycle', () => {
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

  it('Scenario A: reserve then capture moves reserved -> spent and leaves the right available balance', async () => {
    const { sessionBudget } = await createTestHierarchy(pool, {
      org: 100_000_000n,
      agent: 10_000_000n,
      session: 1_000_000n, // $1.00
    });

    const reservation = await reserveBudget(pool, {
      leafBudgetId: sessionBudget.id,
      agentId: sessionBudget.agentId!,
      amountMinor: 30_000n, // $0.03
      ttlSeconds: 60,
    });

    let budget = await getBudget(pool, sessionBudget.id);
    expect(budget.availableMinor).toBe(970_000n);
    expect(budget.reservedMinor).toBe(30_000n);

    await captureReservation(pool, reservation.id);

    budget = await getBudget(pool, sessionBudget.id);
    expect(budget.availableMinor).toBe(970_000n); // unchanged by capture
    expect(budget.reservedMinor).toBe(0n);
    expect(budget.spentMinor).toBe(30_000n);

    const finalReservation = await getReservation(pool, reservation.id);
    expect(finalReservation.status).toBe('CONSUMED');
  });

  it('Scenario B: a reservation request larger than available is rejected and reserves nothing', async () => {
    const { sessionBudget } = await createTestHierarchy(pool, {
      org: 100_000_000n,
      agent: 10_000_000n,
      session: 20_000n, // $0.02
    });

    await expect(
      reserveBudget(pool, {
        leafBudgetId: sessionBudget.id,
        agentId: sessionBudget.agentId!,
        amountMinor: 30_000n, // $0.03 - more than the $0.02 session budget
        ttlSeconds: 60,
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_BUDGET' } satisfies Partial<DomainError>);

    const budget = await getBudget(pool, sessionBudget.id);
    expect(budget.availableMinor).toBe(20_000n);
    expect(budget.reservedMinor).toBe(0n);
  });

  it('Scenario E: a failed payment intent releases its reservation back to available', async () => {
    const { sessionBudget } = await createTestHierarchy(pool, {
      org: 100_000_000n,
      agent: 10_000_000n,
      session: 1_000_000n,
    });

    const reservation = await reserveBudget(pool, {
      leafBudgetId: sessionBudget.id,
      agentId: sessionBudget.agentId!,
      amountMinor: 500_000n,
      ttlSeconds: 60,
    });

    let budget = await getBudget(pool, sessionBudget.id);
    expect(budget.availableMinor).toBe(500_000n);
    expect(budget.reservedMinor).toBe(500_000n);

    // Simulate settlement failing: release rather than capture.
    await releaseReservation(pool, reservation.id);

    budget = await getBudget(pool, sessionBudget.id);
    expect(budget.availableMinor).toBe(1_000_000n);
    expect(budget.reservedMinor).toBe(0n);
    expect(budget.spentMinor).toBe(0n);

    const finalReservation = await getReservation(pool, reservation.id);
    expect(finalReservation.status).toBe('RELEASED');
  });

  it('rejects double-capture and double-release of the same reservation', async () => {
    const { sessionBudget } = await createTestHierarchy(pool, {
      org: 100_000_000n,
      agent: 10_000_000n,
      session: 1_000_000n,
    });
    const reservation = await reserveBudget(pool, {
      leafBudgetId: sessionBudget.id,
      agentId: sessionBudget.agentId!,
      amountMinor: 100_000n,
      ttlSeconds: 60,
    });

    await captureReservation(pool, reservation.id);
    await expect(captureReservation(pool, reservation.id)).rejects.toMatchObject({
      code: 'RESERVATION_NOT_ACTIVE',
    });
    await expect(releaseReservation(pool, reservation.id)).rejects.toMatchObject({
      code: 'RESERVATION_NOT_ACTIVE',
    });
  });

  it('the expiry sweep releases stale ACTIVE reservations and only those', async () => {
    const { sessionBudget } = await createTestHierarchy(pool, {
      org: 100_000_000n,
      agent: 10_000_000n,
      session: 1_000_000n,
    });

    const expiring = await reserveBudget(pool, {
      leafBudgetId: sessionBudget.id,
      agentId: sessionBudget.agentId!,
      amountMinor: 100_000n,
      ttlSeconds: -1, // already expired
    });
    const stillActive = await reserveBudget(pool, {
      leafBudgetId: sessionBudget.id,
      agentId: sessionBudget.agentId!,
      amountMinor: 100_000n,
      ttlSeconds: 3600,
    });

    const result = await sweepExpiredReservations(pool);
    expect(result.expiredReservationIds).toEqual([expiring.id]);

    expect((await getReservation(pool, expiring.id)).status).toBe('EXPIRED');
    expect((await getReservation(pool, stillActive.id)).status).toBe('ACTIVE');

    const budget = await getBudget(pool, sessionBudget.id);
    expect(budget.availableMinor).toBe(900_000n); // expired $0.10 released back; $0.10 still reserved
    expect(budget.reservedMinor).toBe(100_000n);
  });

  it('drives a payment intent through the full state machine transactionally with reservation effects', async () => {
    const { orgId, sessionBudget } = await createTestHierarchy(pool, {
      org: 100_000_000n,
      agent: 10_000_000n,
      session: 1_000_000n,
    });
    const { rows: providerRows } = await pool.query<{ id: string }>(
      `INSERT INTO providers (org_id, name, base_url, resource_path, category, network, configured_price_minor, trust_status)
       VALUES ($1, 'Test Provider', 'http://localhost:4001', '/research', 'search', 'eip155:84532', 30000, 'TRUSTED')
       RETURNING id`,
      [orgId],
    );
    const providerId = providerRows[0]!.id;

    const intent = await createPaymentIntent(pool, {
      orgId,
      agentId: sessionBudget.agentId!,
      sessionBudgetId: sessionBudget.id,
      providerId,
      amountMinor: 30_000n,
      network: 'eip155:84532',
    });
    expect(intent.state).toBe('CREATED');

    await transitionPaymentIntent(pool, intent.id, 'POLICY_EVALUATING');
    await transitionPaymentIntent(pool, intent.id, 'APPROVED');

    const reservation = await reserveBudget(pool, {
      leafBudgetId: sessionBudget.id,
      agentId: sessionBudget.agentId!,
      amountMinor: 30_000n,
      ttlSeconds: 60,
    });
    await transitionPaymentIntent(pool, intent.id, 'RESERVED', { patch: { reservationId: reservation.id } });
    await transitionPaymentIntent(pool, intent.id, 'PAYMENT_PREPARED');
    await transitionPaymentIntent(pool, intent.id, 'VERIFYING');
    await transitionPaymentIntent(pool, intent.id, 'SETTLING');
    await captureReservation(pool, reservation.id);
    await transitionPaymentIntent(pool, intent.id, 'SETTLED', {
      patch: { settlementTxHash: '0xmocktxhash' },
    });

    const finalIntent = await getPaymentIntent(pool, intent.id);
    expect(finalIntent.state).toBe('SETTLED');
    expect(finalIntent.settlementTxHash).toBe('0xmocktxhash');

    // Illegal transition attempt from a terminal state must be rejected.
    await expect(transitionPaymentIntent(pool, intent.id, 'CREATED')).rejects.toMatchObject({
      code: 'INVALID_PAYMENT_STATE',
    });

    const { rows: transitionRows } = await pool.query(
      'SELECT to_state FROM payment_state_transitions WHERE payment_intent_id = $1 ORDER BY created_at',
      [intent.id],
    );
    expect(transitionRows.map((r: { to_state: string }) => r.to_state)).toEqual([
      'CREATED',
      'POLICY_EVALUATING',
      'APPROVED',
      'RESERVED',
      'PAYMENT_PREPARED',
      'VERIFYING',
      'SETTLING',
      'SETTLED',
    ]);
  });
});
