import { mockVerify } from './mock-facilitator.js';
import type {
  PaymentRail,
  PaymentRequirements,
  PayerContext,
  ResourceRef,
  SettleResult,
  SignedPayment,
  VerifyResult,
} from './types.js';
import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  decodeHeader,
  encodeHeader,
  fromWire,
  toWire,
  type PaymentPayloadWire,
  type PaymentRequiredWire,
} from './wire.js';

/**
 * MOCK adapter — performs REAL HTTP requests with the REAL x402 v2 header
 * names (`PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE`) against a resource
 * server, but the "signature" is a plain marker object, not a real EIP-712
 * signature, and settlement is whatever the target server's own mock
 * facilitator logic decides (see `mock-facilitator.ts`) — no blockchain
 * involved anywhere. This is what CI, `pnpm test`, and `pnpm demo:research`
 * use by default. It is intentionally NOT a pure in-memory stub: exercising
 * real HTTP 402 semantics end-to-end (a real GET, a real 402, a real
 * retry with a real header) is what makes the demo credible as "how x402
 * actually works," while keeping settlement itself deterministic and
 * network-independent.
 */
export class MockX402Adapter implements PaymentRail {
  async discoverRequirements(resource: ResourceRef): Promise<PaymentRequirements> {
    const response = await fetch(resource.url);
    if (response.status !== 402) {
      throw new Error(`MockX402Adapter: expected HTTP 402 from ${resource.url}, got ${response.status}`);
    }
    const header = response.headers.get(PAYMENT_REQUIRED_HEADER);
    if (!header) {
      throw new Error(`MockX402Adapter: 402 response from ${resource.url} is missing the ${PAYMENT_REQUIRED_HEADER} header`);
    }
    const required = decodeHeader<PaymentRequiredWire>(header);
    const offer = required.accepts[0];
    if (!offer) {
      throw new Error(`MockX402Adapter: ${resource.url} offered zero payment options`);
    }
    return fromWire(offer);
  }

  async preparePayment(requirements: PaymentRequirements, resource: ResourceRef, payer: PayerContext): Promise<SignedPayment> {
    const wire: PaymentPayloadWire = {
      x402Version: 2,
      resource: { url: resource.url },
      accepted: toWire(requirements),
      payload: {
        mock: true,
        payer: payer.agentId,
        nonce: crypto.randomUUID(),
        signature: 'MOCK-SIGNATURE-NOT-CRYPTOGRAPHIC',
      },
    };
    return { raw: wire };
  }

  /**
   * Optimistic client-side pre-check against the same mock-facilitator
   * logic the target server will apply — lets Treasury fail fast on a
   * malformed payload before spending a network round trip. A real
   * facilitator's `/verify` is normally called by the resource server, not
   * the client, but nothing in the v2 spec restricts who may call it (see
   * docs/RESEARCH.md §6) and pre-validating is a legitimate optimization.
   */
  async verifyPayment(signed: SignedPayment, requirements: PaymentRequirements): Promise<VerifyResult> {
    const result = mockVerify(signed.raw as PaymentPayloadWire, toWire(requirements));
    return { isValid: result.isValid, invalidReason: result.invalidReason };
  }

  async settlePayment(signed: SignedPayment, requirements: PaymentRequirements, resource: ResourceRef): Promise<SettleResult> {
    const header = encodeHeader(signed.raw);
    const response = await fetch(resource.url, { headers: { [PAYMENT_SIGNATURE_HEADER]: header } });

    if (response.status === 200) {
      const resourceBody: unknown = await response.json().catch(() => undefined);
      const transactionHash = response.headers.get('x-mock-settlement-tx') ?? undefined;
      return { outcome: 'SUCCESS', transactionHash, network: requirements.network, resourceBody };
    }

    const errorBody: unknown = await response.json().catch(() => undefined);
    const errorReason =
      (typeof errorBody === 'object' && errorBody !== null && 'error' in errorBody
        ? String((errorBody as { error: unknown }).error)
        : undefined) ?? `settlement failed with HTTP ${response.status}`;
    return { outcome: 'FAILED', errorReason };
  }
}
