import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap, type Bootstrapped } from './bootstrap.js';
import { resetTestDatabase, setupTestApp } from './setup.js';

/**
 * Mandatory scenario (task §11 / §40 Scenario D): an agent retries the
 * exact same payment request repeatedly using the same Idempotency-Key
 * after e.g. a network timeout. Result must be ONE logical payment
 * intent, not N charges.
 */
describe('idempotent payment intent creation', () => {
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

  it('Scenario D: retrying an identical request 5 times with the same key yields exactly one payment intent and one settlement', async () => {
    ctx = await bootstrap(app, pool, { sessionBudget: '1.00', priceMinor: '30000' });
    const idempotencyKey = 'retry-key-abc';
    const payload = { agentId: ctx.agentId, sessionId: ctx.sessionId, providerId: ctx.providerId };

    const responses = [];
    for (let i = 0; i < 5; i++) {
      const resp = await app.inject({
        method: 'POST',
        url: '/payments/intents',
        headers: { authorization: `Bearer ${ctx.apiKey}`, 'idempotency-key': idempotencyKey },
        payload,
      });
      responses.push(resp.json());
    }

    const distinctIntentIds = new Set(responses.map((r) => r.paymentIntentId));
    expect(distinctIntentIds.size).toBe(1);

    // Every response after the first should be flagged as a replay.
    expect(responses[0].idempotentReplay).toBeUndefined();
    for (let i = 1; i < 5; i++) {
      expect(responses[i]!.idempotentReplay).toBe(true);
      expect(responses[i]!.paymentIntentId).toBe(responses[0]!.paymentIntentId);
      expect(responses[i]!.state).toBe('SETTLED');
    }

    // Only ONE payment intent row and ONE settlement actually happened.
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM payment_intents WHERE agent_id = $1', [ctx.agentId]);
    expect(rows[0]!.n).toBe(1);

    const sessionResp = await app.inject({
      method: 'GET',
      url: `/sessions/${ctx.sessionId}`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
    // Spent exactly once, not 5 times.
    expect(sessionResp.json().spent).toBe('0.030000');
    expect(sessionResp.json().available).toBe('0.970000');
  });

  it('rejects reusing the same Idempotency-Key with a different request payload', async () => {
    ctx = await bootstrap(app, pool, { sessionBudget: '1.00', priceMinor: '30000' });
    const idempotencyKey = 'conflict-key';

    const first = await app.inject({
      method: 'POST',
      url: '/payments/intents',
      headers: { authorization: `Bearer ${ctx.apiKey}`, 'idempotency-key': idempotencyKey },
      payload: { agentId: ctx.agentId, sessionId: ctx.sessionId, providerId: ctx.providerId },
    });
    expect(first.statusCode).toBe(200);

    // Same key, but a different providerId — even a nonexistent one is
    // enough to prove the hash changed and the conflict is caught before
    // any provider lookup.
    const second = await app.inject({
      method: 'POST',
      url: '/payments/intents',
      headers: { authorization: `Bearer ${ctx.apiKey}`, 'idempotency-key': idempotencyKey },
      payload: { agentId: ctx.agentId, sessionId: ctx.sessionId, providerId: '00000000-0000-0000-0000-000000000000' },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('different idempotency keys for the same logical request each create their own intent (not deduped)', async () => {
    ctx = await bootstrap(app, pool, { sessionBudget: '1.00', priceMinor: '30000' });
    const payload = { agentId: ctx.agentId, sessionId: ctx.sessionId, providerId: ctx.providerId };

    const a = await app.inject({
      method: 'POST',
      url: '/payments/intents',
      headers: { authorization: `Bearer ${ctx.apiKey}`, 'idempotency-key': 'key-a' },
      payload,
    });
    const b = await app.inject({
      method: 'POST',
      url: '/payments/intents',
      headers: { authorization: `Bearer ${ctx.apiKey}`, 'idempotency-key': 'key-b' },
      payload,
    });

    expect(a.json().paymentIntentId).not.toBe(b.json().paymentIntentId);
    // Both spent — this is intentional (different keys = different logical
    // requests from Treasury's point of view) and demonstrates that the
    // dedup is keyed on the caller's stated intent, not fuzzy payload matching.
    const sessionResp = await app.inject({
      method: 'GET',
      url: `/sessions/${ctx.sessionId}`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
    expect(sessionResp.json().spent).toBe('0.060000');
  });
});
