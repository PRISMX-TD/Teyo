'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { withTransaction, type Tx } from '@/server/db/transaction';
import { requirePermission, AuthError, type OrgContext } from '@/server/auth/guard';
import { currencyExponent, parseDecimalToMinor } from '@/server/domain/money';
import { convertToBaseMinor, formatScaledRate } from '@/server/domain/exchange-rate';
import { LedgerError } from '@/server/domain/ledger';
import { resolveRate } from '@/server/posting/rate';
import {
  POSTING_ACCOUNT_CODES,
  requireAccount,
  resolvePostingAccounts,
} from '@/server/services/posting-accounts';
import { postDocument, voidDocumentPosting } from '@/server/services/document-posting';
import { recordAudit } from '@/server/repositories/audit-logs';
import {
  loadInvoicesForSettlement,
  refreshSettlementStatuses,
} from '@/server/repositories/payments';
import {
  creditNoteAmountsMinor,
  getCreditNote,
  getNextCnNumber,
  insertCreditNote,
  insertCreditNoteItems,
  deleteCreditNoteItems,
  loadTaxRateBps,
  setCreditNoteStatus,
  setCreditNoteTransactionId,
  updateCreditNote,
  type CreditNoteDetail,
  type NewCreditNoteItemRow,
} from '@/server/repositories/credit_notes';

const creditNoteItemSchema = z.object({
  description: z.string().min(1),
  quantity: z.string().optional().default('1'),
  unitPrice: z.string().optional().default('0'),
  taxRateId: z.string().uuid().nullable().optional(),
});

export type CreateCreditNoteInput = {
  invoiceId?: string | null;
  contactId: string;
  issueDate: string;
  currency?: string;
  exchangeRate?: string;
  reason?: string | null;
  notes?: string | null;
  items: z.infer<typeof creditNoteItemSchema>[];
};

export type UpdateCreditNoteInput = {
  invoiceId?: string | null;
  contactId?: string;
  issueDate?: string;
  currency?: string;
  exchangeRate?: string;
  reason?: string | null;
  notes?: string | null;
  items?: z.infer<typeof creditNoteItemSchema>[];
};

/**
 * 贷项通知单表单现在有汇率输入框了（components/credit-notes/credit-note-form.tsx
 * 接上了 RateField），与收付款同一个情况，理由见
 * server/actions/payments.ts 上同名常量的注释。
 */
const CREDIT_NOTE_MANUAL_RATE_ENTRY = 'available' as const;

/**
 * 建一张贷项通知单（草稿）。
 *
 * B2：这里原来把**原币**合计直接写进 base_amount_minor，而且另外算了一个
 * scaledRate 却一次都没用。于是一张 1,000 USD 的贷项通知单，本位币金额也是
 * 1,000——而 server/repositories/aging.ts 的客户对账单会把这个数当本位币
 * 减掉，本位币为 MYR 的公司因此少冲掉三千多令吉。
 *
 * B4：税额也在这里第一次真正被算出来。credit_note_items.tax_rate_id 这一列
 * 从 0009 起就在，但此前没有任何地方读过它——含税的贷项通知单少冲一截应收，
 * 而销项税也没有被冲回去。税额走整数 half-up，见
 * server/repositories/credit_notes.ts 的 creditNoteAmountsMinor。
 */
