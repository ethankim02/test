import type {
  ProviderCandidate,
  RejectedCandidate,
  RoutingConstraints,
  RoutingResult,
  RoutingWeights,
} from './types.js';

/**
 * Default weights for the `balanced` objective. Not hidden inside the
 * scoring math — exported so callers (and the routing_decisions audit
 * log) can see exactly what was used, and can override via
 * `RoutingConstraints.weights`. See docs/ROUTING.md for the full
 * derivation. They sum to 1 but the implementation does not require that;
 * un-normalized weights just scale the resulting score uniformly, which
 * doesn't change which provider wins.
 */
export const DEFAULT_BALANCED_WEIGHTS: RoutingWeights = {
  price: 0.4,
  latency: 0.3,
  reliability: 0.3,
};

function filterFeasible(
  candidates: ProviderCandidate[],
  constraints: RoutingConstraints,
): { feasible: ProviderCandidate[]; rejected: RejectedCandidate[] } {
  const feasible: ProviderCandidate[] = [];
  const rejected: RejectedCandidate[] = [];

  for (const candidate of candidates) {
    if (
      constraints.maxPriceMinor !== undefined &&
      candidate.priceMinor > constraints.maxPriceMinor
    ) {
      rejected.push({
        provider: candidate,
        reason: `price ${candidate.priceMinor} exceeds maxPriceMinor ${constraints.maxPriceMinor}`,
      });
      continue;
    }
    if (constraints.maxLatencyMs !== undefined && candidate.latencyMs > constraints.maxLatencyMs) {
      rejected.push({
        provider: candidate,
        reason: `latency ${candidate.latencyMs}ms exceeds maxLatencyMs ${constraints.maxLatencyMs}ms`,
      });
      continue;
    }
    if (
      constraints.minSuccessRate !== undefined &&
      candidate.successRate < constraints.minSuccessRate
    ) {
      rejected.push({
        provider: candidate,
        reason: `success rate ${candidate.successRate} is below minSuccessRate ${constraints.minSuccessRate}`,
      });
      continue;
    }
    feasible.push(candidate);
  }

  return { feasible, rejected };
}

/** Min-max normalizes `value` into [0, 1] across `values`. Returns 0 if every value is equal (avoids division by zero, and ties should not affect the score). */
function normalize(value: number, values: number[]): number {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return 0;
  return (value - min) / (max - min);
}

/**
 * Scores one feasible candidate. Lower is better — see docs/ROUTING.md.
 *
 * - `cheapest`: score is normalized price only.
 * - `fastest`: score is normalized latency only.
 * - `most_reliable`: score is (1 - successRate) — not min-max normalized,
 *   because success rate is already a proper probability on a fixed
 *   [0, 1] scale, unlike price (dollars) or latency (milliseconds) whose
 *   raw units are arbitrary and only comparable after normalization.
 * - `balanced`: weighted sum of all three normalized dimensions.
 */
function scoreCandidate(
  candidate: ProviderCandidate,
  feasible: ProviderCandidate[],
  objective: RoutingConstraints['objective'],
  weights: RoutingWeights,
): number {
  const prices = feasible.map((c) => Number(c.priceMinor));
  const latencies = feasible.map((c) => c.latencyMs);

  const normPrice = normalize(Number(candidate.priceMinor), prices);
  const normLatency = normalize(candidate.latencyMs, latencies);
  const failureRate = 1 - candidate.successRate;

  switch (objective) {
    case 'cheapest':
      return normPrice;
    case 'fastest':
      return normLatency;
    case 'most_reliable':
      return failureRate;
    case 'balanced':
      return (
        weights.price * normPrice +
        weights.latency * normLatency +
        weights.reliability * failureRate
      );
  }
}

/**
 * Filters candidates by hard constraints, scores the survivors, and picks
 * the lowest score. Every candidate — feasible or not — is accounted for
 * in the result so the decision is fully auditable (see
 * docs/ARCHITECTURE.md ERD `routing_decisions`).
 */
export function route(
  candidates: ProviderCandidate[],
  constraints: RoutingConstraints,
): RoutingResult {
  const { feasible, rejected } = filterFeasible(candidates, constraints);
  const weights = constraints.weights ?? DEFAULT_BALANCED_WEIGHTS;

  const scored = feasible
    .map((provider) => ({
      provider,
      score: scoreCandidate(provider, feasible, constraints.objective, weights),
    }))
    .sort((a, b) => a.score - b.score);

  return {
    objective: constraints.objective,
    selected: scored[0]?.provider ?? null,
    scored,
    rejected,
  };
}
