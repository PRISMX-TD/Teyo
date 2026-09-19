'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { withTransaction } from '@/server/db/transaction';
import { requirePermission, AuthError } from '@/server/auth/guard';
import { currencyExponent, parseDecimalToMinor, sumMinor } from '@/server/domain/money';
import { convertToBaseMinor } from '@/server/domain/exchange-rate';
import { LedgerError } from '@/server/domain/ledger';
import type { PostingEvent } from '@/server/domain/posting-templates';
import { postJournal } from '@/server/posting/post-journal';
import { resolveRate } from '@/server/posting/rate';
import {
  POSTING_ACCOUNT_CODES,
  requireAccount,
  resolvePostingAccounts,
  type PostingAccountCode,
} from '@/server/services/posting-accounts';
import {
  documentClientUuid,
  postDocument,
  voidDocumentPosting,
} from '@/server/services/document-posting';
import {
  allocateProRata,
  clearedBaseMinor,
  fxAdjustmentClientUuid,
  fxAdjustmentEvent,
  planFxAdjustment,
  fxResultMinor,
  summariseFxResults,
  FX_RESULT_KINDS,
  type SettlementSide,
} from '@/server/services/fx-settlement';
import { recordAudit } from '@/server/repositories/audit-logs';
import { findTransactionByClientUuid } from '@/server/repositories/transactions';
import {
  findMoneyAccountId,
  getPayment,
  insertPayment,
  insertPaymentItems,
  loadBillsForSettlement,
  loadInvoicesForSettlement,
  refreshSettlementStatuses,
  setPaymentTransactionId,
  sumSettledByDocument,
  voidPayment,
  MONEY_ACCOUNT_CODE_BY_METHOD,
  type NewPaymentItem,
  type NewPaymentRow,
  type PaymentMethod,
  type SettlementDocument,
  type SettlementDocumentKind,
} from '@/server/repositories/payments';

const paymentItemSchema = z.object({
  invoiceId: z.string().uuid().nullable().optional(),
  billId: z.string().uuid().nullable().optional(),
  amount: z.string().min(1),
});

/**
 * transactionId 不再是入参。
 *
 * 它原来写成 `transactionId: z.string().uuid().nullable().optional()`，然后
 * 原样入库。uuid() 只校验形状，外键只保证那一行存在于 transactions 里——
 * **不保证它属于本公司**（PostgreSQL 的外键校验不受 RLS 约束，这正是
 * server/posting/insert.ts 的 assertAccountsBelongToOrg 专门堵的那类洞）。
 * 于是任何人都能把自己的一笔收款挂到别家公司的交易上，而收付款列表会照着
 * 那个 id 去展示。
 *
 * 这个字段现在完全由服务端过账产生，见下面 createPayment 的第 6-8 步。
 */
const createPaymentSchema = z.object({
  contactId: z.string().uuid(),
  type: z.enum(['received', 'made']),
  amount: z.string().min(1),
  currency: z.string().length(3).default('USD'),
  exchangeRate: z.string().optional(),
  paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  method: z.enum(['cash', 'bank_transfer', 'cheque', 'online', 'other']).default('bank_transfer'),
  reference: z.string().max(200).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  items: z.array(paymentItemSchema).min(1),
});

export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;

/**
 * 收付款表单上现在有汇率输入框了（components/payments/payment-form.tsx
 * 接上了 RateField，并从 FormData 里取 exchangeRate）。
 *
 * 这个常量控制的是「查不到缓存汇率时那句报错怎么措辞」——见
 * server/posting/rate.ts 的 ManualRateEntry。它原来是 'unavailable'，
 * 对应的文案是「去 Transactions 页面自己记，那里能填汇率」。对一笔**收款**
 * 那是一条会把人带错地方的建议：自己记一笔交易不会核销任何发票，那张
 * 发票照样挂在应收上，而用户以为自己已经处理完了。
 *
 * 现在表单上就有那一栏，所以改成 'available'——报错会直接说「在这里填一个」。
 */
