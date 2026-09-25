import { DomainError, type ReasonCode } from '@x402-treasury/shared';
import {
  captureReservation,
  createPaymentIntent,
  getBudget,
  releaseReservation,
  reserveBudget,
  transitionPaymentIntent,
} from '@x402-treasury/ledger';
import { evaluatePolicy, type PolicyRuleConfig, type RuleEvaluation } from '@x402-treasury/policy-engine';
import type { PaymentRail } from '@x402-treasury/x402-adapter';
import type { Pool } from 'pg';
import { attachPaymentIntent, claimIdempotencyKey, completeIdempotencyKey } from './idempotency.js';
import { budgetSummary } from './budget-summary.js';
import { buildPolicyContext } from './policy-context.js';
import { defaultRequestFingerprint } from './fingerprint.js';
import { notFound } from './errors.js';

export interface ExecutePaymentParams {
  orgId: string;
  agentId: string;
  sessionBudgetId: string;
  providerId: string;
  idempotencyKey: string;
  requestHash: string;
  /** DEMO/TEST ONLY: forces the settlement step into RECONCILIATION_REQUIRED instead of actually calling the adapter, to exercise Scenario H deterministically. Never set by the real demo agent's normal path. */
  simulateUncertainSettlement?: boolean | undefined;
  reservationTtlSeconds?: number | undefined;
}

export interface ExecutePaymentResult {
  httpStatus: number;
  body: Record<string, unknown>;
}

const RESERVATION_TTL_DEFAULT_SECONDS = 120;
const RECENT_WINDOW_SECONDS = 300;

/**
 * The full payment orchestration: idempotency claim -> live x402 discovery
 * (authoritative price, never trusted from the caller) -> policy
 * evaluation -> atomic reservation -> the x402 handshake -> capture or
 * release. See docs/ARCHITECTURE.md §2 for the sequence diagram this
 * function implements.
 */
