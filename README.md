# x402 Treasury

**Programmable spending infrastructure for autonomous AI agents.**

x402 lets autonomous software pay for resources. x402 Treasury controls
how, when, where, and how much autonomous software is allowed to spend —
a treasury and payment-control layer that manages budgets, policies,
delegated spending, routing, and settlement across x402-enabled services.

## Why this exists

x402 v2's own specification is explicit about its boundaries: _"Out of
Scope: this specification does not include client-side budget
management, session handling mechanisms, [or] spending policy and
correlation tracking"_ (verified against the current spec — see
[`docs/RESEARCH.md`](docs/RESEARCH.md)). x402 answers _"can this specific
signed payment be settled."_ It has nothing to say about _"should this
agent be allowed to spend this money at all, right now, on this
provider."_ That second question — under concurrency, under retries,
across a crash, with money that isn't actually yours (it's your
organization's) — is what this project is about.

## Architecture

```mermaid
flowchart LR
    Agent["AI Agent"] -->|"1 create session / request resource"| API["Treasury API (Fastify)"]
    API --> Policy["Policy Engine"]
    API --> Router["Routing Engine"]
    API --> Ledger["Ledger / Reservations"]
    Ledger --> PG[("PostgreSQL")]
    API --> Adapter["x402 Adapter"]
    Adapter -->|"verify / settle"| Facilitator["x402 Facilitator"]
    Facilitator --> Base[("Base (Sepolia / mainnet)")]
    Adapter -->|"HTTP 402 + PAYMENT-REQUIRED / PAYMENT-SIGNATURE"| Provider["x402-enabled Provider"]
    Provider -->|"resource"| API
    API -->|"resource + spend summary"| Agent
```

Full sequence diagram, ER diagram, budget-hierarchy diagram, and the
accounting invariant behind them: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Key engineering problems this project solves

- **Atomic hierarchical budget reservation** — `SELECT ... FOR UPDATE`
  locks a budget's entire ancestor chain (task → agent → org), root-first,
  inside one transaction, so a leaf spend can never exceed what any
  ancestor actually has left. Proven under real concurrent load, not
  simulated: 10 parallel $0.50 reservations against a $1.00 budget yield
  exactly 2 successes.
- **Idempotent payment execution** — a client-supplied `Idempotency-Key`,
  claimed via a unique-constraint race, means 5 identical retries after a
  timeout produce exactly one logical payment, not five.
- **Append-only accounting** — a `CHECK`-constrained invariant
  (`available + reserved + spent = allocated`) plus a journal whose
  `UPDATE`/`DELETE` privileges are revoked from the runtime role at the
  database level, not just by application convention (verified directly
  against Postgres, not assumed).
- **Delegated agent budgets** — a child agent's budget is just another
  node in the same hierarchy; it structurally cannot spend more than it
  was delegated, or more than its parents can still afford, and a
  database trigger rejects a cycle even via raw SQL.
- **Cost-aware routing** — a documented, non-hidden weighted-scoring
  formula over real provider metrics, not an ML model with nothing to
  learn from.
- **Settlement reconciliation** — a payment stuck in an uncertain state
  (facilitator `settlement_pending`, or a crash between a decision and
  its side effect) is resolved by a dedicated job and recorded in an
  audit trail, never silently mutated.
- **Real x402 v2 integration** — verified against the actual protocol
  spec and the actual installed `@x402/*` packages, including a header
  rename (`PAYMENT-REQUIRED`/`PAYMENT-SIGNATURE`) that a lot of
  copy-pasted v1 tutorials get wrong.

## Quick start

```bash
pnpm install
cp .env.example .env
docker compose up -d      # Postgres — or point DATABASE_URL at your own instance
pnpm db:migrate
pnpm db:seed               # optional — the demo scripts create their own org anyway
```

```bash
pnpm demo:research         # one end-to-end payment, real HTTP, polished output
pnpm demo:failures         # budget-exceeded, duplicate-retry, concurrency, reconciliation
```