const PAYMENT_MANUAL_RATE_ENTRY = 'available' as const;

/**
 * 记录一笔收付款，并把它记进总账。
 *
 * 顺序不是随意的：
 *
 *   1. 解析汇率 R2。要在任何写入之前——查不到汇率就该整笔失败，而不是先
 *      插一行再回滚。
 *   2. 校验明细：只能核销与本次收付款方向一致的单据（收款对发票、付款对
 *      账单），且单据必须属于本公司、币种必须与这笔钱一致。
 *   3. 取「本次之前」每张单据已核销了多少——必须在写 payment_items **之前**
 *      查，否则本次的金额会被算进「之前」，分摊的起点就错了。
 *   4. 写收付款表头与明细。
 *   5. 解析过账要用的科目。
 *   6. 过账收款/付款本身，整笔按 R2——这一笔内部只有一个汇率，通过 I3。
 *   7. 回写 transaction_id。
 *   8. 汇兑调整，本位币凭证、汇率恰为 1，最多两笔（收益一笔、损失一笔）。
 *      为什么必须另起一笔而不是塞进第 6 步那一笔里，见
 *      server/services/fx-settlement.ts 顶部那段推理。
 *   9. 更新单据状态。
 *  10. 审计。
 *
 * 全部在同一个 withTransaction 里：要么收付款、分录、汇兑调整、单据状态
 * 一起落库，要么一个字节都不写。
 */
