# Demo Walkthrough

Everything below runs entirely against `MockX402Adapter` (see
`docs/RESEARCH.md` §12 and §20) — no blockchain, no facilitator, no
testnet tokens required. Every payment mode line printed says `PAYMENT
MODE: MOCK` so this is never ambiguous.

## Prerequisites

```bash
pnpm install
cp .env.example .env          # defaults are fine for the mock demo
docker compose up -d          # Postgres — or point DATABASE_URL at your own instance
pnpm db:migrate
```

(`pnpm db:seed` is optional — the demo scripts below create their own
fresh org/agent/session/providers over the real API on every run, so
seeding is only useful if you want to poke around manually with `curl`
or a REST client against a pre-populated org.)

## `pnpm demo:research`

```bash
pnpm demo:research
```

What it actually does, all over real HTTP against real local processes
(`apps/demo-agent/src/demo-research.ts`):

1. Spawns the Treasury API (`apps/api`) and both demo providers
   (`apps/demo-provider-a`, `apps/demo-provider-b`) as separate processes
   and waits for each one's `/health` endpoint.
2. Creates an organization with a $100/day treasury, a Research Agent
   with a $20/day budget, and a $1.00 session budget — via
   `POST /organizations`, `POST /agents`, `POST /sessions`.
3. Registers three providers pointing at the real running demo servers
   (Provider A: $0.010, Provider B: $0.030, Provider C: $0.015 — the
   exact price/latency/reliability table from the project spec) and adds
   a small policy set (per-transaction limit, unknown-provider limit,
   duplicate-payment window, provider allowlist).
4. Calls `POST /routes/evaluate` with `objective: "balanced"` and prints
   the full scored table — this is the router
   (`packages/router`/`docs/ROUTING.md`) choosing among real
   configured providers with real observed-metric samples, not a canned
   example.
5. Calls `POST /payments/intents` against the selected provider with a
   real `Idempotency-Key`. This triggers, in order: policy evaluation
   (printed as a checklist), an atomic budget reservation, a real x402
   discovery request against the provider (real HTTP 402 +
   `PAYMENT-REQUIRED` header), a signed mock payment, settlement through
   the mock facilitator, and a reservation capture.
6. Prints the resulting `HTTP` status, the (fake, clearly-labeled)
   settlement transaction hash, the final session budget breakdown, and
   the (clearly `_demo: true`) resource body returned by the provider.
7. Shuts down all three spawned processes.

Sample output (yours will vary slightly — latency/success samples and
the routing score are drawn from small random jitter each run, and
occasionally that changes which provider wins):

```
x402 Treasury Demo
────────────────────────────────────────────────────────
Task
────────────────────────────────────────────────────────
Research API demonstration

Session budget: $1.000000 USDC

────────────────────────────────────────────────────────
Providers discovered: 3
────────────────────────────────────────────────────────
Provider C (balanced)            $0.015 |  672ms | 100.0% | score=0.1895
Provider A (cheap, slow)         $0.010 | 1526ms | 100.0% | score=0.3000
Provider B (expensive, fast)     $0.030 |  309ms | 100.0% | score=0.4000

Routing
Selected: Provider C (balanced)

Payment
Policy checks
✓ SESSION_BUDGET_LIMIT
✓ PER_TRANSACTION_LIMIT
✓ UNKNOWN_PROVIDER_LIMIT
✓ DUPLICATE_PAYMENT_WINDOW
✓ PROVIDER_ALLOWLIST

Result
HTTP 200
Payment settled (mock): 0xMOCK77ea3bc2acb0f918cf5bc60ba45c7673b2734e020cba09ddffec0825b0

Budget
Allocated      $1.000000
Spent          $0.015000
Reserved       $0.000000
Available      $0.985000
```

## `pnpm demo:failures`

```bash
pnpm demo:failures
```

Four real (not canned/hardcoded) failure demonstrations, each a genuine
HTTP round trip against a freshly-spawned API + provider pair
(`apps/demo-agent/src/demo-failures.ts`):

- **A. Budget exceeded** — a $0.005 session budget against a $0.010
  resource is blocked with `SESSION_BUDGET_EXCEEDED` and reserves
  nothing (verified by re-reading the session's balance afterward).
- **B. Duplicate retry** — the identical `Idempotency-Key` is sent 5
  times in a row; all 5 responses reference the same `paymentIntentId`
  and only the first is not flagged `idempotentReplay`.
- **C. Concurrent spending** — 10 truly concurrent (`Promise.all`)
  requests for $0.50 each against a $1.00 budget; exactly 2 succeed, the
  session's `available` balance ends at exactly `$0.00`.
- **D. Settlement failure / uncertain outcome** — a payment is driven
  with `simulateUncertainSettlement: true` (a demo-only flag —
  `apps/api/src/payment-flow.ts` never sets it in the normal path),
  landing in `RECONCILIATION_REQUIRED` with funds still `reserved`, not
  `spent`. `POST /reconciliation/run` then resolves it by re-deriving the
  outcome from the stored signed payload (`apps/api/src/oracle.ts`), and
  the budget correctly moves from `reserved` to `spent`.

## Exploring manually

With the API running (`pnpm dev:api`, after `pnpm db:seed`) and the
seeded demo org's API key from the seed script's output:

```bash
curl -s http://localhost:3000/agents/<researchAgentId> \
  -H "Authorization: Bearer <seeded-api-key>" | jq
```

See `apps/api/src/routes/*.ts` for the full route list, or the OpenAPI
surface implied by the Zod schemas in each route file.

## Running the mandatory automated tests yourself

```bash
pnpm test               # 67 unit tests, no database
docker compose up -d    # if not already running
pnpm db:migrate         # against treasury_test if you set DATABASE_URL/MIGRATOR_DATABASE_URL there
pnpm test:integration   # 32 integration tests against real Postgres
```

The concurrency test in particular
(`packages/ledger/test/concurrency.integration.test.ts`) is worth reading
directly — it's the test the README points to as evidence for the
project's central engineering claim.

## Running against real Base Sepolia (manual, not part of any automated

test or CI)

Requires everything listed in `docs/RESEARCH.md` §12: a running v2
facilitator, a funded Base Sepolia EOA, and `X402_ADAPTER_MODE=real` plus
the corresponding `X402_*` environment variables. `RealX402Adapter`
(`packages/x402-adapter/src/real-adapter.ts`) hard-refuses any network
other than `eip155:84532`. This path was implemented against the actual
installed `@x402/fetch`/`@x402/evm` package APIs (verified, not guessed —
see ADR-007) but was not exercised end-to-end against a live facilitator
during this project's development; treat it as a documented starting
point for a real integration, not a proven one.
