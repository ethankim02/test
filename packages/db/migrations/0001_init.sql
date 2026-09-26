-- x402 Treasury — initial schema.
-- Hand-written SQL (not drizzle-kit generated) so that Postgres-specific
-- correctness features — CHECK-constrained accounting invariants, and the
-- append-only privilege revocation on financial history tables — are
-- explicit and reviewable. See docs/ARCHITECTURE.md and ADR-004.
--
-- Applied in order by packages/db/src/migrate.ts, tracked in _migrations.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Organizations / Agents / API keys
-- ---------------------------------------------------------------------------

CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id),
  parent_agent_id   uuid REFERENCES agents(id),
  name              text NOT NULL,
  status            text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_agents_org_id ON agents(org_id);
CREATE INDEX idx_agents_parent_agent_id ON agents(parent_agent_id);

CREATE TABLE api_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id),
  agent_id    uuid REFERENCES agents(id), -- null = org-level key
  key_hash    text NOT NULL UNIQUE,
  label       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);
CREATE INDEX idx_api_keys_org_id ON api_keys(org_id);

-- ---------------------------------------------------------------------------
-- Budgets — see docs/ARCHITECTURE.md §4 for the accounting invariant.
-- ---------------------------------------------------------------------------

CREATE TABLE budgets (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organizations(id),
  agent_id           uuid REFERENCES agents(id),         -- null for the ORG root budget
  parent_budget_id   uuid REFERENCES budgets(id),         -- null only for the ORG root budget
  scope              text NOT NULL CHECK (scope IN ('ORG', 'AGENT', 'SESSION')),
  name               text NOT NULL,
  period             text NOT NULL CHECK (period IN ('DAILY', 'TOTAL')),
  asset              text NOT NULL DEFAULT 'USDC',
  allocated_minor    bigint NOT NULL CHECK (allocated_minor >= 0),
  available_minor    bigint NOT NULL,
  reserved_minor     bigint NOT NULL DEFAULT 0,
  spent_minor        bigint NOT NULL DEFAULT 0,
  window_started_at  timestamptz NOT NULL DEFAULT now(), -- start of the current DAILY window
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz,
  CONSTRAINT budgets_balance_nonnegative CHECK (
    available_minor >= 0 AND reserved_minor >= 0 AND spent_minor >= 0
  ),
  CONSTRAINT budgets_balance_invariant CHECK (
    available_minor + reserved_minor + spent_minor = allocated_minor
  )
);
CREATE INDEX idx_budgets_parent_budget_id ON budgets(parent_budget_id);
CREATE INDEX idx_budgets_agent_id ON budgets(agent_id);
CREATE INDEX idx_budgets_org_id ON budgets(org_id);

-- ---------------------------------------------------------------------------
-- Reservations
-- ---------------------------------------------------------------------------

CREATE TABLE reservations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  leaf_budget_id  uuid NOT NULL REFERENCES budgets(id),
  agent_id        uuid NOT NULL REFERENCES agents(id),
  amount_minor    bigint NOT NULL CHECK (amount_minor > 0),
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CONSUMED', 'RELEASED', 'EXPIRED')),
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_reservations_status_expires_at ON reservations(status, expires_at);
CREATE INDEX idx_reservations_leaf_budget_id ON reservations(leaf_budget_id);

-- ---------------------------------------------------------------------------
-- Ledger — append-only. See docs/ARCHITECTURE.md §4.3 (balanced multi-entry
-- transactions, not classic two-account double-entry) and ADR-004.
-- ---------------------------------------------------------------------------

