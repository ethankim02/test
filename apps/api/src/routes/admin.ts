import { allocateBudget, getBudget } from '@x402-treasury/ledger';
import { fromDecimalString, hashApiKey } from '@x402-treasury/shared';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { authenticate, requireAgentMatch } from '../auth.js';
import { budgetSummary } from '../budget-summary.js';
import { notFound } from '../errors.js';

const CreateOrgSchema = z.object({ name: z.string().min(1), dailyBudget: z.string() });
const CreateAgentSchema = z.object({
  name: z.string().min(1),
  dailyBudget: z.string(),
  /** If set, this agent's budget is a DELEGATED child of the named parent agent's own budget, not the org root — see Scenario G. */
  parentAgentId: z.string().uuid().optional(),
});
const CreateSessionSchema = z.object({
  agentId: z.string().uuid(),
  name: z.string().min(1),
  budget: z.string(),
  expiresAt: z.string().datetime().optional(),
});
const CreateProviderSchema = z.object({
  name: z.string().min(1),
  baseUrl: z.string().url(),
  resourcePath: z.string().min(1),
  category: z.string().min(1),
  network: z.string().min(1),
  configuredPrice: z.string().optional(),
  trustStatus: z.enum(['TRUSTED', 'KNOWN', 'UNKNOWN']).default('UNKNOWN'),
  payTo: z.string().optional(),
});
const CreatePolicySchema = z.object({
  scope: z.enum(['ORG', 'AGENT']),
  agentId: z.string().uuid().optional(),
  ruleType: z.string().min(1),
  params: z.record(z.unknown()),
  enabled: z.boolean().default(true),
});

