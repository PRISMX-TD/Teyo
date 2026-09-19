'use server';

import { revalidatePath } from 'next/cache';
import { withTransaction, type Tx } from '@/server/db/transaction';
import { requirePermission, AuthError, type OrgContext } from '@/server/auth/guard';
import { LedgerError } from '@/server/domain/ledger';
import { currencyExponent, parseDecimalToMinor, sumMinor } from '@/server/domain/money';
import {
  invoicePostingEvent,
  lineAmountMinor,
  parseTaxRateBps,
  postDocument,
  repostDocument,
  resolveDocumentCurrency,
  resolveInvoiceAccounts,
  taxMinorFor,
  voidDocumentPosting,
  withDocumentNumberRetry,
  type DocumentAmounts,
} from '@/server/services/document-posting';
import { recordAudit } from '@/server/repositories/audit-logs';
import {
  deleteInvoiceItems,
  getInvoice,
  getNextInvoiceNumber,
  insertInvoice,
  insertInvoiceItems,
  markInvoiceVoided,
  setInvoiceStatus,
  setInvoiceTransactionId,
  updateInvoice as updateInvoiceRow,
  type InvoiceDetail,
  type NewInvoiceItemRow,
} from '@/server/repositories/invoices';

/**
 * 发票的记账生命周期。
 *
 * 这个文件开头原来写着「不自动创建交易——发票独立于收款，收款另记收入分录」。
 * 那句话描述的正是本项目最大的缺陷：发票不产生分录，于是应收账款在总账里
 * 结构性地永远为零，而同一个产品的应收账龄表却显示着客户欠着这笔钱。两个
 * 页面读同一套数据、互相否认对方。invoices.transaction_id 这一列从 0008
 * 起就在那儿，从来没有被写入过。
 *
 * 现在的规则只有一条，写在这里以免下次又被当成「独立于收款」：
 *
 *   草稿不进总账，开具之后才进。
 *
 * 为什么不是「一创建就过账」：draft 状态的发票是还没发给客户的底稿，金额、
 * 客户、明细都可能再改几轮。收入确认的时点是开具（发出去）那一刻，不是
 * 起草那一刻。把草稿记进总账，等于每敲一次键盘就动一次收入与应收——而
 * 作废一张从未发出的草稿还要在总账上留一笔冲销。
 *
 * 为什么不是「收款时才记收入」：那是收付实现制。本项目是复式记账的权责
 * 发生制产品（资产负债表上有应收账款这一行就是这个意思），收入在开票时
 * 确认，收款只是应收换成现金——见 posting-templates.ts 里 customer-receipt
 * 那一支：借资金账户 / 贷应收，一分钱收入都不产生。
 *
 * createInvoice 默认仍然建草稿（既有 UI 的行为没变），issue: true 或者
 * 事后调 issueInvoice 才过账。
 */

type InvoiceItemInput = {
  description: string;
  quantity: string;
  unitPrice: string;
};

export type CreateInvoiceInput = {
  contactId: string;
  issueDate: string;
  dueDate: string;
  /**
   * 省略即本位币。原来这里是必填，而表单硬写 'USD'，数据库列也 default 'USD'
   * ——这是给马来西亚商户做的产品，本位币通常是 MYR。0021 把那个默认值删掉了，
   * 缺省币种从此由这里给。
   */
  currency?: string;
  taxRatePercent?: string;
  notes?: string;
  items: InvoiceItemInput[];
  /** true = 创建即开具，直接进总账。默认 false（建草稿）。 */
  issue?: boolean;
};

export type UpdateInvoiceInput = CreateInvoiceInput;

/**
 * 一张发票的三个数：净额、税额、总额，外加每一行明细。
 *
 * 全部走整数 + half-up（见 document-posting.ts 的 mulDivHalfUp）。原来这里
 * 有两处向零截断（行金额与税额）和一处浮点税率解析，三处都会让发票总额与
 * 客户自己算出来的数差一到几分，而分录仍然配平——没有任何一道校验看得出来。
 */
