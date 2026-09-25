/**
 * Domain-level payment rail types. Nothing outside this package (and its
 * two implementations) ever imports an `@x402/*` type directly — see
 * docs/DECISIONS.md ADR-007. `amountMinor` is a `bigint`, consistent with
 * every other monetary value in this project (ADR-003); it is only
 * serialized to a decimal string at the actual wire boundary
 * (`wire.ts`).
 */
export interface ResourceRef {
  url: string;
}

export interface PaymentRequirements {
  scheme: string;
  network: string;
  amountMinor: bigint;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
}

export interface PayerContext {
  agentId: string;
}

/** Opaque signed payment payload — only the adapter that produced it knows how to use it. */
export interface SignedPayment {
  raw: unknown;
}

export interface VerifyResult {
  isValid: boolean;
  invalidReason?: string | undefined;
}

export type SettleOutcome = 'SUCCESS' | 'FAILED' | 'PENDING';

export interface SettleResult {
  outcome: SettleOutcome;
  transactionHash?: string | undefined;
  network?: string | undefined;
  errorReason?: string | undefined;
  /** The resource body returned once payment was accepted (only set on SUCCESS). */
  resourceBody?: unknown;
}

/**
 * The boundary between Treasury's domain logic and the x402 protocol.
 * `MockX402Adapter` (deterministic, used everywhere in CI/tests) and
 * `RealX402Adapter` (real Base Sepolia, manual-only) both implement this;
 * nothing else in the codebase needs to know which one it's talking to.
 */
export interface PaymentRail {
  discoverRequirements(resource: ResourceRef): Promise<PaymentRequirements>;
  preparePayment(
    requirements: PaymentRequirements,
    resource: ResourceRef,
    payer: PayerContext,
  ): Promise<SignedPayment>;
  verifyPayment(signed: SignedPayment, requirements: PaymentRequirements): Promise<VerifyResult>;
  settlePayment(signed: SignedPayment, requirements: PaymentRequirements, resource: ResourceRef): Promise<SettleResult>;
}
