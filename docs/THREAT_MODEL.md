# Threat Model

This document separates what the **x402 protocol itself** already
protects against from what **x402 Treasury** adds, then works through the
specific risks listed in the project brief. Claims here are scoped to
what this codebase actually implements — see `docs/RESEARCH.md` for what
was verified against primary sources and what is explicitly out of scope.

## 1. What x402 already protects against

Per `docs/RESEARCH.md` §5–§7, the `exact`/EVM scheme's EIP-3009
signature scheme + facilitator model already provides:

- **Payment authenticity** — a payment authorization is a signature over
  a specific `(from, to, value, validAfter, validBefore, nonce)` tuple.
  Only the holder of the payer's private key can produce a valid one.
- **Replay protection for one signed authorization** — the `nonce` +
  validity window prevent the _same signed payload_ from being settled
  twice.
- **Facilitator cannot redirect funds** — amount and destination are
  inside the signed payload; a malicious or compromised facilitator can
  withhold or delay settlement, but cannot alter where the money goes.

x402 Treasury depends on these properties and does not attempt to
re-implement or second-guess them.

## 2. What x402 explicitly does not cover (and Treasury does)

Quoting the v2 spec directly (`docs/RESEARCH.md` §11): _"Client-side
budget management... Session handling mechanisms... Spending policy and
correlation tracking"_ are out of scope for the protocol. This is the
entire reason this project exists, and it is also where most of this
threat model's actual content lives — see §3 onward.

## 3. Threats and this project's mitigation

### Private-key leakage

- **Treasury itself never holds, generates, or transmits a private key.**
  `MockX402Adapter` has no concept of a key at all. `RealX402Adapter`
  reads `X402_PAYER_PRIVATE_KEY` once from the environment at process
  start to construct a viem local account; the key is never logged,
  never persisted to the database, and never included in any API
  response, ledger entry, or `payment_intents.x402_payload` (that column
  stores the _signed payload_, which is safe to store — a signature
  cannot be used to derive the private key).
- The `.env.example` file documents the variable but contains no value;
  `.gitignore` excludes `.env`.
- **Residual risk**: if the operator's shell environment or process
  supervisor logs environment variables, the key could leak outside this
  codebase's control. This is a deployment concern, not something
  application code can fully close — documented here so it isn't
  silently assumed away.

### Malicious or compromised provider

- A provider fully controls its own `PaymentRequirements` (price, network,
  payTo) — Treasury has no way to independently verify a provider's
  _identity_ beyond the operator manually setting `trust_status` when
  registering it (`TRUSTED` / `KNOWN` / `UNKNOWN`). This is intentionally
  simple, opt-in metadata, not a cryptographic attestation — see
  "untrusted metadata" below.
- **Price manipulation** is bounded by policy: `PerTransactionLimit`,
  `UnknownProviderLimit`, and `CategoryDailyLimit` all apply to the
  _live-quoted_ price (never a client-supplied one — see "budget bypass"
  below), so a provider that suddenly quotes 100x its configured price
  still cannot exceed the org's own limits.
- A provider that takes payment and never returns a usable resource is
  not currently distinguishable by Treasury from a provider that returned
  a resource — the response body is passed through whatever the
  facilitator/provider returned once settlement succeeds. This is a real
  gap: resource-quality verification is out of scope for v1 (see README
  Roadmap).

### Provider URL spoofing

- Provider `base_url`/`resource_path` are operator-entered, org-scoped
  configuration (`POST /providers`), not agent-suppliable at payment
  time — an agent selects a provider by its Treasury-assigned `id`, never
  by URL. An agent cannot redirect a payment to an arbitrary URL.
- **Residual risk**: an operator who registers a provider with an
  incorrect or malicious URL will have Treasury faithfully pay it. This
  is the same trust boundary as any allowlist-based system — the
  allowlist itself must be curated correctly.

### Replay / duplicate-payment attempts

- Two independent, complementary mechanisms:
  1. **Idempotency-Key** (ADR-006): protects against _infrastructure_
     retries (timeouts, client retry logic) — same caller-asserted
     intent, replayed safely.
  2. **`DuplicatePaymentWindow`** policy rule: protects against a
     _different_ caller/key attempting what looks like the same logical
     purchase (same session + provider) within a short window, even
     without reusing a key.
- Neither mechanism is a substitute for x402's own nonce-based replay
  protection at the settlement layer — they operate one level up, at
  "should Treasury even attempt this payment," not "is this specific
  signature reusable."

### Agent compromise (a legitimate agent starts behaving maliciously /

erratically)

- **Blast radius is bounded by the budget hierarchy.** A compromised
  agent cannot spend more than its own budget node's `allocated_minor`,
  and every reservation simultaneously checks every ancestor's capacity
  (docs/ARCHITECTURE.md §4.3) — a compromised leaf agent cannot drain the
  org treasury beyond what was actually delegated to it.
- `PaymentVelocityLimit` bounds request _rate_, independent of amount —
  relevant if a compromised agent starts looping.
- An API key is the sole authentication factor for "is this really the
  agent." Key revocation (`api_keys.revoked_at`) lets an operator cut off
  a compromised agent immediately; there is no automatic anomaly
  detection (see §6, "no fraud-detection claims").

### Budget bypass

