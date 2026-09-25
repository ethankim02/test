import { randomBytes } from 'node:crypto';
import type { PaymentPayloadWire, PaymentRequirementsWire } from './wire.js';

/**
 * ============================================================================
 * MOCK FACILITATOR — NOT REAL. No cryptographic signature verification, no
 * blockchain, no actual USDC transfer. Deterministic and in-memory only.
 * ============================================================================
 *
 * Mirrors the *shape* of a real x402 v2 facilitator's `/verify` and
 * `/settle` (see docs/RESEARCH.md §6), so the demo providers
 * (apps/demo-provider-a/b) and `MockX402Adapter` can exercise the same
 * request/response contract a real facilitator integration would use,
 * entirely offline and deterministically — required so CI never depends
 * on public testnet infrastructure (task §20).
 *
 * `RealX402Adapter` never imports this file.
 */

export interface MockVerifyResult {
  isValid: boolean;
  invalidReason?: string;
}

export interface MockSettleResult {
  success: boolean;
  transaction?: string;
  network?: string;
  errorReason?: string;
}

export function mockVerify(
  payload: PaymentPayloadWire,
  requirements: PaymentRequirementsWire,
): MockVerifyResult {
  if (payload.x402Version !== 2) {
    return { isValid: false, invalidReason: `unsupported x402Version ${payload.x402Version}` };
  }
  const accepted = payload.accepted;
  const matches =
    accepted.scheme === requirements.scheme &&
    accepted.network === requirements.network &&
    accepted.amount === requirements.amount &&
    accepted.asset === requirements.asset &&
    accepted.payTo === requirements.payTo;
  if (!matches) {
    return {
      isValid: false,
      invalidReason: 'payload.accepted does not match the offered requirements',
    };
  }
  if (payload.payload?.['mock'] !== true) {
    return {
      isValid: false,
      invalidReason:
        'missing mock payment payload marker — this facilitator only accepts mock payloads',
    };
  }
  return { isValid: true };
}

export function mockSettle(
  payload: PaymentPayloadWire,
  requirements: PaymentRequirementsWire,
): MockSettleResult {
  const verify = mockVerify(payload, requirements);
  if (!verify.isValid) {
    return verify.invalidReason !== undefined
      ? { success: false, errorReason: verify.invalidReason }
      : { success: false };
  }
  const transaction = `0xMOCK${randomBytes(29).toString('hex')}`; // clearly-labeled fake hash, never mistakeable for a real one
  return { success: true, transaction, network: requirements.network };
}
