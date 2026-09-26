import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from '@x402/core/http';
import type {
  PaymentRequirements as SdkPaymentRequirements,
  SettleResponse,
} from '@x402/core/types';
import { generatePrivateKey } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';
import { RealX402Adapter } from './real-adapter.js';

/**
 * These tests exercise the REAL SDK code path (`@x402/core` header codecs,
 * `@x402/fetch`'s 402 -> sign -> retry wrapper, `@x402/evm`'s EIP-3009
 * signing) against a local stand-in for the resource server + facilitator.
 * The payer key is a throwaway generated in memory and signing is purely
 * local, so nothing here touches a network or moves any funds.
 */
const NETWORK = 'eip155:84532';
const TX_HASH = `0x${'ab'.repeat(32)}`;

const REQUIREMENTS: SdkPaymentRequirements = {
  scheme: 'exact',
  network: NETWORK,
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  amount: '1000',
  payTo: '0x000000000000000000000000000000000000dEaD',
  maxTimeoutSeconds: 60,
  extra: { name: 'USDC', version: '2' },
};

type Behaviour = 'settle-ok' | 'settle-fails' | 'no-settlement-header' | 'unprotected';

let server: Server | undefined;

async function startResource(
  behaviour: Behaviour,
  accepts: SdkPaymentRequirements[] = [REQUIREMENTS],
): Promise<string> {
  server = createServer((req, res) => {
    if (behaviour === 'unprotected') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"free":true}');
      return;
    }
    const signature = req.headers['payment-signature'];
    if (!signature || Array.isArray(signature)) {
      const url = `http://${req.headers.host}${req.url}`;
      res
        .writeHead(402, {
          'content-type': 'application/json',
          'PAYMENT-REQUIRED': encodePaymentRequiredHeader({
            x402Version: 2,
            resource: { url },
            accepts,
          }),
        })
        .end('{}');
      return;
    }
    // A signed payment arrived; make sure it is a decodable v2 payload.
    const payload = decodePaymentSignatureHeader(signature);
    expect(payload.accepted.network).toBe(NETWORK);

    if (behaviour === 'no-settlement-header') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      return;
    }
    const settle: SettleResponse =
      behaviour === 'settle-ok'
        ? { success: true, transaction: TX_HASH, network: NETWORK }
        : {
            success: false,
            transaction: '',
            network: NETWORK,
            errorReason: 'insufficient_funds',
          };
    res
      .writeHead(200, {
        'content-type': 'application/json',
        'PAYMENT-RESPONSE': encodePaymentResponseHeader(settle),
      })
      .end('{"headline":"paid result"}');
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/real/research`;
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

const newAdapter = () => new RealX402Adapter(generatePrivateKey(), NETWORK);

describe('RealX402Adapter', () => {
  it('refuses any network other than Base Sepolia', () => {
    expect(() => new RealX402Adapter(generatePrivateKey(), 'eip155:8453')).toThrow(/Base Sepolia/);
  });

  describe('discoverRequirements', () => {
    it('reads the authoritative price/payTo from the real PAYMENT-REQUIRED header', async () => {
      const url = await startResource('settle-ok');
      const requirements = await newAdapter().discoverRequirements({ url });
      expect(requirements).toEqual({
        scheme: 'exact',
        network: NETWORK,
        amountMinor: 1000n,
        asset: REQUIREMENTS.asset,
        payTo: REQUIREMENTS.payTo,
        maxTimeoutSeconds: 60,
      });
    });

    it('rejects a resource that is not asking for payment', async () => {
      const url = await startResource('unprotected');
      await expect(newAdapter().discoverRequirements({ url })).rejects.toThrow(/expected HTTP 402/);
    });

    it('rejects a resource that only offers other networks (never falls through to mainnet)', async () => {
      const url = await startResource('settle-ok', [{ ...REQUIREMENTS, network: 'eip155:8453' }]);
      await expect(newAdapter().discoverRequirements({ url })).rejects.toThrow(
        /does not accept the "exact" scheme on eip155:84532/,
      );
    });
  });

  describe('settlePayment', () => {
    it('signs, pays, and surfaces the real settlement transaction hash', async () => {
      const adapter = newAdapter();
      const url = await startResource('settle-ok');
      const requirements = await adapter.discoverRequirements({ url });
      const result = await adapter.settlePayment({ raw: null }, requirements, { url });
      expect(result).toEqual({
        outcome: 'SUCCESS',
        transactionHash: TX_HASH,
        network: NETWORK,
        resourceBody: { headline: 'paid result' },
      });
    });

    it('reports FAILED when the facilitator says settlement failed', async () => {
      const adapter = newAdapter();
      const url = await startResource('settle-fails');
      const requirements = await adapter.discoverRequirements({ url });
      const result = await adapter.settlePayment({ raw: null }, requirements, { url });
      expect(result.outcome).toBe('FAILED');
      expect(result.errorReason).toMatch(/insufficient_funds/);
      expect(result.transactionHash).toBeUndefined();
    });

    it('refuses to report success without a settlement header (no invented tx hash)', async () => {
      const adapter = newAdapter();
      const url = await startResource('no-settlement-header');
      const requirements = await adapter.discoverRequirements({ url });
      const result = await adapter.settlePayment({ raw: null }, requirements, { url });
      expect(result.outcome).toBe('FAILED');
      expect(result.errorReason).toMatch(/no PAYMENT-RESPONSE/);
      expect(result.transactionHash).toBeUndefined();
    });
  });
});
