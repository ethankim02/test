export type RoutingObjective = 'cheapest' | 'fastest' | 'most_reliable' | 'balanced';

export interface ProviderCandidate {
  id: string;
  name: string;
  category: string;
  /** Price in the asset's minor units (e.g. USDC atomic units). */
  priceMinor: bigint;
  /** Observed average latency in milliseconds. */
  latencyMs: number;
  /** Observed success rate, 0..1. */
  successRate: number;
}

export interface RoutingWeights {
  price: number;
  latency: number;
  reliability: number;
}

export interface RoutingConstraints {
  maxPriceMinor?: bigint;
  maxLatencyMs?: number;
  minSuccessRate?: number;
  objective: RoutingObjective;
  /** Only used when objective === 'balanced'. See docs/ROUTING.md for the default and the formula. */
  weights?: RoutingWeights;
}

export interface RejectedCandidate {
  provider: ProviderCandidate;
  reason: string;
}

export interface ScoredCandidate {
  provider: ProviderCandidate;
  score: number;
}

export interface RoutingResult {
  objective: RoutingObjective;
  selected: ProviderCandidate | null;
  /** Every candidate that passed the hard constraints, with its score, best (lowest) first. */
  scored: ScoredCandidate[];
  /** Every candidate that failed a hard constraint, with why. */
  rejected: RejectedCandidate[];
}
