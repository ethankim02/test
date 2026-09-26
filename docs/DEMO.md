# Demo Walkthrough

This document covers two entirely separate things. Do not confuse them:

- **MOCK PAYMENT DEMO** (`pnpm demo:research`, `pnpm demo:failures`, and
  everything CI runs) — real HTTP, real policy/ledger/routing logic, but
  settlement is simulated by an in-memory mock facilitator. **No
  blockchain transaction of any kind occurs.** Every payment mode line
  printed says `PAYMENT MODE: MOCK`.
- **REAL BASE TESTNET x402 DEMO** (`pnpm --filter @x402-treasury/x402-adapter
run testnet:check`, and a real payment flow beyond it) — uses the actual
  Base Sepolia testnet and a real x402 facilitator. Moves testnet USDC
  (worthless test tokens), never mainnet funds. See "Real Base Testnet
  x402 Demo" below for exact status: **completed once end-to-end on
  2026-09-26** — one real $0.001 settlement through the full Treasury
  path, tx hash and explorer link in the README and in that section.

## MOCK PAYMENT DEMO

Everything in this section runs entirely against `MockX402Adapter` (see
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
pnpm test               # 74 unit tests, no database
docker compose up -d    # if not already running
pnpm db:migrate         # against treasury_test if you set DATABASE_URL/MIGRATOR_DATABASE_URL there
pnpm test:integration   # 32 integration tests against real Postgres
```

**Careful with `DATABASE_URL`:** the integration suite `TRUNCATE`s every
domain table in whatever database it resolves. If `DATABASE_URL` /
`MIGRATOR_DATABASE_URL` are exported in your shell and point at
`treasury_dev`, the suite wipes that database — including any real-payment
records. Point both at a dedicated `treasury_test` database for the run
(`docker compose exec postgres psql -U treasury_migrator -d postgres -c
'CREATE DATABASE treasury_test OWNER treasury_migrator;' -c 'GRANT CONNECT
ON DATABASE treasury_test TO treasury_app;'`, then export the two URLs with
`treasury_test`).

The concurrency test in particular
(`packages/ledger/test/concurrency.integration.test.ts`) is worth reading
directly — it's the test the README points to as evidence for the
project's central engineering claim.

## REAL BASE TESTNET x402 DEMO (manual, not part of any automated test or CI)

CI and the two `pnpm demo:*` commands above never touch this path.
`RealX402Adapter` (`packages/x402-adapter/src/real-adapter.ts`)
hard-refuses any network other than `eip155:84532` (Base Sepolia) — there
is no way to point it at mainnet.

### Step 1 — readiness check (safe, costs nothing, no real key required)

```bash
pnpm --filter @x402-treasury/x402-adapter run testnet:check
```

This constructs the full real-adapter dependency chain
(`privateKeyToAccount` → `ExactEvmScheme` → `x402Client` →
`wrapFetchWithPayment`) against the actual installed `@x402/evm`/
`@x402/core`/`@x402/fetch` packages — not guessed APIs, read directly from
the installed packages' type declarations (ADR-007) — using a
construction-only key (Anvil's well-known public test account #0, which
holds no real funds anywhere) if you haven't set `X402_PAYER_PRIVATE_KEY`.
It then attempts one live `GET` against the facilitator's `/supported`
endpoint and reports exactly what happened.

**Result from a machine with normal outbound access (2026-09-26):**

```
✓ Construction path succeeded: privateKeyToAccount -> ExactEvmScheme -> x402Client -> wrapFetchWithPayment
  (all four are real exports of the installed @x402/evm, @x402/core, @x402/fetch packages)

✓ Reached facilitator: HTTP 200
{"kinds":[{"x402Version":2,"scheme":"exact","network":"eip155:84532"}, ... ]}
Network access confirmed. A real payment flow can proceed from this environment.
```

(An environment whose egress policy blocks `x402.org`,
`sepolia.base.org` or `sepolia.basescan.org` — as this project's original
sandbox did, see `docs/RESEARCH.md` §13 — prints `✗ Blocked …` here
instead; that is a network setting, not a code or credential problem.)

### Step 2 — what you need to go further

Once the readiness check reaches the facilitator successfully:

