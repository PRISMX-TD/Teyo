'use server';

import { revalidatePath } from 'next/cache';
import { withTransaction, type Tx } from '@/server/db/transaction';
import { requirePermission, AuthError, type OrgContext } from '@/server/auth/guard';
import { LedgerError } from '@/server/domain/ledger';
import { currencyExponent, parseDecimalToMinor, sumMinor } from '@/server/domain/money';
import {
  billPostingEvent,
  parseTaxRateBps,
  postDocument,
  repostDocument,
  resolveBillAccounts,
  resolveDocumentCurrency,
  taxMinorFor,
  voidDocumentPosting,
  withDocumentNumberRetry,
  type DocumentAmounts,
} from '@/server/services/document-posting';
import { recordAudit } from '@/server/repositories/audit-logs';
import {
  deleteBillItems,
  getBill,
  getNextBillNumber,
  insertBill,
  insertBillItems,
  markBillVoided,
  setBillStatus,
  setBillTransactionId,
  updateBill as updateBillRow,
  type BillDetail,
  type NewBillItemRow,
} from '@/server/repositories/bills';

/**
 * 供应商账单的记账生命周期。
 *
 * 与发票一样，这个模块此前一条 journal_lines 都不产生：应付账款在总账里
 * 结构性地永远为零，而应付账龄表上却挂着要付给供应商的钱。
 *
 * 与发票不同的一点是过账时机。发票默认建成 draft（还没发给客户的底稿，
 * 收入尚未确认），账单默认建成 'received'——这个词本身的意思就是「供应商
 * 的账单已经收到了」，也就是这笔负债已经成立，费用已经发生。权责发生制下
 * 这一刻就该入账，所以 createBill 直接过账，不需要另一个「确认」动作。
 *
 * 想先存个底稿的，传 status: 'draft'，那一支不过账，事后调 receiveBill
 * 再入账——与 issueInvoice 对称。
 */

type BillItemInput = {
  description: string;
  amount: string;
};

export type CreateBillInput = {
  contactId: string;
  issueDate: string;
  dueDate: string;
  /** 省略即本位币。理由见 server/actions/invoices.ts 上的同名字段。 */
  currency?: string;
  /**
   * 税率（百分数字符串）。bills 直到 0021 才有 subtotal_minor / tax_rate_bps /
   * tax_minor 三列——此前一张含 6% SST 的账单，税额只能并进费用科目，
   * repositories/tax.ts 里那句 `0::bigint as tax_minor`（进项恒为 0）就是
   * 这个缺列的直接后果。明细里填的是含税前的净额，税按整单算。
   */
  taxRatePercent?: string;
  /**
   * 用户选中的那条 tax_rates 记录。
   *
   * 与 taxRatePercent 是两件事：后者是税率**数值**，落进 tax_rate_bps 并决定
   * 算出多少税；这个是「他选的是哪一条税率」。两者都要存，因为税率记录会
   * 被改名、被停用、税率本身也会调整（SST 从 6% 调到 8% 时，历史账单上的
   * 6% 必须留在 tax_rate_bps 里不动，而「当初选的是标准税率这一条」只有
   * 这个 id 说得出来）。
   *
   * 此前这一列恒为 null——不是因为它没用，是因为界面上还没有税率选择器，
   * 所以服务端拿不到。现在有了。
   */
  taxRateId?: string | null;
  notes?: string;
  items: BillItemInput[];
  /** 默认 'received'（已收到，直接入账）。'draft' 只存底稿，不进总账。 */
  status?: 'draft' | 'received';
};

export type UpdateBillInput = CreateBillInput;

/**
 * 一张账单的三个数。与发票同一套整数 + half-up 口径
 * （见 document-posting.ts 的 mulDivHalfUp）——同一笔钱在这个项目里
 * 只能有一种舍入规则。
 *
 * 账单明细没有单价与数量，只有一个金额，所以这里不需要 lineAmountMinor。
 */
function computeBillAmounts(
  input: { currency: string; taxRatePercent?: string; items: BillItemInput[] },
): {
  taxRateBps: number;
  amounts: DocumentAmounts;
  items: Omit<NewBillItemRow, 'billId'>[];
} {
  const exponent = currencyExponent(input.currency);
  const taxRateBps = parseTaxRateBps(input.taxRatePercent);

  const items = input.items.map((item) => ({
    description: item.description,
    amountMinor: parseDecimalToMinor((item.amount ?? '').trim() || '0', exponent),
  }));

  const subtotalMinor = sumMinor(items.map((item) => item.amountMinor));
  const taxMinor = taxMinorFor(subtotalMinor, taxRateBps);

  return {
    taxRateBps,
    // 与发票同理：总额只有一个来源，因为 0021 的 CHECK
    // （total_minor = subtotal_minor + tax_minor）与 assertTaxSplit
    // 查的是同一条等式。
    amounts: { subtotalMinor, taxMinor, totalMinor: subtotalMinor + taxMinor },
    items,
  };
}

