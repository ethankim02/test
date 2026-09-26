import { describe, expect, it } from 'vitest';
import {
  add,
  compare,
  fromDecimalString,
  gt,
  isNegative,
  isZero,
  lt,
  max,
  min,
  money,
  MoneyError,
  sub,
  toDecimalString,
} from './money.js';

describe('money', () => {
  it('parses decimal strings into exact minor units', () => {
    expect(fromDecimalString('1.00', 'USDC').amountMinor).toBe(1_000_000n);
    expect(fromDecimalString('0.03', 'USDC').amountMinor).toBe(30_000n);
    expect(fromDecimalString('0.000001', 'USDC').amountMinor).toBe(1n);
    expect(fromDecimalString('2', 'USDC').amountMinor).toBe(2_000_000n);
    expect(fromDecimalString('-0.5', 'USDC').amountMinor).toBe(-500_000n);
  });

  it('round-trips decimal string -> Money -> decimal string', () => {
    for (const input of ['1.00', '0.03', '0.5', '123.456789', '0']) {
      const m = fromDecimalString(input, 'USDC');
      expect(toDecimalString(m)).toBe(Number(input).toFixed(6));
    }
  });

  it('rejects more precision than the asset supports instead of rounding', () => {
    expect(() => fromDecimalString('0.0000001', 'USDC')).toThrow(MoneyError);
  });

  it('rejects garbage input', () => {
    expect(() => fromDecimalString('abc', 'USDC')).toThrow(MoneyError);
    expect(() => fromDecimalString('1.2.3', 'USDC')).toThrow(MoneyError);
  });

  it('adds and subtracts exactly, with no floating point error', () => {
    const a = fromDecimalString('0.1', 'USDC');
    const b = fromDecimalString('0.2', 'USDC');
    expect(toDecimalString(add(a, b))).toBe('0.300000');
  });

  it('refuses to mix assets', () => {
    const usdc = money(1n, 'USDC');
    // @ts-expect-error - only one asset exists today, but the guard is asset-agnostic
    expect(() => add(usdc, money(1n, 'OTHER'))).toThrow();
  });

  it('compares correctly', () => {
    const small = fromDecimalString('0.01', 'USDC');
    const big = fromDecimalString('0.02', 'USDC');
    expect(compare(small, big)).toBe(-1);
    expect(compare(big, small)).toBe(1);
    expect(compare(small, small)).toBe(0);
    expect(gt(big, small)).toBe(true);
    expect(lt(small, big)).toBe(true);
    expect(min(small, big)).toBe(small);
    expect(max(small, big)).toBe(big);
  });

  it('reports sign correctly', () => {
    expect(isZero(fromDecimalString('0', 'USDC'))).toBe(true);
    expect(isNegative(fromDecimalString('-0.01', 'USDC'))).toBe(true);
    expect(isNegative(fromDecimalString('0.01', 'USDC'))).toBe(false);
  });

  it('subtraction below zero produces a negative Money value (callers must check, not the type)', () => {
    const a = fromDecimalString('0.01', 'USDC');
    const b = fromDecimalString('0.02', 'USDC');
    expect(isNegative(sub(a, b))).toBe(true);
  });
});