| Variable                 | Type                           | Where to get it                                                                                                                                                                                | Costs anything?   |
| ------------------------ | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `X402_ADAPTER_MODE`      | string, literal `real`         | set it yourself                                                                                                                                                                                | no                |
| `X402_NETWORK`           | string, literal `eip155:84532` | already the default                                                                                                                                                                            | no                |
| `X402_FACILITATOR_URL`   | URL                            | `https://x402.org/facilitator` (public, verified testnet-only — confirm it's still up)                                                                                                         | no                |
| `X402_PAYER_PRIVATE_KEY` | `0x`-prefixed hex private key  | `pnpm --filter @x402-treasury/x402-adapter run testnet:wallet` — generates a **fresh, throwaway** key and writes it straight to `.env`, printing only the public address, never the key itself | no                |
| — funding that key       | testnet USDC                   | `https://faucet.circle.com` — dispenses testnet USDC on Base Sepolia                                                                                                                           | no, it's a faucet |
| `X402_PAYTO_ADDRESS`     | address                        | any valid address you control (or generate one)                                                                                                                                                | no                |

No testnet ETH is needed for the payer — the `exact`/EIP-3009 flow is
gasless for the payer; the facilitator broadcasts and pays gas
(`docs/RESEARCH.md` §10). Nothing here costs real money; testnet USDC has
no market value.

Set `X402_ADAPTER_MODE=real` and the variables above in `.env`, then start
the API normally (`pnpm dev:api`) — `apps/api/src/index.ts` already
switches between `MockX402Adapter` and `RealX402Adapter` based on
`X402_ADAPTER_MODE`, refusing to start in `real` mode at all unless
`X402_FACILITATOR_URL` and `X402_PAYER_PRIVATE_KEY` are both set
(`apps/api/src/config.ts`). It logs `PAYMENT MODE: REAL BASE TESTNET`
instead of `PAYMENT MODE: MOCK` on startup so the mode is never ambiguous
from the logs. This wiring has now been exercised end-to-end once (see the
README for the transaction hash). Notes from that run: `apps/api` does not
load `.env` by itself — export the variables (or `node --env-file=.env`)
in the process that starts it — and port 3000 may already be taken on your
machine, so set `API_PORT` if `pnpm dev:api` fails to bind.

**Never paste a private key into chat with an AI assistant, a support
ticket, or any other text channel.** Set it as a local environment
variable / `.env` entry (already gitignored) instead — that's the only
place this codebase ever reads it from.

### Step 3 — a genuine x402-protected target: `demo-provider-a`'s real server

Every provider under "MOCK PAYMENT DEMO" above settles through this
project's own in-memory fake facilitator (`mockSettle`) — even with
`X402_ADAPTER_MODE=real` on the API side, those endpoints never send a
real 402 challenge, so paying them can never produce a real settlement.

`apps/demo-provider-a/src/real-server.ts` is a **separate, genuinely
x402-protected endpoint**, wired with the official SDKs exactly as their
own README documents:

```typescript
import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { paymentMiddleware } from '@x402/fastify';
```

It never touches a private key — a resource server only needs its own
public payout address (`payTo`). Start it with:

```bash
X402_REAL_PAYTO_ADDRESS=0xYourTestnetPayoutAddress \
  pnpm --filter @x402-treasury/demo-provider-a run start:real
```

It listens on port 4011 (`DEMO_PROVIDER_A_REAL_PORT` to override) and
serves `GET /real/research`, priced at `X402_REAL_PRICE` (default
`$0.001`) on `X402_NETWORK` (default `eip155:84532`), verified against
`X402_FACILITATOR_URL` (default `https://x402.org/facilitator`). It logs
`PAYMENT MODE: REAL` on startup, never `MOCK`, and must never be started
from CI or an automated test.

To pay it through the **full** Treasury path (not a bypass — Demo Agent →
Treasury API → session → policy → reservation → `RealX402Adapter` → 402 →
payment → facilitator verify/settle → ledger capture), register it as an
ordinary provider once the API is running with `X402_ADAPTER_MODE=real`:

```bash
curl -X POST http://localhost:3000/providers \
  -H "content-type: application/json" \
  -d '{
    "name": "Provider A (real Base Sepolia)",
    "baseUrl": "http://localhost:4011",
    "resourcePath": "/real/research",
    "category": "research",
    "network": "eip155:84532",
    "trustStatus": "TRUSTED"
  }'
```

then send `POST /payments/intents` for that `providerId` the same way
`apps/demo-agent/src/demo-research.ts` does for the mock providers.
`PaymentRail` is the same interface either way (ADR-007); only the
provider being paid, and the adapter behind it, differ. (A first version of
this section claimed no adapter changes were needed; the first real run
showed otherwise — `RealX402Adapter.discoverRequirements` had to read the
real `PAYMENT-REQUIRED` header and `settlePayment` had to return the
settlement hash from `PAYMENT-RESPONSE`. Both are now implemented and
unit-tested in `packages/x402-adapter/src/real-adapter.test.ts`.)

Useful register-time settings from the completed run: a $0.05 session
budget, an ORG `PER_TRANSACTION_LIMIT` of `10000` minor units ($0.01) and a
`PROVIDER_ALLOWLIST` containing just this provider. The default price is
`$0.001`, and `X402_REAL_PAYTO_ADDRESS` set to the payer's own address makes
the payment a self-transfer — still a real on-chain settlement (BaseScan
shows the 0.001 USDC `Transfer`), but the payer's balance will not move; use
a different payout address if you want to watch it change.