function billDescription(billNumber: string): string {
  return `Bill ${billNumber}`;
}

/** 把一张账单过账。创建、确认收到、编辑三条路径共用同一份事件构造。 */
async function postBill(
  tx: Tx,
  context: OrgContext,
  bill: {
    id: string;
    billNumber: string;
    issueDate: string;
    currency: string;
    amounts: DocumentAmounts;
  },
): Promise<string> {
  const accounts = await resolveBillAccounts(
    tx,
    context.organizationId,
    bill.amounts.taxMinor > 0n,
  );

  const posted = await postDocument(tx, context, {
    document: { kind: 'bill', id: bill.id },
    event: billPostingEvent(accounts, bill.amounts),
    occurredOn: bill.issueDate,
    description: billDescription(bill.billNumber),
    currency: bill.currency,
    // 账单表单上同样没有汇率输入框。见 server/posting/rate.ts。
    manualRateEntry: 'unavailable',
    link: (linkTx, transactionId) =>
      setBillTransactionId(linkTx, context.organizationId, bill.id, transactionId),
  });

  return posted.transactionId;
}

/** 审计快照。bigint 转字符串，理由同 invoices.ts。 */
function billSnapshot(bill: {
  billNumber: string | null;
  status: string;
  contactId: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  taxRateBps: number;
  amounts: DocumentAmounts;
  transactionId?: string | null;
}) {
  return {
    billNumber: bill.billNumber,
    status: bill.status,
    contactId: bill.contactId,
    issueDate: bill.issueDate,
    dueDate: bill.dueDate,
    currency: bill.currency,
    taxRateBps: bill.taxRateBps,
    subtotalMinor: bill.amounts.subtotalMinor.toString(),
    taxMinor: bill.amounts.taxMinor.toString(),
    totalMinor: bill.amounts.totalMinor.toString(),
    transactionId: bill.transactionId ?? null,
  };
}

/**
 * 断言这条税率记录属于本公司。
 *
 * bills.tax_rate_id -> tax_rates(id) 这条外键只保证那一行存在，**不检查它
 * 属于哪家公司**，而 RLS 不对外键校验生效——与 server/posting/insert.ts 里
 * assertAccountsBelongToOrg 和 assertProjectBelongsToOrg 堵的是同一类洞。
 * taxRateId 是从表单来的，而「下拉里只列出本公司的税率」是一句约定，
 * 不是结构性保证。
 *
 * 已停用的税率仍然允许引用：停用只影响它出不出现在选择器里，不该让一张
 * 补录的旧账单因为当初那条税率后来被停用而存不下去。
 */
async function assertTaxRateBelongsToOrg(
  tx: Tx,
  organizationId: string,
  taxRateId: string | null | undefined,
): Promise<void> {
  if (!taxRateId) return;
  const rows = await tx`
    select 1 from tax_rates where id = ${taxRateId} and organization_id = ${organizationId}
  `;
  if (rows.length === 0) {
    throw new AuthError('not_found', 'That tax rate was not found in this company.');
  }
}

function amountsOf(bill: BillDetail): DocumentAmounts {
  return {
    subtotalMinor: bill.subtotalMinor,
    taxMinor: bill.taxMinor,
    totalMinor: bill.totalMinor,
  };
}

/**
 * 创建账单。默认 'received'，同一个事务里过账。
 *
 * 权限用 transaction:create 而不是原来的 transaction:read——理由与
 * createInvoice 相同：transaction:read 连 viewer 都有，用只读权限守卫写操作。
 */
