'use server';

import { revalidatePath } from 'next/cache';
import { accountSchema, parseOrThrow, renameSchema } from '@/lib/schemas';
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

  // 资金账户的 type 与 isMoneyAccount 不由入参决定，是这个 Action 的定义的
  // 一部分（accounts_money_is_asset 约束要求资金账户必须是资产类），所以在
  // 这里补齐再交给 accountSchema 一起验，而不是只验名字。
  //
  // 从 renameSchema 换成 accountSchema 不是为了名字那条规则——两者对名字的
  // 要求一模一样（至少填一种语言）——而是为了别的字段将来加进来时，校验的
  // 落点已经在这儿了。
  const names = normaliseNames(
    parseOrThrow(
      accountSchema,
      { ...input, type: 'asset', isMoneyAccount: true },
      (m) => new AccountError(m),
    ),
  );

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

  // 之前这里只验了名字，type 与 isMoneyAccount 一路 `as AccountRow['type']`
  // 硬转到底。那两个 as 是纯粹的谎言：Server Action 的入参来自网络，
  // type 完全可能是 'Asset'、'' 或者一个对象。转成什么都不检查地插进
  // accounts.type（一个 enum 列），最好的结果是 Postgres 报一句用户看不懂
  // 的 invalid input value for enum，最坏的结果是某天有人把这一列改宽。
  const parsed = parseOrThrow(accountSchema, input, (m) => new AccountError(m));
  const names = normaliseNames(parsed);

  const result = await withTransaction(context.userId, async (tx) => {
    const code = await nextAvailableCode(
      tx,
      context.organizationId,
      names.nameEn ?? names.nameZh ?? 'account',
    );
    const sortOrder = await nextAccountSortOrder(tx, context.organizationId, parsed.type);

    const { id } = await insertAccount(tx, {
      organizationId: context.organizationId,
      code,
      nameEn: names.nameEn,
      nameZh: names.nameZh,
      type: parsed.type,
      isMoneyAccount: parsed.isMoneyAccount,
      sortOrder,
    });

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'account.created',
      entityType: 'account',
      entityId: id,
      after: { code, ...names, type: parsed.type, isMoneyAccount: parsed.isMoneyAccount },
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
  // 与另外两个入口用同一条通道：裸 .parse() 抛出的 ZodError，message 是一坨
  // JSON，而组件会把它原样贴到设置页上。
  const names = normaliseNames(parseOrThrow(renameSchema, input, (m) => new AccountError(m)));

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