- **The price used for every policy check, reservation, and ledger entry
  is always the live-quoted `amountMinor` from the provider's actual 402
  response** (`apps/api/src/payment-flow.ts`), never a value supplied in
  the request body. An agent cannot under-report what it's about to
  spend to slip past a limit.
- `requireAgentMatch` (`apps/api/src/auth.ts`) prevents an agent-scoped
  key from acting as a different `agentId` — closing the specific bypass
  the task brief calls out ("must not be able to consume another agent's
  budget merely by changing agentId in JSON"), verified by an
  authorization integration test.

### Race-condition overspend

- The core subject of `docs/ARCHITECTURE.md` §4.4 and ADR-005:
  `SELECT ... FOR UPDATE` on the full ancestor chain, root-to-leaf, inside
  one transaction. Proven under real concurrent load by the mandatory
  concurrency test (10 concurrent $0.50 reservations against a $1.00
  budget → exactly 2 succeed, budget never negative) against real
  Postgres, not simulated.

### Stale reservation abuse

- A reservation that's never captured or released (crashed payment
  attempt, abandoned request) would otherwise lock funds forever. The
  expiry sweep (`packages/ledger/src/expire-sweep.ts`) releases any
  reservation past its `expires_at` back to `available`, tested directly.
- **Residual risk**: the sweep must actually be run (e.g. on a schedule,
  or via `pnpm reconcile`, which is also where the payment-intent-level
  version of this problem — a `FAILED` intent whose reservation never
  got released — is repaired). This project does not ship a cron
  scheduler; running the sweep periodically is an operational
  responsibility documented in the README, not automated.

### Malicious child agent (delegation abuse)

- A delegated child budget's own `allocated_minor` is a hard ceiling
  enforced by the DB `CHECK` constraint on its own row, independent of
  how much capacity its parent has left (Scenario G, tested). A malicious
  child cannot spend past what was explicitly delegated to it, and cannot
  spend past what its ancestors can still afford, because both are
  checked in the same atomic reservation.
- **Cycle prevention**: no API exposes re-parenting an existing budget, so
  a cycle cannot be constructed through normal use; a Postgres trigger
  (`migrations/0002_budget_cycle_guard.sql`) additionally rejects any
  attempt to create one at the database level, tested directly via raw
  SQL.

### Untrusted / unverified metadata

- `providers.trust_status` (`TRUSTED`/`KNOWN`/`UNKNOWN`) is **operator-set
  configuration, not a cryptographic attestation of anything** — Treasury
  does not claim to have verified a provider's real-world identity, legal
  entity, or on-chain reputation. This is stated explicitly in
  `docs/ARCHITECTURE.md` §"configured metadata vs. observed metrics vs.
  verified onchain information": the three are always kept distinct and
  never conflated in the data model or the UI.
- `provider_metrics` (latency/success observations) are Treasury's own
  recorded observations, not third-party attestations — a new or
  low-volume provider will have thin or absent metrics, which the router
  handles by falling back to configured defaults rather than fabricating
  confidence.

### Incorrect chain configuration

- `RealX402Adapter` hard-refuses any network string other than
  `eip155:84532` (Base Sepolia) — see `packages/x402-adapter/src/real-adapter.ts`.
  There is no code path, default, or fallback that would let a
  misconfigured `X402_NETWORK` silently target Base mainnet or any other
  chain. This project never sends mainnet funds automatically, and would
  require deliberate code changes (not just a config value) to do so.

### API authentication

- Bearer API keys, SHA-256 hashed at rest (`hashApiKey` /
  `apiKeyHashEquals`, using `crypto.timingSafeEqual` for comparison —
  see `packages/shared/src/apiKey.ts`). A key is either org-scoped (can
  act as any agent in the org — a human/admin credential) or
  agent-scoped (can only act as itself).
- **This is a genuinely minimal scheme**, appropriate for a local/demo
  deployment, explicitly not a production-grade auth system: no key
  rotation, no scoped permissions beyond org/agent, no expiry, no rate
  limiting on the auth check itself. `CONTRIBUTING.md`/README Roadmap
  name this as a known limitation, not a hidden gap.

### Denial of service

- Not specifically hardened against in this MVP. `PaymentVelocityLimit`
  incidentally bounds how fast one already-authenticated agent can
  generate payment attempts, but there is no request-rate limiting at the
  HTTP layer, no connection-pool exhaustion protection beyond Postgres's
  own pool sizing (`packages/db/src/client.ts` defaults to 10
  connections), and no protection against an attacker who has a valid API
  key simply issuing many expensive `/routes/evaluate` or read-endpoint
  calls. Named explicitly as a roadmap item rather than silently ignored.

## 4. Explicitly not claimed

- **No fraud detection.** Nothing in this codebase claims to detect
  fraudulent behavior from behavioral patterns, anomaly scores, or
  machine learning. The policy engine enforces deterministic, explicit,
  operator-configured rules (task principle B/C) — calling that "fraud
  detection" would overstate what it does.
- **No cryptographic verification of provider identity.** See "untrusted
  metadata" above.
- **No guarantee of resource quality or correctness.** Treasury verifies
  that a payment was authorized and settled correctly; it does not (and
  cannot, in general) verify that the resource returned in exchange was
  the resource promised.
- **No production-hardened auth, rate limiting, or secret management.**
  Named as roadmap items in the README, not implied to already exist.