export async function createPayment(
  orgSlug: string,
  input: CreatePaymentInput,
): Promise<{ id: string }> {
  // 权限用 transaction:create（bookkeeper 有）。数据库 0010 的 payments RLS
  // `with check` 只允许 owner/admin，两者不匹配——bookkeeper 点「记录收款」
  // 会撞一句裸的 Postgres RLS 报错。放宽 `with check` 属于数据库侧的改动，
  // 不在本次改动的文件范围内，已在报告里记下这一对配对。
  const context = await requirePermission(orgSlug, 'transaction:create');
  const parsed = createPaymentSchema.parse(input);

  const result = await withTransaction(context.userId, async (tx) => {
    // 1. 汇率 R2。
    //
    // 这里自己解析一遍，而不是等 postJournal 去解析：payments.exchange_rate
    // 与 base_amount_minor 两列要写的就是这个值，汇兑差额也要用它。
    // postJournal 内部会在同一个事务里再解析一次，读的是同一份快照、同一个
    // 日期、同一种币，结果必然相同，所以两处不会漂移。反过来把解析结果传给
    // postJournal 也能省一次查询，但那要伪装成 manualRate，rate_source 就会
    // 把一个缓存汇率记成「用户手工输入」——那是记进库里的假话，不值得。
    const { scaledRate } = await resolveRate(tx, {
      currency: parsed.currency,
      baseCurrency: context.baseCurrency,
      occurredOn: parsed.paymentDate,
      manualRate: parsed.exchangeRate,
      manualRateEntry: PAYMENT_MANUAL_RATE_ENTRY,
    });

    const exponent = currencyExponent(parsed.currency);
    const amountMinor = parseDecimalToMinor(parsed.amount, exponent);
    if (amountMinor <= 0n) {
      throw new LedgerError('Transaction amount must be greater than zero.');
    }

    // B1：这里原来是 `(amountMinor * scaledRate) / RATE_SCALE`——一份
    // convertToBaseMinor 的劣化手抄。它**截断**而不是 half-up，且完全不处理
    // 两端小数位不同的情况：JPY（exponent 0）换 MYR（exponent 2）会差两个
    // 数量级，1,000 日元记成 10 令吉。记账边界当初要消灭的就是这种「第二份
    // 实现」。
    const baseAmountMinor = convertToBaseMinor({
      amountMinor,
      currency: parsed.currency,
      baseCurrency: context.baseCurrency,
      scaledRate,
    });

    // 2. 明细校验 + 单据装载。
    const side: SettlementSide = parsed.type === 'received' ? 'receivable' : 'payable';
    const documentKind: SettlementDocumentKind = parsed.type === 'received' ? 'invoice' : 'bill';

    const itemAmounts = parsed.items.map((item) =>
      parseDecimalToMinor(item.amount, exponent),
    );
    const itemDocumentIds = parsed.items.map((item, index) =>
      pickDocumentId(parsed.type, item, itemAmounts[index]),
    );

    if (sumMinor(itemAmounts) > amountMinor) {
      throw new LedgerError(
        'The amounts applied to documents add up to more than this payment.',
      );
    }

    const documentIds = [...new Set(itemDocumentIds)];
    const documents =
      documentKind === 'invoice'
        ? await loadInvoicesForSettlement(tx, context.organizationId, documentIds)
        : await loadBillsForSettlement(tx, context.organizationId, documentIds);

    for (const id of documentIds) {
      const document = documents.get(id);
      // 查不到有两种可能：单据不存在，或它属于别家公司。两种都不该把 id
      // 回显给调用方——那等于确认了「这个 id 在别处存在」。
      if (!document) {
        throw new AuthError('not_found', 'One of the documents being settled was not found.');
      }
      if (document.currency !== parsed.currency) {
        throw new LedgerError(
          `${document.number || 'This document'} is in ${document.currency}, ` +
            `but the payment is in ${parsed.currency}. Record the payment in the document's currency.`,
        );
      }
    }

    // 3. 「本次之前」的已核销金额。必须在写 payment_items 之前查。
    const alreadySettled = await sumSettledByDocument(
      tx,
      context.organizationId,
      documentKind,
      documentIds,
    );

    // 4. 写表头与明细。
    const row: NewPaymentRow = {
      organizationId: context.organizationId,
      contactId: parsed.contactId,
      type: parsed.type,
      amountMinor,
      currency: parsed.currency,
      // B7：exchange_rate 是放大 10^8 的 bigint。scaledRate 正是那个表示法，
      // 由 parseRateToScaled 从字符串转来（resolveRate 内部），全程不经
      // Number，也绝不出现 BigInt("1.5") 这种把小数当整数读的写法。
      exchangeRate: scaledRate,
      baseAmountMinor,
      paymentDate: parsed.paymentDate,
      method: parsed.method,
      reference: parsed.reference ?? null,
      notes: parsed.notes ?? null,
      createdBy: context.userId,
    };

    const { id } = await insertPayment(tx, row);

    const items: NewPaymentItem[] = parsed.items.map((item, index) => ({
      paymentId: id,
      invoiceId: documentKind === 'invoice' ? itemDocumentIds[index] : null,
      billId: documentKind === 'bill' ? itemDocumentIds[index] : null,
      amountMinor: itemAmounts[index],
    }));

    await insertPaymentItems(tx, items);

    // 5. 科目。一次查齐，缺哪个就把缺的全列出来。
    const accountCodes: PostingAccountCode[] = [
      side === 'receivable' ? POSTING_ACCOUNT_CODES.receivable : POSTING_ACCOUNT_CODES.payable,
      POSTING_ACCOUNT_CODES.fxGain,
      POSTING_ACCOUNT_CODES.fxLoss,
    ];
    const accounts = await resolvePostingAccounts(tx, context.organizationId, accountCodes);
    const controlAccountId = requireAccount(
      accounts,
      side === 'receivable' ? POSTING_ACCOUNT_CODES.receivable : POSTING_ACCOUNT_CODES.payable,
    );
    const moneyAccountId = await findMoneyAccountId(
      tx,
      context.organizationId,
      MONEY_ACCOUNT_CODE_BY_METHOD[parsed.method as PaymentMethod],
    );

    // 6. 过账收付款本身。整笔按 R2，两行同额，内部只有一个汇率。
    const settlementEvent: PostingEvent =
      side === 'receivable'
        ? { type: 'customer-receipt', moneyAccountId, receivableAccountId: controlAccountId, amountMinor }
        : { type: 'supplier-payment', moneyAccountId, payableAccountId: controlAccountId, amountMinor };

    const description = settlementDescription(parsed.type, parsed.reference ?? null);

    // 7. 回写 transaction_id 由 postDocument 的 link 回调完成——它产生于
    // 服务端过账，不由调用方传入。走 postDocument 而不是直接 postJournal，
    // 是为了与发票/账单共用同一套 clientUuid 派生（幂等）与同一种「过完账
    // 就把 id 写回单据」的顺序，见 server/services/document-posting.ts。
    const posted = await postDocument(tx, context, {
      document: { kind: 'payment', id },
      event: settlementEvent,
      occurredOn: parsed.paymentDate,
      description,
      currency: parsed.currency,
      manualRate: parsed.exchangeRate,
      manualRateEntry: PAYMENT_MANUAL_RATE_ENTRY,
      link: (linkTx, transactionId) =>
        setPaymentTransactionId(linkTx, context.organizationId, id, transactionId),
    });

    // 8. 汇兑调整。
    //
    // 每张单据各自算：本次收到的钱按 R2 折成本位币，减去被清掉的那一部分
    // 应收按 R1 记进去的本位币（应付侧符号相反）。两者的差额就是汇兑损益。
    //
    // 逐项的本位币金额走 allocateProRata 而不是各自 convertToBaseMinor：
    // 半进位不可加，各自换算出来的合计可能与第 6 步整笔换算出来的
    // baseAmountMinor 差一分，而应收上贷掉的是后者——差的那一分会永远留在
    // 应收上。见 fx-settlement.ts 里那个函数的注释。
    const itemBaseAmounts = allocateProRata(baseAmountMinor, amountMinor, itemAmounts);

    const fxResults = itemDocumentIds.map((documentId, index) => {
      const document = documents.get(documentId) as SettlementDocument;
      // 单据还没过账（或那笔分录已作废）时没有 R1 可言：应收从未被借过，
      // 也就没有任何东西需要被真平。
      if (document.postedBaseAmountMinor === null) return 0n;

      const cleared = clearedBaseMinor({
        documentBaseAmountMinor: document.postedBaseAmountMinor,
        documentTotalMinor: document.totalMinor,
        alreadySettledMinor: alreadySettled.get(documentId) ?? 0n,
        settledMinor: itemAmounts[index],
      });

      return fxResultMinor({
        side,
        settlementBaseMinor: itemBaseAmounts[index],
        clearedBaseMinor: cleared,
      });
    });

    const { gainMinor, lossMinor } = summariseFxResults(fxResults);

    const fxAccounts = {
      controlAccountId,
      fxGainAccountId: requireAccount(accounts, POSTING_ACCOUNT_CODES.fxGain),
      fxLossAccountId: requireAccount(accounts, POSTING_ACCOUNT_CODES.fxLoss),
    };

    const paymentClientUuid = documentClientUuid({ kind: 'payment', id });
    const fxTransactionIds: string[] = [];

    for (const resultMinor of [gainMinor, -lossMinor]) {
      const plan = planFxAdjustment(resultMinor);
      if (!plan) continue;

      // 这一笔走 postJournal 而不是 postDocument：postDocument 的 clientUuid
      // 由 (kind, id) 派生，同一张单据的第二、第三笔分录在那里没有位置，而
      // 它的 link 回调也无处可写——payments 上只有一个 transaction_id 列。
      const adjustment = await postJournal(tx, context, {
        event: fxAdjustmentEvent(plan, fxAccounts),
        occurredOn: parsed.paymentDate,
        description: `${description} — exchange ${plan.kind}`,
        // 纯本位币凭证：currency 等于本位币，汇率恒为 1。这一笔不碰 I4
        // （它只在 currency !== baseCurrency 时才看汇率是不是 1）。
        currency: context.baseCurrency,
        manualRateEntry: PAYMENT_MANUAL_RATE_ENTRY,
        categoryId: null,
        clientUuid: fxAdjustmentClientUuid(paymentClientUuid, plan.kind),
        sourceType: 'payment',
        sourceId: id,
      });
      fxTransactionIds.push(adjustment.transactionId);
    }

    // 9. 单据状态。
    await refreshSettlementStatuses(tx, context.organizationId, documentKind, documents);

    // 10. 审计。B5：这两个 action 此前一次都没有调用过 recordAudit——
    // 收付款是直接影响客户余额的操作，却在审计日志里完全不存在。
    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'payment.created',
      entityType: 'payment',
      entityId: id,
      after: {
        type: parsed.type,
        contactId: parsed.contactId,
        paymentDate: parsed.paymentDate,
        method: parsed.method,
        currency: parsed.currency,
        // bigint 不能直接进 JSON，统一转字符串，保持 jsonb 可查询。
        amountMinor: amountMinor.toString(),
        baseAmountMinor: baseAmountMinor.toString(),
        exchangeRate: scaledRate.toString(),
        reference: parsed.reference ?? null,
        transactionId: posted.transactionId,
        fxTransactionIds,
        fxGainMinor: gainMinor.toString(),
        fxLossMinor: lossMinor.toString(),
        items: items.map((item) => ({
          invoiceId: item.invoiceId,
          billId: item.billId,
          amountMinor: item.amountMinor.toString(),
        })),
      },
    });

    return { id };
  });

  revalidatePath(`/${orgSlug}/payments`);
  revalidatePath(`/${orgSlug}/invoices`);
  revalidatePath(`/${orgSlug}/bills`);
  revalidatePath(`/${orgSlug}/transactions`);
  return result;
}

