import { createHash } from 'node:crypto';

/**
 * Default "what is logically being bought" fingerprint used by the
 * DuplicatePaymentWindow / PaymentVelocityLimit policy rules — independent
 * of the Idempotency-Key mechanism (see ADR-006). Two requests for the
 * same session + provider within the configured window look like the
 * same logical purchase even if the caller used a different (or no)
 * idempotency key.
 */
export function defaultRequestFingerprint(sessionBudgetId: string, providerId: string): string {
  return createHash('sha256').update(`${sessionBudgetId}:${providerId}`, 'utf8').digest('hex');
}

export function canonicalRequestHash(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(body)), 'utf8').digest('hex');
}

/** Deterministic key ordering so `{a:1,b:2}` and `{b:2,a:1}` hash identically. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonicalize(v)]),
    );
  }
  return value;
}
