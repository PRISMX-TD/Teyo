import type { Tx } from '@/server/db/transaction';

export type CategoryRow = {
  id: string;
  kind: 'income' | 'expense';
  accountId: string;
  isActive: boolean;
};

export class CategoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CategoryError';
  }
}

/**
 * 取分类连带其记账科目，并校验 kind 与交易类型一致。
 *
 * kind 校验是实质性的：把一笔收入挂到费用分类上，会把金额记进错误的
 * 科目类型，损益表从此对不上，而借贷两边仍然是平的——数据库的平衡触发器
 * 察觉不到这种错误。
 */
export async function getCategoryWithAccount(
  tx: Tx,
  organizationId: string,
  categoryId: string,
  expectedKind: 'income' | 'expense',
): Promise<CategoryRow> {
  const rows = await tx`
    select id, kind, account_id, is_active
    from categories
    where id = ${categoryId} and organization_id = ${organizationId}
  `;

  const row = rows.at(0);
  if (!row) {
    throw new CategoryError('The selected category does not exist in this company.');
  }

  const category: CategoryRow = {
    id: row.id as string,
    kind: row.kind as CategoryRow['kind'],
    accountId: row.account_id as string,
    isActive: row.is_active as boolean,
  };

  if (category.kind !== expectedKind) {
    throw new CategoryError(
      `This category is for ${category.kind}, but the record is ${expectedKind}.`,
    );
  }
  if (!category.isActive) {
    throw new CategoryError('This category is archived.');
  }

  return category;
}