export async function createBill(
  orgSlug: string,
  input: CreateBillInput,
): Promise<{ id: string; transactionId: string | null }> {
  const context = await requirePermission(orgSlug, 'transaction:create');

  if (!input.items || input.items.length === 0) {
    throw new AuthError('forbidden', 'A bill needs at least one item.');
  }

  const currency = resolveDocumentCurrency(input.currency, context.baseCurrency);
  const status = input.status ?? 'received';

  // 单号是「读最大号 + 1」，两个并发创建会算出同一个号。冲突时整笔重来——
  // 失败的那一次已经整体回滚，一个字节都没写，重跑会读到新的最大号。
  // 为什么不是行锁，见 withDocumentNumberRetry 的注释。
  const result = await withDocumentNumberRetry('bills_org_number', () =>
    withTransaction(context.userId, async (tx) => {
      const billNumber = await getNextBillNumber(tx, context.organizationId);
      await assertTaxRateBelongsToOrg(tx, context.organizationId, input.taxRateId);
      const { taxRateBps, amounts, items } = computeBillAmounts({ ...input, currency });

      const { id } = await insertBill(tx, {
        organizationId: context.organizationId,
        contactId: input.contactId,
        billNumber,
        status,
        issueDate: input.issueDate,
        dueDate: input.dueDate,
        currency,
        subtotalMinor: amounts.subtotalMinor,
        taxRateBps,
        taxMinor: amounts.taxMinor,
        totalMinor: amounts.totalMinor,
        taxRateId: input.taxRateId ?? null,
        notes: input.notes?.trim() || null,
      });

      await insertBillItems(
        tx,
        items.map((item) => ({ ...item, billId: id })),
      );

      const transactionId =
        status === 'received'
          ? await postBill(tx, context, {
              id,
              billNumber,
              issueDate: input.issueDate,
              currency,
              amounts,
            })
          : null;

      await recordAudit(tx, {
        organizationId: context.organizationId,
        actorUserId: context.userId,
        action: 'bill.created',
        entityType: 'bill',
        entityId: id,
        after: billSnapshot({
          billNumber,
          status,
          contactId: input.contactId,
          issueDate: input.issueDate,
          dueDate: input.dueDate,
          currency,
          taxRateBps,
          amounts,
          transactionId,
        }),
      });

      return { id, transactionId };
    }),
  );

  revalidateBillPaths(orgSlug, result.transactionId !== null);
  return result;
}

/**
 * 把一张草稿账单确认为已收到：draft -> received，同时进总账。
 * 与 issueInvoice 对称，存在的理由也相同——否则 'draft' 这个状态是个死胡同。
 */
export async function receiveBill(
  orgSlug: string,
  id: string,
): Promise<{ transactionId: string }> {
  const context = await requirePermission(orgSlug, 'transaction:create');

  const result = await withTransaction(context.userId, async (tx) => {
    const bill = await requireBill(tx, context, id);

    if (bill.status === 'voided' || bill.voidedAt) {
      throw new AuthError('forbidden', 'This bill is voided and can no longer be received.');
    }
    if (bill.transactionId) {
      throw new AuthError('forbidden', 'This bill has already been posted.');
    }
    if (bill.status !== 'draft') {
      throw new AuthError('forbidden', `A bill in status ${bill.status} cannot be received.`);
    }
    if (!bill.billNumber) {
      // bills.bill_number 允许为 null（唯一约束是 (organization_id, bill_number)，
      // 而 null 在 Postgres 里不参与唯一性）。分录摘要必须说得出是哪张账单，
      // 所以这里拦下来而不是记一条 "Bill null"。
      throw new AuthError('forbidden', 'This bill needs a bill number before it can be posted.');
    }

    const amounts = amountsOf(bill);
    const transactionId = await postBill(tx, context, {
      id: bill.id,
      billNumber: bill.billNumber,
      issueDate: bill.issueDate,
      currency: bill.currency,
      amounts,
    });

    await setBillStatus(tx, context.organizationId, id, 'received');

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'bill.received',
      entityType: 'bill',
      entityId: id,
      before: { status: bill.status, transactionId: null },
      after: { status: 'received', transactionId },
    });

    return { transactionId };
  });

  revalidateBillPaths(orgSlug, true);
  return result;
}

/**
 * 编辑一张账单。已过账的走 repostJournal 整体重建分录，理由见
 * server/services/document-posting.ts 的 repostDocument。
 */
