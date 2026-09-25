import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap, type Bootstrapped } from './bootstrap.js';
import { resetTestDatabase, setupTestApp } from './setup.js';

describe('POST /payments/intents', () => {
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

  it('Scenario A: a well-formed payment settles and debits the session budget by the live-quoted price', async () => {
    ctx = await bootstrap(app, pool, { sessionBudget: '1.00', priceMinor: '30000' });

    const resp = await app.inject({
      method: 'POST',
      url: '/payments/intents',
      headers: { authorization: `Bearer ${ctx.apiKey}`, 'idempotency-key': 'test-key-1' },
      payload: { agentId: ctx.agentId, sessionId: ctx.sessionId, providerId: ctx.providerId },
    });

    expect(resp.statusCode).toBe(200);
    const body = resp.json();
    expect(body.decision).toBe('ALLOW');
    expect(body.state).toBe('SETTLED');
    expect(body.amountMinor).toBe('30000');
    expect(body.settlement.transactionHash).toMatch(/^0xMOCK/);
    expect(body.sessionBudget.spent).toBe('0.030000');
    expect(body.sessionBudget.available).toBe('0.970000');
    expect(body.resource).toEqual({ result: 'mock research data' });

    const intentResp = await app.inject({
      method: 'GET',
      url: `/payments/intents/${body.paymentIntentId}`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
    expect(intentResp.json().state).toBe('SETTLED');
    expect(intentResp.json().transitions.map((t: { to_state: string }) => t.to_state)).toEqual([
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

  it('Scenario B: a session budget too small for the live-quoted price is blocked and reserves nothing', async () => {
    ctx = await bootstrap(app, pool, { sessionBudget: '0.02', priceMinor: '30000' }); // $0.02 budget, $0.03 price

    const resp = await app.inject({
      method: 'POST',
      url: '/payments/intents',
      headers: { authorization: `Bearer ${ctx.apiKey}`, 'idempotency-key': 'test-key-2' },
      payload: { agentId: ctx.agentId, sessionId: ctx.sessionId, providerId: ctx.providerId },
    });

    expect(resp.statusCode).toBe(402);
    const body = resp.json();
    expect(body.decision).toBe('BLOCK');
    expect(body.reasonCodes).toContain('SESSION_BUDGET_EXCEEDED');

    const sessionResp = await app.inject({
      method: 'GET',
      url: `/sessions/${ctx.sessionId}`,
      headers: { authorization: `Bearer ${ctx.apiKey}` },
    });
    expect(sessionResp.json().available).toBe('0.020000');
    expect(sessionResp.json().reserved).toBe('0.000000');
  });

  it('an agent-scoped API key cannot spend another agent budget by putting a different agentId in the body', async () => {
    ctx = await bootstrap(app, pool);

    // Create a second agent + session under the same org.
    const secondAgentResp = await app.inject({
      method: 'POST',
      url: '/agents',
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: { name: 'Other Agent', dailyBudget: '5.00' },
    });
    const otherAgentId = secondAgentResp.json().id;
    const secondSessionResp = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: { agentId: otherAgentId, name: 'Other Session', budget: '1.00' },
    });
    const otherSessionId = secondSessionResp.json().id;

    // ctx.agentKey is scoped to ctx.agentId; attempt to spend the OTHER agent's session budget.
    const resp = await app.inject({
      method: 'POST',
      url: '/payments/intents',
      headers: { authorization: `Bearer ${ctx.agentKey}`, 'idempotency-key': 'cross-agent-attempt' },
      payload: { agentId: otherAgentId, sessionId: otherSessionId, providerId: ctx.providerId },
    });

    expect(resp.statusCode).toBe(403);
    expect(resp.json().error.code).toBe('FORBIDDEN');
  });

  it('an agent-scoped key CAN spend its own agent budget', async () => {
    ctx = await bootstrap(app, pool, { sessionBudget: '1.00', priceMinor: '30000' });

    const resp = await app.inject({
      method: 'POST',
      url: '/payments/intents',
      headers: { authorization: `Bearer ${ctx.agentKey}`, 'idempotency-key': 'self-spend' },
      payload: { agentId: ctx.agentId, sessionId: ctx.sessionId, providerId: ctx.providerId },
    });

    expect(resp.statusCode).toBe(200);
    expect(resp.json().decision).toBe('ALLOW');
  });

  it('rejects requests with no Authorization header', async () => {
    ctx = await bootstrap(app, pool);
    const resp = await app.inject({
      method: 'POST',
      url: '/payments/intents',
      headers: { 'idempotency-key': 'no-auth' },
      payload: { agentId: ctx.agentId, sessionId: ctx.sessionId, providerId: ctx.providerId },
    });
    expect(resp.statusCode).toBe(401);
  });

  it('requires an Idempotency-Key header', async () => {
    ctx = await bootstrap(app, pool);
    const resp = await app.inject({
      method: 'POST',
      url: '/payments/intents',
      headers: { authorization: `Bearer ${ctx.apiKey}` },
      payload: { agentId: ctx.agentId, sessionId: ctx.sessionId, providerId: ctx.providerId },
    });
    expect(resp.statusCode).toBe(400);
  });
});