export async function createCreditNote(
  orgSlug: string,
  input: CreateCreditNoteInput,
): Promise<{ id: string }> {
  // B6：与收付款同一个配对——'transaction:create' 里有 bookkeeper，而 0010
  // 的 credit_notes RLS `with check` 只允许 owner/admin。已在报告里记下。
  const context = await requirePermission(orgSlug, 'transaction:create');

  if (!input.items || input.items.length === 0) {
    throw new AuthError('forbidden', 'A credit note needs at least one item.');
  }

  const items = input.items.map((item) => creditNoteItemSchema.parse(item));

  const result = await withTransaction(context.userId, async (tx) => {
    const cnNumber = await getNextCnNumber(tx, context.organizationId);
    const currency = input.currency || context.baseCurrency;

    const { scaledRate } = await resolveRate(tx, {
      currency,
      baseCurrency: context.baseCurrency,
      occurredOn: input.issueDate,
      manualRate: input.exchangeRate,
      manualRateEntry: CREDIT_NOTE_MANUAL_RATE_ENTRY,
    });

    const priced = await priceItems(tx, context, currency, items);

    const baseAmountMinor = convertToBaseMinor({
      amountMinor: priced.totals.totalMinor,
      currency,
      baseCurrency: context.baseCurrency,
      scaledRate,
    });

    const { id } = await insertCreditNote(tx, {
      organizationId: context.organizationId,
      invoiceId: input.invoiceId ?? null,
      contactId: input.contactId,
      cnNumber,
      status: 'draft',
      issueDate: input.issueDate,
      currency,
      // B7：exchange_rate 是放大 10^8 的 bigint，scaledRate 正是那个表示法。
      exchangeRate: scaledRate,
      baseAmountMinor,
      reason: input.reason?.trim() || null,
      notes: input.notes?.trim() || null,
      createdBy: context.userId,
    });

    await insertCreditNoteItems(
      tx,
      priced.rows.map((row) => ({ ...row, creditNoteId: id })),
    );

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'credit_note.created',
      entityType: 'credit_note',
      entityId: id,
      after: {
        cnNumber,
        invoiceId: input.invoiceId ?? null,
        contactId: input.contactId,
        issueDate: input.issueDate,
        currency,
        // bigint 不能直接进 JSON，统一转字符串，保持 jsonb 可查询。
        netMinor: priced.totals.netMinor.toString(),
        taxMinor: priced.totals.taxMinor.toString(),
        totalMinor: priced.totals.totalMinor.toString(),
        baseAmountMinor: baseAmountMinor.toString(),
        exchangeRate: scaledRate.toString(),
      },
    });

    return { id };
  });

  revalidatePath(`/${orgSlug}/credit-notes`);
  return result;
}

/**
 * 改一张贷项通知单。
 *
 * 只允许改草稿。已签发的单据已经进了总账，改它而不重新过账会让单据与分录
 * 各说各话；重新过账又要处理「它已经被 applied 到发票上、发票状态已经按旧
 * 金额算过」这一串连锁。拒绝比默默做对一半安全，报错也说得清该怎么办。
 *
 * 另一处修正：币种原来写的是 `input.currency ?? context.baseCurrency`——不传
 * 币种时会拿本位币的小数位去解析一张外币单据的金额。JPY 单据（exponent 0）
 * 在 MYR 公司里会被当成两位小数解析，金额差两个数量级。现在从库里读回这张
 * 单据自己的币种。
 */
export async function updateCreditNoteAction(
  orgSlug: string,
  id: string,
  input: UpdateCreditNoteInput,
): Promise<void> {
  const context = await requirePermission(orgSlug, 'transaction:create');

  await withTransaction(context.userId, async (tx) => {
    const existing = await requireCreditNote(tx, context, id);

    if (existing.status !== 'draft') {
      throw new LedgerError(
        `Credit note ${existing.cnNumber} has already been issued and cannot be edited. ` +
          'Void it and raise a new one.',
      );
    }

    const currency = input.currency ?? existing.currency;

    // 换币种而不重报明细是没有意义的：明细上存的是最小单位整数，而最小单位
    // 由币种决定（JPY 0 位、MYR 2 位）。把一张 JPY 单据改成 MYR 却沿用原来的
    // 整数，金额会静默差两个数量级。要求同时给出明细，比替用户猜一个换算安全。
    if (currency !== existing.currency && input.items === undefined) {
      throw new LedgerError(
        'Changing the currency of a credit note requires re-entering its line amounts.',
      );
    }

    const fields: Parameters<typeof updateCreditNote>[3] = {};

    if (input.invoiceId !== undefined) fields.invoiceId = input.invoiceId;
    if (input.contactId !== undefined) fields.contactId = input.contactId;
    if (input.issueDate !== undefined) fields.issueDate = input.issueDate;
    if (input.currency !== undefined) fields.currency = input.currency;
    if (input.reason !== undefined) fields.reason = input.reason?.trim() || null;
    if (input.notes !== undefined) fields.notes = input.notes?.trim() || null;

    // 币种、日期、明细、手工汇率——任何一个变了，本位币金额都得重算，而重算
    // 要先有汇率。没有任何一项变化时不碰这两列，与 repostJournal 沿用既有
    // 汇率的理由相同（见 server/posting/post-journal.ts 第 2 步的注释）：
    // 只改一句备注不该把已经记下的汇率悄悄换成今天的。
    const needsRepricing =
      input.items !== undefined ||
      input.currency !== undefined ||
      input.issueDate !== undefined ||
      input.exchangeRate !== undefined;

    if (needsRepricing) {
      const { scaledRate } = await resolveRate(tx, {
        currency,
        baseCurrency: context.baseCurrency,
        occurredOn: input.issueDate ?? existing.issueDate,
        manualRate: input.exchangeRate,
        manualRateEntry: CREDIT_NOTE_MANUAL_RATE_ENTRY,
      });

      // 明细没变时不把它们读回来再写一遍：那要把 unit_price_minor 还原成
      // 十进制字符串、再由 parseDecimalToMinor 解析回去，一趟无谓的往返，
      // 而每一次往返都是一次出错的机会。已存的明细直接拿来合计就够了。
      let totalMinor: bigint;

      if (input.items === undefined) {
        totalMinor = creditNoteAmountsMinor(existing.items).totalMinor;
      } else {
        const priced = await priceItems(
          tx,
          context,
          currency,
          input.items.map((item) => creditNoteItemSchema.parse(item)),
        );
        totalMinor = priced.totals.totalMinor;

        await deleteCreditNoteItems(tx, id);
        await insertCreditNoteItems(
          tx,
          priced.rows.map((row) => ({ ...row, creditNoteId: id })),
        );
      }

      fields.exchangeRate = scaledRate;
      fields.baseAmountMinor = convertToBaseMinor({
        amountMinor: totalMinor,
        currency,
        baseCurrency: context.baseCurrency,
        scaledRate,
      });
    }

    await updateCreditNote(tx, context.organizationId, id, fields);

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'credit_note.updated',
      entityType: 'credit_note',
      entityId: id,
      before: auditSnapshot(existing),
      after: await auditSnapshotById(tx, context, id),
    });
  });

  revalidatePath(`/${orgSlug}/credit-notes`);
  revalidatePath(`/${orgSlug}/credit-notes/${id}`);
}