Both demo commands spawn the Treasury API and two demo x402 providers as
real local processes and talk to them over real HTTP — see
[`docs/DEMO.md`](docs/DEMO.md) for exactly what happens and sample
output.

## Demo

```
x402 Treasury Demo
────────────────────────────────────────────────────────
Providers discovered: 3
Provider C (balanced)            $0.015 |  672ms | 100.0% | score=0.1895
Provider A (cheap, slow)         $0.010 | 1526ms | 100.0% | score=0.3000
Provider B (expensive, fast)     $0.030 |  309ms | 100.0% | score=0.4000

Routing
Selected: Provider C (balanced)

Payment
Policy checks
✓ SESSION_BUDGET_LIMIT  ✓ PER_TRANSACTION_LIMIT  ✓ UNKNOWN_PROVIDER_LIMIT
✓ DUPLICATE_PAYMENT_WINDOW  ✓ PROVIDER_ALLOWLIST

Result
HTTP 200
Payment settled (mock): 0xMOCK77ea3bc2acb0f918cf5bc60ba45c7673b2734e020cba09ddffec0825b0

Budget
Allocated $1.000000   Spent $0.015000   Reserved $0.000000   Available $0.985000
```

`PAYMENT MODE: MOCK` is printed on every run of this command — see
[x402 integration](#x402-integration) for what "mock" actually means here
and how to run against real Base Sepolia.

## Budget hierarchy

```mermaid
flowchart TB
    Org["Org Treasury Budget\n$100/day (root, no parent)"]
    Org --> AgentA["Research Agent Budget\n$20/day"]
    Org --> AgentB["Coding Agent Budget\n$30/day"]
    AgentA --> Task1["Task #123 Budget\n$2 total"]
    AgentA --> Task2["Task #124 Budget\n$5 total"]
    AgentA --> Sub["Delegated Sub-Agent Budget\n<= parent grant"]
```

A reservation locks and checks **every** budget on this tree from root to
leaf in one transaction — spending at a leaf simultaneously consumes
capacity at every ancestor. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
§4 for the exact invariant and why this isn't classic double-entry
bookkeeping (and [`docs/DECISIONS.md`](docs/DECISIONS.md) ADR-004 for the
alternative considered and rejected).

## Failure handling

Every failure mode below is exercised by `pnpm demo:failures` against the
real running system, and by the automated test suite against real
Postgres — not asserted, demonstrated:

| Scenario                                                                  | What happens                                                                        |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Session budget too small for the live-quoted price                        | `402` + `SESSION_BUDGET_EXCEEDED`, **zero** funds reserved                          |
| Same `Idempotency-Key` retried 5 times                                    | One logical payment intent; retries 2–5 replay the original response                |
| 10 concurrent $0.50 requests against a $1.00 budget                       | Exactly 2 succeed, 8 fail deterministically, budget never goes negative             |
| Settlement lands in an uncertain state                                    | Reservation stays `reserved` (not lost, not spent) until reconciliation resolves it |
| Reconciliation can't determine the outcome                                | Marked `MARKED_FOR_REVIEW`, not guessed                                             |
| A process crashes between "decided FAILED" and "released the reservation" | The next reconciliation run finds and repairs it                                    |
| Delegated child tries to overspend its own grant                          | Blocked by the same reservation the parent's own spending goes through              |

Full reasoning: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §5 (state
machine) and §7 (reconciliation).

## Tests

```bash
pnpm test               # 67 unit tests — no database
pnpm test:integration   # 32 integration tests — real Postgres (docker compose up -d first)
```

The concurrency test is the one worth reading directly:
[`packages/ledger/test/concurrency.integration.test.ts`](packages/ledger/test/concurrency.integration.test.ts).
It launches 10 genuinely concurrent reservation attempts against a real
Postgres instance and asserts the budget invariant holds — this is the
test that actually proves the locking strategy in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §4.4, not just documents
it.

CI (`.github/workflows/ci.yml`) runs lint, format check, typecheck, unit
tests, and the full integration suite against a real Postgres service
container on every push.

## x402 integration

This project verified the current x402 v2 protocol and the actual
installed `@x402/*` packages before writing any adapter code — see
[`docs/RESEARCH.md`](docs/RESEARCH.md) for primary sources, exact
verified package versions, and a real deviation from widely-copied v1
tutorials (the `X-PAYMENT`/`X-PAYMENT-RESPONSE` headers were renamed to
`PAYMENT-REQUIRED`/`PAYMENT-SIGNATURE` in v2).

Two adapters implement one `PaymentRail` interface
([`docs/DECISIONS.md`](docs/DECISIONS.md) ADR-007):

- **`MockX402Adapter`** — used by CI, `pnpm test:integration`, and both
  demo commands. Performs **real HTTP requests with the real x402 v2
  header names** against a real local resource server; only the
  signature itself and the settlement are simulated (no blockchain). This
  is what makes `PAYMENT MODE: MOCK` appear on every demo run — it is
  never claimed to be a real settlement.
- **`RealX402Adapter`** — Base Sepolia only (hard-refuses any other
  network in code, not just configuration), using the actual installed
  `@x402/fetch`/`@x402/evm` packages (`wrapFetchWithPayment`, `x402Client`,
  `ExactEvmScheme` — read directly from the installed packages' `.d.ts`
  files, not guessed). Exercised manually only; **CI never runs this
  path** and this README does not claim it does.

## Limitations

- `RealX402Adapter` was implemented against the verified SDK surface but
  not exercised end-to-end against a live facilitator during development
  — treat it as a documented starting point, not a proven integration.
- No production-grade auth (API keys are SHA-256-hashed bearer tokens,
  no rotation/expiry/scoping beyond org-vs-agent).
- No request-rate limiting at the HTTP layer.
- `upto` and `batch-settlement` x402 schemes, and non-EVM networks, are
  not implemented.
- Human-approval `REVIEW` decisions from the policy engine are reported
  to the caller but there's no resume-after-approval flow yet — treated
  the same as a block for now.
- See [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) §4 for an explicit
  list of what this project does **not** claim to do (no fraud detection,
  no provider-identity verification, no resource-quality guarantee).

## Roadmap

- Human-approval resume flow for `REVIEW` decisions.
- Scheduled/automatic reservation-expiry sweeps and reconciliation runs
  (both exist as callable functions today; nothing runs them on a
  timer).
- A budget re-parenting API, with the cycle-prevention trigger that
  already exists for it.
- A lightweight read-only dashboard (spec §33) — deliberately not built
  before core payment correctness, per the project's own stated
  priorities.
- Prometheus-compatible metrics export (an internal counter abstraction
  exists; nothing scrapes it yet).
- A full user/identity system beyond org- and agent-scoped API keys.

## Repository layout

```
apps/
  api/                Treasury REST API (Fastify)
  demo-agent/          CLI that drives the whole system over real HTTP
  demo-provider-a/      x402-enabled demo paid API (cheap/slow + balanced tiers)
  demo-provider-b/      x402-enabled demo paid API (expensive/fast)
packages/
  shared/              Money type, IDs, error/reason-code vocabulary, clock
  db/                  Hand-written SQL migrations + Drizzle schema + seed
  ledger/              Append-only ledger, atomic reservations, state machine, reconciliation
  policy-engine/       Composable, pure spending-policy rules
  router/              Deterministic cost-aware provider routing
  x402-adapter/        PaymentRail interface + mock/real implementations
docs/
  RESEARCH.md          Primary-source x402 v2 protocol research
  ARCHITECTURE.md      Domain model, ER diagram, accounting invariant, state machine
  DECISIONS.md         ADRs
  ROUTING.md           Routing formula and worked example
  THREAT_MODEL.md      Threats and mitigations
  DEMO.md              Demo walkthrough with sample output
```

## License

MIT — see [`LICENSE`](LICENSE).