export async function updateBill(
  orgSlug: string,
  id: string,
  input: UpdateBillInput,
): Promise<void> {
  const context = await requirePermission(orgSlug, 'transaction:edit:any');

  if (!input.items || input.items.length === 0) {
    throw new AuthError('forbidden', 'A bill needs at least one item.');
  }

  const currency = resolveDocumentCurrency(input.currency, context.baseCurrency);

  const posted = await withTransaction(context.userId, async (tx) => {
    const existing = await requireBill(tx, context, id);

    if (existing.status === 'voided' || existing.voidedAt) {
      throw new AuthError('forbidden', 'This bill is voided and can no longer be edited.');
    }

    await assertTaxRateBelongsToOrg(tx, context.organizationId, input.taxRateId);
    const { taxRateBps, amounts, items } = computeBillAmounts({ ...input, currency });

    await updateBillRow(tx, context.organizationId, id, {
      contactId: input.contactId,
      issueDate: input.issueDate,
      dueDate: input.dueDate,
      currency,
      subtotalMinor: amounts.subtotalMinor,
      taxRateBps,
      taxMinor: amounts.taxMinor,
      totalMinor: amounts.totalMinor,
      // 编辑时这一列原来根本没传，于是改税率只会改掉税率数值，
      // 「选的是哪一条税率记录」永远停在创建时的那个值。
      taxRateId: input.taxRateId ?? null,
      notes: input.notes?.trim() || null,
    });

    // 明细整体替换，理由同发票：账单行没有稳定的业务主键，逐行匹配只能靠猜。
    await deleteBillItems(tx, id);
    await insertBillItems(
      tx,
      items.map((item) => ({ ...item, billId: id })),
    );

    if (existing.transactionId) {
      const accounts = await resolveBillAccounts(
        tx,
        context.organizationId,
        amounts.taxMinor > 0n,
      );
      await repostDocument(tx, context, {
        transactionId: existing.transactionId,
        event: billPostingEvent(accounts, amounts),
        occurredOn: input.issueDate,
        description: billDescription(existing.billNumber ?? id),
        currency,
        manualRateEntry: 'unavailable',
      });
    }

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'bill.updated',
      entityType: 'bill',
      entityId: id,
      before: billSnapshot({
        billNumber: existing.billNumber,
        status: existing.status,
        contactId: existing.contactId,
        issueDate: existing.issueDate,
        dueDate: existing.dueDate,
        currency: existing.currency,
        taxRateBps: existing.taxRateBps,
        amounts: amountsOf(existing),
        transactionId: existing.transactionId,
      }),
      after: billSnapshot({
        billNumber: existing.billNumber,
        status: existing.status,
        contactId: input.contactId,
        issueDate: input.issueDate,
        dueDate: input.dueDate,
        currency,
        taxRateBps,
        amounts,
        transactionId: existing.transactionId,
      }),
    });

    return existing.transactionId !== null;
  });

  revalidateBillPaths(orgSlug, posted);
  revalidatePath(`/${orgSlug}/bills/${id}`);
}

/**
 * 作废账单，连带作废它那笔分录。理由与 voidInvoice 逐条对应：
 * voided_at 必须写（列表与税务报表读的是它，不是 status）、对应的交易必须
 * 一起作废（否则总账上留着一笔永远不用付的应付）、理由必填（数据库的
 * transactions_void_fields_together 要求三个字段同时存在且理由非空白）。
 */
export async function voidBill(
  orgSlug: string,
  id: string,
  reason: string,
): Promise<void> {
  const cleanReason = reason.trim();
  if (cleanReason === '') {
    throw new LedgerError('Voiding a record needs a reason.');
  }

  const context = await requirePermission(orgSlug, 'transaction:edit:any');

  const hadTransaction = await withTransaction(context.userId, async (tx) => {
    const bill = await requireBill(tx, context, id);

    if (bill.status === 'voided' || bill.voidedAt) {
      throw new AuthError('forbidden', 'This bill is already voided.');
    }

    // 先作废分录：那一步会查期间锁定，封账月份的账单必须在任何写入之前
    // 就被拦下，而不是写了单据再靠回滚擦干净。
    if (bill.transactionId) {
      await voidDocumentPosting(tx, context, {
        transactionId: bill.transactionId,
        reason: cleanReason,
      });
    }

    await markBillVoided(tx, context.organizationId, id);

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'bill.voided',
      entityType: 'bill',
      entityId: id,
      before: { status: bill.status, voidedAt: null },
      after: {
        status: 'voided',
        voidedAt: new Date().toISOString(),
        voidReason: cleanReason,
        transactionId: bill.transactionId,
      },
    });

    return bill.transactionId !== null;
  });

  revalidateBillPaths(orgSlug, hadTransaction);
  revalidatePath(`/${orgSlug}/bills/${id}`);
}

/** 取不到就抛 not_found。理由见 invoices.ts 的 requireInvoice。 */
async function requireBill(tx: Tx, context: OrgContext, id: string): Promise<BillDetail> {
  const bill = await getBill(tx, context.organizationId, id);
  if (!bill) {
    throw new AuthError('not_found', 'This bill was not found in this company.');
  }
  return bill;
}

/**
 * 账单过账之后要刷新的页面。只刷 /bills 是不够的：一张入账的账单会改变
 * 总账，交易列表、报表与首页看板上的数字全都变了。
 */
function revalidateBillPaths(orgSlug: string, posted: boolean): void {
  revalidatePath(`/${orgSlug}/bills`);
  if (!posted) return;
  revalidatePath(`/${orgSlug}`);
  revalidatePath(`/${orgSlug}/transactions`);
  revalidatePath(`/${orgSlug}/reports`);
}
