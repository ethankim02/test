declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type OrgId = Brand<string, 'OrgId'>;
export type AgentId = Brand<string, 'AgentId'>;
export type ApiKeyId = Brand<string, 'ApiKeyId'>;
export type BudgetId = Brand<string, 'BudgetId'>;
export type ReservationId = Brand<string, 'ReservationId'>;
export type PaymentIntentId = Brand<string, 'PaymentIntentId'>;
export type IdempotencyKeyId = Brand<string, 'IdempotencyKeyId'>;
export type ProviderId = Brand<string, 'ProviderId'>;
export type PolicyId = Brand<string, 'PolicyId'>;
export type RoutingDecisionId = Brand<string, 'RoutingDecisionId'>;
export type ReconciliationRecordId = Brand<string, 'ReconciliationRecordId'>;
export type LedgerEntryId = Brand<string, 'LedgerEntryId'>;
export type LedgerTransactionId = Brand<string, 'LedgerTransactionId'>;

export function newId<B extends string>(): Brand<string, B> {
  return crypto.randomUUID() as Brand<string, B>;
}

export function asId<B extends string>(value: string): Brand<string, B> {
  return value as Brand<string, B>;
}
