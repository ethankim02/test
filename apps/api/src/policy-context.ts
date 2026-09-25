import type { PolicyContext, RecentPayment, TrustStatus } from '@x402-treasury/policy-engine';
import type { Pool } from 'pg';

/** Payment intent states that represent committed-or-in-flight spend for daily-limit purposes. */
const COUNTS_TOWARD_DAILY_SPEND = [
  'RESERVED',
  'PAYMENT_PREPARED',
  'VERIFYING',
  'SETTLING',
  'RECONCILIATION_REQUIRED',
  'SETTLED',
] as const;

export interface BuildPolicyContextParams {
  agentId: string;
  orgId: string;
  sessionBudgetId: string;
  sessionAvailableMinor: bigint;
  providerId: string;
  providerCategory: string;
  providerTrustStatus: TrustStatus;
  amountMinor: bigint;
  requestFingerprint: string;
  now: Date;
  /** How far back to look for duplicate/velocity checks. */
  recentWindowSeconds: number;
  /** The payment intent this context is being built for, so its own just-inserted row is never mistaken for a prior duplicate/velocity sample of itself. */
  excludeIntentId: string;
}

/**
 * Assembles a `PolicyContext` from the database. Kept as the one place
 * that translates "today" / "recent" into SQL, so the policy engine
 * itself (packages/policy-engine) never touches a database and stays a
 * pure, independently-testable function of its inputs (task principle E).
 */
export async function buildPolicyContext(pool: Pool, params: BuildPolicyContextParams): Promise<PolicyContext> {
  const todayStart = new Date(Date.UTC(params.now.getUTCFullYear(), params.now.getUTCMonth(), params.now.getUTCDate()));

  const { rows: agentRows } = await pool.query<{ total: string | null }>(
    `SELECT COALESCE(SUM(amount_minor), 0)::text AS total
     FROM payment_intents
     WHERE agent_id = $1 AND created_at >= $2 AND state = ANY($3::text[])`,
    [params.agentId, todayStart.toISOString(), COUNTS_TOWARD_DAILY_SPEND],
  );

  const { rows: orgRows } = await pool.query<{ total: string | null }>(
    `SELECT COALESCE(SUM(amount_minor), 0)::text AS total
     FROM payment_intents
     WHERE org_id = $1 AND created_at >= $2 AND state = ANY($3::text[])`,
    [params.orgId, todayStart.toISOString(), COUNTS_TOWARD_DAILY_SPEND],
  );

  const { rows: categoryRows } = await pool.query<{ total: string | null }>(
    `SELECT COALESCE(SUM(pi.amount_minor), 0)::text AS total
     FROM payment_intents pi
     JOIN providers p ON p.id = pi.provider_id
     WHERE pi.org_id = $1 AND p.category = $2 AND pi.created_at >= $3 AND pi.state = ANY($4::text[])`,
    [params.orgId, params.providerCategory, todayStart.toISOString(), COUNTS_TOWARD_DAILY_SPEND],
  );

  const windowStart = new Date(params.now.getTime() - params.recentWindowSeconds * 1000);
  const { rows: recentRows } = await pool.query<{
    provider_id: string;
    amount_minor: string;
    created_at: Date;
    request_fingerprint: string | null;
  }>(
    `SELECT provider_id, amount_minor, created_at, request_fingerprint
     FROM payment_intents
     WHERE agent_id = $1 AND created_at >= $2 AND id != $3
     ORDER BY created_at DESC`,
    [params.agentId, windowStart.toISOString(), params.excludeIntentId],
  );

  const recentPayments: RecentPayment[] = recentRows.map((r) => ({
    providerId: r.provider_id,
    amountMinor: BigInt(r.amount_minor),
    createdAt: r.created_at,
    requestFingerprint: r.request_fingerprint ?? '',
  }));

  return {
    agentId: params.agentId,
    sessionBudgetId: params.sessionBudgetId,
    provider: { id: params.providerId, category: params.providerCategory, trustStatus: params.providerTrustStatus },
    amountMinor: params.amountMinor,
    requestFingerprint: params.requestFingerprint,
    now: params.now,
    sessionAvailableMinor: params.sessionAvailableMinor,
    agentDailySpentMinor: BigInt(agentRows[0]?.total ?? '0'),
    orgDailySpentMinor: BigInt(orgRows[0]?.total ?? '0'),
    categoryDailySpentMinor: BigInt(categoryRows[0]?.total ?? '0'),
    recentPayments,
  };
}
