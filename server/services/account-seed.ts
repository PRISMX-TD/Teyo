import { randomUUID } from 'node:crypto';
import type { Tx } from '@/server/db/transaction';

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

export type SeedAccount = {
  code: string;
  nameEn: string;
  nameZh: string;
  type: AccountType;
  isMoneyAccount: boolean;
  sortOrder: number;
};

export type SeedCategory = {
  nameEn: string;
  nameZh: string;
  kind: 'income' | 'expense';
  accountCode: string;
  sortOrder: number;
};

export const SEED_ACCOUNTS: readonly SeedAccount[] = [
  // 资产
  { code: 'cash', nameEn: 'Cash', nameZh: '现金', type: 'asset', isMoneyAccount: true, sortOrder: 10 },
  { code: 'bank', nameEn: 'Bank Account', nameZh: '银行账户', type: 'asset', isMoneyAccount: true, sortOrder: 20 },
  { code: 'accounts-receivable', nameEn: 'Accounts Receivable', nameZh: '应收账款', type: 'asset', isMoneyAccount: false, sortOrder: 30 },
  { code: 'inventory', nameEn: 'Inventory', nameZh: '库存', type: 'asset', isMoneyAccount: false, sortOrder: 40 },
  // 负债
  { code: 'accounts-payable', nameEn: 'Accounts Payable', nameZh: '应付账款', type: 'liability', isMoneyAccount: false, sortOrder: 110 },
  { code: 'loans', nameEn: 'Loans', nameZh: '贷款', type: 'liability', isMoneyAccount: false, sortOrder: 120 },
  { code: 'tax-payable', nameEn: 'Tax Payable', nameZh: '待缴税款', type: 'liability', isMoneyAccount: false, sortOrder: 130 },
  // 权益
  { code: 'capital', nameEn: 'Capital', nameZh: '股本', type: 'equity', isMoneyAccount: false, sortOrder: 210 },
  { code: 'retained-earnings', nameEn: 'Retained Earnings', nameZh: '留存收益', type: 'equity', isMoneyAccount: false, sortOrder: 220 },
  { code: 'owners-draw', nameEn: "Owner's Draw", nameZh: '股东提取', type: 'equity', isMoneyAccount: false, sortOrder: 230 },
  // 收入
  { code: 'sales', nameEn: 'Sales', nameZh: '销售收入', type: 'revenue', isMoneyAccount: false, sortOrder: 310 },
  { code: 'other-income', nameEn: 'Other Income', nameZh: '其他收入', type: 'revenue', isMoneyAccount: false, sortOrder: 320 },
  // 费用
  { code: 'rent', nameEn: 'Rent', nameZh: '租金', type: 'expense', isMoneyAccount: false, sortOrder: 410 },
  { code: 'salaries', nameEn: 'Salaries', nameZh: '薪资', type: 'expense', isMoneyAccount: false, sortOrder: 420 },
  { code: 'utilities', nameEn: 'Utilities', nameZh: '水电', type: 'expense', isMoneyAccount: false, sortOrder: 430 },
  { code: 'marketing', nameEn: 'Marketing', nameZh: '市场推广', type: 'expense', isMoneyAccount: false, sortOrder: 440 },
  { code: 'transport', nameEn: 'Transport', nameZh: '交通', type: 'expense', isMoneyAccount: false, sortOrder: 450 },
  { code: 'professional-fees', nameEn: 'Professional Fees', nameZh: '专业服务', type: 'expense', isMoneyAccount: false, sortOrder: 460 },
  { code: 'other-expenses', nameEn: 'Other Expenses', nameZh: '其他', type: 'expense', isMoneyAccount: false, sortOrder: 470 },
] as const;

export const SEED_CATEGORIES: readonly SeedCategory[] = [
  { nameEn: 'Sales', nameZh: '销售收入', kind: 'income', accountCode: 'sales', sortOrder: 10 },
  { nameEn: 'Other Income', nameZh: '其他收入', kind: 'income', accountCode: 'other-income', sortOrder: 20 },
  { nameEn: 'Rent', nameZh: '租金', kind: 'expense', accountCode: 'rent', sortOrder: 110 },
  { nameEn: 'Salaries', nameZh: '薪资', kind: 'expense', accountCode: 'salaries', sortOrder: 120 },
  { nameEn: 'Utilities', nameZh: '水电', kind: 'expense', accountCode: 'utilities', sortOrder: 130 },
  { nameEn: 'Marketing', nameZh: '市场推广', kind: 'expense', accountCode: 'marketing', sortOrder: 140 },
  { nameEn: 'Transport', nameZh: '交通', kind: 'expense', accountCode: 'transport', sortOrder: 150 },
  { nameEn: 'Professional Fees', nameZh: '专业服务', kind: 'expense', accountCode: 'professional-fees', sortOrder: 160 },
  { nameEn: 'Other', nameZh: '其他', kind: 'expense', accountCode: 'other-expenses', sortOrder: 170 },
] as const;

/**
 * 为新公司写入预置科目与分类。必须在事务内调用，且调用方必须已经写入 owner
 * membership——accounts_write / categories_write 策略要求 owner 或 admin 角色。
 *
 * 科目 id 在应用侧生成而不是用 `returning id, code`：分类需要引用科目 id，
 * 自己生成就不必把新行读回来（RETURNING 会额外触发 SELECT 策略检查），
 * 也省掉 map 查找后的非空断言。
 */
export async function seedChartOfAccounts(tx: Tx, organizationId: string): Promise<void> {
  const idByCode = new Map(SEED_ACCOUNTS.map((account) => [account.code, randomUUID()]));

  await tx`
    insert into accounts ${tx(
      SEED_ACCOUNTS.map((account) => ({
        id: idByCode.get(account.code) as string,
        organization_id: organizationId,
        code: account.code,
        name_en: account.nameEn,
        name_zh: account.nameZh,
        type: account.type,
        is_money_account: account.isMoneyAccount,
        is_system: true,
        sort_order: account.sortOrder,
      })),
    )}
  `;

  await tx`
    insert into categories ${tx(
      SEED_CATEGORIES.map((category) => ({
        organization_id: organizationId,
        name_en: category.nameEn,
        name_zh: category.nameZh,
        kind: category.kind,
        account_id: idByCode.get(category.accountCode) as string,
        sort_order: category.sortOrder,
      })),
    )}
  `;
}
