import type { ReasonCode } from '@x402-treasury/shared';

export type TrustStatus = 'TRUSTED' | 'KNOWN' | 'UNKNOWN';

export interface ProviderContext {
  id: string;
  category: string;
  trustStatus: TrustStatus;
}

export interface RecentPayment {
  providerId: string;
  amountMinor: bigint;
  createdAt: Date;
  /** Caller-supplied fingerprint of "what is logically being bought" (e.g. hash of provider+resource+params), used for duplicate detection independent of idempotency keys. */
  requestFingerprint: string;
}

/**
 * Everything a rule might need to make a decision. The policy engine
 * itself never queries a database — the caller (the API layer) is
 * responsible for assembling this from the ledger and payment history, so
 * every rule stays a pure function and is unit-testable with plain
 * objects. See docs/DECISIONS.md ADR-007's sibling principle for the
 * ledger/adapter split — the same "keep domain logic DB-free and
 * independently testable" reasoning applies here.
 */
export interface PolicyContext {
  agentId: string;
  sessionBudgetId: string;
  provider: ProviderContext;
  amountMinor: bigint;
  requestFingerprint: string;
  now: Date;
  /** Session's currently available minor units (from the ledger, read before this call). */
  sessionAvailableMinor: bigint;
  /** Sum of `spent + reserved` for the agent today, excluding this request. */
  agentDailySpentMinor: bigint;
  /** Sum of `spent + reserved` for the whole org today, excluding this request. */
  orgDailySpentMinor: bigint;
  /** Sum of `spent + reserved` for this provider's category, org-wide, today. */
  categoryDailySpentMinor: bigint;
  /** Payments by this agent in some recent lookback window the caller decided (used by velocity/duplicate rules). */
  recentPayments: RecentPayment[];
}

export type Verdict = 'ALLOW' | 'BLOCK' | 'REVIEW';

export interface RuleEvaluation {
  ruleType: string;
  verdict: Verdict;
  reasonCode?: ReasonCode;
  detail: string;
}

export interface PolicyDecision {
  decision: Verdict;
  reasonCodes: ReasonCode[];
  evaluatedRules: RuleEvaluation[];
}

export interface PolicyRuleConfig {
  ruleType: string;
  enabled: boolean;
  params: unknown;
}

export type RuleFn = (context: PolicyContext, params: unknown) => RuleEvaluation;
