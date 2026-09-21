/**
 * 客户 / 供应商对账单。
 *
 * 这个路由此前**不存在**。components/reports/reports-view.tsx 的 StatementTab
 * 一直在 fetch `/api/${orgSlug}/statement`，拿回来的永远是 Next 的 404，
 * 于是 catch 分支把「加载失败」摆在屏幕上——报表页上那两个标签页从上线起
 * 就没有出过一次数。仓储层的 getCustomerStatement / getVendorStatement 早就
 * 写好并测过（tests/repositories/aging-statements.test.ts），只是没有任何东西
 * 把它们接到界面上。
 *
 * 金额一律以**字符串**出网。仓储返回的是 bigint（本位币最小单位），而
 * JSON.stringify 碰到 bigint 会直接抛 TypeError——不是给出 0 或 null，是整个
 * 响应挂掉。客户端那边原来把 res.json() 的结果直接断言成 CustomerStatement
 * （字段类型写的是 bigint），那是一句谎话：JSON 里不可能有 bigint。两边都
 * 改成字符串，由客户端用 BigInt() 转回去。
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AuthError, requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getCustomerStatement, getVendorStatement } from '@/server/repositories/aging';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  type: z.enum(['customer', 'vendor']),
  contactId: z.string().uuid(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/** 出网的形状：与仓储同构，只是 bigint 换成十进制字符串。 */
export type StatementResponse = {
  openingBalance: string;
  lines: { date: string; description: string; reference: string; amount: string; balance: string }[];
  closingBalance: string;
  notice: { count: number; currencies: string[] } | null;
};

export async function GET(
  request: Request,
  { params }: { params: Promise<{ orgSlug: string }> },
): Promise<NextResponse> {
  const { orgSlug } = await params;
  const url = new URL(request.url);

  const parsed = querySchema.safeParse({
    type: url.searchParams.get('type'),
    contactId: url.searchParams.get('contactId'),
    from: url.searchParams.get('from'),
    to: url.searchParams.get('to'),
  });
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }
  // 起止日反了的话，SQL 的 between 会安静地返回空集——一份「这个客户本期
  // 没有任何往来」的对账单，和一份真的没有往来的对账单长得一模一样。
  if (parsed.data.from > parsed.data.to) {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  let context;
  try {
    // 与报表页同一道权限（viewer 也有）。对账单上的每一个数字，在损益表和
    // 账龄表上本来就已经看得到了，单独收紧只会让只读用户改用截图。
    context = await requirePermission(orgSlug, 'transaction:read');
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    throw error;
  }

  const statement = await withTransaction(context.userId, (tx) =>
    parsed.data.type === 'customer'
      ? getCustomerStatement(tx, context.organizationId, parsed.data.contactId, parsed.data.from, parsed.data.to)
      : getVendorStatement(tx, context.organizationId, parsed.data.contactId, parsed.data.from, parsed.data.to),
  );

  const body: StatementResponse = {
    openingBalance: statement.openingBalance.toString(),
    lines: statement.lines.map((line) => ({
      date: line.date,
      description: line.description,
      reference: line.reference,
      amount: line.amount.toString(),
      balance: line.balance.toString(),
    })),
    closingBalance: statement.closingBalance.toString(),
    notice: statement.notice,
  };

  return NextResponse.json(body, {
    // 对账单随时会因为新记一笔款而变。缓存住等于给用户看昨天的账。
    headers: { 'Cache-Control': 'no-store' },
  });
}
