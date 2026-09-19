'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { recordAudit } from '@/server/repositories/audit-logs';
import {
  setBudget,
} from '@/server/repositories/budgets';
import { currencyExponent, parseDecimalToMinor } from '@/server/domain/money';

/**
 * year/month 以前一个字节都没校验，直接进 SQL 与 budgets 表。
 * month = 13 会拼出 `2026-13-01`，用户读到的是 Postgres 那句
 * date/time field value out of range；year 打成 20265 更糟——写得进去、
 * 读得出来，只是永远对不上任何一个月的实际发生额，看起来像「这个月没数据」。
 *
 * 上界取 9999 而不是「今年 +N」：预算本来就可以往后排很多年，限制未来年份
 * 会挡住合法用法；而四位数这个上界与 date 类型能表达的范围对齐，拼出来的
 * 日期字符串永远是合法的。
 */
const updateBudgetSchema = z.object({
  accountId: z.string().uuid(),
  year: z.number().int().min(1900).max(9999),
  month: z.number().int().min(1).max(12),
  amount: z.string().min(1),
});

export async function updateBudget(
  orgSlug: string,
  input: {
    accountId: string;
    year: number;
    month: number;
    amount: string;
  },
): Promise<void> {
  const context = await requirePermission(orgSlug, 'account:manage');
  const parsed = updateBudgetSchema.parse(input);

  // 预算金额与报表一样是本位币，所以小数位数必须按**本位币**的指数解析，
  // 不能硬编码 2。原来写死 exponent = 2 的后果是：本位币为 JPY / KRW / VND
  // （零小数币种）的公司输入 "1000" 会被解析成 100000 minor units，
  // 也就是 100,000 日元——预算被凭空放大了 100 倍，而界面上按零小数币种
  // 格式化回来时显示的正是 "100,000"，用户没有任何线索能看出哪里不对。
  // currencyExponent 是全项目判断「这个币种有几位小数」的唯一出处
  // （server/domain/money.ts），payments/invoices 等 action 早就在用它了。
  const budgetMinor = parseDecimalToMinor(parsed.amount, currencyExponent(context.baseCurrency));

  await withTransaction(context.userId, async (tx) => {
    await setBudget(
      tx,
      context.organizationId,
      parsed.accountId,
      parsed.year,
      parsed.month,
      budgetMinor,
    );

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'budget.updated',
      entityType: 'budget',
      // audit_logs.entity_id 是 **uuid** 列（见 0001 迁移）。这里原来写的是
      // `${accountId}/${year}/${month}` 这样一个拼出来的复合键，Postgres 直接
      // 报 `invalid input syntax for type uuid`——也就是说**每一次保存预算都
      // 在抛错**，从这个功能上线起就没成功过一次。它一直没被发现，是因为
      // 预算页从来没有测试覆盖，而界面上失败的表现只是「保存没反应」。
      //
      // 改成用 accountId：它本身就是 uuid，而且正是这条审计记录指向的实体
      // （「这个科目的预算被改了」）。期间落在 after 里——它是 jsonb，
      // 能装下复合键，entity_id 装不下。
      entityId: parsed.accountId,
      after: {
        accountId: parsed.accountId,
        year: parsed.year,
        month: parsed.month,
        amount: parsed.amount,
        // 记下 minor units 与币种：amount 是用户输入的十进制字符串，
        // 单看它无法还原「当时按几位小数解析的」——正是这次要修的那个 bug
        // 留下的空白。
        budgetMinor: budgetMinor.toString(),
        baseCurrency: context.baseCurrency,
      },
    });
  });

  revalidatePath(`/${orgSlug}/budgets`);
}
