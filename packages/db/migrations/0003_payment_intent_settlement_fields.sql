-- Adds the fields the API layer needs to (a) detect duplicate logical
-- requests independent of the Idempotency-Key mechanism, and (b) let
-- reconciliation deterministically re-derive a mock payment's outcome by
-- re-running the same pure mock-facilitator logic against the originally
-- signed payload, rather than guessing. See docs/ARCHITECTURE.md §7 and
-- apps/api/src/oracle.ts.
ALTER TABLE payment_intents
  ADD COLUMN request_fingerprint text,
  ADD COLUMN x402_payload jsonb;

CREATE INDEX idx_payment_intents_fingerprint ON payment_intents(agent_id, request_fingerprint, created_at);

-- Providers need a payTo reference for Treasury's own bookkeeping /
-- routing display. The authoritative PaymentRequirements used in an
-- actual payment always comes live from the provider's own 402 response
-- (see docs/RESEARCH.md §3) — this column is informational only.
ALTER TABLE providers ADD COLUMN pay_to text;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'treasury_app') THEN
    GRANT SELECT, INSERT, UPDATE ON providers, payment_intents TO treasury_app;
  END IF;
END
$$;
