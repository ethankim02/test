# Routing

`packages/router` picks among providers offering an equivalent capability
(e.g. three "research" providers) using a deterministic, fully auditable
formula — no machine learning, per the task's explicit anti-goal and
principle C ("if deterministic optimization solves a problem better, use
deterministic optimization"). There is no historical labeled dataset of
"which provider was actually the right choice" for this project to learn
from, and a financial control system needs an answer to "why did you pick
this provider" that is exact, not probabilistic.

## Two phases

### 1. Hard constraint filtering

A request may specify:

```ts
interface RoutingConstraints {
  maxPriceMinor?: bigint;
  maxLatencyMs?: number;
  minSuccessRate?: number;
  objective: 'cheapest' | 'fastest' | 'most_reliable' | 'balanced';
  weights?: { price: number; latency: number; reliability: number };
}
```

Any candidate violating `maxPriceMinor`, `maxLatencyMs`, or
`minSuccessRate` is rejected outright, with the specific reason recorded
(`packages/router/src/route.ts` `filterFeasible`). Rejected candidates are
never scored — this matters for the `balanced` objective, since including
an infeasible outlier would skew the min-max normalization for everyone
else.

### 2. Scoring the survivors — lower wins

```
normPrice   = minmax(priceMinor)     across feasible candidates
normLatency = minmax(latencyMs)      across feasible candidates
failureRate = 1 - successRate        (already a probability, not normalized)

cheapest:      score = normPrice
fastest:       score = normLatency
most_reliable: score = failureRate
balanced:      score = w_price * normPrice + w_latency * normLatency + w_reliability * failureRate
```

`minmax(x) = (x - min) / (max - min)` across the feasible set, or `0` if
every candidate ties (avoids division by zero without letting a tie
influence the outcome).

`failureRate` is deliberately **not** min-max normalized like price and
latency: price is in arbitrary currency units and latency in arbitrary
milliseconds, so only their *relative* position among today's candidates
is meaningful — but success rate is already a probability on a fixed
`[0, 1]` scale, and normalizing it would make "the least reliable
candidate in this batch" look artificially bad even if all candidates are
99%+ reliable. Comparing raw failure rate keeps that scale meaningful.

### Default weights for `balanced`

```
price:       0.4
latency:     0.3
reliability: 0.3
```

Exported as `DEFAULT_BALANCED_WEIGHTS` — not a hidden constant, and
overridable per-request via `constraints.weights`. They don't need to sum
to 1; the implementation doesn't require it (uniform rescaling of all
three weights doesn't change which candidate has the lowest score), but
summing to 1 keeps scores in a human-legible 0–1 range for logging.

### Worked example (also the router's own test fixture)

| Provider | Price | Latency | Success rate |
|---|---|---|---|
| A | $0.010 | 1800ms | 99.9% |
| B | $0.040 | 300ms | 99.5% |
| C | $0.020 | 700ms | 98.1% |

- `cheapest` → **A** (lowest price)
- `fastest` → **B** (lowest latency)
- `most_reliable` → **A** (lowest failure rate)
- `balanced` (default weights) → **C**: A scores 0.300, B scores 0.402, C
  scores 0.219 — C's mid-range price and latency and no single terrible
  dimension beats A's very high latency and B's very high price.

## Auditability

Every routing call's full input and output — every candidate considered,
why any were rejected, and every survivor's score — is persisted to
`routing_decisions` (see `docs/ARCHITECTURE.md` ERD) before a payment
intent references it, so "why this provider" is always answerable after
the fact, not just at decision time.

## Not implemented: multi-resource constrained optimization

Task §18 describes an optional advanced mode: choosing a *set* of
providers across N resource requests to minimize total cost subject to a
deadline and reliability floor — a small linear/integer program. This
project's routing need (pick one provider per single resource request) is
already fully solved by the two-phase filter-then-score approach above,
and the demo agent never needs to satisfy N requests against a shared
constraint simultaneously. Implementing a solver for a need that doesn't
exist yet would be exactly the kind of premature complexity the project's
own anti-goals warn against ("don't build 50 abstractions before the
first working payment"). Left as a documented roadmap item — see the
README.