/**
 * 签发一张贷项通知单：这一步才进总账。
 *
 * 为什么是签发而不是创建：草稿还没有发给客户，它在会计上什么也没发生。
 * 与发票「开出去才确认收入」是同一条线。
 *
 * 分录是发票的完全反向——借收入（净额）/ 借销项税（税额）/ 贷应收（总额），
 * 方向由 server/domain/posting-templates.ts 的 'credit-note' 模板决定，
 * 这里一行也不写。
 */
export async function issueCreditNote(
  orgSlug: string,
  id: string,
): Promise<void> {
  const context = await requirePermission(orgSlug, 'transaction:create');

  await withTransaction(context.userId, async (tx) => {
    const creditNote = await requireCreditNote(tx, context, id);

    if (creditNote.status !== 'draft') {
      // 幂等：已签发就什么也不做，而不是再过一次账。
      return;
    }

    const totals = creditNoteAmountsMinor(creditNote.items);
    if (totals.totalMinor <= 0n) {
      throw new LedgerError('Transaction amount must be greater than zero.');
    }

    const accounts = await resolvePostingAccounts(tx, context.organizationId, [
      POSTING_ACCOUNT_CODES.receivable,
      POSTING_ACCOUNT_CODES.revenue,
      POSTING_ACCOUNT_CODES.outputTax,
    ]);

    const posted = await postDocument(tx, context, {
      document: { kind: 'credit-note', id },
      event: {
        type: 'credit-note',
        receivableAccountId: requireAccount(accounts, POSTING_ACCOUNT_CODES.receivable),
        revenueAccountId: requireAccount(accounts, POSTING_ACCOUNT_CODES.revenue),
        // 税额为零时传 null：templateFor 不会出税行，也就不需要这个科目。
        taxAccountId:
          totals.taxMinor > 0n ? requireAccount(accounts, POSTING_ACCOUNT_CODES.outputTax) : null,
        netMinor: totals.netMinor,
        taxMinor: totals.taxMinor,
        amountMinor: totals.totalMinor,
      },
      occurredOn: creditNote.issueDate,
      description: `Credit note ${creditNote.cnNumber}`,
      currency: creditNote.currency,
      // 用这张单据落库时记下的那个汇率，不重新解析。单据上的本位币金额
      // （base_amount_minor）就是按它算的，重新解析会让单据与分录各记一个
      // 汇率——而用户在列表上看到的是前者。exchange_rate 列是放大 10^8 的
      // 定标整数，转回十进制字符串只走 formatScaledRate 这一处实现，
      // 它与 parseRateToScaled 精确互逆（尾零裁剪不影响 8 位以内的值）。
      //
      // 代价是这笔交易的 rate_source 会记成 'manual'，即使这张单据当初拿的
      // 是缓存汇率。两害相权：记成 'auto' 但汇率与单据对不上，比来源标错更
      // 难查——用户看到的是同一张单据在两个页面上金额不同。这一条已在报告
      // 里记下，等 transactions 上有了「沿用单据汇率」这个来源再改。
      manualRate: formatScaledRate(creditNote.exchangeRate),
      manualRateEntry: CREDIT_NOTE_MANUAL_RATE_ENTRY,
      link: (linkTx, transactionId) =>
        setCreditNoteTransactionId(linkTx, context.organizationId, id, transactionId),
    });

    await setCreditNoteStatus(tx, context.organizationId, id, 'issued');

    // 签发之后这张单据才开始冲减发票余额，发票状态要跟着变——一张 1,000 的
    // 发票收了 800、再签一张 200 的贷项通知单，它就该是收讫了。
    await refreshInvoiceStatus(tx, context, creditNote.invoiceId);

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'credit_note.issued',
      entityType: 'credit_note',
      entityId: id,
      after: {
        cnNumber: creditNote.cnNumber,
        transactionId: posted.transactionId,
        netMinor: totals.netMinor.toString(),
        taxMinor: totals.taxMinor.toString(),
        totalMinor: totals.totalMinor.toString(),
      },
    });
  });

  revalidatePath(`/${orgSlug}/credit-notes`);
  revalidatePath(`/${orgSlug}/invoices`);
  revalidatePath(`/${orgSlug}/transactions`);
}

