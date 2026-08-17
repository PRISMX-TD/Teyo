import type { Tx } from '@/server/db/transaction';
import { LedgerError, type DraftJournalLine, type TransactionKind } from '@/server/domain/ledger';
import { formatScaledRate, type RateSource } from '@/server/domain/exchange-rate';

/**
 * 记账凭证的底层写入函数。
 *
 * 只对 server/posting/ 内部导出——postJournal 与 repostJournal
 * （见 ./post-journal.ts）是唯一应该调用它们的地方。
 * 任务 4-6 依次收编了 transactions.ts、recurring.ts、fixed_assets.ts，
 * 至此 server/posting/ 之外已无任何直接导入；任务 7 用 lint 规则把这条
 * 路径堵死。deleteJournalLines 原来留在 server/repositories/transactions.ts，
 * 后来搬进这个文件——三个底层写入函数现在同属一个模块，按模块整体禁止导入，
 * 不用再对某一个名字单独开 importNames 白名单／黑名单。
 */

export type NewTransactionRow = {
  organizationId: string;
  kind: TransactionKind;
  occurredOn: string;
  description: string;
  currency: string;
  amountMinor: bigint;
  baseAmountMinor: bigint;
  scaledRate: bigint;
  rateSource: RateSource;
  categoryId: string | null;
  createdBy: string;
  clientUuid: string;
};

/**
 * exchange_rate 列是 numeric(20,8)，而应用内部用放大 10^8 的 bigint。
 * 这里转成十进制字符串写入，全程不经 Number，避免浮点误差改动汇率。
 * formatScaledRate 会裁掉尾部零，numeric 列不在意这个。
 */
export async function insertTransaction(
  tx: Tx,
  row: NewTransactionRow,
): Promise<{ id: string }> {
  const inserted = await tx`
    insert into transactions (
      organization_id, kind, occurred_on, description, currency,
      amount_minor, base_amount_minor, exchange_rate, rate_source,
      category_id, created_by, client_uuid
    )
    values (
      ${row.organizationId},
      ${row.kind},
      ${row.occurredOn},
      ${row.description},
      ${row.currency},
      ${row.amountMinor.toString()},
      ${row.baseAmountMinor.toString()},
      ${formatScaledRate(row.scaledRate)},
      ${row.rateSource},
      ${row.categoryId},
      ${row.createdBy},
      ${row.clientUuid}
    )
    returning id
  `;

  return { id: inserted[0].id as string };
}

/** 科目 id -> 科目代码，取自归属校验那一次查询。 */
export type AccountCodesById = ReadonlyMap<string, string>;

/**
 * 断言分录里出现的每一个科目 id 都属于 organizationId 这家公司，
 * 并把这次查到的 id -> code 映射带回去。
 *
 * PostgreSQL 的外键约束只保证 account_id 在 accounts 表里确实存在，不检查
 * 它是否属于当前公司——RLS 不对外键校验生效。调用方一旦把别家公司的
 * 账户 id 传进来（表单被篡改、id 拼错、跨公司复制粘贴的脚本），外键
 * 校验会照样放行，把这家公司的分录钉死在别家公司的科目上。
 *
 * 之前这层校验完全靠调用方各自记得先查（findAccount/getMoneyAccount 之
 * 类），是约定而不是结构性保证。这里把它收紧成写入路径本身的强制条件：
 * 不管调用方有没有先查过，insertJournalLines 落库前总会再核一遍。
 *
 * code 是顺手取的：这条 select 本来就要按 id 扫这几行，多带一列不多一次
 * 往返。审计快照要靠它写下人读得懂的科目代码——分录行里只有 uuid。
 */
async function assertAccountsBelongToOrg(
  tx: Tx,
  organizationId: string,
  accountIds: string[],
): Promise<AccountCodesById> {
  const codesById = new Map<string, string>();

  const uniqueIds = [...new Set(accountIds)];
  if (uniqueIds.length === 0) return codesById;

  const rows = await tx`
    select id, code from accounts
    where organization_id = ${organizationId} and id = any(${uniqueIds}::uuid[])
  `;
  for (const row of rows) {
    codesById.set(row.id as string, row.code as string);
  }

  const missing = uniqueIds.filter((id) => !codesById.has(id));
  if (missing.length > 0) {
    throw new LedgerError(
      `Account(s) not found in this company: ${missing.join(', ')}`,
    );
  }

  return codesById;
}

/** 写分录行，返回这批科目的 id -> code 映射，供调用方写审计快照。 */
export async function insertJournalLines(
  tx: Tx,
  organizationId: string,
  transactionId: string,
  lines: DraftJournalLine[],
): Promise<AccountCodesById> {
  if (lines.length === 0) return new Map();

  const codesById = await assertAccountsBelongToOrg(
    tx,
    organizationId,
    lines.map((line) => line.accountId),
  );

  await tx`
    insert into journal_lines ${tx(
      lines.map((line) => ({
        transaction_id: transactionId,
        organization_id: organizationId,
        account_id: line.accountId,
        direction: line.direction,
        // bigint 列传十进制字符串：驱动类型定义不接受 bigint 参数，
        // 而字符串由 Postgres 直接解析，不经浮点，精度无损。
        amount_minor: line.amountMinor.toString(),
        base_amount_minor: line.baseAmountMinor.toString(),
      })),
      'transaction_id',
      'organization_id',
      'account_id',
      'direction',
      'amount_minor',
      'base_amount_minor',
    )}
  `;

  return codesById;
}

/**
 * 删掉一笔交易名下的全部分录行，供编辑路径重建分录用（先删后插，见
 * repostJournal 的注释）。原先落在 server/repositories/transactions.ts，
 * 纯粹搬家：行为、签名、SQL 都未改动。
 */
export async function deleteJournalLines(
  tx: Tx,
  organizationId: string,
  transactionId: string,
): Promise<void> {
  await tx`
    delete from journal_lines
    where transaction_id = ${transactionId} and organization_id = ${organizationId}
  `;
}
