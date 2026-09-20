'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { parseOrThrow } from '@/lib/schemas';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { currencyExponent, parseDecimalToMinor } from '@/server/domain/money';
import { getMoneyAccount } from '@/server/repositories/accounts';
import {
  createReconciliation,
  addReconciliationItem,
  filterOwnTransactionIds,
  updateReconciliationItem,
  completeReconciliation,
  ReconciliationError,
} from '@/server/repositories/reconciliation';
import { recordAudit } from '@/server/repositories/audit-logs';

const uuid = z.string().uuid('Pick one of the options in the list.');

/**
 * 对账单上的金额。
 *
 * 与交易金额不同，这里允许 0（一个刚开的户口余额就是 0），也允许负数
 * （透支的往来账户对账单余额是负的），所以不能直接复用 lib/schemas 里的
 * positiveAmount。格式仍然按字符串验，一位浮点都不碰。
 */
const signedAmount = z
  .string()
  .trim()
  .regex(/^-?\d{1,3}(,\d{3})*(\.\d+)?$|^-?\d+(\.\d+)?$/, 'Enter the amount as a plain number.');

const reconcileSchema = z
  .object({
    moneyAccountId: uuid,
    statementDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date format YYYY-MM-DD.'),
    statementBalance: signedAmount,
    itemIds: z.array(uuid).max(5000, 'That is too many lines for one reconciliation.'),
    // 这里刻意不用 signedAmount 逐个验：界面把**每一个**输入框的当前值都放进
    // 这张表，包括用户勾掉后又清空的那些（值是空串），而它们中的绝大多数根本
    // 不在 itemIds 里。整张表一起验，会让一个没被选中的空输入框否决掉整次对账。
    // 真正要用到的那几条在下面的循环里逐条验。
    adjustments: z.record(z.string(), z.string()),
  })
  .strict();

/**
 * 解析一个可以带负号的金额。
 *
 * parseDecimalToMinor 只收非负串（它的 MoneyError 文案就是这么写的），所以
 * 符号在这里剥掉、在 bigint 上加回去——绝不先转成 number 再取负。
 */
function parseSignedToMinor(value: string, exponent: number): bigint {
  const negative = value.startsWith('-');
  const minor = parseDecimalToMinor(negative ? value.slice(1) : value, exponent);
  return negative ? -minor : minor;
}

export async function reconcile(
  orgSlug: string,
  input: {
    moneyAccountId: string;
    statementDate: string;
    statementBalance: string;
    itemIds: string[];
    adjustments: Record<string, string>;
  },
): Promise<{ id: string }> {
  const context = await requirePermission(orgSlug, 'transaction:edit:any');

  const parsed = parseOrThrow(reconcileSchema, input, (m) => new ReconciliationError(m));

  // 小数位数由本位币决定，不是永远两位。原来这里硬写 2，于是一家 JPY 公司
  // 的对账单余额「1200」会被记成 12 日元，而「1200.00」这种 JPY 根本不该有
  // 的写法反倒被放行——两个方向都错，而且错得无声无息。
  const exponent = currencyExponent(context.baseCurrency);
  const statementBalanceMinor = parseSignedToMinor(parsed.statementBalance, exponent);

  const result = await withTransaction(context.userId, async (tx) => {
    // 资金账户必须先按公司维度查回来。imported/reconciliation 这两张表的外键
    // 都只指向 accounts(id)，没有公司维度，所以一个别家公司的账户 id 本来是
    // 插得进去的——插进去之后，这次对账会挂在别人的银行账户上。
    const moneyAccount = await getMoneyAccount(tx, context.organizationId, parsed.moneyAccountId);

    // 同理，itemIds 是客户端给的，过去被直接当 transaction_id 插入。
    // 参照 server/actions/attachments.ts 的做法：先确认这些交易属于本公司，
    // 再动手。
    const own = await filterOwnTransactionIds(tx, context.organizationId, parsed.itemIds);
    if (own.size !== parsed.itemIds.length) {
      throw new ReconciliationError(
        'Some of the selected records are not in this company, or have been voided. ' +
          'Reload the page and try again.',
      );
    }

    const { id } = await createReconciliation(tx, {
      organizationId: context.organizationId,
      moneyAccountId: moneyAccount.id,
      statementDate: parsed.statementDate,
      statementBalanceMinor,
      createdBy: context.userId,
    });

    for (const itemId of parsed.itemIds) {
      // 空输入框就是「没有调整」。之前写的是 `?? '0'`，只兜住了「键不存在」，
      // 兜不住「键在、值是空串」——而后者恰恰是用户点进输入框又删掉时的样子，
      // 于是整次对账倒在一句 MoneyError 上。
      const raw = (parsed.adjustments[itemId] ?? '').trim();
      const adjMinor =
        raw === ''
          ? 0n
          : parseSignedToMinor(
              parseOrThrow(signedAmount, raw, (m) => new ReconciliationError(m)),
              exponent,
            );
      await addReconciliationItem(tx, {
        reconciliationId: id,
        transactionId: itemId,
        isCleared: true,
        adjustmentMinor: adjMinor,
        note: null,
      });
    }

    await completeReconciliation(tx, context.organizationId, id);

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'reconciliation.completed',
      entityType: 'reconciliation',
      entityId: id,
      after: {
        moneyAccountId: moneyAccount.id,
        statementDate: parsed.statementDate,
        items: parsed.itemIds.length,
      },
    });

    return { id };
  });

  revalidatePath(`/${orgSlug}/reconciliation`);
  return result;
}

export async function updateItem(
  orgSlug: string,
  id: string,
  cleared: boolean,
  adjustment: string,
): Promise<void> {
  const context = await requirePermission(orgSlug, 'transaction:edit:any');

  const parsed = parseOrThrow(
    z.object({ id: uuid, adjustment: signedAmount }).strict(),
    // 与 reconcile 里同一条约定：空输入框等于没有调整。
    { id, adjustment: adjustment.trim() === '' ? '0' : adjustment },
    (m) => new ReconciliationError(m),
  );
  const adjMinor = parseSignedToMinor(parsed.adjustment, currencyExponent(context.baseCurrency));

  await withTransaction(context.userId, async (tx) => {
    // organizationId 往下传。不传的话 where 子句里只有一个 id，
    // 任何成员都能改别家公司的对账行——见仓库层那个函数的注释。
    await updateReconciliationItem(tx, context.organizationId, parsed.id, cleared, adjMinor);
  });

  revalidatePath(`/${orgSlug}/reconciliation`);
}

export async function complete(orgSlug: string, id: string): Promise<void> {
  const context = await requirePermission(orgSlug, 'transaction:edit:any');

  const parsed = parseOrThrow(
    z.object({ id: uuid }).strict(),
    { id },
    (m) => new ReconciliationError(m),
  );

  await withTransaction(context.userId, async (tx) => {
    await completeReconciliation(tx, context.organizationId, parsed.id);

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'reconciliation.completed',
      entityType: 'reconciliation',
      entityId: parsed.id,
      after: { completed: true },
    });
  });

  revalidatePath(`/${orgSlug}/reconciliation`);
}
