'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
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
  findActiveBillForPurchaseOrder,
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
import {
  setSettlementStatus,
  settlementStatusFor,
  sumSettledByDocument,
} from '@/server/repositories/payments';
import {
  PO_BILLABLE_STATUSES,
  isPoBillable,
  lockPurchaseOrder,
  setPoStatus,
  type PoStatus,
} from '@/server/repositories/purchase-orders';

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
  /**
   * 从哪张采购单转来（采购单详情页的「转为账单」-> bills/new?fromPo=<id>）。
   *
   * 账单号由 getNextBillNumber 生成、到期日要用户照供应商的账单填，所以
   * 「转账单」不是一个一步到位的按钮，而是一张按采购单预填好的新建表单，
   * 提交时带上这个 id。服务端在建账单的同一个事务里核对这张采购单、写
   * bills.purchase_order_id、把采购单推到 billed——过账走的仍是下面同一条
   * createBill 路径，与手工录入的账单分毫不差。
   */
  purchaseOrderId?: string | null;
};

/** 编辑不改来源采购单：转出来的账单作废后重转，而不是把链接改到别处。 */
export type UpdateBillInput = Omit<CreateBillInput, 'purchaseOrderId'>;

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

/**
 * 核对一张采购单此刻能不能转成这张账单，并锁住它的表头。
 *
 * 逐条：
 * - 必须是本公司的（外键不受 RLS 约束，id 又是从表单来的）；
 * - 状态必须是 sent / received（isPoBillable）——草稿还没发给供应商，
 *   billed 已经转过，closed / voided 是终态；
 * - 名下不能已有一张未作废的账单。状态是 billed 时上一条已经挡下，这一条
 *   兜的是状态与链接不一致的情形；
 * - 供应商与币种必须与采购单一致。表单上这两个下拉在转账单时是锁住的，
 *   但 Server Action 是网络端点，一张 USD 的采购单转出一张 MYR 的账单，
 *   金额就全错了。明细行可以改（分批到货、只开了一部分账单都是常事）。
 */
async function assertPurchaseOrderBillable(
  tx: Tx,
  organizationId: string,
  purchaseOrderId: string,
  bill: { contactId: string; currency: string },
): Promise<{ poNumber: string; status: PoStatus }> {
  const po = await lockPurchaseOrder(tx, organizationId, purchaseOrderId);
  if (!po) {
    throw new AuthError('not_found', 'That purchase order was not found in this company.');
  }
  if (!isPoBillable(po.status)) {
    throw new LedgerError(
      `Purchase order ${po.poNumber} is ${po.status}; only a purchase order that is ` +
        `${PO_BILLABLE_STATUSES.join(' or ')} can be converted into a bill.`,
    );
  }
  const existing = await findActiveBillForPurchaseOrder(tx, organizationId, purchaseOrderId);
  if (existing) {
    throw new LedgerError(
      `Purchase order ${po.poNumber} has already been converted into bill ` +
        `${existing.billNumber ?? existing.id}. Void that bill first to bill it again.`,
    );
  }
  if (po.contactId !== bill.contactId) {
    throw new LedgerError(
      `A bill converted from ${po.poNumber} must be for the same vendor as the purchase order.`,
    );
  }
  if (po.currency !== bill.currency) {
    throw new LedgerError(
      `A bill converted from ${po.poNumber} must be in ${po.currency}, the purchase order's currency.`,
    );
  }
  return { poNumber: po.poNumber, status: po.status };
}

/**
 * 采购单转账单之前是什么状态。
 *
 * 转账单时 purchase_order.billed 那条审计记下了 before.status，作废账单时
 * 照它还原——sent 的回到 sent，received 的回到 received，不替用户臆造一个
 * 「已收货」。voidBill 要 transaction:edit:any（owner/admin），正是
 * audit_logs 的 RLS 允许读的那两个角色；万一读不到，退回 sent：采购单状态
 * 只能往前走，从 sent 还能再标成 received，反过来就回不去了。
 */