function computeInvoiceAmounts(
  input: { currency: string; taxRatePercent?: string; items: InvoiceItemInput[] },
): {
  taxRateBps: number;
  amounts: DocumentAmounts;
  items: Omit<NewInvoiceItemRow, 'invoiceId'>[];
} {
  const exponent = currencyExponent(input.currency);
  const taxRateBps = parseTaxRateBps(input.taxRatePercent);

  const items = input.items.map((item) => {
    const quantity = (item.quantity ?? '').trim() || '1';
    const unitPriceMinor = parseDecimalToMinor((item.unitPrice ?? '').trim() || '0', exponent);
    return {
      description: item.description,
      quantity,
      unitPriceMinor,
      amountMinor: lineAmountMinor(unitPriceMinor, quantity),
    };
  });

  const subtotalMinor = sumMinor(items.map((item) => item.amountMinor));
  const taxMinor = taxMinorFor(subtotalMinor, taxRateBps);

  return {
    taxRateBps,
    // totalMinor 由这两个数相加得出，而不是另算一遍：0021 给 invoices 加了
    // `total_minor = subtotal_minor + tax_minor` 的 CHECK，而 PostingEvent
    // 那边 assertTaxSplit 查的是同一条等式。两处算法只要有一处独立算，
    // 就有可能对不上——让它只有一个来源。
    amounts: { subtotalMinor, taxMinor, totalMinor: subtotalMinor + taxMinor },
    items,
  };
}

/** 分录摘要。日后翻总账的人要能认出这一笔是哪张发票来的。 */
function invoiceDescription(invoiceNumber: string): string {
  return `Invoice ${invoiceNumber}`;
}

/**
 * 把一张发票过账。创建、开具、编辑三条路径共用同一份事件构造，
 * 避免三处各写一遍「净额挂收入、税额挂销项税」。
 */
async function postInvoice(
  tx: Tx,
  context: OrgContext,
  invoice: {
    id: string;
    invoiceNumber: string;
    issueDate: string;
    currency: string;
    amounts: DocumentAmounts;
  },
): Promise<string> {
  const accounts = await resolveInvoiceAccounts(
    tx,
    context.organizationId,
    invoice.amounts.taxMinor > 0n,
  );

  const posted = await postDocument(tx, context, {
    document: { kind: 'invoice', id: invoice.id },
    event: invoicePostingEvent(accounts, invoice.amounts),
    occurredOn: invoice.issueDate,
    description: invoiceDescription(invoice.invoiceNumber),
    currency: invoice.currency,
    // 发票表单上没有汇率输入框——CreateInvoiceInput 里没有 exchangeRate，
    // invoice-form.tsx 上也没有那一栏。所以查不到缓存汇率时那句报错不能
    // 叫用户「在这里填一个」。见 server/posting/rate.ts 的 ManualRateEntry。
    manualRateEntry: 'unavailable',
    link: (linkTx, transactionId) =>
      setInvoiceTransactionId(linkTx, context.organizationId, invoice.id, transactionId),
  });

  return posted.transactionId;
}

/** 审计快照。bigint 不能直接进 JSON，统一转字符串，保持 jsonb 可查询。 */
function invoiceSnapshot(invoice: {
  invoiceNumber: string;
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
    invoiceNumber: invoice.invoiceNumber,
    status: invoice.status,
    contactId: invoice.contactId,
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    currency: invoice.currency,
    taxRateBps: invoice.taxRateBps,
    subtotalMinor: invoice.amounts.subtotalMinor.toString(),
    taxMinor: invoice.amounts.taxMinor.toString(),
    totalMinor: invoice.amounts.totalMinor.toString(),
    transactionId: invoice.transactionId ?? null,
  };
}

/** 从库里读回来的一张发票，转成计算侧用的那三个数。 */
function amountsOf(invoice: InvoiceDetail): DocumentAmounts {
  return {
    subtotalMinor: invoice.subTotalMinor,
    taxMinor: invoice.taxMinor,
    totalMinor: invoice.totalMinor,
  };
}

