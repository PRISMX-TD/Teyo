import Link from 'next/link';
import { getMessages } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { getTransactionDetail } from '@/server/repositories/transactions';
import type { ReactNode } from 'react';

export default async function TransactionDetailPage({
  params,
}: {
  params: Promise<{ orgSlug: string; id: string }>;
}) {
  const { orgSlug, id } = await params;
  const context = await requirePermission(orgSlug, 'transaction:read');
  const locale = (await getUserLocale(context.userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  const row = await withTransaction(context.userId, (tx) =>
    getTransactionDetail(tx, context.organizationId, id),
  );

  if (!row) {
    return (
      <Layout orgSlug={orgSlug} t={t}>
        <p>{t.errors.notFound}</p>
      </Layout>
    );
  }

  const isVoided = !!row.voidedAt;
  const kindLabel =
    row.kind === 'income'
      ? t.transaction.income
      : row.kind === 'expense'
        ? t.transaction.expense
        : t.transaction.transfer;

  return (
    <Layout orgSlug={orgSlug} t={t}>
      <article className={isVoided ? 'record-detail voided' : 'record-detail'}>
        <h1>{isVoided ? t.transaction.voided : t.transaction.editTitle}</h1>
        {isVoided && row.voidReason ? (
          <p className="form-error">{row.voidReason}</p>
        ) : null}

        <dl>
          <dt>{t.transaction.kind}</dt>
          <dd>{kindLabel}</dd>
          <dt>{t.transaction.date}</dt>
          <dd className="mono">{row.occurredOn}</dd>
          <dt>{t.transaction.amount}</dt>
          <dd className="mono amount">{formatMoney(row.amountMinor, row.currency, locale)}</dd>
          <dt>{t.transaction.description}</dt>
          <dd>{row.description || '\u2014'}</dd>
          <dt>{t.transaction.createdBy}</dt>
          <dd>{row.createdBy}</dd>
        </dl>
      </article>
    </Layout>
  );
}

function Layout({ orgSlug, t, children }: { orgSlug: string; t: ReturnType<typeof getMessages>; children: ReactNode }) {
  return (
    <>
      <Link href={`/${orgSlug}/transactions`}>&larr; {t.transaction.listTitle}</Link>
      {children}
    </>
  );
}
