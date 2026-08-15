import { randomUUID } from 'node:crypto';
import type { Tx } from '@/server/db/transaction';

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

export type CashFlowCategory = 'operating' | 'investing' | 'financing';

export type SeedAccount = {
  code: string;
  nameEn: string;
  nameZh: string;
  type: AccountType;
  isMoneyAccount: boolean;
  sortOrder: number;
  /**
   * 现金流量表分类：分类的是现金的对方科目，不是资金账户本身。
   * 资金账户（isMoneyAccount = true）留空——它们是现金本身，不是现金的去向。
   */
  cashFlowCategory?: CashFlowCategory;
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
  // AR/inventory 是标准间接法下的营运资金调整项——server/repositories/reports.ts
  // 已经把 -netFlow('accounts-receivable') / -netFlow('inventory') 计入 operatingTotal，
  // 这里补上分类只是让列与既有代码的处理口径一致，不是新判断。
  { code: 'accounts-receivable', nameEn: 'Accounts Receivable', nameZh: '应收账款', type: 'asset', isMoneyAccount: false, sortOrder: 30, cashFlowCategory: 'operating' },
  { code: 'inventory', nameEn: 'Inventory', nameZh: '库存', type: 'asset', isMoneyAccount: false, sortOrder: 40, cashFlowCategory: 'operating' },
  { code: 'equipment', nameEn: 'Equipment', nameZh: '设备', type: 'asset', isMoneyAccount: false, sortOrder: 50, cashFlowCategory: 'investing' },
  { code: 'furniture', nameEn: 'Furniture & Fixtures', nameZh: '家具及装修', type: 'asset', isMoneyAccount: false, sortOrder: 60, cashFlowCategory: 'investing' },
  { code: 'vehicles', nameEn: 'Vehicles', nameZh: '车辆', type: 'asset', isMoneyAccount: false, sortOrder: 70, cashFlowCategory: 'investing' },
  { code: 'software-intangible', nameEn: 'Software (Intangible)', nameZh: '无形资产·软件', type: 'asset', isMoneyAccount: false, sortOrder: 80, cashFlowCategory: 'investing' },
  // 累计折旧/摊销科目留空（不是 operating）：它们只在非现金的折旧/摊销分录里
  // 被触碰，而那笔调整已经通过 depreciation / amortization 两个费用科目算过
  // 一次了。给它们再分类会导致现金流量表把同一笔非现金费用加回两次。
  { code: 'ad-equipment', nameEn: 'Accum. Depr. - Equipment', nameZh: '累计折旧·设备', type: 'asset', isMoneyAccount: false, sortOrder: 85 },
  { code: 'ad-furniture', nameEn: 'Accum. Depr. - Furniture', nameZh: '累计折旧·家具', type: 'asset', isMoneyAccount: false, sortOrder: 86 },
  { code: 'ad-vehicles', nameEn: 'Accum. Depr. - Vehicles', nameZh: '累计折旧·车辆', type: 'asset', isMoneyAccount: false, sortOrder: 87 },
  { code: 'ad-software', nameEn: 'Accum. Amort. - Software', nameZh: '累计摊销·软件', type: 'asset', isMoneyAccount: false, sortOrder: 88 },
  // prepaid-expenses 同 AR/inventory：server/repositories/reports.ts 已把
  // -netFlow('prepaid-expenses') 计入 operatingTotal，是营运资金调整项。
  { code: 'prepaid-expenses', nameEn: 'Prepaid Expenses', nameZh: '预付费用', type: 'asset', isMoneyAccount: false, sortOrder: 90, cashFlowCategory: 'operating' },
  // 负债
  { code: 'accounts-payable', nameEn: 'Accounts Payable', nameZh: '应付账款', type: 'liability', isMoneyAccount: false, sortOrder: 110, cashFlowCategory: 'operating' },
  { code: 'loans', nameEn: 'Loans', nameZh: '贷款', type: 'liability', isMoneyAccount: false, sortOrder: 120, cashFlowCategory: 'financing' },
  { code: 'tax-payable', nameEn: 'Tax Payable', nameZh: '待缴税款', type: 'liability', isMoneyAccount: false, sortOrder: 130, cashFlowCategory: 'operating' },
  { code: 'deferred-revenue', nameEn: 'Deferred Revenue', nameZh: '递延收入', type: 'liability', isMoneyAccount: false, sortOrder: 140, cashFlowCategory: 'operating' },
  // 权益
  { code: 'capital', nameEn: 'Capital', nameZh: '股本', type: 'equity', isMoneyAccount: false, sortOrder: 210, cashFlowCategory: 'financing' },
  // retained-earnings 留空：server/ 下没有任何地方对它过账（净利润结转不是
  // 一笔现金分录的对方科目），因此它从不是现金移动的对方科目，没有可分类的行为。
  { code: 'retained-earnings', nameEn: 'Retained Earnings', nameZh: '留存收益', type: 'equity', isMoneyAccount: false, sortOrder: 220 },
  { code: 'owners-draw', nameEn: "Owner's Draw", nameZh: '股东提取', type: 'equity', isMoneyAccount: false, sortOrder: 230, cashFlowCategory: 'financing' },
  // 收入
  { code: 'sales', nameEn: 'Sales', nameZh: '销售收入', type: 'revenue', isMoneyAccount: false, sortOrder: 310, cashFlowCategory: 'operating' },
  { code: 'other-income', nameEn: 'Other Income', nameZh: '其他收入', type: 'revenue', isMoneyAccount: false, sortOrder: 320, cashFlowCategory: 'operating' },
  // 费用
  { code: 'rent', nameEn: 'Rent', nameZh: '租金', type: 'expense', isMoneyAccount: false, sortOrder: 410, cashFlowCategory: 'operating' },
  { code: 'salaries', nameEn: 'Salaries', nameZh: '薪资', type: 'expense', isMoneyAccount: false, sortOrder: 420, cashFlowCategory: 'operating' },
  { code: 'utilities', nameEn: 'Utilities', nameZh: '水电', type: 'expense', isMoneyAccount: false, sortOrder: 430, cashFlowCategory: 'operating' },
  { code: 'marketing', nameEn: 'Marketing', nameZh: '市场推广', type: 'expense', isMoneyAccount: false, sortOrder: 440, cashFlowCategory: 'operating' },
  { code: 'transport', nameEn: 'Transport', nameZh: '交通', type: 'expense', isMoneyAccount: false, sortOrder: 450, cashFlowCategory: 'operating' },
  { code: 'professional-fees', nameEn: 'Professional Fees', nameZh: '专业服务', type: 'expense', isMoneyAccount: false, sortOrder: 460, cashFlowCategory: 'operating' },
  { code: 'ai-llm-costs', nameEn: 'AI & LLM Costs', nameZh: 'AI/LLM 费用', type: 'expense', isMoneyAccount: false, sortOrder: 470, cashFlowCategory: 'operating' },
  { code: 'depreciation', nameEn: 'Depreciation', nameZh: '折旧', type: 'expense', isMoneyAccount: false, sortOrder: 480, cashFlowCategory: 'operating' },
  { code: 'amortization', nameEn: 'Amortization', nameZh: '摊销', type: 'expense', isMoneyAccount: false, sortOrder: 490, cashFlowCategory: 'operating' },
  { code: 'other-expenses', nameEn: 'Other Expenses', nameZh: '其他', type: 'expense', isMoneyAccount: false, sortOrder: 500, cashFlowCategory: 'operating' },
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
  { nameEn: 'AI / LLM', nameZh: 'AI/LLM 费用', kind: 'expense', accountCode: 'ai-llm-costs', sortOrder: 170 },
  { nameEn: 'Depreciation', nameZh: '折旧', kind: 'expense', accountCode: 'depreciation', sortOrder: 180 },
  { nameEn: 'Amortization', nameZh: '摊销', kind: 'expense', accountCode: 'amortization', sortOrder: 190 },
  { nameEn: 'Other', nameZh: '其他', kind: 'expense', accountCode: 'other-expenses', sortOrder: 200 },
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
        cash_flow_category: account.cashFlowCategory ?? null,
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
