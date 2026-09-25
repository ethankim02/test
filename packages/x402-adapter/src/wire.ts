import type { PaymentRequirements } from './types.js';

/**
 * JSON wire shapes, matching the fields of x402 v2's `PaymentRequirements`
 * / `PaymentPayload` verified in docs/RESEARCH.md §5 (scheme, network,
 * amount as a decimal atomic-unit string, asset, payTo,
 * maxTimeoutSeconds). This project's mock path defines its own
 * `PaymentRequired` envelope (`{ x402Version, accepts }`) rather than
 * importing `@x402/core`'s type for it, since the mock path has no
 * runtime dependency on `@x402/core` at all — only the fields this
 * project's routing/policy logic actually reads are modeled here. The
 * real adapter (`real-adapter.ts`) uses the official types directly.
 */
export interface PaymentRequirementsWire {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
}

export interface PaymentRequiredWire {
  x402Version: 2;
  accepts: PaymentRequirementsWire[];
}

export interface PaymentPayloadWire {
  x402Version: 2;
  resource: { url: string };
  accepted: PaymentRequirementsWire;
  payload: Record<string, unknown>;
}

export const PAYMENT_REQUIRED_HEADER = 'PAYMENT-REQUIRED';
export const PAYMENT_SIGNATURE_HEADER = 'PAYMENT-SIGNATURE';

export function toWire(req: PaymentRequirements): PaymentRequirementsWire {
  return {
    scheme: req.scheme,
    network: req.network,
    amount: req.amountMinor.toString(),
    asset: req.asset,
    payTo: req.payTo,
    maxTimeoutSeconds: req.maxTimeoutSeconds,
  };
}

export function fromWire(wire: PaymentRequirementsWire): PaymentRequirements {
  return {
    scheme: wire.scheme,
    network: wire.network,
    amountMinor: BigInt(wire.amount),
    asset: wire.asset,
    payTo: wire.payTo,
    maxTimeoutSeconds: wire.maxTimeoutSeconds,
  };
}

export function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

export function decodeHeader<T>(header: string): T {
  return JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as T;
}
