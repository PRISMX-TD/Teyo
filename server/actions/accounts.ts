'use server';

import { revalidatePath } from 'next/cache';
import { renameSchema } from '@/lib/schemas';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import {
  AccountError,
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

  revalidatePath(`/${orgSlug}/settings/accounts`);
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

  revalidatePath(`/${orgSlug}/settings/accounts`);
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

  revalidatePath(`/${orgSlug}/settings/accounts`);
}
