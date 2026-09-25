import type { AssetCode } from '@x402-treasury/shared';

export type BudgetScope = 'ORG' | 'AGENT' | 'SESSION';
export type BudgetPeriod = 'DAILY' | 'TOTAL';
export type ReservationStatus = 'ACTIVE' | 'CONSUMED' | 'RELEASED' | 'EXPIRED';
export type LedgerEntryType = 'ALLOCATE' | 'RESERVE' | 'RELEASE' | 'CAPTURE' | 'EXPIRE';

export interface BudgetRow {
  id: string;
  orgId: string;
  agentId: string | null;
  parentBudgetId: string | null;
  scope: BudgetScope;
  name: string;
  period: BudgetPeriod;
  asset: AssetCode;
  allocatedMinor: bigint;
  availableMinor: bigint;
  reservedMinor: bigint;
  spentMinor: bigint;
  windowStartedAt: Date;
  createdAt: Date;
  expiresAt: Date | null;
}

export interface ReservationRow {
  id: string;
  leafBudgetId: string;
  agentId: string;
  amountMinor: bigint;
  status: ReservationStatus;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface LedgerEntryRow {
  id: string;
  ledgerTransactionId: string;
  budgetId: string;
  entryType: LedgerEntryType;
  amountMinor: bigint;
  balanceAfterMinor: bigint;
  reservationId: string | null;
  createdAt: Date;
}

/** Raw row shapes as returned by `pg` (snake_case, driver-native types). */
export interface RawBudgetRow {
  id: string;
  org_id: string;
  agent_id: string | null;
  parent_budget_id: string | null;
  scope: BudgetScope;
  name: string;
  period: BudgetPeriod;
  asset: AssetCode;
  allocated_minor: string;
  available_minor: string;
  reserved_minor: string;
  spent_minor: string;
  window_started_at: Date;
  created_at: Date;
  expires_at: Date | null;
}

export interface RawReservationRow {
  id: string;
  leaf_budget_id: string;
  agent_id: string;
  amount_minor: string;
  status: ReservationStatus;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

export function mapBudgetRow(r: RawBudgetRow): BudgetRow {
  return {
    id: r.id,
    orgId: r.org_id,
    agentId: r.agent_id,
    parentBudgetId: r.parent_budget_id,
    scope: r.scope,
    name: r.name,
    period: r.period,
    asset: r.asset,
    allocatedMinor: BigInt(r.allocated_minor),
    availableMinor: BigInt(r.available_minor),
    reservedMinor: BigInt(r.reserved_minor),
    spentMinor: BigInt(r.spent_minor),
    windowStartedAt: r.window_started_at,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  };
}

export function mapReservationRow(r: RawReservationRow): ReservationRow {
  return {
    id: r.id,
    leafBudgetId: r.leaf_budget_id,
    agentId: r.agent_id,
    amountMinor: BigInt(r.amount_minor),
    status: r.status,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
