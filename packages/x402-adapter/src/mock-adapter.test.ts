import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockX402Adapter } from './mock-adapter.js';
import { mockSettle } from './mock-facilitator.js';
import { PAYMENT_REQUIRED_HEADER, PAYMENT_SIGNATURE_HEADER, decodeHeader, encodeHeader, type PaymentPayloadWire, type PaymentRequiredWire, type PaymentRequirementsWire } from './wire.js';

/**
 * A minimal x402 v2-shaped resource server, standing in for
 * apps/demo-provider-a in this unit test so MockX402Adapter's real-HTTP
 * behavior (402 -> read header -> retry with signed header -> 200) is
 * exercised without spinning up the whole demo app or a database.
 */
function startTestProvider(requirements: PaymentRequirementsWire): { server: Server; url: string } {
  const server = createServer((req, res) => {
    const sigHeader = req.headers[PAYMENT_SIGNATURE_HEADER.toLowerCase()];
    if (!sigHeader || Array.isArray(sigHeader)) {
      const required: PaymentRequiredWire = { x402Version: 2, accepts: [requirements] };
      res.writeHead(402, { [PAYMENT_REQUIRED_HEADER]: encodeHeader(required), 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'payment required' }));
      return;
    }
    const payload = decodeHeader<PaymentPayloadWire>(sigHeader);
    const settlement = mockSettle(payload, requirements);
    if (!settlement.success) {
      res.writeHead(402, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: settlement.errorReason }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', 'x-mock-settlement-tx': settlement.transaction! });
    res.end(JSON.stringify({ result: 'mock research data', query: 'test' }));
  });
  server.listen(0);
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('failed to bind test server');
  return { server, url: `http://127.0.0.1:${address.port}/research` };
}

describe('MockX402Adapter end-to-end HTTP flow', () => {
  let server: Server;
  let url: string;
  const requirements: PaymentRequirementsWire = {
    scheme: 'exact',
    network: 'eip155:84532',
    amount: '30000',
    asset: 'mock:usdc',
    payTo: '0xprovider',
    maxTimeoutSeconds: 60,
  };

  beforeAll(() => {
    ({ server, url } = startTestProvider(requirements));
  });
  afterAll(() => {
    server.close();
  });

  it('discovers requirements from a real 402 response over real HTTP', async () => {
    const adapter = new MockX402Adapter();
    const discovered = await adapter.discoverRequirements({ url });
    expect(discovered.amountMinor).toBe(30_000n);
    expect(discovered.network).toBe('eip155:84532');
    expect(discovered.payTo).toBe('0xprovider');
  });

  it('completes the full discover -> prepare -> verify -> settle flow and returns the resource', async () => {
    const adapter = new MockX402Adapter();
    const requirementsFromServer = await adapter.discoverRequirements({ url });
    const signed = await adapter.preparePayment(requirementsFromServer, { url }, { agentId: 'agent-1' });

    const verifyResult = await adapter.verifyPayment(signed, requirementsFromServer);
    expect(verifyResult.isValid).toBe(true);

    const settleResult = await adapter.settlePayment(signed, requirementsFromServer, { url });
    expect(settleResult.outcome).toBe('SUCCESS');
    expect(settleResult.transactionHash).toMatch(/^0xMOCK/);
    expect(settleResult.resourceBody).toEqual({ result: 'mock research data', query: 'test' });
  });

  it('fails settlement cleanly if the payload is tampered with after preparation', async () => {
    const adapter = new MockX402Adapter();
    const requirementsFromServer = await adapter.discoverRequirements({ url });
    const signed = await adapter.preparePayment(requirementsFromServer, { url }, { agentId: 'agent-1' });
    const tampered = { raw: { ...(signed.raw as PaymentPayloadWire), payload: { ...(signed.raw as PaymentPayloadWire).payload, mock: false } } };

    const settleResult = await adapter.settlePayment(tampered, requirementsFromServer, { url });
    expect(settleResult.outcome).toBe('FAILED');
    expect(settleResult.transactionHash).toBeUndefined();
  });

  it('throws a clear error if a resource never returns 402', async () => {
    const okServer = createServer((_req, res) => {
      res.writeHead(200);
      res.end('{}');
    });
    okServer.listen(0);
    const address = okServer.address();
    if (typeof address !== 'object' || address === null) throw new Error('bind failed');
    const adapter = new MockX402Adapter();
    await expect(adapter.discoverRequirements({ url: `http://127.0.0.1:${address.port}` })).rejects.toThrow(/expected HTTP 402/);
    okServer.close();
  });
});
