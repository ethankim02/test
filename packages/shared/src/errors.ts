/**
 * All reason codes the system can return for a blocked, rejected, or
 * failed operation. Kept in one place so the policy engine, ledger, and
 * API error handler agree on the vocabulary — see docs/ARCHITECTURE.md
 * §"transparent decision-making" (task principle D).
 */
export const REASON_CODES = [
  // policy engine
  'PER_TRANSACTION_LIMIT_EXCEEDED',
  'SESSION_BUDGET_EXCEEDED',
  'AGENT_DAILY_LIMIT_EXCEEDED',
  'ORG_DAILY_LIMIT_EXCEEDED',
  'CATEGORY_DAILY_LIMIT_EXCEEDED',
  'PROVIDER_NOT_ALLOWED',
  'UNKNOWN_PROVIDER_LIMIT_EXCEEDED',
  'DUPLICATE_PAYMENT',
  'PAYMENT_VELOCITY_EXCEEDED',
  'APPROVAL_REQUIRED',
  // ledger / reservation
  'INSUFFICIENT_BUDGET',
  'RESERVATION_EXPIRED',
  'RESERVATION_NOT_ACTIVE',
  // delegation
  'DELEGATION_CYCLE',
  'DELEGATION_EXCEEDS_PARENT',
  // idempotency
  'IDEMPOTENCY_CONFLICT',
  // payment state machine
  'INVALID_PAYMENT_STATE',
  'SETTLEMENT_FAILED',
  'RECONCILIATION_REQUIRED',
  // routing
  'NO_ELIGIBLE_PROVIDER',
  // generic
  'NOT_FOUND',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'VALIDATION_ERROR',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

const DEFAULT_HTTP_STATUS: Record<ReasonCode, number> = {
  PER_TRANSACTION_LIMIT_EXCEEDED: 402,
  SESSION_BUDGET_EXCEEDED: 402,
  AGENT_DAILY_LIMIT_EXCEEDED: 402,
  ORG_DAILY_LIMIT_EXCEEDED: 402,
  CATEGORY_DAILY_LIMIT_EXCEEDED: 402,
  PROVIDER_NOT_ALLOWED: 402,
  UNKNOWN_PROVIDER_LIMIT_EXCEEDED: 402,
  DUPLICATE_PAYMENT: 409,
  PAYMENT_VELOCITY_EXCEEDED: 402,
  APPROVAL_REQUIRED: 202,
  INSUFFICIENT_BUDGET: 402,
  RESERVATION_EXPIRED: 409,
  RESERVATION_NOT_ACTIVE: 409,
  DELEGATION_CYCLE: 400,
  DELEGATION_EXCEEDS_PARENT: 402,
  IDEMPOTENCY_CONFLICT: 409,
  INVALID_PAYMENT_STATE: 409,
  SETTLEMENT_FAILED: 502,
  RECONCILIATION_REQUIRED: 202,
  NO_ELIGIBLE_PROVIDER: 422,
  NOT_FOUND: 404,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  VALIDATION_ERROR: 400,
};

export interface DomainErrorOptions {
  httpStatus?: number;
  details?: Record<string, unknown>;
}

/**
 * Base class for every error that should surface to an API caller as a
 * structured `{ code, message, details }` response rather than a leaked
 * stack trace or raw database exception (task principle: never leak raw
 * database exceptions).
 */
export class DomainError extends Error {
  readonly code: ReasonCode;
  readonly httpStatus: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ReasonCode, message: string, options: DomainErrorOptions = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.httpStatus = options.httpStatus ?? DEFAULT_HTTP_STATUS[code];
    this.details = options.details;
  }

  toJSON(): { code: ReasonCode; message: string; details?: Record<string, unknown> } {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export function isDomainError(err: unknown): err is DomainError {
  return err instanceof DomainError;
}
