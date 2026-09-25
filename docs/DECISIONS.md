# Architecture Decision Records

## ADR-001: Language and runtime — TypeScript on Node.js

**Context.** The official x402 SDK is published as TypeScript packages
(`@x402/*`, verified on npm — see `RESEARCH.md`); a Go and Python
implementation also exist in the same monorepo, but TypeScript has the most
complete, actively-versioned set of transport integrations (Fastify,
Express, Hono, Next, fetch, axios) as of this research pass.

**Decision.** Node.js 22 LTS + TypeScript, strict mode.

**Alternatives considered.**
- Go: has an x402 implementation too, and would be a reasonable choice for
  a payments backend, but the SDK surface (facilitator client,
  framework middleware) is less complete than TypeScript's as verified.
- Python: same tradeoff as Go, plus weaker fit for the Fastify/Zod-style
  schema-first API this project wants.

**Tradeoffs.** TypeScript's `number` cannot safely represent large
monetary values without care — addressed directly in ADR-003, not treated
as a reason to avoid TypeScript.

## ADR-002: Database — PostgreSQL

**Context.** The core problem is transactional correctness under
concurrency (atomic reservations, no overspend, idempotency, an
append-only ledger with a DB-enforced invariant).

**Decision.** PostgreSQL 16, accessed only through parameterized
queries/the query builder — never raw string interpolation.

**Alternatives considered.**
- SQLite: fine for the demo apps' own local state, wrong choice for a
  system whose entire value proposition is "correct under concurrent
  writers" — SQLite serializes all writers at the file level, which would
  make the concurrency test trivially "pass" for the wrong reason.
- A document store (Mongo/Dynamo): would require reimplementing
  row-level locking and constraint checking that Postgres provides
  natively (`SELECT ... FOR UPDATE`, `CHECK` constraints, transactional
  DDL). Rejected — no reason to build what the database already does
  correctly.

**Tradeoffs.** Requires a running Postgres for integration tests; addressed
with `docker-compose.yml` and CI running a Postgres service container
rather than mocking the database in the tests that exist specifically to
prove database-level correctness.

## ADR-003: Monetary representation — integer minor units as `bigint`

**Context.** USDC has 6 decimals. JavaScript `number` is an IEEE-754
double: safe integers only up to 2^53-1, and any arithmetic involving
fractional decimals (`0.1 + 0.2`) is unsafe for money regardless of
magnitude.

**Decision.** Every monetary amount is stored and computed as an integer
count of the asset's smallest unit (e.g. `1000000` = 1.00 USDC), typed as
`bigint` in TypeScript and `bigint`/`numeric(0)` — actually Postgres
`bigint` (8-byte integer) — in the database. A branded `Money` type
(`packages/shared/src/money.ts`) wraps a `bigint` plus an asset/decimals
tag and only exposes checked arithmetic (`add`, `sub`, `isNegative`, ...);
there is no implicit conversion to/from `number` anywhere in domain code.
Formatting to a human string (`"$0.030"`) happens only at the
presentation edge (API JSON responses, CLI output).

**Alternatives considered.**
- `Decimal`/arbitrary-precision library (e.g. `decimal.js`): unnecessary —
  once you're in integer atomic units, plain integer arithmetic is exact
  and `bigint` is native to the language and to Postgres's `bigint` column
  type, with no added dependency.
- Storing dollars as floating point with a documented "round to 3dp"
  convention: this is the exact anti-pattern the task explicitly forbids
  (§8, §43) and was never seriously considered.

## ADR-004: Ledger model — append-only journal + per-budget balance
counters + balanced multi-entry transactions (not classic double-entry)

See `ARCHITECTURE.md` §4 for the full reasoning. Summary:

**Decision.** Two structures, updated together in one DB transaction per
financial event:
1. `ledger_entries` — append-only (DB-level `UPDATE`/`DELETE` revoked for
   the app role), one or more rows per event, grouped by
   `ledger_transaction_id`.
2. `budgets.{available,reserved,spent}_minor` — materialized counters with
   a `CHECK (available_minor + reserved_minor + spent_minor =
   allocated_minor AND available_minor >= 0 AND reserved_minor >= 0 AND
   spent_minor >= 0)` constraint.

A reservation/settlement/release produces **one ledger entry per budget on
the ancestor path** (task, agent, org), not a single entry, because the
invariant that must hold is "capacity is consumed at every level
simultaneously," not "value moves between exactly two accounts."

