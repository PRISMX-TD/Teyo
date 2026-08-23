'use server';

import { revalidatePath } from 'next/cache';
import { renameSchema } from '@/lib/schemas';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import {
  AccountError,
  AccountRow,
  countActiveMoneyAccounts,
  getAccount,
  insertAccount,
  nextAccountSortOrder,
  nextAvailableCode,
  updateAccountActive,
  updateAccountNames,
} from '@/server/repositories/accounts';
import { recordAudit } from '@/server/repositories/audit-logs';

/** 空串与纯空白都当作「没填」，落库为 null，与 accounts_name_present 约束一致。 */
function normaliseNames(input: { nameEn?: string; nameZh?: string }) {
  return {
    nameEn: input.nameEn?.trim() || null,
    nameZh: input.nameZh?.trim() || null,
  };
}

/**
 * 科目改动会影响的每一个页面。
 *
 * 与分类同一个问题：之前只刷新科目设置页，而消费科目列表的页面有十三个。
 * 一个人新建了银行账户，回到「记一笔」却在账户下拉里找不到它——资金账户
 * 恰恰是新用户最早要建的东西，所以这是最容易被撞上的那一个。
 *
 * 动态路由要带 'page' 参数按路由刷新，因为这里不可能知道是哪一条记录。
 */
function revalidateAccountConsumers(orgSlug: string): void {
  for (const path of [
    `/${orgSlug}/settings/accounts`,
    `/${orgSlug}/settings/categories`,
    `/${orgSlug}/settings/inventory`,
    `/${orgSlug}/settings/recurring`,
    `/${orgSlug}/transactions`,
    `/${orgSlug}/transactions/new`,
    `/${orgSlug}/transactions/journal`,
    `/${orgSlug}/general-ledger`,
    `/${orgSlug}/reconciliation`,
    `/${orgSlug}/bank-import`,
    `/${orgSlug}/fixed-assets`,
    `/${orgSlug}/fixed-assets/new`,
  ]) {
    revalidatePath(path);
  }
  revalidatePath(`/${orgSlug}/transactions/[id]`, 'page');
}

export async function createMoneyAccount(
  orgSlug: string,
  input: { nameEn?: string; nameZh?: string },
): Promise<{ id: string }> {
  const context = await requirePermission(orgSlug, 'account:manage');
  const names = normaliseNames(renameSchema.parse(input));

  const result = await withTransaction(context.userId, async (tx) => {
    const code = await nextAvailableCode(
      tx,
      context.organizationId,
      names.nameEn ?? names.nameZh ?? 'wallet',
    );
    const sortOrder = await nextAccountSortOrder(tx, context.organizationId, 'asset');

    const { id } = await insertAccount(tx, {
      organizationId: context.organizationId,
      code,
      nameEn: names.nameEn,
      nameZh: names.nameZh,
      // 资金账户必须是资产类：accounts_money_is_asset 约束要求
      // not is_money_account or type = 'asset'。
      type: 'asset',
      isMoneyAccount: true,
      sortOrder,
    });

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'account.created',
      entityType: 'account',
      entityId: id,
      after: { code, ...names, isMoneyAccount: true },
    });

    return { id };
  });

  revalidateAccountConsumers(orgSlug);
  return result;
}

export async function createAccount(
  orgSlug: string,
  input: {
    nameEn?: string;
    nameZh?: string;
    type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
    isMoneyAccount: boolean;
  },
): Promise<{ id: string }> {
  const context = await requirePermission(orgSlug, 'account:manage');
  const names = normaliseNames(renameSchema.parse(input));

  const result = await withTransaction(context.userId, async (tx) => {
    const code = await nextAvailableCode(
      tx,
      context.organizationId,
      names.nameEn ?? names.nameZh ?? 'account',
    );
    const sortOrder = await nextAccountSortOrder(tx, context.organizationId, input.type as AccountRow['type']);

    const { id } = await insertAccount(tx, {
      organizationId: context.organizationId,
      code,
      nameEn: names.nameEn,
      nameZh: names.nameZh,
      type: input.type as AccountRow['type'],
      isMoneyAccount: input.isMoneyAccount,
      sortOrder,
    });

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'account.created',
      entityType: 'account',
      entityId: id,
      after: { code, ...names, type: input.type, isMoneyAccount: input.isMoneyAccount },
    });

    return { id };
  });

  revalidateAccountConsumers(orgSlug);
  return result;
}

export async function renameAccount(
  orgSlug: string,
  accountId: string,
  input: { nameEn?: string; nameZh?: string },
): Promise<void> {
  const context = await requirePermission(orgSlug, 'account:manage');
  const names = normaliseNames(renameSchema.parse(input));

  await withTransaction(context.userId, async (tx) => {
    const before = await getAccount(tx, context.organizationId, accountId);
    await updateAccountNames(tx, context.organizationId, accountId, names);

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'account.updated',
      entityType: 'account',
      entityId: accountId,
      before: { nameEn: before.nameEn, nameZh: before.nameZh },
      after: names,
    });
  });

  revalidateAccountConsumers(orgSlug);
}

/**
 * 停用或恢复科目。只停用，从不删除——已有分录的科目一旦删掉，历史账就查不出
 * 当初记在哪，所以本模块没有删除 Action，数据库层也没有 delete 策略。
 *
 * 唯一的硬性拦截是「不能停用最后一个启用中的资金账户」：一个都不剩时任何
 * 收支都录不进去，用户会卡在一个自己造成、且没有提示的死局里。
 */
export async function setAccountActive(
  orgSlug: string,
  accountId: string,
  isActive: boolean,
): Promise<void> {
  const context = await requirePermission(orgSlug, 'account:manage');

  await withTransaction(context.userId, async (tx) => {
    const before = await getAccount(tx, context.organizationId, accountId);

    if (!isActive && before.isMoneyAccount && before.isActive) {
      const remaining = await countActiveMoneyAccounts(tx, context.organizationId);
      if (remaining <= 1) {
        throw new AccountError(
          'This is the last active money account. Add another one before archiving it.',
        );
      }
    }

    await updateAccountActive(tx, context.organizationId, accountId, isActive);

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'account.updated',
      entityType: 'account',
      entityId: accountId,
      before: { isActive: before.isActive },
      after: { isActive },
    });
  });

  revalidateAccountConsumers(orgSlug);
}