/**
 * 把一张已签发的贷项通知单标记为「已抵扣」。
 *
 * 纯状态变更，不产生分录：应收在签发那一刻就已经被贷掉了，抵扣只是说明这
 * 张单据的去向。必须先签发——直接从草稿跳到 applied 会让一张从未进过总账
 * 的单据出现在客户对账单上。
 */
export async function applyCreditNote(
  orgSlug: string,
  id: string,
): Promise<void> {
  const context = await requirePermission(orgSlug, 'transaction:create');

  await withTransaction(context.userId, async (tx) => {
    const creditNote = await requireCreditNote(tx, context, id);

    if (creditNote.status === 'applied') return;
    if (creditNote.status !== 'issued') {
      throw new LedgerError(
        `Credit note ${creditNote.cnNumber} must be issued before it can be applied.`,
      );
    }

    await setCreditNoteStatus(tx, context.organizationId, id, 'applied');
    await refreshInvoiceStatus(tx, context, creditNote.invoiceId);

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'credit_note.applied',
      entityType: 'credit_note',
      entityId: id,
      before: { status: creditNote.status },
      after: { status: 'applied', invoiceId: creditNote.invoiceId },
    });
  });

  revalidatePath(`/${orgSlug}/credit-notes`);
  revalidatePath(`/${orgSlug}/invoices`);
}

/**
 * 作废一张贷项通知单，连带作废它的分录。
 *
 * 只作废、不删除：账本从不删行。发票状态要跟着回退，否则一张因为贷项通知单
 * 才显示「已付」的发票，会在单据作废之后继续显示已付。
 */
export async function voidCreditNote(
  orgSlug: string,
  id: string,
): Promise<void> {
  const context = await requirePermission(orgSlug, 'transaction:create');

  await withTransaction(context.userId, async (tx) => {
    const creditNote = await requireCreditNote(tx, context, id);
    if (creditNote.status === 'voided') return;

    await setCreditNoteStatus(tx, context.organizationId, id, 'voided');

    if (creditNote.transactionId !== null) {
      // voidDocumentPosting 而不是直接 markVoided：它先查期间是否封账，并
      // 写一条 transaction.voided 审计。作废一张落在已封账月份里的贷项通知单
      // 等于改动已经出过报表的那个月。
      await voidDocumentPosting(tx, context, {
        transactionId: creditNote.transactionId,
        reason: `Credit note ${creditNote.cnNumber} voided`,
      });
    }

    await refreshInvoiceStatus(tx, context, creditNote.invoiceId);

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'credit_note.voided',
      entityType: 'credit_note',
      entityId: id,
      before: auditSnapshot(creditNote),
      after: { status: 'voided', voidedTransactionId: creditNote.transactionId },
    });
  });

  revalidatePath(`/${orgSlug}/credit-notes`);
  revalidatePath(`/${orgSlug}/invoices`);
  revalidatePath(`/${orgSlug}/transactions`);
}

