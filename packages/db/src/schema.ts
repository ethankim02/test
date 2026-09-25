import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// This mirrors packages/db/migrations/0001_init.sql exactly. The SQL file
// is the source of truth for DDL (constraints, REVOKEs); this file exists
// so application code gets typed query building via drizzle-orm. See
// docs/DECISIONS.md ADR-002 and packages/db/README for why migrations are
// hand-written SQL rather than drizzle-kit-generated.

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    parentAgentId: uuid('parent_agent_id'),
    name: text('name').notNull(),
    status: text('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_agents_org_id').on(t.orgId), index('idx_agents_parent_agent_id').on(t.parentAgentId)],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    agentId: uuid('agent_id').references(() => agents.id),
    keyHash: text('key_hash').notNull().unique(),
    label: text('label'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('idx_api_keys_org_id').on(t.orgId)],
);

export const budgets = pgTable(
  'budgets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    agentId: uuid('agent_id').references(() => agents.id),
    parentBudgetId: uuid('parent_budget_id'),
    scope: text('scope').notNull(), // 'ORG' | 'AGENT' | 'SESSION'
    name: text('name').notNull(),
    period: text('period').notNull(), // 'DAILY' | 'TOTAL'
    asset: text('asset').notNull().default('USDC'),
    allocatedMinor: bigint('allocated_minor', { mode: 'bigint' }).notNull(),
    availableMinor: bigint('available_minor', { mode: 'bigint' }).notNull(),
    reservedMinor: bigint('reserved_minor', { mode: 'bigint' }).notNull().default(0n),
    spentMinor: bigint('spent_minor', { mode: 'bigint' }).notNull().default(0n),
    windowStartedAt: timestamp('window_started_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (t) => [
    index('idx_budgets_parent_budget_id').on(t.parentBudgetId),
    index('idx_budgets_agent_id').on(t.agentId),
    index('idx_budgets_org_id').on(t.orgId),
    check(
      'budgets_balance_invariant',
      sql`${t.availableMinor} + ${t.reservedMinor} + ${t.spentMinor} = ${t.allocatedMinor}`,
    ),
  ],
);

export const reservations = pgTable(
  'reservations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    leafBudgetId: uuid('leaf_budget_id')
      .notNull()
      .references(() => budgets.id),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    status: text('status').notNull().default('ACTIVE'), // ACTIVE|CONSUMED|RELEASED|EXPIRED
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_reservations_status_expires_at').on(t.status, t.expiresAt),
    index('idx_reservations_leaf_budget_id').on(t.leafBudgetId),
  ],
);

export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ledgerTransactionId: uuid('ledger_transaction_id').notNull(),
    budgetId: uuid('budget_id')
      .notNull()
      .references(() => budgets.id),
    entryType: text('entry_type').notNull(), // ALLOCATE|RESERVE|RELEASE|CAPTURE|EXPIRE
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    balanceAfterMinor: bigint('balance_after_minor', { mode: 'bigint' }).notNull(),
    reservationId: uuid('reservation_id').references(() => reservations.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_ledger_entries_budget_id').on(t.budgetId, t.createdAt),
    index('idx_ledger_entries_ledger_transaction_id').on(t.ledgerTransactionId),
  ],
);

export const providers = pgTable(
  'providers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').references(() => organizations.id),
    name: text('name').notNull(),
    baseUrl: text('base_url').notNull(),
    resourcePath: text('resource_path').notNull(),
    category: text('category').notNull(),
    network: text('network').notNull(),
    asset: text('asset').notNull().default('USDC'),
    configuredPriceMinor: bigint('configured_price_minor', { mode: 'bigint' }),
    trustStatus: text('trust_status').notNull().default('UNKNOWN'), // TRUSTED|KNOWN|UNKNOWN
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_providers_org_id').on(t.orgId), index('idx_providers_category').on(t.category)],
);

export const providerMetrics = pgTable(
  'provider_metrics',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => providers.id),
    observedPriceMinor: bigint('observed_price_minor', { mode: 'bigint' }).notNull(),
    observedLatencyMs: integer('observed_latency_ms').notNull(),
    observedSuccess: boolean('observed_success').notNull(),
    sampledAt: timestamp('sampled_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_provider_metrics_provider_id_sampled_at').on(t.providerId, t.sampledAt)],
);

export const policies = pgTable(
  'policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    scope: text('scope').notNull(), // ORG|AGENT|SESSION
    agentId: uuid('agent_id').references(() => agents.id),
    ruleType: text('rule_type').notNull(),
    params: jsonb('params').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_policies_org_id').on(t.orgId), index('idx_policies_agent_id').on(t.agentId)],
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    responseBody: jsonb('response_body'),
    paymentIntentId: uuid('payment_intent_id'),
    status: text('status').notNull().default('PENDING'), // PENDING|COMPLETED
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [unique('idempotency_keys_agent_id_key').on(t.agentId, t.key)],
);

export const routingDecisions = pgTable(
  'routing_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionBudgetId: uuid('session_budget_id')
      .notNull()
      .references(() => budgets.id),
    constraints: jsonb('constraints').notNull(),
    considered: jsonb('considered').notNull(),
    selectedProviderId: uuid('selected_provider_id').references(() => providers.id),
    objective: text('objective').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_routing_decisions_session_budget_id').on(t.sessionBudgetId)],
);

export const paymentIntents = pgTable(
  'payment_intents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    sessionBudgetId: uuid('session_budget_id')
      .notNull()
      .references(() => budgets.id),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => providers.id),
    reservationId: uuid('reservation_id').references(() => reservations.id),
    idempotencyKeyId: uuid('idempotency_key_id').references(() => idempotencyKeys.id),
    routingDecisionId: uuid('routing_decision_id').references(() => routingDecisions.id),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    asset: text('asset').notNull().default('USDC'),
    network: text('network').notNull(),
    state: text('state').notNull(),
    failureReason: text('failure_reason'),
    settlementTxHash: text('settlement_tx_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_payment_intents_agent_id').on(t.agentId, t.createdAt),
    index('idx_payment_intents_session_budget_id').on(t.sessionBudgetId),
    index('idx_payment_intents_state').on(t.state),
  ],
);

export const paymentStateTransitions = pgTable(
  'payment_state_transitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    paymentIntentId: uuid('payment_intent_id')
      .notNull()
      .references(() => paymentIntents.id),
    fromState: text('from_state'),
    toState: text('to_state').notNull(),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_payment_state_transitions_intent_id').on(t.paymentIntentId, t.createdAt)],
);

export const reconciliationRecords = pgTable(
  'reconciliation_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    paymentIntentId: uuid('payment_intent_id')
      .notNull()
      .references(() => paymentIntents.id),
    previousState: text('previous_state').notNull(),
    resolution: text('resolution').notNull(), // REPAIRED|MARKED_FOR_REVIEW|CONFIRMED_SETTLED|CONFIRMED_FAILED
    detail: text('detail'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_reconciliation_records_intent_id').on(t.paymentIntentId)],
);
