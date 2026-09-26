import { describe, expect, it } from 'vitest';
import { route } from './route.js';
import type { ProviderCandidate } from './types.js';

// The exact three-provider scenario from the project spec: same
// capability, different price/latency/reliability characteristics.
const providerA: ProviderCandidate = {
  id: 'A',
  name: 'Cheap & slow',
  category: 'search',
  priceMinor: 10_000n,
  latencyMs: 1800,
  successRate: 0.999,
};
const providerB: ProviderCandidate = {
  id: 'B',
  name: 'Expensive & fast',
  category: 'search',
  priceMinor: 40_000n,
  latencyMs: 300,
  successRate: 0.995,
};
const providerC: ProviderCandidate = {
  id: 'C',
  name: 'Balanced',
  category: 'search',
  priceMinor: 20_000n,
  latencyMs: 700,
  successRate: 0.981,
};

const candidates = [providerA, providerB, providerC];

describe('route', () => {
  it('different objectives select different providers, as required by the spec', () => {
    expect(route(candidates, { objective: 'cheapest' }).selected?.id).toBe('A');
    expect(route(candidates, { objective: 'fastest' }).selected?.id).toBe('B');
    expect(route(candidates, { objective: 'most_reliable' }).selected?.id).toBe('A');
  });

  it('filters out providers that violate hard constraints before scoring', () => {
    const result = route(candidates, { objective: 'cheapest', maxLatencyMs: 1000 });
    expect(result.rejected.map((r) => r.provider.id)).toEqual(['A']);
    expect(result.scored.map((s) => s.provider.id).sort()).toEqual(['B', 'C']);
    expect(result.selected?.id).toBe('C'); // cheapest of the two remaining
  });

  it('filters by maxPriceMinor', () => {
    const result = route(candidates, { objective: 'fastest', maxPriceMinor: 25_000n });
    expect(result.rejected.map((r) => r.provider.id)).toEqual(['B']);
    expect(result.selected?.id).toBe('C');
  });

  it('filters by minSuccessRate', () => {
    const result = route(candidates, { objective: 'cheapest', minSuccessRate: 0.99 });
    expect(result.rejected.map((r) => r.provider.id)).toEqual(['C']);
  });

  it('returns null selection and every candidate rejected when nothing is feasible', () => {
    const result = route(candidates, { objective: 'cheapest', maxLatencyMs: 1 });
    expect(result.selected).toBeNull();
    expect(result.rejected).toHaveLength(3);
    expect(result.scored).toHaveLength(0);
  });

  it('balanced objective weighs all three dimensions and is order-independent of input', () => {
    const forward = route(candidates, { objective: 'balanced' });
    const reversed = route([...candidates].reverse(), { objective: 'balanced' });
    expect(forward.selected?.id).toBe(reversed.selected?.id);
    // With default weights (price 0.4 / latency 0.3 / reliability 0.3),
    // provider C (balanced price/latency/reliability) should win over the
    // two extremes.
    expect(forward.selected?.id).toBe('C');
  });

  it('custom weights change the balanced outcome predictably', () => {
    // Weight price so heavily that the cheapest provider wins balanced too.
    const priceHeavy = route(candidates, {
      objective: 'balanced',
      weights: { price: 0.98, latency: 0.01, reliability: 0.01 },
    });
    expect(priceHeavy.selected?.id).toBe('A');

    const latencyHeavy = route(candidates, {
      objective: 'balanced',
      weights: { price: 0.01, latency: 0.98, reliability: 0.01 },
    });
    expect(latencyHeavy.selected?.id).toBe('B');
  });

  it('every candidate is accounted for exactly once across scored + rejected', () => {
    const result = route(candidates, { objective: 'balanced', maxLatencyMs: 1000 });
    const total = result.scored.length + result.rejected.length;
    expect(total).toBe(candidates.length);
  });

  it('scored results are sorted best (lowest score) first', () => {
    const result = route(candidates, { objective: 'balanced' });
    for (let i = 1; i < result.scored.length; i++) {
      expect(result.scored[i - 1]!.score).toBeLessThanOrEqual(result.scored[i]!.score);
    }
  });

  it('is deterministic', () => {
    const first = route(candidates, { objective: 'balanced' });
    const second = route(candidates, { objective: 'balanced' });
    expect(first).toEqual(second);
  });

  it('treats a single feasible candidate as the winner regardless of objective', () => {
    const result = route([providerA], { objective: 'fastest' });
    expect(result.selected?.id).toBe('A');
    expect(result.scored[0]?.score).toBe(0); // no spread to normalize against
  });
});
