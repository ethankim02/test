import { ExactEvmScheme } from '@x402/evm';
import { x402Client } from '@x402/core/client';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
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
 * `discoverRequirements` issues one plain, unpaid GET and reads the real
 * `PAYMENT-REQUIRED` header off the resource's 402 response — this is what
 * lets Treasury learn the authoritative price/payTo before it reserves
 * budget (`apps/api/src/payment-flow.ts`). The SDK exposes signing only as
 * a fetch wrapper (`wrapFetchWithPayment`) that internally does the
 * 402 -> sign -> retry dance, so `preparePayment`/`verifyPayment` are
 * no-ops for interface compatibility with `PaymentRail`, and the signing +
 * facilitator verify/settle (which the *resource server* performs, not the
 * client — see docs/RESEARCH.md §3/§6) all happen inside the one wrapped
 * request in `settlePayment`. The settlement transaction hash is read from
 * that response's `PAYMENT-RESPONSE` header; a success without one is
 * refused rather than reported.
 *
 * Requires `X402_PAYER_PRIVATE_KEY` (a Base Sepolia-funded EOA — never a
 * mainnet key) and `X402_NETWORK` (must be `eip155:84532`, enforced
 * below). See docs/RESEARCH.md §12 and docs/THREAT_MODEL.md.
 */
export class RealX402Adapter implements PaymentRail {
  private readonly client: x402Client;
  private readonly network: string;

  constructor(payerPrivateKey: `0x${string}`, network: string) {
    if (network !== 'eip155:84532') {
      throw new Error(
        `RealX402Adapter only supports Base Sepolia (eip155:84532); refusing network "${network}". ` +
          'This project never sends real mainnet funds automatically — see docs/THREAT_MODEL.md.',
      );
    }
    this.network = network;
    const account = privateKeyToAccount(payerPrivateKey);
    this.client = new x402Client().register(network, new ExactEvmScheme(account));
  }

  async discoverRequirements(resource: ResourceRef): Promise<PaymentRequirements> {
    const response = await fetch(resource.url);
    if (response.status !== 402) {
      throw new Error(
        `expected HTTP 402 Payment Required from ${resource.url}, got HTTP ${response.status} — ` +
          'the resource is not x402-protected (or is not asking for payment)',
      );
    }
    const header = response.headers.get('PAYMENT-REQUIRED');
    const paymentRequired: PaymentRequired = header
      ? decodePaymentRequiredHeader(header)
      : ((await response.json()) as PaymentRequired);

    const accepted = paymentRequired.accepts?.find(
      (a) => a.scheme === 'exact' && a.network === this.network,
    );
    if (!accepted) {
      throw new Error(
        `${resource.url} does not accept the "exact" scheme on ${this.network}; it offered: ` +
          JSON.stringify((paymentRequired.accepts ?? []).map((a) => `${a.scheme}@${a.network}`)),
      );
    }
    return {
      scheme: accepted.scheme,
      network: accepted.network,
      amountMinor: BigInt(accepted.amount),
      asset: accepted.asset,
      payTo: accepted.payTo,
      maxTimeoutSeconds: accepted.maxTimeoutSeconds,
    };
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
      const settlementHeader =
        response.headers.get('PAYMENT-RESPONSE') ?? response.headers.get('X-PAYMENT-RESPONSE');
      if (!settlementHeader) {
        return {
          outcome: 'FAILED',
          errorReason:
            `HTTP ${response.status} from ${resource.url} carried no PAYMENT-RESPONSE settlement ` +
            'header, so no settlement transaction hash can be confirmed',
        };
      }
      const settlement = decodePaymentResponseHeader(settlementHeader);
      if (!settlement.success || !settlement.transaction) {
        return {
          outcome: 'FAILED',
          errorReason: `facilitator reported settlement failure: ${settlement.errorReason ?? 'unknown'}${
            settlement.errorMessage ? ` (${settlement.errorMessage})` : ''
          }`,
        };
      }
      const resourceBody: unknown = await response.json().catch(() => undefined);
      return {
        outcome: 'SUCCESS',
        transactionHash: settlement.transaction,
        network: settlement.network,
        resourceBody,
      };
    } catch (err) {
      return { outcome: 'FAILED', errorReason: err instanceof Error ? err.message : String(err) };
    }
  }
}
