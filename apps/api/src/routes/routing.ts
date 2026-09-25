import { fromDecimalString } from '@x402-treasury/shared';
import {
  DEFAULT_BALANCED_WEIGHTS,
  route,
  type ProviderCandidate,
  type RoutingObjective,
} from '@x402-treasury/router';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { authenticate } from '../auth.js';

const EvaluateRoutesSchema = z.object({
  category: z.string().min(1),
  maxPrice: z.string().optional(),
  maxLatencyMs: z.number().positive().optional(),
  minSuccessRate: z.number().min(0).max(1).optional(),
  objective: z.enum(['cheapest', 'fastest', 'most_reliable', 'balanced']).default('balanced'),
  weights: z.object({ price: z.number(), latency: z.number(), reliability: z.number() }).optional(),
  sessionBudgetId: z.string().uuid().optional(),
});

/** bigint doesn't survive JSON.stringify — serialize priceMinor as a decimal string at the API boundary. */
function serializeCandidate(candidate: ProviderCandidate): Record<string, unknown> {
  return { ...candidate, priceMinor: candidate.priceMinor.toString() };
}

interface ProviderAggregateRow {
  id: string;
  name: string;
  category: string;
  configured_price_minor: string | null;
  avg_latency_ms: number | null;
  success_rate: number | null;
}

export function registerRoutingRoutes(app: FastifyInstance, pool: Pool): void {
  app.post('/routes/evaluate', async (request, reply) => {
    const auth = await authenticate(pool, request);
    const body = EvaluateRoutesSchema.parse(request.body);

    const { rows } = await pool.query<ProviderAggregateRow>(
      `SELECT
         p.id, p.name, p.category, p.configured_price_minor,
         AVG(m.observed_latency_ms) AS avg_latency_ms,
         AVG(CASE WHEN m.observed_success THEN 1.0 ELSE 0.0 END) AS success_rate
       FROM providers p
       LEFT JOIN provider_metrics m ON m.provider_id = p.id
       WHERE (p.org_id = $1 OR p.org_id IS NULL) AND p.category = $2
       GROUP BY p.id, p.name, p.category, p.configured_price_minor`,
      [auth.orgId, body.category],
    );

    const candidates: ProviderCandidate[] = rows
      .filter((r) => r.configured_price_minor !== null)
      .map((r) => ({
        id: r.id,
        name: r.name,
        category: r.category,
        priceMinor: BigInt(r.configured_price_minor!),
        latencyMs: r.avg_latency_ms !== null ? Math.round(r.avg_latency_ms) : 0,
        successRate: r.success_rate !== null ? r.success_rate : 1,
      }));

    const objective = body.objective as RoutingObjective;
    const result = route(candidates, {
      objective,
      maxPriceMinor: body.maxPrice
        ? fromDecimalString(body.maxPrice, 'USDC').amountMinor
        : undefined,
      maxLatencyMs: body.maxLatencyMs,
      minSuccessRate: body.minSuccessRate,
      weights: body.weights ?? (objective === 'balanced' ? DEFAULT_BALANCED_WEIGHTS : undefined),
    });

    let decisionId: string | null = null;
    if (body.sessionBudgetId) {
      const { rows: decisionRows } = await pool.query<{ id: string }>(
        `INSERT INTO routing_decisions (session_budget_id, constraints, considered, selected_provider_id, objective)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [
          body.sessionBudgetId,
          JSON.stringify({
            maxPrice: body.maxPrice,
            maxLatencyMs: body.maxLatencyMs,
            minSuccessRate: body.minSuccessRate,
            objective,
          }),
          JSON.stringify({
            scored: result.scored.map((s) => ({ providerId: s.provider.id, score: s.score })),
            rejected: result.rejected.map((r) => ({ providerId: r.provider.id, reason: r.reason })),
          }),
          result.selected?.id ?? null,
          objective,
        ],
      );
      decisionId = decisionRows[0]!.id;
    }

    reply.send({
      decisionId,
      objective,
      selected: result.selected ? serializeCandidate(result.selected) : null,
      scored: result.scored.map((s) => ({
        provider: serializeCandidate(s.provider),
        score: s.score,
      })),
      rejected: result.rejected.map((r) => ({
        provider: serializeCandidate(r.provider),
        reason: r.reason,
      })),
    });
  });
}