export function registerAdminRoutes(app: FastifyInstance, pool: Pool): void {
  // Organizations: no auth required to create the first one (bootstrapping) —
  // this mirrors a signup flow. Every other endpoint requires a key.
  app.post('/organizations', async (request, reply) => {
    const body = CreateOrgSchema.parse(request.body);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string }>(
        'INSERT INTO organizations (name) VALUES ($1) RETURNING id',
        [body.name],
      );
      const orgId = rows[0]!.id;
      const allocated = fromDecimalString(body.dailyBudget, 'USDC');
      await client.query(
        `INSERT INTO budgets (org_id, scope, name, period, allocated_minor, available_minor)
         VALUES ($1, 'ORG', 'Org Treasury', 'DAILY', $2, $2)`,
        [orgId, allocated.amountMinor.toString()],
      );
      const apiKey = `sk_${crypto.randomUUID().replace(/-/g, '')}`;
      await client.query('INSERT INTO api_keys (org_id, key_hash, label) VALUES ($1, $2, $3)', [
        orgId,
        hashApiKey(apiKey),
        'Initial org key',
      ]);
      await client.query('COMMIT');
      reply.status(201).send({ id: orgId, name: body.name, apiKey });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  app.post('/agents', async (request, reply) => {
    const auth = await authenticate(pool, request);
    const body = CreateAgentSchema.parse(request.body);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: agentRows } = await client.query<{ id: string }>(
        'INSERT INTO agents (org_id, parent_agent_id, name) VALUES ($1, $2, $3) RETURNING id',
        [auth.orgId, body.parentAgentId ?? null, body.name],
      );
      const agentId = agentRows[0]!.id;

      let parentBudgetId: string;
      if (body.parentAgentId) {
        const { rows: parentBudgetRows } = await client.query<{ id: string }>(
          `SELECT id FROM budgets WHERE agent_id = $1 AND scope = 'AGENT' LIMIT 1`,
          [body.parentAgentId],
        );
        const parentBudget = parentBudgetRows[0];
        if (!parentBudget) throw notFound('parent agent budget for agent', body.parentAgentId);
        parentBudgetId = parentBudget.id;
      } else {
        const { rows: orgBudgetRows } = await client.query<{ id: string }>(
          `SELECT id FROM budgets WHERE org_id = $1 AND scope = 'ORG' LIMIT 1`,
          [auth.orgId],
        );
        const orgBudget = orgBudgetRows[0];
        if (!orgBudget) throw notFound('org treasury budget for org', auth.orgId);
        parentBudgetId = orgBudget.id;
      }
      await client.query('COMMIT');

      const allocated = fromDecimalString(body.dailyBudget, 'USDC');
      const agentBudget = await allocateBudget(pool, {
        orgId: auth.orgId,
        agentId,
        parentBudgetId,
        scope: 'AGENT',
        name: `${body.name} Budget`,
        period: body.parentAgentId ? 'TOTAL' : 'DAILY',
        allocatedMinor: allocated.amountMinor,
      });

      reply.status(201).send({
        id: agentId,
        name: body.name,
        parentAgentId: body.parentAgentId ?? null,
        budget: await budgetSummary(pool, agentBudget.id),
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });

  app.get('/agents/:id', async (request, reply) => {
    await authenticate(pool, request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { rows } = await pool.query<{
      id: string;
      name: string;
      parent_agent_id: string | null;
      status: string;
    }>('SELECT id, name, parent_agent_id, status FROM agents WHERE id = $1', [id]);
    const agent = rows[0];
    if (!agent) throw notFound('agent', id);
    const { rows: budgetRows } = await pool.query<{ id: string }>(
      `SELECT id FROM budgets WHERE agent_id = $1 AND scope = 'AGENT'`,
      [id],
    );
    const budget = budgetRows[0] ? await budgetSummary(pool, budgetRows[0].id) : null;
    reply.send({
      id: agent.id,
      name: agent.name,
      parentAgentId: agent.parent_agent_id,
      status: agent.status,
      budget,
    });
  });

  app.post('/sessions', async (request, reply) => {
    const auth = await authenticate(pool, request);
    const body = CreateSessionSchema.parse(request.body);
    requireAgentMatch(auth, body.agentId);

    const { rows: agentBudgetRows } = await pool.query<{ id: string; org_id: string }>(
      `SELECT id, org_id FROM budgets WHERE agent_id = $1 AND scope = 'AGENT' LIMIT 1`,
      [body.agentId],
    );
    const agentBudget = agentBudgetRows[0];
    if (!agentBudget) throw notFound('agent budget for agent', body.agentId);

    const allocated = fromDecimalString(body.budget, 'USDC');
    const sessionBudget = await allocateBudget(pool, {
      orgId: agentBudget.org_id,
      agentId: body.agentId,
      parentBudgetId: agentBudget.id,
      scope: 'SESSION',
      name: body.name,
      period: 'TOTAL',
      allocatedMinor: allocated.amountMinor,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
    });

    reply.status(201).send(await budgetSummary(pool, sessionBudget.id));
  });

  app.get('/sessions/:id', async (request, reply) => {
    await authenticate(pool, request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await getBudget(pool, id); // throws NOT_FOUND if missing
    const summary = await budgetSummary(pool, id);

    const { rows: byProvider } = await pool.query<{
      provider_name: string;
      total: string;
      count: string;
    }>(
      `SELECT p.name AS provider_name, COALESCE(SUM(pi.amount_minor), 0)::text AS total, COUNT(*)::text AS count
       FROM payment_intents pi
       JOIN providers p ON p.id = pi.provider_id
       WHERE pi.session_budget_id = $1 AND pi.state = 'SETTLED'
       GROUP BY p.name`,
      [id],
    );

    reply.send({
      ...summary,
      byProvider: byProvider.map((r) => ({
        provider: r.provider_name,
        spentMinor: r.total,
        paymentCount: Number(r.count),
      })),
    });
  });

  app.post('/providers', async (request, reply) => {
    const auth = await authenticate(pool, request);
    const body = CreateProviderSchema.parse(request.body);
    const configuredPriceMinor = body.configuredPrice
      ? fromDecimalString(body.configuredPrice, 'USDC').amountMinor
      : null;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO providers (org_id, name, base_url, resource_path, category, network, configured_price_minor, trust_status, pay_to)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        auth.orgId,
        body.name,
        body.baseUrl,
        body.resourcePath,
        body.category,
        body.network,
        configuredPriceMinor?.toString() ?? null,
        body.trustStatus,
        body.payTo ?? null,
      ],
    );
    reply.status(201).send({ id: rows[0]!.id, ...body });
  });

  app.get('/providers', async (request, reply) => {
    const auth = await authenticate(pool, request);
    const { rows } = await pool.query(
      `SELECT id, name, base_url, resource_path, category, network, configured_price_minor, trust_status
       FROM providers WHERE org_id = $1 OR org_id IS NULL ORDER BY name`,
      [auth.orgId],
    );
    reply.send({ providers: rows });
  });

  app.post('/policies', async (request, reply) => {
    const auth = await authenticate(pool, request);
    const body = CreatePolicySchema.parse(request.body);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO policies (org_id, scope, agent_id, rule_type, params, enabled) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        auth.orgId,
        body.scope,
        body.agentId ?? null,
        body.ruleType,
        JSON.stringify(body.params),
        body.enabled,
      ],
    );
    reply.status(201).send({ id: rows[0]!.id, ...body });
  });

  app.get('/policies', async (request, reply) => {
    const auth = await authenticate(pool, request);
    const { rows } = await pool.query('SELECT * FROM policies WHERE org_id = $1', [auth.orgId]);
    reply.send({ policies: rows });
  });
}