async function statusBeforeBilling(
  tx: Tx,
  organizationId: string,
  purchaseOrderId: string,
): Promise<PoStatus> {
  const rows = await tx`
    select before->>'status' as status
    from audit_logs
    where organization_id = ${organizationId}
      and entity_type = 'purchase_order'
      and entity_id = ${purchaseOrderId}
      and action = 'purchase_order.billed'
    order by created_at desc
    limit 1
  `;
  const status = rows.at(0)?.status as PoStatus | null | undefined;
  return status && isPoBillable(status) ? status : 'sent';
}

/**
 * 转出来的账单被作废之后，让采购单可以再转一次。
 *
 * 只在采购单仍是 billed 时还原：已经关单或作废的采购单是终态，不因为一张
 * 账单作废就被重新打开。名下若还有另一张未作废的账单（转换时就挡掉了，
 * 理论上不会有），也不动。这里直接调 setPoStatus 而不是 setPoStatusAction：
 * 后者的状态只许往前走，而「账单作废、采购单退回待开账单」是唯一一条合法
 * 的回退，它属于账单作废这件事本身，不是用户手里的一个状态按钮。
 *
 * bills.purchase_order_id 不清：作废的那张确实是从这张采购单转出来的，
 * 审计上要查得到。「已经转过」的判断（findActiveBillForPurchaseOrder）
 * 本来就不认作废的账单。
 */