**Alternatives considered.**
- **Classic double-entry with abstract GL accounts** (e.g. a
  `Treasury:Liabilities:AgentX` account credited and an
  `Expenses:ProviderY` account debited): a faithful double-entry ledger
  models value moving between two parties. That's a good fit for
  *settlement* (money leaves the org and goes to a provider) but a poor
  fit for *budget allocation*, where nothing actually moves when a parent
  grants a child a ceiling — the parent doesn't lose spendable capacity
  the moment it allocates, only when something is actually spent, and then
  it loses capacity at every level at once, not just its own. Modeling
  that faithfully in classic double-entry requires either fictitious
  clearing accounts per parent-child pair or a chart-of-accounts more
  complex than any config an operator of this project would actually set
  up. Rejected as overfitting a well-known pattern to a domain it doesn't
  quite match, which the task explicitly warns against ("do not force
  [complexity] into the problem").
- **Single mutable `balance` column per budget, no journal**: rejected —
  no audit trail, and the task explicitly requires an append-only ledger.
- **Event-sourced ledger only (derive balance columns by replay on every
  read)**: correct but throws away the ability to cheaply enforce the
  invariant with a `CHECK` constraint and a row lock at write time; would
  require re-deriving balances (a `SUM` over history) inside the same
  critical section as the concurrency-sensitive reservation, which is
  strictly more work than maintaining a materialized counter that the
  journal can be replayed to verify against (which reconciliation does
  anyway, getting both properties).

## ADR-005: Concurrency strategy — pessimistic row locking (`SELECT ...
FOR UPDATE`), fixed lock order, `READ COMMITTED`

**Decision.** See `ARCHITECTURE.md` §4.4. Lock every budget on the
ancestor path, root-to-leaf by ascending id, inside one transaction, at
`READ COMMITTED` isolation.

**Alternatives considered.**
- **Optimistic concurrency control** (version column, retry on conflict):
  poor fit for a scenario designed around high contention on a single
  resource (10 agents racing for the last $1) — most participants would
  retry at least once, and OCC gives no natural way to say "no" to the 8
  that should lose; it would just mean 8 retries that discover the same
  loss on the second (or later) attempt. Pessimistic locking makes losers
  fail once, immediately.
- **`SERIALIZABLE` isolation for the whole transaction**: strictly stronger
  guarantee than needed here — the invariant depends only on the explicitly
  locked rows, so `SERIALIZABLE`'s extra predicate-locking and
  abort-and-retry machinery adds cost without adding correctness for this
  specific operation. `SERIALIZABLE` would be the right default if the
  transaction read/wrote rows outside what's explicitly locked, which
  reservations do not.
- **Application-level distributed lock (Redis)**: rejected per the
  project's own anti-goals ("add Redis unless it solves a real problem") —
  Postgres row locks already solve this problem inside the same
  transaction that needs to be atomic anyway.

## ADR-006: Idempotency strategy — persisted key + request hash, DB unique
constraint as the atomic claim

**Decision.** `idempotency_keys (agent_id, key)` is `UNIQUE`. Claiming a
key is `INSERT ... ON CONFLICT (agent_id, key) DO NOTHING RETURNING *`;
the caller that gets a row back is the "first writer" who proceeds to
create the payment intent; every other caller (including true concurrent
racers) reads back the existing row. If the existing row's
`request_hash` (SHA-256 of a canonicalized JSON body) doesn't match the
new request's hash, the request is rejected with `IDEMPOTENCY_CONFLICT`
(409) rather than silently reusing the old response. Completed rows store
the resulting `payment_intent_id` so a retry after full completion returns
the same intent's current state instead of re-running any logic.

**Alternatives considered.**
- **Hash-only, no persisted key row** (recompute idempotency purely from
  request content): can't distinguish "same logical request, expected to
  be a retry" from "coincidentally identical request, should be a new
  charge" — the whole point of a client-supplied key is that the *caller*
  asserts retry intent, not that Treasury infers it from payload
  similarity.
- **Advisory lock instead of unique constraint**: unique constraint +
  `ON CONFLICT` is simpler, self-documenting in the schema, and gives a
  permanent record for free (an advisory lock is released and leaves no
  row to look up later for debugging/audit).

## ADR-007: x402 adapter design — `PaymentRail` interface, protocol
objects never leak past the adapter boundary

**Decision.** `packages/x402-adapter` exposes one interface:

```ts
interface PaymentRail {
  discoverRequirements(resource: ResourceRef): Promise<PaymentRequirements>;
  preparePayment(requirements: PaymentRequirements, payer: PayerContext): Promise<SignedPayment>;
  verifyPayment(signed: SignedPayment, requirements: PaymentRequirements): Promise<VerifyResult>;
  settlePayment(signed: SignedPayment, requirements: PaymentRequirements): Promise<SettleResult>;
}
```

`MockX402Adapter` implements this in-memory (deterministic, used in every
automated test and CI). `RealX402Adapter` implements it using the verified
`@x402/core`, `@x402/evm`, and `@x402/fetch` packages against Base Sepolia
(`eip155:84532`) and is exercised only by a manually-run script, never CI.
The rest of the codebase (policy engine, ledger, router, API) depends only
on `PaymentRail` and the internal domain types it returns — it never
imports an `@x402/*` type directly. `@x402/*` packages are pinned to exact
versions (no `^`/`~`) inside `packages/x402-adapter` and `apps/demo-provider-*`
only, per the version-skew note in `RESEARCH.md` §9.

**Alternatives considered.**
- **Depend on `@x402/*` types throughout the domain layer**: rejected —
  couples core financial logic (which needs to be independently unit
  testable, per the task's explicit principle E) to a third-party SDK's
  evolution. A v3 protocol header rename would then touch the policy
  engine instead of one adapter file.
- **Skip the mock adapter, always hit a real facilitator in tests**: would
  make CI non-deterministic and dependent on public testnet
  infrastructure staying up — explicitly warned against in the task
  (§20).

## ADR-008: Routing algorithm — deterministic weighted scoring over
normalized, filtered candidates (no ML)

**Decision.** See `docs/ROUTING.md` for the full formula. Summary: filter
providers that violate hard constraints (`maxPrice`, `maxLatencyMs`,
`minSuccessRate`, allowlist/denylist), then score survivors with
explicit, configured, non-hidden weights per objective
(`cheapest`/`fastest`/`most_reliable`/`balanced`), lowest score wins, and
persist every candidate considered plus why it was rejected or its score,
to `routing_decisions`.

**Alternatives considered.**
- **A learned ranking model**: rejected per the task's explicit anti-goal
  — there is no historical labeled routing-outcome dataset this project
  has access to, and a deterministic formula is more auditable for a
  financial-control system where "why did you pick this provider" must be
  answerable exactly, not probabilistically.
- **Simple cheapest-only routing with no scoring**: doesn't satisfy the
  stated requirement that different objectives (fastest, most reliable,
  balanced) produce different, defensible provider selections, and doesn't
  demonstrate the routing/optimization engineering the project is meant to
  showcase.
