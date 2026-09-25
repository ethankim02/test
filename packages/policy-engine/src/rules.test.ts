import { describe, expect, it } from 'vitest';
import {
  categoryDailyLimit,
  dailyAgentLimit,
  dailyOrgLimit,
  duplicatePaymentWindow,
  humanApprovalThreshold,
  paymentVelocityLimit,
  perTransactionLimit,
  providerAllowlist,
  providerDenylist,
  sessionBudgetLimit,
  unknownProviderLimit,
} from './rules.js';
import { baseContext } from './test-helpers.js';

describe('perTransactionLimit', () => {
  it('blocks amounts over the limit', () => {
    const ctx = baseContext({ amountMinor: 600_000n });
    const result = perTransactionLimit(ctx, { maxAmountMinor: '500000' });
    expect(result.verdict).toBe('BLOCK');
    expect(result.reasonCode).toBe('PER_TRANSACTION_LIMIT_EXCEEDED');
  });

  it('allows amounts at or under the limit', () => {
    const ctx = baseContext({ amountMinor: 500_000n });
    expect(perTransactionLimit(ctx, { maxAmountMinor: '500000' }).verdict).toBe('ALLOW');
  });
});

describe('sessionBudgetLimit', () => {
  it('blocks when amount exceeds session available balance (Scenario B)', () => {
    const ctx = baseContext({ amountMinor: 30_000n, sessionAvailableMinor: 20_000n });
    const result = sessionBudgetLimit(ctx, undefined);
    expect(result.verdict).toBe('BLOCK');
    expect(result.reasonCode).toBe('SESSION_BUDGET_EXCEEDED');
  });

  it('allows when amount is within session available balance', () => {
    const ctx = baseContext({ amountMinor: 20_000n, sessionAvailableMinor: 20_000n });
    expect(sessionBudgetLimit(ctx, undefined).verdict).toBe('ALLOW');
  });
});

describe('dailyAgentLimit / dailyOrgLimit', () => {
  it('blocks when projected agent spend exceeds the limit', () => {
    const ctx = baseContext({ amountMinor: 100_000n, agentDailySpentMinor: 19_950_000n });
    const result = dailyAgentLimit(ctx, { maxAmountMinor: '20000000' });
    expect(result.verdict).toBe('BLOCK');
    expect(result.reasonCode).toBe('AGENT_DAILY_LIMIT_EXCEEDED');
  });

  it('blocks when projected org spend exceeds the limit', () => {
    const ctx = baseContext({ amountMinor: 1n, orgDailySpentMinor: 100_000_000n });
    const result = dailyOrgLimit(ctx, { maxAmountMinor: '100000000' });
    expect(result.verdict).toBe('BLOCK');
    expect(result.reasonCode).toBe('ORG_DAILY_LIMIT_EXCEEDED');
  });
});

describe('categoryDailyLimit', () => {
  it('is scoped to the configured category and ignores others', () => {
    const ctx = baseContext({ provider: { id: 'p', category: 'data', trustStatus: 'TRUSTED' }, categoryDailySpentMinor: 10_000_000n, amountMinor: 1n });
    const result = categoryDailyLimit(ctx, { category: 'search', maxAmountMinor: '5000000' });
    expect(result.verdict).toBe('ALLOW');
  });

  it('blocks when the matching category would exceed its limit', () => {
    const ctx = baseContext({ provider: { id: 'p', category: 'search', trustStatus: 'TRUSTED' }, categoryDailySpentMinor: 4_990_000n, amountMinor: 20_000n });
    const result = categoryDailyLimit(ctx, { category: 'search', maxAmountMinor: '5000000' });
    expect(result.verdict).toBe('BLOCK');
    expect(result.reasonCode).toBe('CATEGORY_DAILY_LIMIT_EXCEEDED');
  });
});

describe('providerAllowlist / providerDenylist', () => {
  it('blocks a provider not on the allowlist', () => {
    const ctx = baseContext({ provider: { id: 'unlisted', category: 'search', trustStatus: 'TRUSTED' } });
    const result = providerAllowlist(ctx, { providerIds: ['a', 'b'] });
    expect(result.verdict).toBe('BLOCK');
    expect(result.reasonCode).toBe('PROVIDER_NOT_ALLOWED');
  });

  it('allows a provider on the allowlist', () => {
    const ctx = baseContext({ provider: { id: 'a', category: 'search', trustStatus: 'TRUSTED' } });
    expect(providerAllowlist(ctx, { providerIds: ['a', 'b'] }).verdict).toBe('ALLOW');
  });

  it('blocks a provider on the denylist', () => {
    const ctx = baseContext({ provider: { id: 'bad', category: 'search', trustStatus: 'TRUSTED' } });
    const result = providerDenylist(ctx, { providerIds: ['bad'] });
    expect(result.verdict).toBe('BLOCK');
  });
});

