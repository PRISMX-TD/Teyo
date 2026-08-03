import type { Tx } from '@/server/db/transaction';
import type { DraftJournalLine, TransactionKind } from '@/server/domain/ledger';
import { formatScaledRate } from '@/server/domain/exchange-rate';
import type { RateSource } from '@/server/domain/exchange-rate';

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

export async function insertJournalLines(
  tx: Tx,
  organizationId: string,
  transactionId: string,
  lines: DraftJournalLine[],
): Promise<void> {
  if (lines.length === 0) return;

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
}

/** client_uuid 是离线幂等键，唯一约束是 (organization_id, client_uuid)。 */
export async function findTransactionByClientUuid(
  tx: Tx,
  organizationId: string,
  clientUuid: string,
): Promise<{ id: string } | null> {
  const rows = await tx`
    select id from transactions
    where organization_id = ${organizationId} and client_uuid = ${clientUuid}
  `;
  const row = rows.at(0);
  return row ? { id: row.id as string } : null;
}
