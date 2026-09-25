import { createServer, type Server } from 'node:http';
import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  decodeHeader,
  encodeHeader,
  mockSettle,
  type PaymentPayloadWire,
  type PaymentRequiredWire,
  type PaymentRequirementsWire,
} from '@x402-treasury/x402-adapter';

/**
 * A minimal x402 v2-shaped resource server for integration tests, so
 * apps/api's payment flow can be exercised against something that speaks
 * real HTTP 402 semantics without depending on the actual
 * apps/demo-provider-* apps (which are a separate deployable and not a
 * test fixture). Structurally identical to
 * packages/x402-adapter/src/mock-adapter.test.ts's fixture.
 */
export function startTestProvider(requirements: PaymentRequirementsWire): { server: Server; url: string; baseUrl: string; resourcePath: string } {
  const resourcePath = '/research';
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
    res.end(JSON.stringify({ result: 'mock research data' }));
  });
  server.listen(0);
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('failed to bind test provider');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { server, url: `${baseUrl}${resourcePath}`, baseUrl, resourcePath };
}