async function reopenPurchaseOrderAfterBillVoid(
  tx: Tx,
  context: OrgContext,
  purchaseOrderId: string,
  billId: string,
): Promise<void> {
  const po = await lockPurchaseOrder(tx, context.organizationId, purchaseOrderId);
  if (!po || po.status !== 'billed') return;

  const other = await findActiveBillForPurchaseOrder(tx, context.organizationId, purchaseOrderId);
  if (other) return;

  const restored = await statusBeforeBilling(tx, context.organizationId, purchaseOrderId);
  await setPoStatus(tx, context.organizationId, purchaseOrderId, restored);

  await recordAudit(tx, {
    organizationId: context.organizationId,
    actorUserId: context.userId,
    action: 'purchase_order.reopened',
    entityType: 'purchase_order',
    entityId: purchaseOrderId,
    before: { status: po.status },
    after: { status: restored, voidedBillId: billId },
  });
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
  const purchaseOrderId =
    input.purchaseOrderId == null || input.purchaseOrderId === ''
      ? null
      : z.string().uuid().parse(input.purchaseOrderId);

  // 单号是「读最大号 + 1」，两个并发创建会算出同一个号。冲突时整笔重来——
  // 失败的那一次已经整体回滚，一个字节都没写，重跑会读到新的最大号。
  // 为什么不是行锁，见 withDocumentNumberRetry 的注释。
  const result = await withDocumentNumberRetry('bills_org_number', () =>
    withTransaction(context.userId, async (tx) => {
      const billNumber = await getNextBillNumber(tx, context.organizationId);
      await assertTaxRateBelongsToOrg(tx, context.organizationId, input.taxRateId);
      // 先核对采购单再写任何东西：被拒的转换不该留下半张账单。
      const sourcePo = purchaseOrderId
        ? await assertPurchaseOrderBillable(tx, context.organizationId, purchaseOrderId, {
            contactId: input.contactId,
            currency,
          })
        : null;
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
        purchaseOrderId,
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

      if (purchaseOrderId && sourcePo) {
        await setPoStatus(tx, context.organizationId, purchaseOrderId, 'billed');
        // before.status 是作废账单时还原采购单状态的依据，见 statusBeforeBilling。
        await recordAudit(tx, {
          organizationId: context.organizationId,
          actorUserId: context.userId,
          action: 'purchase_order.billed',
          entityType: 'purchase_order',
          entityId: purchaseOrderId,
          before: { status: sourcePo.status },
          after: { status: 'billed', billId: id, billNumber },
        });
      }

      return { id, transactionId };
    }),
  );

  revalidateBillPaths(orgSlug, result.transactionId !== null);
  if (purchaseOrderId) revalidatePurchaseOrderPaths(orgSlug, purchaseOrderId);
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

    // 从采购单转来的账单，供应商与币种跟着采购单走，理由见
    // assertPurchaseOrderBillable。要换就作废这张、改了采购单再转。
    if (
      existing.purchaseOrderId &&
      (input.contactId !== existing.contactId || currency !== existing.currency)
    ) {
      throw new LedgerError(
        `This bill was converted from purchase order ${existing.purchaseOrderNumber ?? ''}; ` +
          'its vendor and currency follow the purchase order.',
      );
    }

    await assertTaxRateBelongsToOrg(tx, context.organizationId, input.taxRateId);
    const { taxRateBps, amounts, items } = computeBillAmounts({ ...input, currency });

    // 已经付过款的账单：付款核销的是原币金额，换币种之后那几笔付款的数就
    // 对不上这张账单了；把总额改到已付金额之下，则会留下一笔永远冲不掉的
    // 多付——应付科目变成借方余额，而账单状态照样显示「已付清」。两种都
    // 当场拒绝，要改就先作废那几笔付款。
    const settled =
      (await sumSettledByDocument(tx, context.organizationId, 'bill', [id])).get(id) ?? 0n;
    if (settled > 0n) {
      if (currency !== existing.currency) {
        throw new LedgerError(
          'This bill already has payments against it, so its currency cannot be changed. ' +
            'Void those payments first.',
        );
      }
      if (amounts.totalMinor < settled) {
        throw new LedgerError(
          'The new total is less than what has already been paid on this bill. ' +
            'Void or reduce those payments first.',
        );
      }
    }

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

    // 总额变了，「已付清 / 部分付款 / 未付」也可能跟着变：一张付清的账单
    // 加了一行，就不再是付清的了。与收付款那一侧共用同一个推导。
    const nextStatus = settlementStatusFor({
      kind: 'bill',
      currentStatus: existing.status,
      totalMinor: amounts.totalMinor,
      settledMinor: settled,
    });
    if (nextStatus !== null) {
      await setSettlementStatus(tx, context.organizationId, 'bill', id, nextStatus);
    }

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

  const voided = await withTransaction(context.userId, async (tx) => {
    const bill = await requireBill(tx, context, id);

    if (bill.status === 'voided' || bill.voidedAt) {
      throw new AuthError('forbidden', 'This bill is already voided.');
    }

    // 还挂着有效付款的账单不能直接作废：账单的分录作废了，付款那笔「借应付
    // / 贷银行」还在，应付科目上就剩一个对不上任何账单的借方余额。先作废
    // 付款，再作废账单。
    const settled =
      (await sumSettledByDocument(tx, context.organizationId, 'bill', [id])).get(id) ?? 0n;
    if (settled > 0n) {
      throw new LedgerError(
        'This bill has payments against it. Void those payments before voiding the bill.',
      );
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

    if (bill.purchaseOrderId) {
      await reopenPurchaseOrderAfterBillVoid(tx, context, bill.purchaseOrderId, id);
    }

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

    return { posted: bill.transactionId !== null, purchaseOrderId: bill.purchaseOrderId };
  });

  revalidateBillPaths(orgSlug, voided.posted);
  revalidatePath(`/${orgSlug}/bills/${id}`);
  if (voided.purchaseOrderId) revalidatePurchaseOrderPaths(orgSlug, voided.purchaseOrderId);
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

/** 转账单与作废转出的账单都会改采购单状态。路由段叫 purchase-orders。 */
function revalidatePurchaseOrderPaths(orgSlug: string, purchaseOrderId: string): void {
  revalidatePath(`/${orgSlug}/purchase-orders`);
  revalidatePath(`/${orgSlug}/purchase-orders/${purchaseOrderId}`);
}