describe('unknownProviderLimit', () => {
  it('is a no-op for known/trusted providers regardless of amount', () => {
    const ctx = baseContext({ provider: { id: 'p', category: 'search', trustStatus: 'TRUSTED' }, amountMinor: 5_000_000n });
    expect(unknownProviderLimit(ctx, { maxAmountMinor: '50000' }).verdict).toBe('ALLOW');
  });

  it('blocks an unknown provider above the small limit', () => {
    const ctx = baseContext({ provider: { id: 'p', category: 'search', trustStatus: 'UNKNOWN' }, amountMinor: 60_000n });
    const result = unknownProviderLimit(ctx, { maxAmountMinor: '50000' });
    expect(result.verdict).toBe('BLOCK');
    expect(result.reasonCode).toBe('UNKNOWN_PROVIDER_LIMIT_EXCEEDED');
  });
});

describe('duplicatePaymentWindow', () => {
  it('blocks an identical fingerprint seen within the window', () => {
    const ctx = baseContext({
      requestFingerprint: 'fp-x',
      now: new Date('2026-01-01T00:00:10.000Z'),
      recentPayments: [{ providerId: 'p', amountMinor: 1n, requestFingerprint: 'fp-x', createdAt: new Date('2026-01-01T00:00:07.000Z') }],
    });
    const result = duplicatePaymentWindow(ctx, { windowSeconds: 5 });
    expect(result.verdict).toBe('BLOCK');
    expect(result.reasonCode).toBe('DUPLICATE_PAYMENT');
  });

  it('allows an identical fingerprint outside the window', () => {
    const ctx = baseContext({
      requestFingerprint: 'fp-x',
      now: new Date('2026-01-01T00:00:10.000Z'),
      recentPayments: [{ providerId: 'p', amountMinor: 1n, requestFingerprint: 'fp-x', createdAt: new Date('2026-01-01T00:00:00.000Z') }],
    });
    expect(duplicatePaymentWindow(ctx, { windowSeconds: 5 }).verdict).toBe('ALLOW');
  });

  it('retrying the identical logical request 5 times in a row only the first is allowed', () => {
    const params = { windowSeconds: 5 };
    let recentPayments: { providerId: string; amountMinor: bigint; requestFingerprint: string; createdAt: Date }[] = [];
    const results = [];
    for (let i = 0; i < 5; i++) {
      const now = new Date('2026-01-01T00:00:00.000Z');
      const ctx = baseContext({ requestFingerprint: 'retry-fp', now, recentPayments });
      const result = duplicatePaymentWindow(ctx, params);
      results.push(result.verdict);
      if (result.verdict === 'ALLOW') {
        recentPayments = [...recentPayments, { providerId: 'p', amountMinor: 1n, requestFingerprint: 'retry-fp', createdAt: now }];
      }
    }
    expect(results).toEqual(['ALLOW', 'BLOCK', 'BLOCK', 'BLOCK', 'BLOCK']);
  });
});

describe('paymentVelocityLimit', () => {
  it('blocks once the count-in-window would exceed maxCount', () => {
    const now = new Date('2026-01-01T00:00:10.000Z');
    const recentPayments = Array.from({ length: 3 }, (_, i) => ({
      providerId: 'p',
      amountMinor: 1n,
      requestFingerprint: `fp-${i}`,
      createdAt: new Date('2026-01-01T00:00:05.000Z'),
    }));
    const ctx = baseContext({ now, recentPayments });
    const result = paymentVelocityLimit(ctx, { windowSeconds: 10, maxCount: 3 });
    expect(result.verdict).toBe('BLOCK');
    expect(result.reasonCode).toBe('PAYMENT_VELOCITY_EXCEEDED');
  });
});

describe('humanApprovalThreshold', () => {
  it('downgrades to REVIEW above the threshold, never BLOCK', () => {
    const ctx = baseContext({ amountMinor: 10_000_000n });
    const result = humanApprovalThreshold(ctx, { thresholdMinor: '5000000' });
    expect(result.verdict).toBe('REVIEW');
    expect(result.reasonCode).toBe('APPROVAL_REQUIRED');
  });
});