export async function executePayment(pool: Pool, adapter: PaymentRail, params: ExecutePaymentParams): Promise<ExecutePaymentResult> {
  const claim = await claimIdempotencyKey(pool, params.agentId, params.idempotencyKey, params.requestHash);

  if (!claim.isNew) {
    if (claim.responseBody !== null && claim.responseBody !== undefined) {
      return { httpStatus: 200, body: { ...(claim.responseBody as Record<string, unknown>), idempotentReplay: true } };
    }
    if (claim.paymentIntentId) {
      return { httpStatus: 202, body: { paymentIntentId: claim.paymentIntentId, status: 'PROCESSING', idempotentReplay: true } };
    }
    return { httpStatus: 202, body: { status: 'PROCESSING', idempotentReplay: true } };
  }

  const now = new Date();
  const requestFingerprint = defaultRequestFingerprint(params.sessionBudgetId, params.providerId);

  const { rows: providerRows } = await pool.query<{
    base_url: string;
    resource_path: string;
    category: string;
    trust_status: 'TRUSTED' | 'KNOWN' | 'UNKNOWN';
  }>('SELECT base_url, resource_path, category, trust_status FROM providers WHERE id = $1', [params.providerId]);
  const provider = providerRows[0];
  if (!provider) throw notFound('provider', params.providerId);
  const providerUrl = `${provider.base_url}${provider.resource_path}`;

  // Authoritative price/network/payTo comes from the LIVE provider via a
  // real x402 discovery request — never from the caller's request body.
  // This is what makes it impossible for an agent to under-report what it
  // will actually be charged.
  const requirements = await adapter.discoverRequirements({ url: providerUrl });

  const sessionBudget = await getBudget(pool, params.sessionBudgetId);

  const intent = await createPaymentIntent(pool, {
    orgId: params.orgId,
    agentId: params.agentId,
    sessionBudgetId: params.sessionBudgetId,
    providerId: params.providerId,
    amountMinor: requirements.amountMinor,
    network: requirements.network,
    idempotencyKeyId: claim.id,
    requestFingerprint,
  });
  await attachPaymentIntent(pool, claim.id, intent.id);

  await transitionPaymentIntent(pool, intent.id, 'POLICY_EVALUATING');

  const { rows: policyRows } = await pool.query<{ rule_type: string; enabled: boolean; params: unknown }>(
    `SELECT rule_type, enabled, params FROM policies
     WHERE org_id = $1 AND enabled = true AND (scope = 'ORG' OR (scope = 'AGENT' AND agent_id = $2))`,
    [params.orgId, params.agentId],
  );
  const policyConfigs: PolicyRuleConfig[] = policyRows.map((r) => ({ ruleType: r.rule_type, enabled: r.enabled, params: r.params }));

  const policyContext = await buildPolicyContext(pool, {
    agentId: params.agentId,
    orgId: params.orgId,
    sessionBudgetId: params.sessionBudgetId,
    sessionAvailableMinor: sessionBudget.availableMinor,
    providerId: params.providerId,
    providerCategory: provider.category,
    providerTrustStatus: provider.trust_status,
    amountMinor: requirements.amountMinor,
    requestFingerprint,
    now,
    recentWindowSeconds: RECENT_WINDOW_SECONDS,
    excludeIntentId: intent.id,
  });

  const decision = evaluatePolicy(policyContext, policyConfigs);

  if (decision.decision === 'BLOCK' || decision.decision === 'REVIEW') {
    await transitionPaymentIntent(pool, intent.id, 'POLICY_REJECTED', {
      reason: decision.decision === 'REVIEW' ? 'human approval required (not auto-resolvable in this MVP)' : decision.reasonCodes.join(','),
    });
    const body = {
      paymentIntentId: intent.id,
      decision: decision.decision,
      reasonCodes: decision.reasonCodes,
      evaluatedRules: decision.evaluatedRules,
      state: 'POLICY_REJECTED',
    };
    await completeIdempotencyKey(pool, claim.id, body);
    return { httpStatus: decision.decision === 'REVIEW' ? 202 : 402, body };
  }

  await transitionPaymentIntent(pool, intent.id, 'APPROVED');

  let reservation;
  try {
    reservation = await reserveBudget(pool, {
      leafBudgetId: params.sessionBudgetId,
      agentId: params.agentId,
      amountMinor: requirements.amountMinor,
      ttlSeconds: params.reservationTtlSeconds ?? RESERVATION_TTL_DEFAULT_SECONDS,
    });
  } catch (err) {
    if (err instanceof DomainError && err.code === 'INSUFFICIENT_BUDGET') {
      await transitionPaymentIntent(pool, intent.id, 'FAILED', { reason: 'lost the race for budget between policy check and reservation' });
      const body = {
        paymentIntentId: intent.id,
        decision: 'BLOCK' as const,
        reasonCodes: ['INSUFFICIENT_BUDGET'] as ReasonCode[],
        state: 'FAILED',
      };
      await completeIdempotencyKey(pool, claim.id, body);
      return { httpStatus: 402, body };
    }
    throw err;
  }

  await transitionPaymentIntent(pool, intent.id, 'RESERVED', { patch: { reservationId: reservation.id } });

  const signed = await adapter.preparePayment(requirements, { url: providerUrl }, { agentId: params.agentId });
  await transitionPaymentIntent(pool, intent.id, 'PAYMENT_PREPARED', { patch: { x402Payload: signed.raw } });

  await transitionPaymentIntent(pool, intent.id, 'VERIFYING');
  const verifyResult = await adapter.verifyPayment(signed, requirements);
  if (!verifyResult.isValid) {
    await transitionPaymentIntent(pool, intent.id, 'FAILED', { reason: verifyResult.invalidReason ?? 'payment verification failed' });
    await releaseReservation(pool, reservation.id);
    await transitionPaymentIntent(pool, intent.id, 'RESERVATION_RELEASED', { reason: 'released after failed verification' });
    const body = { paymentIntentId: intent.id, decision: 'BLOCK' as const, reasonCodes: ['SETTLEMENT_FAILED'] as ReasonCode[], state: 'RESERVATION_RELEASED' };
    await completeIdempotencyKey(pool, claim.id, body);
    return { httpStatus: 402, body };
  }

  await transitionPaymentIntent(pool, intent.id, 'SETTLING');

  if (params.simulateUncertainSettlement) {
    await transitionPaymentIntent(pool, intent.id, 'RECONCILIATION_REQUIRED', {
      reason: 'simulated facilitator settlement_pending / timeout (demo flag, not a real outcome)',
    });
    const body = {
      paymentIntentId: intent.id,
      decision: 'REVIEW' as const,
      reasonCodes: ['RECONCILIATION_REQUIRED'] as ReasonCode[],
      state: 'RECONCILIATION_REQUIRED',
      note: 'settlement outcome is uncertain; run reconciliation to resolve',
    };
    await completeIdempotencyKey(pool, claim.id, body);
    return { httpStatus: 202, body };
  }

  const settleResult = await adapter.settlePayment(signed, requirements, { url: providerUrl });

  if (settleResult.outcome === 'SUCCESS') {
    await captureReservation(pool, reservation.id);
    await transitionPaymentIntent(pool, intent.id, 'SETTLED', {
      patch: { settlementTxHash: settleResult.transactionHash ?? null },
    });
    const summary = await budgetSummary(pool, params.sessionBudgetId);
    const body = {
      paymentIntentId: intent.id,
      decision: 'ALLOW' as const,
      state: 'SETTLED',
      amountMinor: requirements.amountMinor.toString(),
      evaluatedRules: decision.evaluatedRules,
      settlement: { transactionHash: settleResult.transactionHash, network: settleResult.network },
      resource: settleResult.resourceBody,
      sessionBudget: summary,
    };
    await completeIdempotencyKey(pool, claim.id, body);
    return { httpStatus: 200, body };
  }

  // FAILED or PENDING-that-we-don't-trust: fail safe and release funds.
  await transitionPaymentIntent(pool, intent.id, 'FAILED', { reason: settleResult.errorReason ?? 'settlement failed' });
  await releaseReservation(pool, reservation.id);
  await transitionPaymentIntent(pool, intent.id, 'RESERVATION_RELEASED', { reason: 'released after failed settlement' });
  const body = {
    paymentIntentId: intent.id,
    decision: 'BLOCK' as const,
    reasonCodes: ['SETTLEMENT_FAILED'] as ReasonCode[],
    state: 'RESERVATION_RELEASED',
    error: settleResult.errorReason,
  };
  await completeIdempotencyKey(pool, claim.id, body);
  return { httpStatus: 402, body };
}

export type { RuleEvaluation };
