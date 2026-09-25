import { ExactEvmScheme } from '@x402/evm';
import { x402Client } from '@x402/core/client';
import { wrapFetchWithPayment } from '@x402/fetch';
import { privateKeyToAccount } from 'viem/accounts';
import type {
  PaymentRail,
  PaymentRequirements,
  ResourceRef,
  SettleResult,
  SignedPayment,
  VerifyResult,
} from './types.js';

/**
 * REAL adapter — Base Sepolia only, never used in CI. Verified against the
 * actually-installed `@x402/fetch` (2.27.0) and `@x402/evm` (2.27.0)
 * package type declarations (docs/RESEARCH.md §9): `wrapFetchWithPayment`,
 * `x402Client`, and `ExactEvmScheme` are real exports with the constructor
 * shapes used below, not guessed.
 *
 * This class collapses `discoverRequirements` / `preparePayment` /
 * `verifyPayment` / `settlePayment` into one underlying call to
 * `wrapFetchWithPayment`, because that's what the real SDK actually
 * exposes: a fetch wrapper that internally does the 402 -> sign -> retry
 * dance and talks to the facilitator server-side (the resource server
 * calls verify/settle, not the client — see docs/RESEARCH.md §3/§6).
 * `discoverRequirements`/`preparePayment` are no-ops here for interface
 * compatibility with `PaymentRail`; the real work happens in
 * `settlePayment`, which performs the one wrapped request. `verifyPayment`
 * always returns `isValid: true` optimistically — the actual verification
 * happens as part of that same wrapped request, and its result surfaces
 * through the HTTP outcome of `settlePayment`.
 *
 * Requires `X402_PAYER_PRIVATE_KEY` (a Base Sepolia-funded EOA — never a
 * mainnet key) and `X402_NETWORK` (must be `eip155:84532`, enforced
 * below). See docs/RESEARCH.md §12 and docs/THREAT_MODEL.md.
 */
export class RealX402Adapter implements PaymentRail {
  private readonly client: x402Client;

  constructor(payerPrivateKey: `0x${string}`, network: string) {
    if (network !== 'eip155:84532') {
      throw new Error(
        `RealX402Adapter only supports Base Sepolia (eip155:84532); refusing network "${network}". ` +
          'This project never sends real mainnet funds automatically — see docs/THREAT_MODEL.md.',
      );
    }
    const account = privateKeyToAccount(payerPrivateKey);
    this.client = new x402Client().register(network, new ExactEvmScheme(account));
  }

  async discoverRequirements(_resource: ResourceRef): Promise<PaymentRequirements> {
    // wrapFetchWithPayment discovers requirements internally from the
    // real 402 response; there is nothing useful to pre-fetch here
    // without duplicating that request. Treasury's caller should treat
    // discoverRequirements as informational for the real adapter and
    // rely on settlePayment's result for the authoritative outcome.
    throw new Error(
      'RealX402Adapter.discoverRequirements is not separately supported — call settlePayment, which performs discovery, signing, and settlement in one wrapped request via @x402/fetch.',
    );
  }

  async preparePayment(): Promise<SignedPayment> {
    return { raw: null }; // no-op: @x402/fetch signs internally during settlePayment
  }

  async verifyPayment(): Promise<VerifyResult> {
    return { isValid: true }; // verification happens facilitator-side during settlePayment
  }

  async settlePayment(
    _signed: SignedPayment,
    requirements: PaymentRequirements,
    resource: ResourceRef,
  ): Promise<SettleResult> {
    const payFetch = wrapFetchWithPayment(fetch, this.client);
    try {
      const response = await payFetch(resource.url);
      if (!response.ok) {
        return {
          outcome: 'FAILED',
          errorReason: `HTTP ${response.status} from ${resource.url} after payment`,
        };
      }
      const resourceBody: unknown = await response.json().catch(() => undefined);
      // @x402/core/http exposes decodePaymentResponseHeader to read the
      // settlement confirmation off the response; wire it in here once
      // you've confirmed the header name your facilitator actually sends
      // (see docs/RESEARCH.md — this project did not exercise a live
      // facilitator during development, so the exact response header is
      // documented as unverified).
      return { outcome: 'SUCCESS', network: requirements.network, resourceBody };
    } catch (err) {
      return { outcome: 'FAILED', errorReason: err instanceof Error ? err.message : String(err) };
    }
  }
}
