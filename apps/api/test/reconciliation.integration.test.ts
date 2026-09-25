import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap, type Bootstrapped } from './bootstrap.js';
import { resetTestDatabase, setupTestApp } from './setup.js';

describe('reconciliation via the API', () => {
  let app: FastifyInstance;
  let pool: pg.Pool;
  let ctx: Bootstrapped;

  beforeAll(async () => {
    ({ app, pool } = await setupTestApp());
  });
  afterEach(async () => {
    ctx?.providerServer.close();
    await resetTestDatabase();
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('Scenario H: an uncertain settlement is resolved to SETTLED by reconciliation, and the ledger reflects it', async () => {
    ctx = await bootstrap(app, pool, { sessionBudget: '1.00', priceMinor: '30000' });

    const paymentResp = await app.inject({
      method: 'POST',
      url: '/payments/intents',
      headers: { authorization: `Bearer ${ctx.apiKey}`, 'idempotency-key': 'uncertain-1' },
      payload: {
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
        providerId: ctx.providerId,
        simulateUncertainSettlement: true,
      },
    });
    expect(paymentResp.statusCode).toBe(202);
    const paymentIntentId = paymentResp.json().paymentIntentId;

    // Still reserved, not yet spent, while uncertain.
    let session = (
      await app.inject({
        method: 'GET',
        url: `/sessions/${ctx.sessionId}`,
        headers: { authorization: `Bearer ${ctx.apiKey}` },
      })
    ).json();
    expect(session.reserved).toBe('0.030000');
    expect(session.spent).toBe('0.000000');

    const reconcileResp = await app.inject({
      method: 'POST',
      url: '/reconciliation/run',
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
    expect(reconcileResp.statusCode).toBe(200);
    const outcomes = reconcileResp.json().outcomes;
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].paymentIntentId).toBe(paymentIntentId);
    expect(outcomes[0].resolution).toBe('CONFIRMED_SETTLED');

    const intent = (
      await app.inject({
        method: 'GET',
        url: `/payments/intents/${paymentIntentId}`,
        headers: { authorization: `Bearer ${ctx.apiKey}` },
      })
    ).json();
    expect(intent.state).toBe('SETTLED');

    session = (
      await app.inject({
        method: 'GET',
        url: `/sessions/${ctx.sessionId}`,
        headers: { authorization: `Bearer ${ctx.apiKey}` },
      })
    ).json();
    expect(session.reserved).toBe('0.000000');
    expect(session.spent).toBe('0.030000');
  });

  it('running reconciliation with nothing pending is a no-op', async () => {
    ctx = await bootstrap(app, pool);
    const resp = await app.inject({
      method: 'POST',
      url: '/reconciliation/run',
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
    expect(resp.json().outcomes).toEqual([]);
  });
});
