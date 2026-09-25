import type { PolicyContext } from './types.js';

export function baseContext(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    agentId: 'agent-1',
    sessionBudgetId: 'session-1',
    provider: { id: 'provider-1', category: 'search', trustStatus: 'TRUSTED' },
    amountMinor: 30_000n,
    requestFingerprint: 'fp-1',
    now: new Date('2026-01-01T00:00:00.000Z'),
    sessionAvailableMinor: 1_000_000n,
    agentDailySpentMinor: 0n,
    orgDailySpentMinor: 0n,
    categoryDailySpentMinor: 0n,
    recentPayments: [],
    ...overrides,
  };
}
