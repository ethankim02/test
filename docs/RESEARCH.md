# x402 Protocol Research (as of 2026-09-25)

This document records what was verified against primary sources before any
implementation began, per the project's engineering principle: **do not
invent APIs, do not assume outdated behavior.**

Network access in this environment blocks `x402.org` directly (egress proxy
denial), so verification relied on the GitHub source of truth
(`x402-foundation/x402`) and the public npm registry (`registry.npmjs.org`),
fetched on 2026-09-25. Where a claim below could not be independently
confirmed, it is marked **(unverified)** and treated as a documented
assumption rather than fact.

## 1. Governance and canonical repository

x402 was originally published by Coinbase in May 2025. In mid-2025 the
project moved to a vendor-neutral **x402 Foundation**. The repository
`coinbase/x402` now redirects contributors to
**`x402-foundation/x402`**, which is the canonical, actively-maintained
repository; `coinbase/x402` is described in its own README as "a
development fork." All research below is against `x402-foundation/x402`.

Source: https://github.com/coinbase/x402, https://github.com/x402-foundation/x402

## 2. Protocol version

The spec repository carries **two parallel specifications**:

- `specs/x402-specification-v1.md` — legacy protocol
- `specs/x402-specification-v2.md` — current protocol

x402 Treasury targets **v2**. v2's own text explicitly separates the
protocol spec, SDK implementation, and facilitators into independent,
versioned layers ("plug-in-driven and future-proof"), which is why the
TypeScript SDK moved from a monolithic `x402` package to scoped `@x402/*`
packages (see §5).

Source: https://github.com/x402-foundation/x402/tree/main/specs,
https://x402.org/x402-v2-launch/ (title/summary only — page itself blocked
by network policy in this environment)

## 3. Payment flow (v2)

v2 generalizes the flow beyond the original "pay after 402" pattern. The
default flow, and the one this project implements, is:

1. **Client Request** — agent requests a protected resource.
2. **Payment Required Response** — server responds with an HTTP 402 and a
   `PaymentRequired` object describing acceptable payment options
   (`PaymentRequirements[]`).
3. **Payment Authorization Request** — client retries the request,
   attaching a signed `PaymentPayload` that satisfies one of the offered
   requirements.
4. **Settlement Response** — server (via a facilitator) verifies and
   settles the payment, then returns the resource.

v2 additionally defines two non-default flow variants, `upfront` and
`escrow`, which settle before or during resource execution rather than
strictly after. **x402 Treasury only implements the default (`authorization`
/ pay-then-fulfill) flow** — the flow that matches how the demo providers in
this repo work. `upfront`/`escrow` are out of scope; see
`docs/ARCHITECTURE.md` "Out of scope."

## 4. HTTP transport (v2) — this is a real deviation from widely-copied v1 tutorials

Many public tutorials still show the **v1** headers `X-PAYMENT` (request)
and `X-PAYMENT-RESPONSE` (response). **v2 renamed these:**

| Direction | v2 header | Content |
|---|---|---|
| Server → Client (402 response) | `PAYMENT-REQUIRED` | base64-encoded JSON `PaymentRequired` object |
| Client → Server (retry) | `PAYMENT-SIGNATURE` | base64-encoded JSON `PaymentPayload` (signed) |
| Facilitator → Server (out-of-band, not forwarded to buyer) | `EXTENSION-RESPONSES` | extension-specific outcomes |

Source: https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/http.md

x402 Treasury's adapter layer (`packages/x402-adapter`) is written against
the **v2** header names. If a specific facilitator or framework middleware
still speaks v1 on the wire (common during the v1→v2 migration window), that
is handled entirely inside the adapter/framework package — Treasury's domain
code never references header names directly (see §11, ADR-007).

## 5. Core data structures (v2)

```
PaymentRequirements {
  scheme: string            // e.g. "exact"
  network: string           // CAIP-2, e.g. "eip155:84532" (Base Sepolia)
  amount: string            // atomic units, as a decimal string
  asset: string             // token contract address or ISO-4217 code
  payTo: string             // recipient address or role
  maxTimeoutSeconds: number
  extra?: object            // scheme-specific (assetTransferMethod, paymentFlow, ...)
}

PaymentPayload {
  x402Version: 2
  resource?: ResourceInfo
  accepted: PaymentRequirements
  payload: object           // scheme-specific (EIP-712 sig + EIP-3009 auth for exact/evm)
  extensions?: object
}
```

