import { formatMoney, money, toDecimalString, type AssetCode } from '@x402-treasury/shared';
import { getBudget } from '@x402-treasury/ledger';
import type { Pool } from 'pg';

export interface BudgetSummary {
  id: string;
  name: string;
  allocated: string;
  available: string;
  reserved: string;
  spent: string;
  asset: string;
}

export async function budgetSummary(pool: Pool, budgetId: string): Promise<BudgetSummary> {
  const budget = await getBudget(pool, budgetId);
  const asset = budget.asset as AssetCode;
  return {
    id: budget.id,
    name: budget.name,
    allocated: toDecimalString(money(budget.allocatedMinor, asset)),
    available: toDecimalString(money(budget.availableMinor, asset)),
    reserved: toDecimalString(money(budget.reservedMinor, asset)),
    spent: toDecimalString(money(budget.spentMinor, asset)),
    asset,
  };
}

export { formatMoney };
