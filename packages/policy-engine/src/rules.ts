import { z } from 'zod';
import type { RuleEvaluation, RuleFn } from './types.js';

// Params are validated with zod at evaluation time rather than trusted
// blindly from the `policies.params` jsonb column, since that column is
// operator-editable (potentially via the API) and a malformed rule should
// fail loudly, not silently no-op.
const bigintString = z
  .string()
  .regex(/^\d+$/)
  .transform((s) => BigInt(s));

function allow(ruleType: string, detail: string): RuleEvaluation {
  return { ruleType, verdict: 'ALLOW', detail };
}

// ---------------------------------------------------------------------------
// PerTransactionLimit
// ---------------------------------------------------------------------------
const PerTransactionLimitParams = z.object({ maxAmountMinor: bigintString });
export const perTransactionLimit: RuleFn = (ctx, rawParams) => {
  const params = PerTransactionLimitParams.parse(rawParams);
  if (ctx.amountMinor > params.maxAmountMinor) {
    return {
      ruleType: 'PER_TRANSACTION_LIMIT',
      verdict: 'BLOCK',
      reasonCode: 'PER_TRANSACTION_LIMIT_EXCEEDED',
      detail: `amount ${ctx.amountMinor} exceeds per-transaction limit ${params.maxAmountMinor}`,
    };
  }
  return allow('PER_TRANSACTION_LIMIT', 'within per-transaction limit');
};

// ---------------------------------------------------------------------------
// SessionBudgetLimit — a fast, explicit pre-check mirroring what the
// ledger will enforce atomically anyway (see packages/ledger/reserve.ts).
// Having it here means a blocked request gets a reason code without an
// attempted reservation, and it's covered by the same policy audit trail.
// ---------------------------------------------------------------------------
export const sessionBudgetLimit: RuleFn = (ctx) => {
  if (ctx.amountMinor > ctx.sessionAvailableMinor) {
    return {
      ruleType: 'SESSION_BUDGET_LIMIT',
      verdict: 'BLOCK',
      reasonCode: 'SESSION_BUDGET_EXCEEDED',
      detail: `amount ${ctx.amountMinor} exceeds session's available ${ctx.sessionAvailableMinor}`,
    };
  }
  return allow('SESSION_BUDGET_LIMIT', 'within session budget');
};

// ---------------------------------------------------------------------------
// DailyAgentLimit / DailyOrgLimit
// ---------------------------------------------------------------------------
const DailyLimitParams = z.object({ maxAmountMinor: bigintString });

export const dailyAgentLimit: RuleFn = (ctx, rawParams) => {
  const params = DailyLimitParams.parse(rawParams);
  const projected = ctx.agentDailySpentMinor + ctx.amountMinor;
  if (projected > params.maxAmountMinor) {
    return {
      ruleType: 'DAILY_AGENT_LIMIT',
      verdict: 'BLOCK',
      reasonCode: 'AGENT_DAILY_LIMIT_EXCEEDED',
      detail: `projected daily agent spend ${projected} exceeds limit ${params.maxAmountMinor}`,
    };
  }
  return allow('DAILY_AGENT_LIMIT', 'within agent daily limit');
};

export const dailyOrgLimit: RuleFn = (ctx, rawParams) => {
  const params = DailyLimitParams.parse(rawParams);
  const projected = ctx.orgDailySpentMinor + ctx.amountMinor;
  if (projected > params.maxAmountMinor) {
    return {
      ruleType: 'DAILY_ORG_LIMIT',
      verdict: 'BLOCK',
      reasonCode: 'ORG_DAILY_LIMIT_EXCEEDED',
      detail: `projected daily org spend ${projected} exceeds limit ${params.maxAmountMinor}`,
    };
  }
  return allow('DAILY_ORG_LIMIT', 'within org daily limit');
};

