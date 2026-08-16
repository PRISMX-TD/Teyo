import Link from 'next/link';
import { getMessages, localizedName } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { getTransactionDetail, TransactionNotFoundError } from '@/server/repositories/transactions';
import { listMoneyAccounts } from '@/server/repositories/accounts';
import { listSelectableCategories, type CategoryRow } from '@/server/repositories/categories';
import { listAttachments } from '@/server/repositories/attachments';
import { SUPPORTED_CURRENCIES } from '@/server/services/exchange-rate-sync';
import { TransactionForm } from '@/components/transaction/transaction-form';
import { VoidButton } from '@/components/transaction/void-button';
import { AttachmentPanel } from '@/components/transaction/attachment-panel';
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
  let incomeCategories: CategoryRow[];
  let expenseCategories: CategoryRow[];
  let attachments: Awaited<ReturnType<typeof listAttachments>>;

  try {
    [row, accounts, incomeCategories, expenseCategories, attachments] = await withTransaction(
      context.userId,
      async (tx) =>
        Promise.all([
          getTransactionDetail(tx, context.organizationId, id),
          listMoneyAccounts(tx, context.organizationId),
          listSelectableCategories(tx, context.organizationId, 'income'),
          listSelectableCategories(tx, context.organizationId, 'expense'),
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
  const attachmentItems = attachments.map((at) => ({
    id: at.id,
    fileName: at.fileName,
    mimeType: at.mimeType,
    sizeBytes: at.sizeBytes,
  }));

  if (isVoided) {
    // 已作废的交易：只读展示，不可编辑
    const kindLabel =
      row.kind === 'income'
        ? t.transaction.income
        : row.kind === 'expense'
          ? t.transaction.expense
          : row.kind === 'journal'
            ? t.transaction.journal
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

  if (row.kind === 'journal') {
    // 挂起分录——"不确定"队列指向的正是这类记录，不可编辑，只能查看与
    // 作废。updateTransaction 把 kind 钉死在原值上，kind 为 journal 时
    // resolveCounterAccountId 对任何分类都会抛
    // 'Journal entries do not use categories.'，Save 必然失败。这里绝不
    // 渲染那个必败的可编辑表单，只提供确实有效的操作。
    const debitLine = row.lines.find((line) => line.direction === 'debit');
    const creditLine = row.lines.find((line) => line.direction === 'credit');

    return (
      <Layout orgSlug={orgSlug} t={t}>
        <h1>{t.uncertain.title}</h1>
        <p className="uncertain-explain">{t.uncertain.explain}</p>
        <article className="record-detail">
          <dl>
            <dt>{t.transaction.kind}</dt>
            <dd>{t.transaction.journal}</dd>
            <dt>{t.transaction.date}</dt>
            <dd className="mono">{row.occurredOn}</dd>
            <dt>{t.transaction.amount}</dt>
            <dd className="mono amount">{formatMoney(row.amountMinor, row.currency, locale)}</dd>
            <dt>{t.journal.debitAccount}</dt>
            <dd>
              {debitLine
                ? localizedName(
                    { name_en: debitLine.accountNameEn, name_zh: debitLine.accountNameZh },
                    locale,
                  )
                : '—'}
            </dd>
            <dt>{t.journal.creditAccount}</dt>
            <dd>
              {creditLine
                ? localizedName(
                    { name_en: creditLine.accountNameEn, name_zh: creditLine.accountNameZh },
                    locale,
                  )
                : '—'}
            </dd>
            <dt>{t.transaction.description}</dt>
            <dd>{row.description || '—'}</dd>
            <dt>{t.transaction.createdBy}</dt>
            <dd>{row.createdByName}</dd>
          </dl>
        </article>
        <VoidButton orgSlug={orgSlug} transactionId={row.id} t={t} />
        <AttachmentPanel
          orgSlug={orgSlug}
          transactionId={row.id}
          attachments={attachmentItems}
          t={t}
        />
      </Layout>
    );
  }

  // 未作废、非挂起分录：显示编辑表单
  const categoryId = row.categoryId;

  // 这笔交易可能已经挂在一个只应由系统过账的分类上（比如固定资产模块
  // 记的折旧）。listSelectableCategories 把这类分类从选择器里筛掉是对的
  // ——但如果筛掉之后这里的下拉找不到当前值，<select required> 会掉回
  // 禁用的占位项，用户明明只是想改个日期或备注，却被逼着先随便选一个
  // 错误的分类才能保存。把它临时补回对应 kind 的选项列表：不新增选它
  // 的入口（其它交易的选择器里仍然看不到它），只是让已经如此分类的这一
  // 笔在未被用户主动改动时，保存时不会悄悄换成别的分类。
  const categoryPools: { income: CategoryRow[]; expense: CategoryRow[] } = {
    income: [...incomeCategories],
    expense: [...expenseCategories],
  };
  if (categoryId && (row.kind === 'income' || row.kind === 'expense')) {
    const pool = categoryPools[row.kind];
    if (!pool.some((c) => c.id === categoryId)) {
      pool.push({
        id: categoryId,
        nameEn: row.categoryNameEn,
        nameZh: row.categoryNameZh,
        kind: row.kind,
        accountId: '',
        isActive: true,
      });
    }
  }
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
        incomeCategories={categoryPools.income.map((c) => ({
          id: c.id,
          name_en: c.nameEn,
          name_zh: c.nameZh,
        }))}
        expenseCategories={categoryPools.expense.map((c) => ({
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
          rateSource: row.rateSource,
          // 安全：journal 已经在上面单独 return，走到这里的 row.kind
          // 只可能是 income/expense/transfer。
          kind: row.kind,
        }}
        attachments={attachmentItems}
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
