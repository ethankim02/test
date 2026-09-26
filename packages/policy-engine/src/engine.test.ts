import { DomainError } from '@x402-treasury/shared';
import { describe, expect, it } from 'vitest';
import { evaluatePolicy } from './engine.js';
import { baseContext } from './test-helpers.js';
import type { PolicyRuleConfig } from './types.js';

describe('evaluatePolicy', () => {
  it('allows a request that passes every configured rule', () => {
    const configs: PolicyRuleConfig[] = [
      { ruleType: 'PER_TRANSACTION_LIMIT', enabled: true, params: { maxAmountMinor: '500000' } },
      { ruleType: 'PROVIDER_ALLOWLIST', enabled: true, params: { providerIds: ['provider-1'] } },
    ];
    const decision = evaluatePolicy(baseContext(), configs);
    expect(decision.decision).toBe('ALLOW');
    expect(decision.reasonCodes).toEqual([]);
  });

  it('matches the spec example: BLOCK with multiple reason codes when several rules fail at once', () => {
    const configs: PolicyRuleConfig[] = [
      {
        ruleType: 'PROVIDER_ALLOWLIST',
        enabled: true,
        params: { providerIds: ['some-other-provider'] },
      },
      { ruleType: 'UNKNOWN_PROVIDER_LIMIT', enabled: true, params: { maxAmountMinor: '50000' } },
    ];
    const ctx = baseContext({
      sessionAvailableMinor: 10_000n, // also fails session budget
      amountMinor: 60_000n, // also over the unknown-provider limit
      provider: { id: 'unknown-provider', category: 'search', trustStatus: 'UNKNOWN' },
    });
    const decision = evaluatePolicy(ctx, configs);

    expect(decision.decision).toBe('BLOCK');
    expect(decision.reasonCodes).toEqual(
      expect.arrayContaining([
        'SESSION_BUDGET_EXCEEDED',
        'PROVIDER_NOT_ALLOWED',
        'UNKNOWN_PROVIDER_LIMIT_EXCEEDED',
      ]),
    );
    // Every configured rule ran — not just the first failure.
    expect(decision.evaluatedRules).toHaveLength(3); // built-in session rule + 2 configured
  });

  it('BLOCK outranks REVIEW when both fire', () => {
    const configs: PolicyRuleConfig[] = [
      { ruleType: 'HUMAN_APPROVAL_THRESHOLD', enabled: true, params: { thresholdMinor: '10000' } },
      { ruleType: 'PER_TRANSACTION_LIMIT', enabled: true, params: { maxAmountMinor: '5000' } },
    ];
    const decision = evaluatePolicy(baseContext({ amountMinor: 20_000n }), configs);
    expect(decision.decision).toBe('BLOCK');
    expect(decision.reasonCodes).toContain('PER_TRANSACTION_LIMIT_EXCEEDED');
    expect(decision.reasonCodes).toContain('APPROVAL_REQUIRED');
  });

  it('REVIEW when a threshold rule fires and nothing blocks', () => {
    const configs: PolicyRuleConfig[] = [
      { ruleType: 'HUMAN_APPROVAL_THRESHOLD', enabled: true, params: { thresholdMinor: '10000' } },
    ];
    const decision = evaluatePolicy(
      baseContext({ amountMinor: 20_000n, sessionAvailableMinor: 1_000_000n }),
      configs,
    );
    expect(decision.decision).toBe('REVIEW');
  });

  it('skips disabled rules entirely', () => {
    const configs: PolicyRuleConfig[] = [
      { ruleType: 'PER_TRANSACTION_LIMIT', enabled: false, params: { maxAmountMinor: '1' } },
    ];
    const decision = evaluatePolicy(baseContext({ amountMinor: 999_999n }), configs);
    expect(decision.decision).toBe('ALLOW');
  });

  it('always evaluates the built-in session budget rule even with zero configured policies', () => {
    const decision = evaluatePolicy(
      baseContext({ amountMinor: 2_000_000n, sessionAvailableMinor: 1_000_000n }),
      [],
    );
    expect(decision.decision).toBe('BLOCK');
    expect(decision.reasonCodes).toEqual(['SESSION_BUDGET_EXCEEDED']);
  });

  it('is deterministic: the same context and configs always produce the same decision', () => {
    const configs: PolicyRuleConfig[] = [
      { ruleType: 'PER_TRANSACTION_LIMIT', enabled: true, params: { maxAmountMinor: '500000' } },
    ];
    const ctx = baseContext({ amountMinor: 600_000n });
    const first = evaluatePolicy(ctx, configs);
    const second = evaluatePolicy(ctx, configs);
    expect(first).toEqual(second);
  });

  it('throws a config error (not a spending decision) for an unknown rule_type', () => {
    const configs: PolicyRuleConfig[] = [
      { ruleType: 'NOT_A_REAL_RULE', enabled: true, params: {} },
    ];
    expect(() => evaluatePolicy(baseContext(), configs)).toThrow(DomainError);
  });
});
