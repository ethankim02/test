import { mockSettle, type PaymentPayloadWire } from '@x402-treasury/x402-adapter';
import type { SettlementOracle } from '@x402-treasury/ledger';
import type { Pool } from 'pg';

/**
 * The oracle `runReconciliation` (packages/ledger) asks for the
 * authoritative outcome of a payment stuck in RECONCILIATION_REQUIRED. For
 * the mock rail, "ask the facilitator again" means "re-run the same
 * deterministic mock-facilitator logic against the payload we stored when
 * we prepared the payment" (`payment_intents.x402_payload`, added in
 * migration 0003) — this mirrors how a real oracle would re-query a real
 * facilitator's `/verify` or inspect chain state for a known tx, without
 * requiring an actual chain in this demo.
 *
 * The stored payload's own `accepted` field — not a freshly reconstructed
 * one — is used as the requirements to check it against: `accepted` is
 * exactly what the live provider offered at PAYMENT_PREPARED time
 * (`preparePayment` copies `requirements` into it verbatim), so
 * reconstructing requirements independently here from `providers.pay_to`
 * (which is informational-only metadata, not the authoritative payTo —
 * see docs/RESEARCH.md §3) would risk a spurious mismatch. This still
 * genuinely re-validates the payload's shape and mock marker, it just
 * doesn't re-derive requirements from a second, potentially-stale source.
 *
 * If no payload was ever stored (the intent never got past RESERVED), the
 * outcome is genuinely undeterminable and this returns 'UNKNOWN' — the
 * honest answer, not a guess.
 */
export function createMockSettlementOracle(pool: Pool): SettlementOracle {
  return {
    async lookup(paymentIntentId: string): Promise<'SETTLED' | 'FAILED' | 'UNKNOWN'> {
      const { rows } = await pool.query<{ x402_payload: unknown }>(
        'SELECT x402_payload FROM payment_intents WHERE id = $1',
        [paymentIntentId],
      );
      const row = rows[0];
      if (!row || !row.x402_payload) return 'UNKNOWN';

      const payload = row.x402_payload as PaymentPayloadWire;
      const result = mockSettle(payload, payload.accepted);
      return result.success ? 'SETTLED' : 'FAILED';
    },
  };
}