// ---------------------------------------------------------------------------
// CategoryDailyLimit
// ---------------------------------------------------------------------------
const CategoryDailyLimitParams = z.object({ category: z.string(), maxAmountMinor: bigintString });
export const categoryDailyLimit: RuleFn = (ctx, rawParams) => {
  const params = CategoryDailyLimitParams.parse(rawParams);
  if (ctx.provider.category !== params.category) {
    return allow(
      'CATEGORY_DAILY_LIMIT',
      `rule scoped to category "${params.category}", request is "${ctx.provider.category}"`,
    );
  }
  const projected = ctx.categoryDailySpentMinor + ctx.amountMinor;
  if (projected > params.maxAmountMinor) {
    return {
      ruleType: 'CATEGORY_DAILY_LIMIT',
      verdict: 'BLOCK',
      reasonCode: 'CATEGORY_DAILY_LIMIT_EXCEEDED',
      detail: `projected daily "${params.category}" spend ${projected} exceeds limit ${params.maxAmountMinor}`,
    };
  }
  return allow('CATEGORY_DAILY_LIMIT', 'within category daily limit');
};

// ---------------------------------------------------------------------------
// ProviderAllowlist / ProviderDenylist
// ---------------------------------------------------------------------------
const ProviderListParams = z.object({ providerIds: z.array(z.string()) });

export const providerAllowlist: RuleFn = (ctx, rawParams) => {
  const params = ProviderListParams.parse(rawParams);
  if (!params.providerIds.includes(ctx.provider.id)) {
    return {
      ruleType: 'PROVIDER_ALLOWLIST',
      verdict: 'BLOCK',
      reasonCode: 'PROVIDER_NOT_ALLOWED',
      detail: `provider ${ctx.provider.id} is not on the allowlist`,
    };
  }
  return allow('PROVIDER_ALLOWLIST', 'provider is allowlisted');
};

export const providerDenylist: RuleFn = (ctx, rawParams) => {
  const params = ProviderListParams.parse(rawParams);
  if (params.providerIds.includes(ctx.provider.id)) {
    return {
      ruleType: 'PROVIDER_DENYLIST',
      verdict: 'BLOCK',
      reasonCode: 'PROVIDER_NOT_ALLOWED',
      detail: `provider ${ctx.provider.id} is on the denylist`,
    };
  }
  return allow('PROVIDER_DENYLIST', 'provider is not denylisted');
};

// ---------------------------------------------------------------------------
// UnknownProviderLimit
// ---------------------------------------------------------------------------
const UnknownProviderLimitParams = z.object({ maxAmountMinor: bigintString });
export const unknownProviderLimit: RuleFn = (ctx, rawParams) => {
  const params = UnknownProviderLimitParams.parse(rawParams);
  if (ctx.provider.trustStatus !== 'UNKNOWN') {
    return allow(
      'UNKNOWN_PROVIDER_LIMIT',
      `provider trust status is ${ctx.provider.trustStatus}, rule not applicable`,
    );
  }
  if (ctx.amountMinor > params.maxAmountMinor) {
    return {
      ruleType: 'UNKNOWN_PROVIDER_LIMIT',
      verdict: 'BLOCK',
      reasonCode: 'UNKNOWN_PROVIDER_LIMIT_EXCEEDED',
      detail: `amount ${ctx.amountMinor} exceeds unknown-provider limit ${params.maxAmountMinor}`,
    };
  }
  return allow('UNKNOWN_PROVIDER_LIMIT', 'within unknown-provider limit');
};

// ---------------------------------------------------------------------------
// DuplicatePaymentWindow — same logical request (fingerprint) seen again
// within a short window. Independent of the Idempotency-Key mechanism
// (packages/ledger idempotency_keys): this catches an agent that didn't
// send a key at all, or sent a *different* key for what is semantically
// the same purchase.
// ---------------------------------------------------------------------------
const DuplicatePaymentWindowParams = z.object({ windowSeconds: z.number().positive() });
export const duplicatePaymentWindow: RuleFn = (ctx, rawParams) => {
  const params = DuplicatePaymentWindowParams.parse(rawParams);
  const windowStart = ctx.now.getTime() - params.windowSeconds * 1000;
  const duplicate = ctx.recentPayments.find(
    (p) => p.requestFingerprint === ctx.requestFingerprint && p.createdAt.getTime() >= windowStart,
  );
  if (duplicate) {
    return {
      ruleType: 'DUPLICATE_PAYMENT_WINDOW',
      verdict: 'BLOCK',
      reasonCode: 'DUPLICATE_PAYMENT',
      detail: `identical request fingerprint seen at ${duplicate.createdAt.toISOString()}, within ${params.windowSeconds}s window`,
    };
  }
  return allow('DUPLICATE_PAYMENT_WINDOW', 'no duplicate in window');
};