/**
 * 创建发票。
 *
 * 权限用 transaction:create 而不是原来的 transaction:read——后者 viewer 也有
 * （见 server/domain/permissions.ts 的 MATRIX），等于用只读权限守卫一个写操作。
 * 目前挡住 viewer 的只有 invoices 表的 RLS `with check`，而用户读到的是一句
 * 裸的 Postgres 策略报错，不是「你的角色不能做这件事」。
 *
 * 注：另一位代理正在给 permissions.ts 加单据类 Action（document:create 之类），
 * 这里先用语义最接近的既有 Action，等那边落地后统一替换。
 */
export async function createInvoice(
  orgSlug: string,
  input: CreateInvoiceInput,
): Promise<{ id: string; transactionId: string | null }> {
  const context = await requirePermission(orgSlug, 'transaction:create');

  if (!input.items || input.items.length === 0) {
    throw new AuthError('forbidden', 'An invoice needs at least one item.');
  }

  const currency = resolveDocumentCurrency(input.currency, context.baseCurrency);
  const issue = input.issue === true;

  // 单号是「读最大号 + 1」，两个并发创建会算出同一个号。冲突时整笔重来——
  // 失败的那一次已经整体回滚，一个字节都没写，重跑会读到新的最大号。
  // 为什么不是行锁，见 withDocumentNumberRetry 的注释。
  const result = await withDocumentNumberRetry('invoices_org_number', () =>
    withTransaction(context.userId, async (tx) => {
      const invoiceNumber = await getNextInvoiceNumber(tx, context.organizationId);
      const { taxRateBps, amounts, items } = computeInvoiceAmounts({ ...input, currency });

      const status = issue ? 'sent' : 'draft';

      const { id } = await insertInvoice(tx, {
        organizationId: context.organizationId,
        contactId: input.contactId,
        invoiceNumber,
        status,
        issueDate: input.issueDate,
        dueDate: input.dueDate,
        currency,
        subTotalMinor: amounts.subtotalMinor,
        taxRateBps,
        taxMinor: amounts.taxMinor,
        totalMinor: amounts.totalMinor,
        notes: input.notes?.trim() || null,
      });

      await insertInvoiceItems(
        tx,
        items.map((item) => ({ ...item, invoiceId: id })),
      );

      // 过账与单据写入在同一个 tx 里。分开的话，单据落库而分录没落（或反过来）
      // 就是「应收账龄表显示欠款、资产负债表显示零」这个缺陷换一种形式回来。
      const transactionId = issue
        ? await postInvoice(tx, context, {
            id,
            invoiceNumber,
            issueDate: input.issueDate,
            currency,
            amounts,
          })
        : null;

      // 审计。这个模块此前一次都没调用过 recordAudit，整个应收模块在审计日志里
      // 不可见。before/after 必须交给 recordAudit 用 tx.json() 传，直接
      // JSON.stringify 会在 jsonb 列里存成 JSON 标量字符串——见 audit-logs.ts。
      await recordAudit(tx, {
        organizationId: context.organizationId,
        actorUserId: context.userId,
        action: 'invoice.created',
        entityType: 'invoice',
        entityId: id,
        after: invoiceSnapshot({
          invoiceNumber,
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

  revalidateInvoicePaths(orgSlug, result.transactionId !== null);
  return result;
}

/**
 * 开具一张草稿发票：draft -> sent，同时进总账。
 *
 * 这个动作此前不存在——发票建出来就永远停在 draft，没有任何代码路径能让它
 * 变成 sent。加它是为了让「草稿不进总账」这条规则有一个对应的出口，否则那
 * 条规则等于「发票永远不进总账」。
 *
 * 幂等：clientUuid 由发票 id 派生，重复点两次「开具」不会记两笔应收
 * （见 documentClientUuid）。状态已经不是 draft 时直接报错而不是静默返回——
 * 一张已经作废的发票被「开具」是用户点错了，不是一次无害的重放。
 */
export async function issueInvoice(
  orgSlug: string,
  id: string,
): Promise<{ transactionId: string }> {
  const context = await requirePermission(orgSlug, 'transaction:create');

  const result = await withTransaction(context.userId, async (tx) => {
    const invoice = await requireInvoice(tx, context, id);

    if (invoice.status === 'voided' || invoice.voidedAt) {
      throw new AuthError('forbidden', 'This invoice is voided and can no longer be issued.');
    }
    if (invoice.transactionId) {
      // 已经过账过了。重放 postDocument 会命中幂等短路返回同一笔，但状态
      // 机器上这已经不是「开具」而是「再开具一次」，说清楚比默默成功好。
      throw new AuthError('forbidden', 'This invoice has already been issued.');
    }
    if (invoice.status !== 'draft') {
      throw new AuthError('forbidden', `An invoice in status ${invoice.status} cannot be issued.`);
    }

    const amounts = amountsOf(invoice);
    const transactionId = await postInvoice(tx, context, {
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      issueDate: invoice.issueDate,
      currency: invoice.currency,
      amounts,
    });

    await setInvoiceStatus(tx, context.organizationId, id, 'sent');

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'invoice.issued',
      entityType: 'invoice',
      entityId: id,
      before: { status: invoice.status, transactionId: null },
      after: { status: 'sent', transactionId },
    });

    return { transactionId };
  });

  revalidateInvoicePaths(orgSlug, true);
  return result;
}

/**
 * 编辑一张发票。
 *
 * 已经过账的发票改了金额、日期或币种，必须走 repostJournal 把那笔分录整体
 * 重建——不能用 postDocument：clientUuid 由发票 id 派生，幂等查询必然命中，
 * 于是用户改完保存成功、账上一分钱没变（见 repostDocument 的注释）。
 *
 * 草稿没有分录，改完就是改完。
 */
export async function updateInvoice(
  orgSlug: string,
  id: string,
  input: UpdateInvoiceInput,
): Promise<void> {
  const context = await requirePermission(orgSlug, 'transaction:edit:any');

  if (!input.items || input.items.length === 0) {
    throw new AuthError('forbidden', 'An invoice needs at least one item.');
  }

  const currency = resolveDocumentCurrency(input.currency, context.baseCurrency);

  const posted = await withTransaction(context.userId, async (tx) => {
    const existing = await requireInvoice(tx, context, id);

    if (existing.status === 'voided' || existing.voidedAt) {
      throw new AuthError('forbidden', 'This invoice is voided and can no longer be edited.');
    }

    const { taxRateBps, amounts, items } = computeInvoiceAmounts({ ...input, currency });

    await updateInvoiceRow(tx, context.organizationId, id, {
      contactId: input.contactId,
      issueDate: input.issueDate,
      dueDate: input.dueDate,
      currency,
      subTotalMinor: amounts.subtotalMinor,
      taxRateBps,
      taxMinor: amounts.taxMinor,
      totalMinor: amounts.totalMinor,
      notes: input.notes?.trim() || null,
    });

    // 明细整体替换而不是逐行 diff：发票行没有稳定的业务主键（描述可以改、
    // 顺序可以调），逐行匹配只能靠猜，猜错就是把两行的金额换了位置。
    await deleteInvoiceItems(tx, id);
    await insertInvoiceItems(
      tx,
      items.map((item) => ({ ...item, invoiceId: id })),
    );

    if (existing.transactionId) {
      const accounts = await resolveInvoiceAccounts(
        tx,
        context.organizationId,
        amounts.taxMinor > 0n,
      );
      await repostDocument(tx, context, {
        transactionId: existing.transactionId,
        event: invoicePostingEvent(accounts, amounts),
        occurredOn: input.issueDate,
        description: invoiceDescription(existing.invoiceNumber),
        currency,
        manualRateEntry: 'unavailable',
      });
    }

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'invoice.updated',
      entityType: 'invoice',
      entityId: id,
      before: invoiceSnapshot({
        invoiceNumber: existing.invoiceNumber,
        status: existing.status,
        contactId: existing.contactId,
        issueDate: existing.issueDate,
        dueDate: existing.dueDate,
        currency: existing.currency,
        taxRateBps: existing.taxRateBps,
        amounts: amountsOf(existing),
        transactionId: existing.transactionId,
      }),
      after: invoiceSnapshot({
        invoiceNumber: existing.invoiceNumber,
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

  revalidateInvoicePaths(orgSlug, posted);
  revalidatePath(`/${orgSlug}/invoices/${id}`);
}

/**
 * 作废发票，连带作废它那笔分录。
 *
 * 原来只把 status 改成 'voided'，三个后果：
 *   1. voided_at 留空，而 listInvoices 与税务报表读的都是 voided_at——
 *      作废后的发票仍然在应收账龄表与销项税里。
 *   2. 对应的交易完全不动（当然，因为从来没有交易）。现在有了，就必须一起作废，
 *      否则总账上留着一笔永远收不回来的应收。
 *   3. 没有理由字段。transactions_void_fields_together 要求
 *      voided_at / voided_by / void_reason 三者同时存在且理由非空白，
 *      所以 reason 成了必填参数。
 *
 * 权限从 transaction:read 换成 transaction:edit:any：作废是写操作，而且是
 * 不可逆的写操作，viewer 不该做得了。owner/admin 才有这个 Action，这与
 * invoices 表 RLS 的 `with check`（owner/admin）也对得上。
 */
export async function voidInvoice(
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
    const invoice = await requireInvoice(tx, context, id);

    if (invoice.status === 'voided' || invoice.voidedAt) {
      throw new AuthError('forbidden', 'This invoice is already voided.');
    }

    // 先作废分录再作废单据。顺序在同一个事务里不影响最终状态，但分录那一步
    // 会查期间锁定（voidDocumentPosting 里的 assertPeriodOpen）——封账月份
    // 的发票必须在任何写入之前就被拦下，而不是写了单据再回滚。
    if (invoice.transactionId) {
      await voidDocumentPosting(tx, context, {
        transactionId: invoice.transactionId,
        reason: cleanReason,
      });
    }

    await markInvoiceVoided(tx, context.organizationId, id);

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'invoice.voided',
      entityType: 'invoice',
      entityId: id,
      before: { status: invoice.status, voidedAt: null },
      after: {
        status: 'voided',
        voidedAt: new Date().toISOString(),
        voidReason: cleanReason,
        transactionId: invoice.transactionId,
      },
    });

    return invoice.transactionId !== null;
  });

  revalidateInvoicePaths(orgSlug, hadTransaction);
  revalidatePath(`/${orgSlug}/invoices/${id}`);
}

/**
 * 按 id 取一张本公司的发票，取不到就抛 not_found。
 *
 * getInvoice 返回 null，而三个动作都需要「没有就停下」。统一在这里抛，
 * 而不是各写一遍 if (!invoice) throw——三处里漏掉一处，表现为后面某一行
 * 读 undefined.transactionId 的 TypeError。
 */
async function requireInvoice(
  tx: Tx,
  context: OrgContext,
  id: string,
): Promise<InvoiceDetail> {
  const invoice = await getInvoice(tx, context.organizationId, id);
  if (!invoice) {
    throw new AuthError('not_found', 'This invoice was not found in this company.');
  }
  return invoice;
}

/**
 * 发票过账之后要刷新的页面。
 *
 * 只刷 /invoices 是不够的：一张开具的发票现在会改变总账，于是交易列表、
 * 报表与首页看板上的数字全都变了。posted 为 false（草稿）时不必刷那三个页面
 * ——草稿不进总账，那边什么都没变。
 */
function revalidateInvoicePaths(orgSlug: string, posted: boolean): void {
  revalidatePath(`/${orgSlug}/invoices`);
  if (!posted) return;
  revalidatePath(`/${orgSlug}`);
  revalidatePath(`/${orgSlug}/transactions`);
  revalidatePath(`/${orgSlug}/reports`);
}
