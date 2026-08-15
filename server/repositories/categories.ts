import type { Tx } from '@/server/db/transaction';

export type CategoryRow = {
  id: string;
  nameEn: string | null;
  nameZh: string | null;
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
    select id, name_en, name_zh, kind, account_id, is_active
    from categories
    where id = ${categoryId} and organization_id = ${organizationId}
  `;

  const row = rows.at(0);
  if (!row) {
    throw new CategoryError('The selected category does not exist in this company.');
  }

  const category: CategoryRow = {
    id: row.id as string,
    nameEn: (row.name_en as string | null) ?? null,
    nameZh: (row.name_zh as string | null) ?? null,
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

/** 取分类，只校验归属，不校验 kind。用于改名与停用场景。 */
export async function getCategory(
  tx: Tx,
  organizationId: string,
  categoryId: string,
): Promise<CategoryRow> {
  const rows = await tx`
    select id, name_en, name_zh, kind, account_id, is_active
    from categories
    where id = ${categoryId} and organization_id = ${organizationId}
  `;
  const row = rows.at(0);
  if (!row) {
    throw new CategoryError('This category was not found in this company.');
  }
  return {
    id: row.id as string,
    nameEn: (row.name_en as string | null) ?? null,
    nameZh: (row.name_zh as string | null) ?? null,
    kind: row.kind as CategoryRow['kind'],
    accountId: row.account_id as string,
    isActive: row.is_active as boolean,
  };
}

export async function insertCategory(
  tx: Tx,
  row: {
    organizationId: string;
    nameEn: string | null;
    nameZh: string | null;
    kind: 'income' | 'expense';
    accountId: string;
    sortOrder: number;
  },
): Promise<{ id: string }> {
  const [inserted] = await tx`
    insert into categories (organization_id, name_en, name_zh, kind, account_id, is_active, sort_order)
    values (${row.organizationId}, ${row.nameEn}, ${row.nameZh}, ${row.kind},
            ${row.accountId}, true, ${row.sortOrder})
    returning id
  `;
  return { id: inserted.id as string };
}

export async function updateCategoryNames(
  tx: Tx,
  organizationId: string,
  categoryId: string,
  names: { nameEn: string | null; nameZh: string | null },
): Promise<void> {
  const result = await tx`
    update categories
    set name_en = ${names.nameEn}, name_zh = ${names.nameZh}
    where id = ${categoryId} and organization_id = ${organizationId}
  `;
  if (result.count === 0) {
    throw new CategoryError('This category was not found in this company.');
  }
}

export async function updateCategoryActive(
  tx: Tx,
  organizationId: string,
  categoryId: string,
  isActive: boolean,
): Promise<void> {
  const result = await tx`
    update categories set is_active = ${isActive}
    where id = ${categoryId} and organization_id = ${organizationId}
  `;
  if (result.count === 0) {
    throw new CategoryError('This category was not found in this company.');
  }
}

export async function nextCategorySortOrder(
  tx: Tx,
  organizationId: string,
  kind: 'income' | 'expense',
): Promise<number> {
  const [row] = await tx`
    select coalesce(max(sort_order), 0) + 10 as next
    from categories
    where organization_id = ${organizationId} and kind = ${kind}
  `;
  return Number(row.next);
}

/** 列出所有活跃分类，供交易表单选择。按 sort_order 排序。 */
export async function listCategories(
  tx: Tx,
  organizationId: string,
): Promise<Array<{ id: string; nameEn: string | null; nameZh: string | null; kind: string }>> {
  const rows = await tx`
    select id, name_en, name_zh, kind
    from categories
    where organization_id = ${organizationId} and is_active = true
    order by sort_order
  `;
  return rows.map((row) => ({
    id: row.id as string,
    nameEn: (row.name_en as string) ?? null,
    nameZh: (row.name_zh as string) ?? null,
    kind: row.kind as string,
  }));
}

/**
 * 供录入表单使用：排除只应由系统过账的分类（折旧、摊销等）。
 *
 * 这些分类背后没有对应的现金移动——折旧/摊销由固定资产模块直接过账，
 * 从不经过用户填写的表单。留在录入选择器里，一个小白买了台电脑很
 * 自然地会选「折旧」，生成一笔贷记资金账户的分录：一次从未发生的
 * 现金流出，并且与固定资产模块的过账重复计算。
 */
export async function listSelectableCategories(
  tx: Tx,
  organizationId: string,
  kind: 'income' | 'expense',
): Promise<CategoryRow[]> {
  const rows = await tx`
    select id, name_en, name_zh, kind, account_id, is_active
    from categories
    where organization_id = ${organizationId}
      and kind = ${kind}
      and is_active
      and not is_system_only
    order by sort_order, id
  `;
  return rows.map((row) => ({
    id: row.id as string,
    nameEn: (row.name_en as string | null) ?? null,
    nameZh: (row.name_zh as string | null) ?? null,
    kind: row.kind as CategoryRow['kind'],
    accountId: row.account_id as string,
    isActive: row.is_active as boolean,
  }));
}

/**
 * 供录入表单的快捷芯片使用：按该公司最近 90 天内的使用频次取前 `limit`
 * 个分类（默认 6）。
 *
 * 与 listSelectableCategories 一样排除只应由系统过账的分类——芯片比下拉
 * 更容易被误触，把折旧/摊销这类分类摆成一键可选的芯片，比留在下拉里更危险。
 */
export async function listRecentCategories(
  tx: Tx,
  organizationId: string,
  kind: 'income' | 'expense',
  limit = 6,
): Promise<CategoryRow[]> {
  const rows = await tx`
    select c.id, c.name_en, c.name_zh, c.kind, c.account_id, c.is_active,
           count(t.id) as uses
    from categories c
    join transactions t on t.category_id = c.id
    where c.organization_id = ${organizationId}
      and c.kind = ${kind}
      and c.is_active
      and not c.is_system_only
      and t.voided_at is null
      and t.occurred_on >= current_date - interval '90 days'
    group by c.id, c.name_en, c.name_zh, c.kind, c.account_id, c.is_active
    order by uses desc, c.sort_order
    limit ${limit}
  `;
  return rows.map((row) => ({
    id: row.id as string,
    nameEn: (row.name_en as string | null) ?? null,
    nameZh: (row.name_zh as string | null) ?? null,
    kind: row.kind as CategoryRow['kind'],
    accountId: row.account_id as string,
    isActive: row.is_active as boolean,
  }));
}

/** 列出全部分类（含已隐藏），供设置页管理。 */
export async function listAllCategories(
  tx: Tx,
  organizationId: string,
): Promise<Array<{ id: string; nameEn: string | null; nameZh: string | null; kind: string; isActive: boolean }>> {
  const rows = await tx`
    select id, name_en, name_zh, kind, is_active
    from categories
    where organization_id = ${organizationId}
    order by sort_order
  `;
  return rows.map((row) => ({
    id: row.id as string,
    nameEn: (row.name_en as string) ?? null,
    nameZh: (row.name_zh as string) ?? null,
    kind: row.kind as string,
    isActive: row.is_active as boolean,
  }));
}
