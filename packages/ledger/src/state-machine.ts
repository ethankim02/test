import { DomainError } from '@x402-treasury/shared';

/**
 * Payment intent lifecycle. See docs/ARCHITECTURE.md §5 for the diagram
 * and the reasoning behind FAILED vs. RESERVATION_RELEASED being distinct
 * terminal-ish states.
 */
export const PAYMENT_INTENT_STATES = [
  'CREATED',
  'POLICY_EVALUATING',
  'POLICY_REJECTED',
  'APPROVED',
  'RESERVED',
  'PAYMENT_PREPARED',
  'VERIFYING',
  'SETTLING',
  'SETTLED',
  'FAILED',
  'RESERVATION_RELEASED',
  'RECONCILIATION_REQUIRED',
] as const;

export type PaymentIntentState = (typeof PAYMENT_INTENT_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<PaymentIntentState> = new Set([
  'POLICY_REJECTED',
  'SETTLED',
  'RESERVATION_RELEASED',
]);

const LEGAL_TRANSITIONS: Record<PaymentIntentState, readonly PaymentIntentState[]> = {
  CREATED: ['POLICY_EVALUATING'],
  POLICY_EVALUATING: ['POLICY_REJECTED', 'APPROVED'],
  POLICY_REJECTED: [],
  APPROVED: ['RESERVED', 'FAILED'],
  RESERVED: ['PAYMENT_PREPARED', 'FAILED'],
  PAYMENT_PREPARED: ['VERIFYING', 'FAILED'],
  VERIFYING: ['SETTLING', 'FAILED'],
  SETTLING: ['SETTLED', 'FAILED', 'RECONCILIATION_REQUIRED'],
  RECONCILIATION_REQUIRED: ['SETTLED', 'FAILED'],
  SETTLED: [],
  FAILED: ['RESERVATION_RELEASED'],
  RESERVATION_RELEASED: [],
};

export function isLegalTransition(from: PaymentIntentState, to: PaymentIntentState): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

/** Throws INVALID_PAYMENT_STATE if the transition isn't legal; otherwise a no-op check. */
export function assertLegalTransition(from: PaymentIntentState, to: PaymentIntentState): void {
  if (!isLegalTransition(from, to)) {
    throw new DomainError(
      'INVALID_PAYMENT_STATE',
      `illegal payment intent transition: ${from} -> ${to}`,
      { details: { from, to, legalNextStates: LEGAL_TRANSITIONS[from] } },
    );
  }
}

export function isTerminal(state: PaymentIntentState): boolean {
  return TERMINAL_STATES.has(state);
}