CREATE TABLE ledger_entries (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_transaction_id  uuid NOT NULL,
  budget_id              uuid NOT NULL REFERENCES budgets(id),
  entry_type             text NOT NULL CHECK (entry_type IN ('ALLOCATE', 'RESERVE', 'RELEASE', 'CAPTURE', 'EXPIRE')),
  amount_minor           bigint NOT NULL, -- signed: +available for ALLOCATE/RELEASE credits, -available for RESERVE debits, etc.
  balance_after_minor    bigint NOT NULL, -- available_minor on this budget immediately after this entry, for audit replay
  reservation_id         uuid REFERENCES reservations(id),
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ledger_entries_budget_id ON ledger_entries(budget_id, created_at);
CREATE INDEX idx_ledger_entries_ledger_transaction_id ON ledger_entries(ledger_transaction_id);
CREATE INDEX idx_ledger_entries_reservation_id ON ledger_entries(reservation_id);

-- ---------------------------------------------------------------------------
-- Providers
-- ---------------------------------------------------------------------------

CREATE TABLE providers (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid REFERENCES organizations(id), -- null = globally visible demo provider
  name                   text NOT NULL,
  base_url               text NOT NULL,
  resource_path          text NOT NULL,
  category               text NOT NULL,
  network                text NOT NULL,
  asset                  text NOT NULL DEFAULT 'USDC',
  configured_price_minor bigint,
  trust_status           text NOT NULL DEFAULT 'UNKNOWN' CHECK (trust_status IN ('TRUSTED', 'KNOWN', 'UNKNOWN')),
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_providers_org_id ON providers(org_id);
CREATE INDEX idx_providers_category ON providers(category);

CREATE TABLE provider_metrics (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id            uuid NOT NULL REFERENCES providers(id),
  observed_price_minor   bigint NOT NULL,
  observed_latency_ms    integer NOT NULL,
  observed_success       boolean NOT NULL,
  sampled_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_provider_metrics_provider_id_sampled_at ON provider_metrics(provider_id, sampled_at DESC);

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------

CREATE TABLE policies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id),
  scope       text NOT NULL CHECK (scope IN ('ORG', 'AGENT', 'SESSION')),
  agent_id    uuid REFERENCES agents(id),
  rule_type   text NOT NULL,
  params      jsonb NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_policies_org_id ON policies(org_id);
CREATE INDEX idx_policies_agent_id ON policies(agent_id);

-- ---------------------------------------------------------------------------
-- Idempotency
-- ---------------------------------------------------------------------------

CREATE TABLE idempotency_keys (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id            uuid NOT NULL REFERENCES agents(id),
  key                 text NOT NULL,
  request_hash        text NOT NULL,
  response_body       jsonb,
  payment_intent_id   uuid,
  status              text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'COMPLETED')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  UNIQUE (agent_id, key)
);

-- ---------------------------------------------------------------------------
-- Routing decisions — auditable, append-only.
-- ---------------------------------------------------------------------------

CREATE TABLE routing_decisions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_budget_id      uuid NOT NULL REFERENCES budgets(id),
  constraints            jsonb NOT NULL,
  considered             jsonb NOT NULL,
  selected_provider_id   uuid REFERENCES providers(id),
  objective              text NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_routing_decisions_session_budget_id ON routing_decisions(session_budget_id);

-- ---------------------------------------------------------------------------
-- Payment intents — see docs/ARCHITECTURE.md §5 for the state machine.
-- ---------------------------------------------------------------------------

CREATE TABLE payment_intents (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES organizations(id),
  agent_id              uuid NOT NULL REFERENCES agents(id),
  session_budget_id     uuid NOT NULL REFERENCES budgets(id),
  provider_id           uuid NOT NULL REFERENCES providers(id),
  reservation_id        uuid REFERENCES reservations(id),
  idempotency_key_id    uuid REFERENCES idempotency_keys(id),
  routing_decision_id   uuid REFERENCES routing_decisions(id),
  amount_minor          bigint NOT NULL CHECK (amount_minor > 0),
  asset                 text NOT NULL DEFAULT 'USDC',
  network                text NOT NULL,
  state                 text NOT NULL,
  failure_reason        text,
  settlement_tx_hash    text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_payment_intents_agent_id ON payment_intents(agent_id, created_at);
CREATE INDEX idx_payment_intents_session_budget_id ON payment_intents(session_budget_id);
CREATE INDEX idx_payment_intents_state ON payment_intents(state);

CREATE TABLE payment_state_transitions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_intent_id   uuid NOT NULL REFERENCES payment_intents(id),
  from_state          text,
  to_state            text NOT NULL,
  reason              text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_payment_state_transitions_intent_id ON payment_state_transitions(payment_intent_id, created_at);

-- ---------------------------------------------------------------------------
-- Reconciliation — append-only audit trail. See docs/ARCHITECTURE.md §7.
-- ---------------------------------------------------------------------------

CREATE TABLE reconciliation_records (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_intent_id   uuid NOT NULL REFERENCES payment_intents(id),
  previous_state      text NOT NULL,
  resolution          text NOT NULL CHECK (resolution IN ('REPAIRED', 'MARKED_FOR_REVIEW', 'CONFIRMED_SETTLED', 'CONFIRMED_FAILED')),
  detail              text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_reconciliation_records_intent_id ON reconciliation_records(payment_intent_id);

-- ---------------------------------------------------------------------------
-- Append-only enforcement: the application runtime role may INSERT and
-- SELECT on financial history tables, but never UPDATE or DELETE. Only a
-- migration (run as the migrator/owner role) can alter their structure.
-- No-op (rather than an error) if the role doesn't exist yet, so this
-- migration is safe to run against a database where the app role hasn't
-- been provisioned.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'treasury_app') THEN
    GRANT SELECT, INSERT ON ledger_entries TO treasury_app;
    REVOKE UPDATE, DELETE ON ledger_entries FROM treasury_app;

    GRANT SELECT, INSERT ON payment_state_transitions TO treasury_app;
    REVOKE UPDATE, DELETE ON payment_state_transitions FROM treasury_app;

    GRANT SELECT, INSERT ON reconciliation_records TO treasury_app;
    REVOKE UPDATE, DELETE ON reconciliation_records FROM treasury_app;

    GRANT SELECT, INSERT ON routing_decisions TO treasury_app;
    REVOKE UPDATE, DELETE ON routing_decisions FROM treasury_app;

    GRANT SELECT, INSERT, UPDATE ON
      organizations, agents, api_keys, budgets, reservations, providers,
      provider_metrics, policies, idempotency_keys, payment_intents
      TO treasury_app;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO treasury_app;
  END IF;
END
$$;