/**
 * 作废一笔收付款，连带作废它产生的全部分录。
 *
 * 一笔收款最多产生三笔交易：收款本身、汇兑收益、汇兑损失。payments 表上
 * 只有**一个** transaction_id 列，另外两笔没有任何列指得回来——所以它们的
 * client_uuid 是由 (payment id, 用途) 确定性算出来的，作废时照同一个公式
 * 再算一遍就能找回来。推导见 fx-settlement.ts 的 deterministicClientUuid。
 *
 * 只作废分录、不删除：账本从不删行。单据状态要跟着退回去，否则一张发票会
 * 因为一笔已经作废的收款永远显示「已付」。
 */
export async function voidPaymentAction(
  orgSlug: string,
  id: string,
): Promise<void> {
  const context = await requirePermission(orgSlug, 'transaction:create');

  await withTransaction(context.userId, async (tx) => {
    const payment = await getPayment(tx, context.organizationId, id);
    if (!payment) {
      throw new AuthError('not_found', 'Payment not found.');
    }
    if (payment.voidedAt !== null) {
      // 幂等：重复点击不该报错，也不该再写一遍审计。
      return;
    }

    await voidPayment(tx, context.organizationId, id);

    const reason = 'Payment voided';
    const voidedTransactionIds: string[] = [];

    // 三笔：收款本身 + 汇兑收益 + 汇兑损失。前者由 payments.transaction_id
    // 指着，后两笔只能靠确定性 client_uuid 找回来——payments 上没有能装下
    // 它们的列，见 fx-settlement.ts 的 fxAdjustmentClientUuid。
    //
    // voidDocumentPosting 而不是直接 markVoided：它会先查期间是否封账
    // （作废一笔落在已封账月份里的分录等于改动已经出过报表的那个月），
    // 并且写一条 transaction.voided 审计，两件事都不该在这里重写一遍。
    const paymentClientUuid = documentClientUuid({ kind: 'payment', id });
    const clientUuids = [
      paymentClientUuid,
      ...FX_RESULT_KINDS.map((kind) => fxAdjustmentClientUuid(paymentClientUuid, kind)),
    ];

    for (const clientUuid of clientUuids) {
      const existing = await findTransactionByClientUuid(tx, context.organizationId, clientUuid);
      if (!existing) continue;
      await voidDocumentPosting(tx, context, { transactionId: existing.id, reason });
      voidedTransactionIds.push(existing.id);
    }

    // 单据状态回退。payment 已经被标记作废，所以 sumSettledByDocument 现在
    // 已经不会把它算进去了——不必再传 excludePaymentId。
    const documentKind: SettlementDocumentKind = payment.type === 'received' ? 'invoice' : 'bill';
    const documentIds = [
      ...new Set(
        payment.items
          .map((item) => (documentKind === 'invoice' ? item.invoiceId : item.billId))
          .filter((value): value is string => value !== null),
      ),
    ];

    const documents =
      documentKind === 'invoice'
        ? await loadInvoicesForSettlement(tx, context.organizationId, documentIds)
        : await loadBillsForSettlement(tx, context.organizationId, documentIds);

    await refreshSettlementStatuses(tx, context.organizationId, documentKind, documents);

    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'payment.voided',
      entityType: 'payment',
      entityId: id,
      before: {
        type: payment.type,
        paymentDate: payment.paymentDate,
        currency: payment.currency,
        amountMinor: payment.amountMinor.toString(),
        baseAmountMinor: payment.baseAmountMinor.toString(),
        transactionId: payment.transactionId,
      },
      after: { voided: true, voidedTransactionIds },
    });
  });

  revalidatePath(`/${orgSlug}/payments`);
  revalidatePath(`/${orgSlug}/invoices`);
  revalidatePath(`/${orgSlug}/bills`);
  revalidatePath(`/${orgSlug}/transactions`);
}

