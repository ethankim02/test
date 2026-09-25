import { DomainError, type ReasonCode } from '@x402-treasury/shared';
import { RULES, sessionBudgetLimit } from './rules.js';
import type { PolicyContext, PolicyDecision, PolicyRuleConfig, RuleEvaluation } from './types.js';

/**
 * Evaluates every enabled rule against `context` and combines them into
 * one decision. All rules run (never short-circuits on the first BLOCK) so
 * a caller always gets the complete set of reasons — task principle D:
 * "when a payment is approved or rejected, return structured reasons," not
 * just the first one found. BLOCK outranks REVIEW, which outranks ALLOW.
 *
 * `SESSION_BUDGET_LIMIT` is evaluated unconditionally, independent of the
 * `configs` an org has set up — it isn't an optional policy an operator
 * can forget to configure, it's a direct read of the ledger's own
 * available balance, surfaced through the same reason-code mechanism as
 * every other rule so a blocked caller gets `SESSION_BUDGET_EXCEEDED`
 * instead of just an opaque 402 from the ledger later.
 */
export function evaluatePolicy(
  context: PolicyContext,
  configs: PolicyRuleConfig[],
): PolicyDecision {
  const evaluatedRules: RuleEvaluation[] = [sessionBudgetLimit(context, undefined)];

  for (const config of configs) {
    if (!config.enabled) continue;
    const rule = RULES[config.ruleType];
    if (!rule) {
      throw new DomainError(
        'VALIDATION_ERROR',
        `unknown policy rule_type "${config.ruleType}" — this is a configuration error, not a runtime spending decision`,
        { details: { ruleType: config.ruleType } },
      );
    }
    evaluatedRules.push(rule(context, config.params));
  }

  const reasonCodes: ReasonCode[] = evaluatedRules
    .filter((r) => r.verdict !== 'ALLOW')
    .map((r) => r.reasonCode)
    .filter((c): c is ReasonCode => c !== undefined);

  let decision: PolicyDecision['decision'] = 'ALLOW';
  if (evaluatedRules.some((r) => r.verdict === 'BLOCK')) {
    decision = 'BLOCK';
  } else if (evaluatedRules.some((r) => r.verdict === 'REVIEW')) {
    decision = 'REVIEW';
  }

  return { decision, reasonCodes, evaluatedRules };
}
