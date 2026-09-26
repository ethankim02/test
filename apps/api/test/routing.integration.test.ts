import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resetTestDatabase, setupTestApp } from './setup.js';

describe('POST /routes/evaluate', () => {
  let app: FastifyInstance;
  let pool: pg.Pool;

  beforeAll(async () => {
    ({ app, pool } = await setupTestApp());
  });
  afterEach(async () => {
    await resetTestDatabase();
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  async function seedOrgWithProviders(): Promise<string> {
    const orgResp = await app.inject({
      method: 'POST',
      url: '/organizations',
      payload: { name: 'Routing Org', dailyBudget: '100' },
    });
    const apiKey = orgResp.json().apiKey;

    const providers = [
      { name: 'Cheap Slow', price: '0.010', latency: 1800, success: 0.999 },
      { name: 'Expensive Fast', price: '0.040', latency: 300, success: 0.995 },
      { name: 'Balanced', price: '0.020', latency: 700, success: 0.981 },
    ];
    for (const p of providers) {
      const resp = await app.inject({
        method: 'POST',
        url: '/providers',
        headers: { authorization: `Bearer ${apiKey}` },
        payload: {
          name: p.name,
          baseUrl: 'http://localhost:9', // never called in this test — routing only reads metadata
          resourcePath: '/research',
          category: 'search',
          network: 'eip155:84532',
          configuredPrice: p.price,
          trustStatus: 'TRUSTED',
        },
      });
      const providerId = resp.json().id;
      await pool.query(
        'INSERT INTO provider_metrics (provider_id, observed_price_minor, observed_latency_ms, observed_success) VALUES ($1, $2, $3, $4)',
        [providerId, Math.round(Number(p.price) * 1_000_000), p.latency, Math.random() < p.success],
      );
      // Deterministic success rate: insert enough samples to converge.
      for (let i = 0; i < 99; i++) {
        await pool.query(
          'INSERT INTO provider_metrics (provider_id, observed_price_minor, observed_latency_ms, observed_success) VALUES ($1, $2, $3, $4)',
          [providerId, Math.round(Number(p.price) * 1_000_000), p.latency, i / 99 < p.success],
        );
      }
    }
    return apiKey;
  }

  it('selects different providers for different objectives, using real DB-backed provider metrics', async () => {
    const apiKey = await seedOrgWithProviders();

    const cheapest = await app.inject({
      method: 'POST',
      url: '/routes/evaluate',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { category: 'search', objective: 'cheapest' },
    });
    expect(cheapest.json().selected.name).toBe('Cheap Slow');

    const fastest = await app.inject({
      method: 'POST',
      url: '/routes/evaluate',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { category: 'search', objective: 'fastest' },
    });
    expect(fastest.json().selected.name).toBe('Expensive Fast');

    const balanced = await app.inject({
      method: 'POST',
      url: '/routes/evaluate',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { category: 'search', objective: 'balanced' },
    });
    expect(balanced.json().selected.name).toBe('Balanced');
  });

  it('filters out providers violating a maxLatencyMs constraint', async () => {
    const apiKey = await seedOrgWithProviders();
    const resp = await app.inject({
      method: 'POST',
      url: '/routes/evaluate',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { category: 'search', objective: 'cheapest', maxLatencyMs: 1000 },
    });
    const body = resp.json();
    expect(body.rejected.map((r: { provider: { name: string } }) => r.provider.name)).toContain(
      'Cheap Slow',
    );
    expect(body.selected.name).toBe('Balanced');
  });

  it('persists an auditable routing decision when sessionBudgetId is provided', async () => {
    const orgResp = await app.inject({
      method: 'POST',
      url: '/organizations',
      payload: { name: 'Audit Org', dailyBudget: '10' },
    });
    const apiKey = orgResp.json().apiKey;
    const agentResp = await app.inject({
      method: 'POST',
      url: '/agents',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { name: 'A', dailyBudget: '5' },
    });
    const sessionResp = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { agentId: agentResp.json().id, name: 'S', budget: '1' },
    });
    await app.inject({
      method: 'POST',
      url: '/providers',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        name: 'P',
        baseUrl: 'http://localhost:9',
        resourcePath: '/r',
        category: 'search',
        network: 'eip155:84532',
        configuredPrice: '0.01',
        trustStatus: 'TRUSTED',
      },
    });

    const resp = await app.inject({
      method: 'POST',
      url: '/routes/evaluate',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        category: 'search',
        objective: 'cheapest',
        sessionBudgetId: sessionResp.json().id,
      },
    });
    expect(resp.json().decisionId).toBeTruthy();

    const { rows } = await pool.query('SELECT * FROM routing_decisions WHERE id = $1', [
      resp.json().decisionId,
    ]);
    expect(rows).toHaveLength(1);
  });
});
