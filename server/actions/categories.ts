'use server';

import { revalidatePath } from 'next/cache';
import { categorySchema, renameSchema } from '@/lib/schemas';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getAccount } from '@/server/repositories/accounts';
import { recordAudit } from '@/server/repositories/audit-logs';
import {
  CategoryError,
  getCategory,
  insertCategory,
  nextCategorySortOrder,
  updateCategoryActive,
  updateCategoryNames,
} from '@/server/repositories/categories';

export async function createCategory(
  orgSlug: string,
  input: { nameEn?: string; nameZh?: string; kind: 'income' | 'expense'; accountId: string },
): Promise<{ id: string }> {
  const context = await requirePermission(orgSlug, 'category:manage');
  const parsed = categorySchema.parse(input);
  return createCategoryChecked(orgSlug, context, parsed);
}

/**
 * `NamedList` 是通用组件，`onCreate` 的 payload 里 kind/accountId 是可选的——
 * 其它复用它的列表（科目、联系人等）根本不需要这两个字段。分类这边它们其实
 * 是必填的，所以在跨越 Server/Client 组件边界之前，在这里做一次运行时收窄，
 * 而不是放宽 `createCategory` 本身的类型或者用 `as` 把类型系统压下去——
 * 那样 tsc 就又检查不到这条链路了。
 */
export async function createCategoryFromNamedList(
  orgSlug: string,
  input: { nameEn?: string; nameZh?: string; kind?: 'income' | 'expense'; accountId?: string },
): Promise<{ id: string }> {
  const context = await requirePermission(orgSlug, 'category:manage');
  if (!input.kind || !input.accountId) {
    throw new CategoryError('Choose income or expense and an account before adding a category.');
  }
  const parsed = categorySchema.parse({
    nameEn: input.nameEn,
    nameZh: input.nameZh,
    kind: input.kind,
    accountId: input.accountId,
  });
  return createCategoryChecked(orgSlug, context, parsed);
}

async function createCategoryChecked(
  orgSlug: string,
  context: Awaited<ReturnType<typeof requirePermission>>,
  parsed: { nameEn?: string; nameZh?: string; kind: 'income' | 'expense'; accountId: string },
): Promise<{ id: string }> {

  const result = await withTransaction(context.userId, async (tx) => {
    const account = await getAccount(tx, context.organizationId, parsed.accountId);

    // 收入类分类只能挂收入科目，支出类只能挂费用科目。
    // 挂错了分录方向就是对的但科目类型错了，损益表从此对不上。
    const expectedType = parsed.kind === 'income' ? 'revenue' : 'expense';
    if (account.type !== expectedType) {
      throw new CategoryError(
        `A ${parsed.kind} category must map to a ${expectedType} account, got ${account.type}.`,
      );
    }

    const sortOrder = await nextCategorySortOrder(tx, context.organizationId, parsed.kind);

    const { id } = await insertCategory(tx, {
      organizationId: context.organizationId,
      nameEn: parsed.nameEn?.trim() || null,
      nameZh: parsed.nameZh?.trim() || null,
      kind: parsed.kind,
      accountId: parsed.accountId,
      sortOrder,
    });

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'category.created',
      entityType: 'category',
      entityId: id,
      after: {
        nameEn: parsed.nameEn?.trim() || null,
        nameZh: parsed.nameZh?.trim() || null,
        kind: parsed.kind,
        accountId: parsed.accountId,
      },
    });

    return { id };
  });

  revalidatePath(`/${orgSlug}/settings/categories`);
  return result;
}

export async function renameCategory(
  orgSlug: string,
  categoryId: string,
  input: { nameEn?: string; nameZh?: string },
): Promise<void> {
  const context = await requirePermission(orgSlug, 'category:manage');
  const parsed = renameSchema.parse(input);
  const names = {
    nameEn: parsed.nameEn?.trim() || null,
    nameZh: parsed.nameZh?.trim() || null,
  };

  await withTransaction(context.userId, async (tx) => {
    const before = await getCategory(tx, context.organizationId, categoryId);
    await updateCategoryNames(tx, context.organizationId, categoryId, names);

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'category.updated',
      entityType: 'category',
      entityId: categoryId,
      before: { nameEn: before.nameEn, nameZh: before.nameZh },
      after: names,
    });
  });

  revalidatePath(`/${orgSlug}/settings/categories`);
}

export async function setCategoryActive(
  orgSlug: string,
  categoryId: string,
  isActive: boolean,
): Promise<void> {
  const context = await requirePermission(orgSlug, 'category:manage');

  await withTransaction(context.userId, async (tx) => {
    const before = await getCategory(tx, context.organizationId, categoryId);
    await updateCategoryActive(tx, context.organizationId, categoryId, isActive);

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'category.updated',
      entityType: 'category',
      entityId: categoryId,
      before: { isActive: before.isActive },
      after: { isActive },
    });
  });

  revalidatePath(`/${orgSlug}/settings/categories`);
}
