/**
 * Monetary values are always an integer count of the asset's smallest unit,
 * carried as `bigint`. See docs/DECISIONS.md ADR-003 for why: JS `number`
 * cannot exactly represent arbitrary decimal amounts, and this project must
 * never approximate money.
 */

export type AssetCode = 'USDC';

export const ASSETS: Record<AssetCode, { decimals: number; symbol: string }> = {
  USDC: { decimals: 6, symbol: 'USDC' },
};

export interface Money {
  readonly amountMinor: bigint;
  readonly asset: AssetCode;
}

export class MoneyError extends Error {}

function assertSameAsset(a: Money, b: Money): void {
  if (a.asset !== b.asset) {
    throw new MoneyError(`asset mismatch: ${a.asset} vs ${b.asset}`);
  }
}

export function money(amountMinor: bigint, asset: AssetCode): Money {
  return { amountMinor, asset };
}

export function zero(asset: AssetCode): Money {
  return money(0n, asset);
}

/**
 * Parse a human decimal string ("0.03") into exact minor units. Never uses
 * floating point. Throws on more fractional digits than the asset supports
 * rather than silently rounding, since silent rounding of money is exactly
 * the class of bug this type exists to prevent.
 */
export function fromDecimalString(input: string, asset: AssetCode): Money {
  const decimals = ASSETS[asset].decimals;
  const trimmed = input.trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) {
    throw new MoneyError(`invalid decimal amount: "${input}"`);
  }
  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > decimals) {
    throw new MoneyError(
      `"${input}" has more precision than ${asset} supports (${decimals} decimals)`,
    );
  }
  const paddedFraction = fraction.padEnd(decimals, '0');
  const magnitude = BigInt(whole + paddedFraction);
  const amountMinor = sign === '-' ? -magnitude : magnitude;
  return money(amountMinor, asset);
}

export function toDecimalString(m: Money): string {
  const decimals = ASSETS[m.asset].decimals;
  const negative = m.amountMinor < 0n;
  const abs = negative ? -m.amountMinor : m.amountMinor;
  const str = abs.toString().padStart(decimals + 1, '0');
  const whole = str.slice(0, str.length - decimals);
  const fraction = decimals > 0 ? str.slice(str.length - decimals) : '';
  const body = decimals > 0 ? `${whole}.${fraction}` : whole;
  return negative ? `-${body}` : body;
}

export function formatMoney(m: Money): string {
  return `${toDecimalString(m)} ${ASSETS[m.asset].symbol}`;
}

export function add(a: Money, b: Money): Money {
  assertSameAsset(a, b);
  return money(a.amountMinor + b.amountMinor, a.asset);
}

export function sub(a: Money, b: Money): Money {
  assertSameAsset(a, b);
  return money(a.amountMinor - b.amountMinor, a.asset);
}

export function isNegative(m: Money): boolean {
  return m.amountMinor < 0n;
}

export function isZero(m: Money): boolean {
  return m.amountMinor === 0n;
}

export function isPositive(m: Money): boolean {
  return m.amountMinor > 0n;
}

/** -1 if a<b, 0 if a===b, 1 if a>b */
export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameAsset(a, b);
  if (a.amountMinor < b.amountMinor) return -1;
  if (a.amountMinor > b.amountMinor) return 1;
  return 0;
}

export function gt(a: Money, b: Money): boolean {
  return compare(a, b) === 1;
}

export function gte(a: Money, b: Money): boolean {
  return compare(a, b) >= 0;
}

export function lt(a: Money, b: Money): boolean {
  return compare(a, b) === -1;
}

export function lte(a: Money, b: Money): boolean {
  return compare(a, b) <= 0;
}

export function min(a: Money, b: Money): Money {
  return lte(a, b) ? a : b;
}

export function max(a: Money, b: Money): Money {
  return gte(a, b) ? a : b;
}