// ---------------------------------------------------------------------------
// PaymentVelocityLimit — too many payments in a rolling window, regardless
// of amount (catches a runaway loop, not just an expensive one).
// ---------------------------------------------------------------------------
const PaymentVelocityLimitParams = z.object({
  windowSeconds: z.number().positive(),
  maxCount: z.number().int().positive(),
});
export const paymentVelocityLimit: RuleFn = (ctx, rawParams) => {
  const params = PaymentVelocityLimitParams.parse(rawParams);
  const windowStart = ctx.now.getTime() - params.windowSeconds * 1000;
  const countInWindow = ctx.recentPayments.filter(
    (p) => p.createdAt.getTime() >= windowStart,
  ).length;
  if (countInWindow + 1 > params.maxCount) {
    return {
      ruleType: 'PAYMENT_VELOCITY_LIMIT',
      verdict: 'BLOCK',
      reasonCode: 'PAYMENT_VELOCITY_EXCEEDED',
      detail: `${countInWindow} payments already in the last ${params.windowSeconds}s, limit is ${params.maxCount}`,
    };
  }
  return allow('PAYMENT_VELOCITY_LIMIT', 'within velocity limit');
};

// ---------------------------------------------------------------------------
// HumanApprovalThreshold — doesn't block, but downgrades the decision to
// REVIEW above a threshold. See engine.ts for how REVIEW composes with
// BLOCK from other rules (BLOCK always wins).
// ---------------------------------------------------------------------------
const HumanApprovalThresholdParams = z.object({ thresholdMinor: bigintString });
export const humanApprovalThreshold: RuleFn = (ctx, rawParams) => {
  const params = HumanApprovalThresholdParams.parse(rawParams);
  if (ctx.amountMinor > params.thresholdMinor) {
    return {
      ruleType: 'HUMAN_APPROVAL_THRESHOLD',
      verdict: 'REVIEW',
      reasonCode: 'APPROVAL_REQUIRED',
      detail: `amount ${ctx.amountMinor} exceeds auto-approval threshold ${params.thresholdMinor}`,
    };
  }
  return allow('HUMAN_APPROVAL_THRESHOLD', 'below approval threshold');
};

/**
 * Registry mapping a policy's `rule_type` (as stored in the `policies`
 * table) to its implementation. A lookup table rather than a switch
 * statement so adding a rule type never means editing a growing
 * conditional — see docs/DECISIONS.md's "avoid a giant switch statement"
 * principle (task §13).
 */
export const RULES: Record<string, RuleFn> = {
  PER_TRANSACTION_LIMIT: perTransactionLimit,
  SESSION_BUDGET_LIMIT: sessionBudgetLimit,
  DAILY_AGENT_LIMIT: dailyAgentLimit,
  DAILY_ORG_LIMIT: dailyOrgLimit,
  CATEGORY_DAILY_LIMIT: categoryDailyLimit,
  PROVIDER_ALLOWLIST: providerAllowlist,
  PROVIDER_DENYLIST: providerDenylist,
  UNKNOWN_PROVIDER_LIMIT: unknownProviderLimit,
  DUPLICATE_PAYMENT_WINDOW: duplicatePaymentWindow,
  PAYMENT_VELOCITY_LIMIT: paymentVelocityLimit,
  HUMAN_APPROVAL_THRESHOLD: humanApprovalThreshold,
};
