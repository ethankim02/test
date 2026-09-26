import { describe, expect, it } from 'vitest';
import { mockSettle, mockVerify } from './mock-facilitator.js';
import type { PaymentPayloadWire, PaymentRequirementsWire } from './wire.js';

const requirements: PaymentRequirementsWire = {
  scheme: 'exact',
  network: 'eip155:84532',
  amount: '30000',
  asset: 'mock:usdc',
  payTo: '0xprovider',
  maxTimeoutSeconds: 60,
};

function validPayload(overrides: Partial<PaymentPayloadWire['payload']> = {}): PaymentPayloadWire {
  return {
    x402Version: 2,
    resource: { url: 'http://localhost/research' },
    accepted: requirements,
    payload: { mock: true, payer: 'agent-1', nonce: 'n1', signature: 'MOCK', ...overrides },
  };
}

describe('mockVerify', () => {
  it('accepts a well-formed mock payload matching the requirements', () => {
    expect(mockVerify(validPayload(), requirements)).toEqual({ isValid: true });
  });

  it('rejects a payload whose accepted requirements do not match what was offered', () => {
    const result = mockVerify(
      { ...validPayload(), accepted: { ...requirements, amount: '999' } },
      requirements,
    );
    expect(result.isValid).toBe(false);
  });

  it('rejects a payload missing the mock marker', () => {
    const result = mockVerify(validPayload({ mock: false }), requirements);
    expect(result.isValid).toBe(false);
  });

  it('rejects an unsupported protocol version', () => {
    const result = mockVerify({ ...validPayload(), x402Version: 1 as 2 }, requirements);
    expect(result.isValid).toBe(false);
  });
});

describe('mockSettle', () => {
  it('produces a clearly-fake transaction hash on success', () => {
    const result = mockSettle(validPayload(), requirements);
    expect(result.success).toBe(true);
    expect(result.transaction).toMatch(/^0xMOCK/);
    expect(result.network).toBe(requirements.network);
  });

  it('fails settlement for an invalid payload without producing a transaction hash', () => {
    const result = mockSettle(validPayload({ mock: false }), requirements);
    expect(result.success).toBe(false);
    expect(result.transaction).toBeUndefined();
  });

  it('is deterministic in outcome (though the tx hash itself is random per call)', () => {
    const a = mockSettle(validPayload(), requirements);
    const b = mockSettle(validPayload(), requirements);
    expect(a.success).toBe(b.success);
    expect(a.transaction).not.toBe(b.transaction); // no two "transactions" collide
  });
});