Source: https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md

## 6. Facilitator interface (v2)

A facilitator is a third party (or self-hosted service) that verifies
signatures/balances and submits settlement transactions on behalf of a
resource server, so the resource server never needs its own chain RPC
access or gas management.

- `POST /verify` — stateless validation of a `PaymentPayload` against
  `PaymentRequirements`. Returns `{ isValid: boolean, invalidReason?: string }`.
- `POST /settle` — durable commitment: broadcasts (or binds) the payment.
  Returns `{ success: boolean, transaction?: string, network?: string, errorReason?: string }`.
  Notably, `settlement_pending` is a **non-terminal** error code meaning the
  transaction broadcast but confirmation is not yet certain — this is the
  exact ambiguous state x402 Treasury's reconciliation subsystem exists to
  resolve (see `docs/ARCHITECTURE.md` §Reconciliation).
- `GET /supported` — capability discovery: which `scheme`/`network` pairs and
  extensions the facilitator supports, plus its signer addresses per CAIP-2
  pattern.

Source: same as §5.

## 7. Schemes

- **`exact`** — fixed-amount payment. The scheme this project uses.
- **`upto`** — client authorizes a maximum; actual charge may be lower.
- **`batch-settlement`** — multiple payments settled together.
- **`auth-capture`** — referenced in the spec index but full scheme
  documentation was not reachable in this environment **(unverified
  detail; not used by this project)**.

For EVM networks, `exact` is implemented via **EIP-3009
`transferWithAuthorization`** on the token contract (USDC supports this).
The client signs an EIP-712 authorization (`from`, `to`, `value`,
`validAfter`, `validBefore`, `nonce`); the facilitator submits it on-chain.
The facilitator cannot alter amount or destination — those are inside the
signed payload — so a compromised or malicious facilitator can withhold or
delay settlement but not redirect funds.

Source: https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md

## 8. Network identifiers

CAIP-2 format (`namespace:reference`). Relevant to this project:

| Network | CAIP-2 |
|---|---|
| Base mainnet | `eip155:8453` |
| Base Sepolia (testnet) | `eip155:84532` |

x402 Treasury's demo and manual E2E test target **Base Sepolia**
(`eip155:84532`) exclusively. No mainnet chain ID appears anywhere in code,
config defaults, or tests.

## 9. Official TypeScript packages actually used

Verified directly against `registry.npmjs.org` on 2026-09-25 (scoped
`@x402/*`, published by the x402 Foundation):

| Package | Verified version | Role |
|---|---|---|
| `@x402/core` | 2.27.0 | protocol types/schemas (depends on `zod@^3.24.2`) |
| `@x402/evm` | 2.27.0 | EVM (Base) implementation of the `exact` scheme |
| `@x402/fastify` | 2.26.0 | Fastify middleware for protected resource servers (peer: `fastify@^5.0.0`) |
| `@x402/fetch` | 2.27.0 | client-side `fetch` wrapper that handles the 402→sign→retry loop |

**Deviation noted:** `@x402/fastify` at 2.26.0 pins `@x402/core@~2.26.0`,
one patch behind the `@x402/core@2.27.0` latest. This project pins exact
versions in each `package.json` (no `^`/`~` ranges on `@x402/*` packages) to
avoid silently picking up a protocol-level change mid-development; see
ADR-007.

`@coinbase/x402` (2.1.0) still exists as a facilitator-client convenience
package under the legacy `coinbase/x402` fork; it is **not used** — this
project talks to a facilitator through the foundation-maintained
`@x402/*` packages only, to track the canonical spec rather than a vendor
fork.

## 10. Base Sepolia / USDC test setup

- Chain: Base Sepolia, CAIP-2 `eip155:84532`.
- Asset: USDC test token on Base Sepolia. USDC uses **6 decimals**; all
  amounts in this project are handled as integer atomic units (see
  ADR-003) — `"1000000"` atomic units == `1.00` USDC.
