import { DomainError } from '@x402-treasury/shared';
import { describe, expect, it } from 'vitest';
import {
  PAYMENT_INTENT_STATES,
  assertLegalTransition,
  isLegalTransition,
  isTerminal,
  type PaymentIntentState,
} from './state-machine.js';

describe('payment intent state machine', () => {
  it('allows the full happy path', () => {
    const happyPath: PaymentIntentState[] = [
      'CREATED',
      'POLICY_EVALUATING',
      'APPROVED',
      'RESERVED',
      'PAYMENT_PREPARED',
      'VERIFYING',
      'SETTLING',
      'SETTLED',
    ];
    for (let i = 0; i < happyPath.length - 1; i++) {
      expect(isLegalTransition(happyPath[i]!, happyPath[i + 1]!)).toBe(true);
    }
  });

  it('allows policy rejection', () => {
    expect(isLegalTransition('POLICY_EVALUATING', 'POLICY_REJECTED')).toBe(true);
  });

  it('allows failure from every non-terminal in-flight state', () => {
    const canFail: PaymentIntentState[] = [
      'APPROVED',
      'RESERVED',
      'PAYMENT_PREPARED',
      'VERIFYING',
      'SETTLING',
    ];
    for (const state of canFail) {
      expect(isLegalTransition(state, 'FAILED')).toBe(true);
    }
  });

  it('allows settlement uncertainty only from SETTLING, and resolves either way', () => {
    expect(isLegalTransition('SETTLING', 'RECONCILIATION_REQUIRED')).toBe(true);
    expect(isLegalTransition('RECONCILIATION_REQUIRED', 'SETTLED')).toBe(true);
    expect(isLegalTransition('RECONCILIATION_REQUIRED', 'FAILED')).toBe(true);
  });

  it('requires FAILED before RESERVATION_RELEASED', () => {
    expect(isLegalTransition('FAILED', 'RESERVATION_RELEASED')).toBe(true);
    expect(isLegalTransition('RESERVED', 'RESERVATION_RELEASED')).toBe(false);
  });

  it('rejects the canonical illegal transition SETTLED -> CREATED', () => {
    expect(isLegalTransition('SETTLED', 'CREATED')).toBe(false);
    expect(() => assertLegalTransition('SETTLED', 'CREATED')).toThrow(DomainError);
  });

  it('rejects skipping states, e.g. CREATED -> SETTLED', () => {
    expect(isLegalTransition('CREATED', 'SETTLED')).toBe(false);
  });

  it('rejects any transition out of a terminal state other than FAILED->RESERVATION_RELEASED', () => {
    const terminal: PaymentIntentState[] = ['POLICY_REJECTED', 'SETTLED', 'RESERVATION_RELEASED'];
    for (const state of terminal) {
      for (const target of PAYMENT_INTENT_STATES) {
        expect(isLegalTransition(state, target)).toBe(false);
      }
    }
  });

  it('classifies terminal states correctly', () => {
    expect(isTerminal('SETTLED')).toBe(true);
    expect(isTerminal('POLICY_REJECTED')).toBe(true);
    expect(isTerminal('RESERVATION_RELEASED')).toBe(true);
    expect(isTerminal('FAILED')).toBe(false); // FAILED can still advance to RESERVATION_RELEASED
    expect(isTerminal('SETTLING')).toBe(false);
  });

  it('assertLegalTransition throws a DomainError carrying the legal next states', () => {
    try {
      assertLegalTransition('SETTLED', 'RESERVED');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe('INVALID_PAYMENT_STATE');
      expect((err as DomainError).details?.['legalNextStates']).toEqual([]);
    }
  });
});
