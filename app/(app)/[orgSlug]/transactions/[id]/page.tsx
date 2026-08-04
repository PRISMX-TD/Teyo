import Link from 'next/link';
import { getMessages } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { getTransactionDetail, TransactionNotFoundError } from '@/server/repositories/transactions';
import { listMoneyAccounts } from '@/server/repositories/accounts';
import { listCategories } from '@/server/repositories/categories';
import { listAttachments } from '@/server/repositories/attachments';
import { SUPPORTED_CURRENCIES } from '@/server/services/exchange-rate-sync';
import { TransactionForm } from '@/components/transaction/transaction-form';
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

  let row: Awaited<ReturnType<typeof getTransactionDetail>>;
  let accounts: Awaited<ReturnType<typeof listMoneyAccounts>>;
  let allCategories: Awaited<ReturnType<typeof listCategories>>;
  let attachments: Awaited<ReturnType<typeof listAttachments>>;

  try {
    [row, accounts, allCategories, attachments] = await withTransaction(
      context.userId,
      async (tx) =>
        Promise.all([
          getTransactionDetail(tx, context.organizationId, id),
          listMoneyAccounts(tx, context.organizationId),
          listCategories(tx, context.organizationId),
          listAttachments(tx, context.organizationId, id),
        ]),
    );
  } catch (e) {
    if (e instanceof TransactionNotFoundError) {
      return (
        <Layout orgSlug={orgSlug} t={t}>
          <p>{t.errors.notFound}</p>
        </Layout>
      );
    }
    throw e;
  }

  const isVoided = !!row.voidedAt;

  if (isVoided) {
    // 已作废的交易：只读展示，不可编辑
    const kindLabel =
      row.kind === 'income'
        ? t.transaction.income
        : row.kind === 'expense'
          ? t.transaction.expense
          : t.transaction.transfer;

    return (
      <Layout orgSlug={orgSlug} t={t}>
        <article className="record-detail voided">
          <h1>{t.transaction.voided}</h1>
          {row.voidReason ? <p className="form-error">{row.voidReason}</p> : null}
          <dl>
            <dt>{t.transaction.kind}</dt>
            <dd>{kindLabel}</dd>
            <dt>{t.transaction.date}</dt>
            <dd className="mono">{row.occurredOn}</dd>
            <dt>{t.transaction.amount}</dt>
            <dd className="mono amount">
              {formatMoney(row.amountMinor, row.currency, locale)}
            </dd>
            <dt>{t.transaction.description}</dt>
            <dd>{row.description || '\u2014'}</dd>
            <dt>{t.transaction.createdBy}</dt>
            <dd>{row.createdBy}</dd>
          </dl>
        </article>
      </Layout>
    );
  }

  // 未作废：显示编辑表单
  const categoryId = row.categoryId;
  const incomeCategories = allCategories.filter((c) => c.kind === 'income');
  const expenseCategories = allCategories.filter((c) => c.kind === 'expense');
  const currenciesList = [...SUPPORTED_CURRENCIES];

  return (
    <Layout orgSlug={orgSlug} t={t}>
      <h1>{t.transaction.editTitle}</h1>
      <TransactionForm
        orgSlug={orgSlug}
        baseCurrency={context.baseCurrency}
        locale={locale}
        moneyAccounts={accounts.map((a) => ({
          id: a.id,
          name_en: a.nameEn,
          name_zh: a.nameZh,
        }))}
        incomeCategories={incomeCategories.map((c) => ({
          id: c.id,
          name_en: c.nameEn,
          name_zh: c.nameZh,
        }))}
        expenseCategories={expenseCategories.map((c) => ({
          id: c.id,
          name_en: c.nameEn,
          name_zh: c.nameZh,
        }))}
        currencies={currenciesList}
        mode="edit"
        initialData={{
          id: row.id,
          occurredOn: row.occurredOn,
          amount: (Number(row.amountMinor) / 100).toString(),
          currency: row.currency,
          moneyAccountId: row.moneyAccountId ?? '',
          categoryId,
          counterAccountId: row.counterAccountId ?? null,
          description: row.description ?? '',
          exchangeRate: row.exchangeRate ?? '1',
          kind: row.kind as 'income' | 'expense' | 'transfer',
        }}
        attachments={attachments.map((at) => ({
          id: at.id,
          fileName: at.fileName,
          mimeType: at.mimeType,
          sizeBytes: at.sizeBytes,
        }))}
      />
    </Layout>
  );
}

function Layout({
  orgSlug,
  t,
  children,
}: {
  orgSlug: string;
  t: ReturnType<typeof getMessages>;
  children: ReactNode;
}) {
  return (
    <>
      <Link href={`/${orgSlug}/transactions`}>&larr; {t.transaction.listTitle}</Link>
      {children}
    </>
  );
}