- Obtaining a facilitator endpoint and testnet USDC requires the operator
  to hold a Base Sepolia-funded EOA and register with a running facilitator
  (or run one from `x402-foundation/x402`'s facilitator example). This
  project does **not** hardcode a facilitator URL or contract address in
  source — both are required environment variables
  (`X402_FACILITATOR_URL`, `X402_NETWORK`) documented in `.env.example`,
  populated by the operator, never committed. See §12 "What you must
  provide" below and `docs/THREAT_MODEL.md`.

## 11. What x402 already provides vs. what x402 Treasury adds

The v2 specification contains an explicit, unambiguous **out-of-scope**
statement, which is the entire reason this project exists:

> "Out of Scope: This specification does not include... Client-side budget
> management... Session handling mechanisms... Spending policy and
> correlation tracking... Application-specific implementation patterns."

| Capability | Provided by x402 | Provided by x402 Treasury |
|---|---|---|
| Payment requirement discovery (402 + `PaymentRequired`) | Yes | — (consumed via adapter) |
| Signing & submitting a payment | Yes (client SDK) | — (consumed via adapter) |
| Verifying & settling on-chain | Yes (facilitator) | — (consumed via adapter) |
| Replay/signature validity, authorization windows | Yes (protocol-level, EIP-3009 nonce + validAfter/validBefore) | — |
| **Who is allowed to spend, how much, on what** | No | **Yes — policy engine** |
| **Hierarchical/delegated budgets** | No | **Yes — ledger + delegation graph** |
| **"Did I already pay for this logical request" across retries** | Partial (nonce prevents re-settling the *same signed payload*) | **Yes — application-level idempotency keyed on caller intent, independent of any one signature** |
| **Choosing among multiple equivalent paid providers** | No | **Yes — router** |
| **Recovering from an uncertain settlement (`settlement_pending`, crash mid-flow)** | No | **Yes — reconciliation subsystem** |
| **Auditable accounting of what was spent, by whom, from where** | No | **Yes — append-only ledger** |

This division of responsibility is the core architectural boundary of the
project: **x402 answers "can this specific signed payment be settled";
Treasury answers "should this agent be allowed to spend this money at all,
right now, on this provider."**

## 12. Limitations discovered / operator-provided secrets

- `x402.org` (marketing/docs site) is unreachable from this build
  environment's network policy; all protocol facts above come from the
  GitHub spec source and npm registry instead, which are authoritative for
  the SDK and spec text anyway.
- Some individual raw file paths under `specs/schemes/` 404'd on first
  guess (`scheme_exact_evm.md` path had to be located via the rendered
  GitHub tree view rather than a raw URL guess) — a reminder that this
  document reflects what was actually fetched and read, not assumed
  paths.
- The full `auth-capture` scheme document was not reached; the project does
  not use that scheme, so this is noted but not blocking.
- **What you (the human operator) must provide, and only when running the
  real (non-mock) Base Sepolia demo:**
  - `X402_FACILITATOR_URL` — a running v2-compatible facilitator endpoint.
  - `X402_PAYER_PRIVATE_KEY` — a Base Sepolia EOA private key, funded with
    Sepolia ETH (gas, if your facilitator requires it) and test USDC.
    **Never commit this. Never use a mainnet key.** See
    `docs/THREAT_MODEL.md` §Private key handling.
  - `X402_PAYTO_ADDRESS` — the address demo providers should be paid to.
  - CI and the default `pnpm test`/`pnpm demo:research` run entirely
    against `MockX402Adapter` and require none of the above (§20 of the
    task spec: "Never claim CI performs real settlement unless it actually
    does" — it does not).

## Primary sources consulted

- https://github.com/x402-foundation/x402
- https://github.com/x402-foundation/x402/tree/main/specs
- https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md
- https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/http.md
- https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md
- https://github.com/x402-foundation/x402/tree/main/typescript/packages
- https://registry.npmjs.org/@x402/core/latest
- https://registry.npmjs.org/@x402/evm/latest
- https://registry.npmjs.org/@x402/fastify/latest
- https://registry.npmjs.org/@x402/fetch/latest
- https://registry.npmjs.org/@coinbase/x402/latest