/**
 * 明细定价：数量 × 单价，再按行取税率。
 *
 * 数量是 numeric(12,4)，用「整数部分 × 10^4 + 小数部分」的大整数乘法算，
 * 全程不经浮点——这一段沿用既有写法，它本来就是对的。
 *
 * 税率从库里查，而不是信任入参带来的任何数字：tax_rate_id 的外键不保证那条
 * 税率属于本公司（外键不受 RLS 约束），查不到就抛错，绝不静默当成 0%——
 * 那会让一张含税的贷项通知单少冲一截应收，而且事后从数据里看不出来。
 */
async function priceItems(
  tx: Tx,
  context: OrgContext,
  currency: string,
  items: readonly z.infer<typeof creditNoteItemSchema>[],
): Promise<{
  rows: Omit<NewCreditNoteItemRow, 'creditNoteId'>[];
  totals: { netMinor: bigint; taxMinor: bigint; totalMinor: bigint };
}> {
  const exponent = currencyExponent(currency);

  const taxRateIds = items
    .map((item) => item.taxRateId ?? null)
    .filter((value): value is string => value !== null);
  const rateBpsById = await loadTaxRateBps(tx, context.organizationId, taxRateIds);

  const priced = items.map((item) => {
    const quantity = item.quantity || '1';
    const unitPriceMinor = parseDecimalToMinor(item.unitPrice || '0', exponent);

    const [whole, fraction = ''] = quantity.split('.');
    const scaledQuantity = BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, '0').slice(0, 4));
    const amountMinor = (unitPriceMinor * scaledQuantity) / 10000n;

    const taxRateId = item.taxRateId ?? null;
    if (taxRateId !== null && !rateBpsById.has(taxRateId)) {
      throw new AuthError('not_found', 'One of the tax rates on this credit note was not found.');
    }
    const taxRateBps = taxRateId === null ? 0 : (rateBpsById.get(taxRateId) as number);

    return {
      row: {
        description: item.description,
        quantity,
        unitPriceMinor,
        amountMinor,
        taxRateId,
      },
      taxRateBps,
    };
  });

  return {
    rows: priced.map((entry) => entry.row),
    totals: creditNoteAmountsMinor(
      priced.map((entry) => ({ amountMinor: entry.row.amountMinor, taxRateBps: entry.taxRateBps })),
    ),
  };
}

async function requireCreditNote(
  tx: Tx,
  context: OrgContext,
  id: string,
): Promise<CreditNoteDetail> {
  const creditNote = await getCreditNote(tx, context.organizationId, id);
  if (!creditNote) {
    throw new AuthError('not_found', 'Credit note not found.');
  }
  return creditNote;
}

/** 贷项通知单挂在哪张发票上，就把那张发票的状态重算一遍。没挂发票则不做事。 */
async function refreshInvoiceStatus(
  tx: Tx,
  context: OrgContext,
  invoiceId: string | null,
): Promise<void> {
  if (invoiceId === null) return;

  const invoices = await loadInvoicesForSettlement(tx, context.organizationId, [invoiceId]);
  await refreshSettlementStatuses(tx, context.organizationId, 'invoice', invoices);
}

function auditSnapshot(creditNote: CreditNoteDetail) {
  const totals = creditNoteAmountsMinor(creditNote.items);
  return {
    cnNumber: creditNote.cnNumber,
    status: creditNote.status,
    invoiceId: creditNote.invoiceId,
    issueDate: creditNote.issueDate,
    currency: creditNote.currency,
    exchangeRate: creditNote.exchangeRate.toString(),
    netMinor: totals.netMinor.toString(),
    taxMinor: totals.taxMinor.toString(),
    totalMinor: totals.totalMinor.toString(),
    baseAmountMinor: creditNote.baseAmountMinor.toString(),
  };
}

async function auditSnapshotById(tx: Tx, context: OrgContext, id: string) {
  const creditNote = await requireCreditNote(tx, context, id);
  return auditSnapshot(creditNote);
}