/**
 * 一条收付款明细指向哪张单据。
 *
 * 四件事在这里一次判完：
 *   - 金额必须为正。零额明细在 payment_items 上没有 CHECK 拦着，会变成一条
 *     什么也没核销的记录，后面按比例分摊时还会成为一个分母为零的诱因。
 *   - 一条明细不能同时挂发票和账单——那在业务上无法解释，而两个外键都允许
 *     非空。
 *   - 也不能两个都不挂。这一条不是本函数的发明：payment_items 上有
 *     `payment_items_one_target` CHECK，要求两列**恰好一非空**（见 0009
 *     迁移）。components/payments/payment-form.tsx 在用户一张单据都没勾选时
 *     偏偏送的就是 `{ invoiceId: null, billId: null }`，于是「记一笔不核销
 *     任何单据的预收」这件事今天必然撞一条裸的 Postgres 约束报错。挡在这里
 *     至少让用户读到一句人话；要真正支持预收，得先放宽那条 CHECK，那是数据库
 *     侧的改动，已在报告里记下。
 *   - 方向必须一致：收款只能核销发票，付款只能核销账单。反过来写照样能插
 *     进库里，然后应收与应付会各自算出一个谁也对不上的余额。
 */
function pickDocumentId(
  type: 'received' | 'made',
  item: { invoiceId?: string | null; billId?: string | null },
  amountMinor: bigint,
): string {
  if (amountMinor <= 0n) {
    throw new LedgerError('Each applied amount must be greater than zero.');
  }

  const invoiceId = item.invoiceId ?? null;
  const billId = item.billId ?? null;

  if (invoiceId !== null && billId !== null) {
    throw new LedgerError('A payment line cannot settle an invoice and a bill at the same time.');
  }
  if (invoiceId === null && billId === null) {
    throw new LedgerError(
      type === 'received'
        ? 'Choose which invoice this payment settles.'
        : 'Choose which bill this payment settles.',
    );
  }

  if (type === 'received') {
    if (billId !== null) {
      throw new LedgerError('A received payment settles invoices, not bills.');
    }
    return invoiceId as string;
  }

  if (invoiceId !== null) {
    throw new LedgerError('A payment made settles bills, not invoices.');
  }
  return billId as string;
}

function settlementDescription(type: 'received' | 'made', reference: string | null): string {
  const base = type === 'received' ? 'Customer receipt' : 'Supplier payment';
  return reference ? `${base} · ${reference}` : base;
}
