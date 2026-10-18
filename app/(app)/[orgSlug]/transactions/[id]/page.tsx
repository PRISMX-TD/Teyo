import Link from 'next/link';
import { BackLink } from '@/components/ui/back-link';
import { getMessages, interpolate, localizedName } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';
import { requirePermission } from '@/server/auth/guard';
import { canEditTransaction } from '@/server/domain/permissions';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import {
  findTransactionSource,
  getTransactionDetail,
  TransactionNotFoundError,
  type TransactionSource,
} from '@/server/repositories/transactions';
import { listMoneyAccounts } from '@/server/repositories/accounts';
import {
  listRecentCategories,
  listSelectableCategories,
  type CategoryRow,
} from '@/server/repositories/categories';
import { listAttachments } from '@/server/repositories/attachments';
import { listProjects } from '@/server/repositories/projects';
import { currencyExponent, formatMinorToDecimal } from '@/server/domain/money';
import { SUPPORTED_CURRENCIES } from '@/server/services/exchange-rate-sync';
import { TransactionForm } from '@/components/transaction/transaction-form';
import { VoidButton } from '@/components/transaction/void-button';
import { AttachmentPanel } from '@/components/transaction/attachment-panel';
import type { ReactNode } from 'react';

export default async function TransactionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; id: string }>;
  searchParams: Promise<{ receiptsFailed?: string }>;
}) {
  const { orgSlug, id } = await params;
  // 新建表单在交易存好、收据却有几张没传上去时跳到这里（见 transaction-form.tsx
  // 的 finishCreate）。只认正整数，地址栏里随手改出来的别的值一律当作没有。
  const receiptsFailed = Number((await searchParams).receiptsFailed ?? '');
  const receiptsFailedNotice =
    Number.isInteger(receiptsFailed) && receiptsFailed > 0 ? receiptsFailed : null;
  const context = await requirePermission(orgSlug, 'transaction:read');
  const locale = (await getUserLocale(context.userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  let row: Awaited<ReturnType<typeof getTransactionDetail>>;
  let accounts: Awaited<ReturnType<typeof listMoneyAccounts>>;
  let incomeCategories: CategoryRow[];
  let expenseCategories: CategoryRow[];
  let attachments: Awaited<ReturnType<typeof listAttachments>>;
  let allProjects: Awaited<ReturnType<typeof listProjects>>;
  let source: TransactionSource | null;
  // 编辑表单的常用分类芯片，和新建时同一份。原来编辑页不传，表单上就剩
  // 一句「这笔钱是做什么用的？」底下什么也没有。
  let recentIncomeCategories: CategoryRow[];
  let recentExpenseCategories: CategoryRow[];

  try {
    [
      row,
      accounts,
      incomeCategories,
      expenseCategories,
      attachments,
      allProjects,
      source,
      recentIncomeCategories,
      recentExpenseCategories,
    ] = await withTransaction(context.userId, async (tx) =>
      Promise.all([
        getTransactionDetail(tx, context.organizationId, id),
        listMoneyAccounts(tx, context.organizationId),
        listSelectableCategories(tx, context.organizationId, 'income'),
        listSelectableCategories(tx, context.organizationId, 'expense'),
        listAttachments(tx, context.organizationId, { type: 'transaction', id }),
        listProjects(tx, context.organizationId),
        findTransactionSource(tx, context.organizationId, id),
        listRecentCategories(tx, context.organizationId, 'income'),
        listRecentCategories(tx, context.organizationId, 'expense'),
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
  // 与 updateTransaction / voidTransaction 里的授权是同一条判断。界面上不先判，
  // viewer（以及看别人记录的 bookkeeper）会拿到一张可编辑的表单和一个作废
  // 按钮，填完点下去才被服务端拒掉。
  const canEdit = canEditTransaction(context.role, row.createdBy === context.userId);
  const attachmentItems = attachments.map((at) => ({
    id: at.id,
    fileName: at.fileName,
    mimeType: at.mimeType,
    sizeBytes: at.sizeBytes,
  }));

  if (source && !isVoided) {
    // 单据生成的分录：只读，不给作废按钮也不给编辑表单。改动它必须回到单据
    // 那一侧（作废发票、撤销年结……），否则单据还停在「已开具 / 已付款」，
    // 明细账与总账从此对不上。updateTransaction / voidTransaction 对这类
    // 分录同样会拒（assertNotDocumentGenerated），这里不渲染是为了不让用户
    // 填完点下去才被拒。
    //
    // 这类分录常常不止两行（带税的发票是三行），所以逐行列出，而不是像下面
    // 凭证分支那样只取第一条借方与第一条贷方。
    return (
      <Layout orgSlug={orgSlug} t={t}>
        <h1>{t.common.viewDetails}</h1>
        <SourceNote orgSlug={orgSlug} source={source} t={t} />
        <p className="field-hint">{t.transaction.sourceHint}</p>
        <article className="record-detail">
          <dl>
            <dt>{t.transaction.date}</dt>
            <dd className="mono">{row.occurredOn}</dd>
            <dt>{t.transaction.amount}</dt>
            <dd className="mono amount">{formatMoney(row.amountMinor, row.currency, locale)}</dd>
            {row.lines.map((line, index) => (
              <LineEntry key={index} line={line} currency={row.currency} locale={locale} t={t} />
            ))}
            <dt>{t.transaction.description}</dt>
            <dd>{row.description || '—'}</dd>
            <dt>{t.transaction.createdBy}</dt>
            <dd>{row.createdByName}</dd>
          </dl>
        </article>
        <AttachmentPanel
          orgSlug={orgSlug}
          owner={{ type: 'transaction', id: row.id }}
          attachments={attachmentItems}
          t={t}
          readOnly={!canEdit}
        />
      </Layout>
    );
  }

  if (isVoided || (!canEdit && row.kind !== 'journal' && row.kind !== 'closing')) {
    // 已作废的交易、或者这个人无权改的收支/转账：只读展示，不可编辑
    const kindLabel =
      row.kind === 'income'
        ? t.transaction.income
        : row.kind === 'expense'
          ? t.transaction.expense
          : row.kind === 'journal'
            ? t.transaction.journal
            : row.kind === 'closing'
              ? t.yearEnd.closingEntry
              : t.transaction.transfer;

    return (
      <Layout orgSlug={orgSlug} t={t}>
        <article className={isVoided ? 'record-detail voided' : 'record-detail'}>
          <h1>{isVoided ? t.transaction.voided : t.common.viewDetails}</h1>
          {source ? <SourceNote orgSlug={orgSlug} source={source} t={t} /> : null}
          {!isVoided ? <p className="field-hint">{t.common.noEditPermission}</p> : null}
          <dl>
            {/* 作废原因原来是一条没有标签的红色横幅，贴在卡片顶上，看上去像
                表单报错。现在是卡片里有标签的第一行。 */}
            {isVoided && row.voidReason ? (
              <>
                <dt>{t.transaction.voidReasonLabel}</dt>
                <dd className="tx-void-reason">{row.voidReason}</dd>
              </>
            ) : null}
            <dt>{t.transaction.kind}</dt>
            <dd>{kindLabel}</dd>
            <dt>{t.transaction.date}</dt>
            <dd className="mono">{row.occurredOn}</dd>
            <dt>{t.transaction.amount}</dt>
            <dd className="mono amount">
              {formatMoney(row.amountMinor, row.currency, locale)}
            </dd>
            {/* 在手机上核对一笔作废的账，最想确认的就是它动了哪个账户、记在哪个分类。 */}
            <AccountRows row={row} locale={locale} t={t} />
            <dt>{t.transaction.description}</dt>
            <dd>{row.description || '\u2014'}</dd>
            <dt>{t.transaction.createdBy}</dt>
            {/* 原来这里渲染的是 created_by 的 uuid。 */}
            <dd>{row.createdByName}</dd>
          </dl>
        </article>
        {!isVoided ? (
          <AttachmentPanel
            orgSlug={orgSlug}
            owner={{ type: 'transaction', id: row.id }}
            attachments={attachmentItems}
            t={t}
            readOnly
          />
        ) : null}
      </Layout>
    );
  }

  if (row.kind === 'journal' || row.kind === 'closing') {
    // 挂起分录——"不确定"队列指向的正是这类记录，不可编辑，只能查看与
    // 作废。updateTransaction 把 kind 钉死在原值上，kind 为 journal 时
    // resolveCounterAccountId 对任何分类都会抛
    // 'Journal entries do not use categories.'，Save 必然失败。这里绝不
    // 渲染那个必败的可编辑表单，只提供确实有效的操作。
    //
    // 年结分录（kind = 'closing'）走同一条分支，理由更硬：它是一整个财年
    // 损益的结转，改动它等于悄悄改写已经定案的年度利润。要撤销只能走
    // 设置里的年结页——那条路径会连同 fiscal_year_closings 的登记一起撤掉，
    // 两边不会各说各的。updateTransaction 对它也会明确抛错。
    const debitLine = row.lines.find((line) => line.direction === 'debit');
    const creditLine = row.lines.find((line) => line.direction === 'credit');
    // 只有挂在悬置科目上的才是「不确定」队列里的那种（与 server/repositories/
    // uncertain.ts 的定义一致）。从记账凭证页录的普通凭证、年结分录原来也一律
    // 顶着「需要你决定」的标题和那段「作废后重录」的说明。
    const isSuspense = row.lines.some((line) => line.accountCode === 'suspense');
    const isClosing = row.kind === 'closing';

    return (
      <Layout orgSlug={orgSlug} t={t}>
        <h1>{isSuspense ? t.uncertain.title : isClosing ? t.yearEnd.closingEntry : t.journal.newTitle}</h1>
        {/* 「不确定」场景也走新建表单的 finishCreate，收据传失败时同样落到这里。 */}
        {receiptsFailedNotice !== null ? (
          <p role="alert" className="form-error">
            {interpolate(t.transaction.receiptsUploadFailed, { count: receiptsFailedNotice })}
          </p>
        ) : null}
        {isSuspense ? <p className="uncertain-explain">{t.uncertain.explain}</p> : null}
        <article className="record-detail">
          <dl>
            <dt>{t.transaction.kind}</dt>
            <dd>{isClosing ? t.yearEnd.closingEntry : t.transaction.journal}</dd>
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
        <AttachmentPanel
          orgSlug={orgSlug}
          owner={{ type: 'transaction', id: row.id }}
          attachments={attachmentItems}
          t={t}
          readOnly={!canEdit}
        />
        {/* 年结分录不能单独作废（voidTransaction 会拒），撤销走年结页。
            作废放在页面最底下，与编辑页一致。 */}
        {canEdit && !isClosing ? (
          <VoidButton orgSlug={orgSlug} transactionId={row.id} t={t} />
        ) : null}
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

  // 进行中的项目 + 这笔交易当前挂着的那个（它可能已经完结了——不补回去的话
  // 下拉框会落到「--」，用户只是想改个备注，保存之后项目归属被抹掉）。
  const activeProjects = allProjects.filter((project) => project.status === 'active');
  const projectOptions = (
    row.projectId && !activeProjects.some((project) => project.id === row.projectId)
      ? [...allProjects.filter((project) => project.id === row.projectId), ...activeProjects]
      : activeProjects
  ).map((project) => ({ id: project.id, name: project.name }));

  return (
    <Layout orgSlug={orgSlug} t={t}>
      <h1>{t.transaction.editTitle}</h1>
      {receiptsFailedNotice !== null ? (
        <p role="alert" className="form-error">
          {interpolate(t.transaction.receiptsUploadFailed, { count: receiptsFailedNotice })}
        </p>
      ) : null}
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
        recentIncomeCategories={recentIncomeCategories.map((c) => ({
          id: c.id,
          name_en: c.nameEn,
          name_zh: c.nameZh,
        }))}
        recentExpenseCategories={recentExpenseCategories.map((c) => ({
          id: c.id,
          name_en: c.nameEn,
          name_zh: c.nameZh,
        }))}
        currencies={currenciesList}
        projects={projectOptions}
        mode="edit"
        initialData={{
          id: row.id,
          occurredOn: row.occurredOn,
          // 原来是 (Number(row.amountMinor) / 100).toString()，两个毛病，
          // 和这个仓库反复修过的是同一类：
          //   1. 硬编码 ÷100。零小数币种（JPY/KRW/VND）没有小数位，一笔
          //      10,000 日元的交易打开编辑表单会显示成 100，用户什么都没
          //      改直接保存，账上那笔就真的变成 100 日元了。
          //   2. Number(bigint)。超过 2^53 的最小单位会静默丢精度。
          // formatMinorToDecimal 按币种的小数位还原，和保存时解析用的
          // parseDecimalToMinor 是同一把尺。
          amount: formatMinorToDecimal(row.amountMinor, currencyExponent(row.currency)),
          currency: row.currency,
          moneyAccountId: row.moneyAccountId ?? '',
          categoryId,
          projectId: row.projectId ?? null,
          counterAccountId: row.counterAccountId ?? null,
          description: row.description ?? '',
          exchangeRate: row.exchangeRate ?? '1',
          rateSource: row.rateSource,
          // 安全：journal 与 closing 都已经在上面单独 return，走到这里的
          // row.kind 只可能是 income/expense/transfer。
          kind: row.kind,
        }}
        attachments={attachmentItems}
      />
    </Layout>
  );
}

/** 单据详情页的路由。收付款没有详情页，只能落到列表。 */
function sourceHref(orgSlug: string, source: TransactionSource): string {
  switch (source.type) {
    case 'invoice':
      return `/${orgSlug}/invoices/${source.id}`;
    case 'bill':
      return `/${orgSlug}/bills/${source.id}`;
    case 'credit_note':
      return `/${orgSlug}/credit-notes/${source.id}`;
    case 'payment':
      return `/${orgSlug}/payments`;
    case 'depreciation':
    case 'asset_disposal':
      // findTransactionSource 对这两种给的就是资产 id，不是折旧计划那一行。
      return `/${orgSlug}/fixed-assets/${source.id}`;
    case 'year_end':
      return `/${orgSlug}/settings/year-end`;
  }
}

function sourceTypeLabel(t: ReturnType<typeof getMessages>, type: TransactionSource['type']): string {
  switch (type) {
    case 'invoice':
      return t.transaction.sourceInvoice;
    case 'bill':
      return t.transaction.sourceBill;
    case 'credit_note':
      return t.transaction.sourceCreditNote;
    case 'payment':
      return t.transaction.sourcePayment;
    case 'depreciation':
      return t.transaction.sourceDepreciation;
    case 'year_end':
      return t.transaction.sourceYearEnd;
    case 'asset_disposal':
      return t.transaction.sourceAssetDisposal;
  }
}

function SourceNote({
  orgSlug,
  source,
  t,
}: {
  orgSlug: string;
  source: TransactionSource;
  t: ReturnType<typeof getMessages>;
}) {
  const typeLabel = sourceTypeLabel(t, source.type);
  return (
    <p>
      {t.transaction.sourceFrom}{' '}
      <Link href={sourceHref(orgSlug, source)}>
        {source.label ? `${typeLabel} ${source.label}` : typeLabel}
      </Link>
    </p>
  );
}

/**
 * 只读卡片里「动了哪个账户」的那几行，按类型说：收支是资金账户 + 分类，
 * 转账是转出 + 转入，凭证是借方 + 贷方。转账与凭证从分录行里取——
 * 转账借记转入方、贷记转出方（server/domain/posting-templates.ts）。
 */
function AccountRows({
  row,
  locale,
  t,
}: {
  row: Awaited<ReturnType<typeof getTransactionDetail>>;
  locale: 'en' | 'zh';
  t: ReturnType<typeof getMessages>;
}) {
  const lineName = (direction: 'debit' | 'credit') => {
    const line = row.lines.find((l) => l.direction === direction);
    return line
      ? localizedName({ name_en: line.accountNameEn, name_zh: line.accountNameZh }, locale)
      : '\u2014';
  };

  if (row.kind === 'transfer') {
    return (
      <>
        <dt>{t.transaction.transferredFrom}</dt>
        <dd>{lineName('credit')}</dd>
        <dt>{t.transaction.transferredTo}</dt>
        <dd>{lineName('debit')}</dd>
      </>
    );
  }
  if (row.kind === 'journal' || row.kind === 'closing') {
    return (
      <>
        <dt>{t.journal.debitAccount}</dt>
        <dd>{lineName('debit')}</dd>
        <dt>{t.journal.creditAccount}</dt>
        <dd>{lineName('credit')}</dd>
      </>
    );
  }
  return (
    <>
      <dt>{t.settings.moneyAccount}</dt>
      <dd>
        {row.moneyAccountId
          ? localizedName(
              { name_en: row.moneyAccountNameEn, name_zh: row.moneyAccountNameZh },
              locale,
            )
          : '\u2014'}
      </dd>
      <dt>{t.transaction.category}</dt>
      <dd>
        {row.categoryId
          ? localizedName({ name_en: row.categoryNameEn, name_zh: row.categoryNameZh }, locale)
          : '\u2014'}
      </dd>
    </>
  );
}

function LineEntry({
  line,
  currency,
  locale,
  t,
}: {
  line: Awaited<ReturnType<typeof getTransactionDetail>>['lines'][number];
  currency: string;
  locale: 'en' | 'zh';
  t: ReturnType<typeof getMessages>;
}) {
  return (
    <>
      <dt>{line.direction === 'debit' ? t.reports.debit : t.reports.credit}</dt>
      <dd>
        {localizedName({ name_en: line.accountNameEn, name_zh: line.accountNameZh }, locale)}{' '}
        <span className="mono">{formatMoney(line.amountMinor, currency, locale)}</span>
      </dd>
    </>
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
      <BackLink href={`/${orgSlug}/transactions`}>{t.transaction.listTitle}</BackLink>
      {children}
    </>
  );
}
