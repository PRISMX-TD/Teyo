'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { withTransaction, type Tx } from '@/server/db/transaction';
import { requirePermission, AuthError } from '@/server/auth/guard';
import { currencyExponent, parseDecimalToMinor, sumMinor } from '@/server/domain/money';
import { convertToBaseMinor, formatScaledRate } from '@/server/domain/exchange-rate';
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
import {
  applicationClientUuid,
  applicationPostingEvent,
  depositLegClientUuid,
  depositPostingEvent,
  splitPaymentLegs,
  MAX_PREPAYMENT_APPLICATIONS,
  PREPAYMENT_ACCOUNT_CODE,
  type PaymentDirection,
} from '@/server/services/prepayment';
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
  sumAppliedByPayment,
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
  /**
   * 空数组是合法的，这一条是本次改动的入口。
   *
   * 原来是 `.min(1)`：一笔收款必须说明它核销哪一张单据，于是「客户先付
   * 定金，票还没开」在这个产品里无法录入。0024 把 payment_items 上的
   * payment_items_one_target 放宽成「至多一个非空」之后，没有核销目标的
   * 那一部分钱有了自己的去处——预收账款（负债）/ 预付账款（资产），
   * 见 server/services/prepayment.ts。
   *
   * 注意放宽的是**数组长度**，不是单条明细的形状：pickDocumentId 仍然
   * 拒绝一条两列都为空的明细。挂账金额由「收款总额 − 核销合计」算出来，
   * 不存成一条明细，理由见 sumAppliedByPayment 的注释。
   */
  items: z.array(paymentItemSchema).default([]),
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

    // 2. 明细校验 + 单据装载。
    const side: SettlementSide = parsed.type === 'received' ? 'receivable' : 'payable';
    const documentKind: SettlementDocumentKind = parsed.type === 'received' ? 'invoice' : 'bill';

    const itemAmounts = parsed.items.map((item) =>
      parseDecimalToMinor(item.amount, exponent),
    );
    const itemDocumentIds = parsed.items.map((item, index) =>
      pickDocumentId(parsed.type, item, itemAmounts[index]),
    );

    // 2b. 拆腿：核销了多少、挂账多少，以及两者各自的本位币金额。
    //
    // B1：本位币换算此前是 `(amountMinor * scaledRate) / RATE_SCALE`——一份
    // convertToBaseMinor 的劣化手抄，**截断**而不是 half-up，且不处理两端
    // 小数位不同（JPY 换 MYR 差两个数量级）。现在整件事交给
    // splitPaymentLegs，它内部只调用 convertToBaseMinor，没有第二份实现。
    //
    // 「核销合计不得超过收款金额」这条校验也搬进了那个函数：它与拆腿是
    // 同一个判断的两面（超额意味着挂账金额为负），分开写迟早会漂移。
    const legs = splitPaymentLegs({
      amountMinor,
      itemAmounts,
      currency: parsed.currency,
      baseCurrency: context.baseCurrency,
      scaledRate,
    });
    const baseAmountMinor = legs.baseAmountMinor;

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
    //
    // 预收/预付科目只在真的有挂账金额时才要：resolvePostingAccounts 对任何
    // 一个缺失的 code 都抛错，无条件要它会让一家建于 0024 之前、还没跑过
    // 回填的公司连一笔普通收款都记不了。与 resolveInvoiceAccounts 对税科目
    // 的处理同一个道理。
    const controlCode =
      side === 'receivable' ? POSTING_ACCOUNT_CODES.receivable : POSTING_ACCOUNT_CODES.payable;
    const depositCode = PREPAYMENT_ACCOUNT_CODE[parsed.type];

    const accountCodes: PostingAccountCode[] = [
      controlCode,
      POSTING_ACCOUNT_CODES.fxGain,
      POSTING_ACCOUNT_CODES.fxLoss,
    ];
    if (legs.unappliedMinor > 0n) accountCodes.push(depositCode);

    const accounts = await resolvePostingAccounts(tx, context.organizationId, accountCodes);
    const controlAccountId = requireAccount(accounts, controlCode);
    const moneyAccountId = await findMoneyAccountId(
      tx,
      context.organizationId,
      MONEY_ACCOUNT_CODE_BY_METHOD[parsed.method as PaymentMethod],
    );

    const description = settlementDescription(parsed.type, parsed.reference ?? null);
    const depositDescriptionText = `${description} — on account`;
    const paymentClientUuid = documentClientUuid({ kind: 'payment', id });

    // 6. 过账。两条腿，各自内部只有一个汇率。
    //
    //   核销腿  借资金账户 / 贷应收（收款侧），金额 = 核销合计
    //   预收腿  借资金账户 / 贷预收账款，      金额 = 挂账余额
    //
    // 为什么不是一笔三行分录：那要在 server/domain/posting-templates.ts 里
    // 新增一种事件类型，那个文件不归本次改动（已在报告里给出建议形状）。
    // 两笔各自配平、各自一个汇率，与汇兑调整必须另起一笔是同一种结构。
    //
    // **主分录**（拿 documentClientUuid、并把 transaction_id 写回 payments）
    // 是「存在的第一条腿」，顺序为 核销腿 → 预收腿：
    //   - 有核销：核销腿是主分录，预收腿用派生的 client_uuid；
    //   - 纯预收：预收腿就是主分录，此时不存在派生的那一笔。
    // 这条规则让 payments.transaction_id 在任何情况下都指得到一笔真实分录，
    // 而作废时只要把「主 + 派生」两个 uuid 都试一遍即可，不必先判断当初
    // 走的是哪一支。
    const hasSettlementLeg = legs.appliedMinor > 0n;

    const settlementEvent: PostingEvent | null = hasSettlementLeg
      ? side === 'receivable'
        ? {
            type: 'customer-receipt',
            moneyAccountId,
            receivableAccountId: controlAccountId,
            amountMinor: legs.appliedMinor,
          }
        : {
            type: 'supplier-payment',
            moneyAccountId,
            payableAccountId: controlAccountId,
            amountMinor: legs.appliedMinor,
          }
      : null;

    const depositEvent: PostingEvent | null =
      legs.unappliedMinor > 0n
        ? depositPostingEvent({
            direction: parsed.type,
            moneyAccountId,
            depositAccountId: requireAccount(accounts, depositCode),
            amountMinor: legs.unappliedMinor,
          })
        : null;

    // 7. 回写 transaction_id 由 postDocument 的 link 回调完成——它产生于
    // 服务端过账，不由调用方传入。走 postDocument 而不是直接 postJournal，
    // 是为了与发票/账单共用同一套 clientUuid 派生（幂等）与同一种「过完账
    // 就把 id 写回单据」的顺序，见 server/services/document-posting.ts。
    const posted = await postDocument(tx, context, {
      document: { kind: 'payment', id },
      // settlementEvent 为 null 意味着纯预收，此时 depositEvent 必不为 null
      // （splitPaymentLegs 保证两条腿不会同时为零，且 amountMinor > 0）。
      event: (settlementEvent ?? depositEvent) as PostingEvent,
      occurredOn: parsed.paymentDate,
      description: hasSettlementLeg ? description : depositDescriptionText,
      currency: parsed.currency,
      manualRate: parsed.exchangeRate,
      manualRateEntry: PAYMENT_MANUAL_RATE_ENTRY,
      link: (linkTx, transactionId) =>
        setPaymentTransactionId(linkTx, context.organizationId, id, transactionId),
    });

    let depositTransactionId: string | null = null;
    if (hasSettlementLeg && depositEvent) {
      const depositPosted = await postJournal(tx, context, {
        event: depositEvent,
        occurredOn: parsed.paymentDate,
        description: depositDescriptionText,
        currency: parsed.currency,
        manualRate: parsed.exchangeRate,
        manualRateEntry: PAYMENT_MANUAL_RATE_ENTRY,
        categoryId: null,
        clientUuid: depositLegClientUuid(paymentClientUuid),
        sourceType: 'payment',
        sourceId: id,
      });
      depositTransactionId = depositPosted.transactionId;
    }

    // 8. 汇兑调整。
    //
    // 每张单据各自算：本次收到的钱按 R2 折成本位币，减去被清掉的那一部分
    // 应收按 R1 记进去的本位币（应付侧符号相反）。两者的差额就是汇兑损益。
    //
    // 分母是**核销腿**的金额，不是整笔收款：贷进应收的是 legs.appliedBaseMinor，
    // 挂账那一截从来没碰过应收，也就没有 R1 可对照。全额核销时两者相等，
    // 与改动之前逐字同一个数。
    //
    // 逐项的本位币金额走 allocateProRata 而不是各自 convertToBaseMinor：
    // 半进位不可加，各自换算出来的合计可能与核销腿整体换算出来的金额差一分，
    // 而应收上贷掉的是后者——差的那一分会永远留在应收上。
    const itemBaseAmounts = hasSettlementLeg
      ? allocateProRata(legs.appliedBaseMinor, legs.appliedMinor, itemAmounts)
      : [];

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
        // 挂在预收/预付上的那一截。写进审计而不是只写核销明细：一笔
        // 「收了一万、只核销三千」的收款，剩下七千去了哪里，事后只能从
        // 这里读出来——payment_items 上没有它的行（见 sumAppliedByPayment）。
        appliedMinor: legs.appliedMinor.toString(),
        unappliedMinor: legs.unappliedMinor.toString(),
        depositTransactionId,
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

const applyPrepaymentSchema = z.object({
  paymentId: z.string().uuid(),
  /** 核销发生在哪一天。它决定这笔分录落在哪个月，也因此要过封账检查。 */
  applicationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  items: z.array(paymentItemSchema).min(1),
});

export type ApplyPrepaymentInput = z.infer<typeof applyPrepaymentSchema>;

/**
 * 把一笔已经挂账的预收/预付核销到单据上。
 *
 * 只能收定金、不能核销，等于把钱永远挂在负债上——预收账款会一年比一年大，
 * 而客户明明早就收到货、发票也开了。这一步是预收款生命周期里缺不得的
 * 后半截。
 *
 * 顺序与 createPayment 同构，差别都是**核销不移动现金**带来的：
 *
 *   1. 取这笔收付款，必须属于本公司、未作废。
 *   2. 校验明细方向（收款只核销发票，付款只核销账单）与单据归属、币种。
 *   3. 算这笔款还剩多少没核销：amount_minor − Σ payment_items。本次不得超过
 *      它——超了就等于凭空核销一笔没收到的钱。**必须在写入新明细之前查**。
 *   4. 取「本次之前」每张单据已核销了多少（汇兑分摊的起点），同样必须在
 *      写入之前。
 *   5. 追加 payment_items。只新增、不改写已有的行，见
 *      server/repositories/payments.ts 的 sumAppliedByPayment。
 *   6. 过账：借预收账款 / 贷应收账款（付款侧镜像）。
 *      **用的是收款当初那个汇率 R2**，不是今天的牌价——理由见
 *      server/services/prepayment.ts 顶部。
 *   7. 汇兑调整：应收侧按 R1 记进去、按 R2 被清掉，差额进 fx-gain/fx-loss。
 *      与 createPayment 共用 fx-settlement.ts 的同一套函数。
 *   8. 单据状态。
 *   9. 审计。
 *
 * 幂等性与 createPayment 一致，也就是说：**没有**。客户端双击会核销两次，
 * 与双击「记录收款」会记两笔收款是同一种情况（那条路径上每次点击都生成
 * 一个新的 payment id，clientUuid 因此也是新的）。挡住它的是界面上的
 * pending 禁用，以及第 3 步那条「不得超过剩余额度」——后者会把第二次点击
 * 变成一句人话，而不是一笔悄悄多出来的分录。真要做重放保护，得让客户端
 * 生成 clientUuid 并一路传到这里，那是整个收付款路径的改动，不止这一处。
 */
export async function applyPrepayment(
  orgSlug: string,
  input: ApplyPrepaymentInput,
): Promise<{ transactionId: string }> {
  const context = await requirePermission(orgSlug, 'transaction:create');
  const parsed = applyPrepaymentSchema.parse(input);

  const result = await withTransaction(context.userId, async (tx) => {
    // 1. 这笔收付款。
    const payment = await getPayment(tx, context.organizationId, parsed.paymentId);
    if (!payment) {
      throw new AuthError('not_found', 'Payment not found.');
    }
    if (payment.voidedAt !== null) {
      throw new LedgerError('This payment was voided; it can no longer be applied to documents.');
    }

    const direction: PaymentDirection = payment.type;
    const side: SettlementSide = direction === 'received' ? 'receivable' : 'payable';
    const documentKind: SettlementDocumentKind = direction === 'received' ? 'invoice' : 'bill';

    // 2. 明细。币种取**这笔收付款的**，不是本位币也不是调用方传来的——
    // 核销的是当初那笔钱，它是什么币种就只能按什么币种核销。
    const exponent = currencyExponent(payment.currency);
    const itemAmounts = parsed.items.map((item) => parseDecimalToMinor(item.amount, exponent));
    const itemDocumentIds = parsed.items.map((item, index) =>
      pickDocumentId(direction, item, itemAmounts[index]),
    );
    const applyMinor = sumMinor(itemAmounts);

    // 3. 剩余可核销额度。
    const appliedSoFar =
      (await sumAppliedByPayment(tx, context.organizationId, [payment.id])).get(payment.id) ?? 0n;
    const unappliedMinor = payment.amountMinor - appliedSoFar;

    if (unappliedMinor <= 0n) {
      throw new LedgerError('This payment has already been applied in full.');
    }
    if (applyMinor > unappliedMinor) {
      throw new LedgerError(
        `This payment only has ${unappliedMinor} (minor units of ${payment.currency}) left to apply, ` +
          `but ${applyMinor} was requested.`,
      );
    }

    // 单据装载 + 归属/币种校验。与 createPayment 逐字同一套：查不到就是
    // 不存在或属于别家公司，两种都不把 id 回显出去。
    const documentIds = [...new Set(itemDocumentIds)];
    const documents =
      documentKind === 'invoice'
        ? await loadInvoicesForSettlement(tx, context.organizationId, documentIds)
        : await loadBillsForSettlement(tx, context.organizationId, documentIds);

    for (const documentId of documentIds) {
      const document = documents.get(documentId);
      if (!document) {
        throw new AuthError('not_found', 'One of the documents being settled was not found.');
      }
      if (document.currency !== payment.currency) {
        throw new LedgerError(
          `${document.number || 'This document'} is in ${document.currency}, ` +
            `but the payment is in ${payment.currency}. A payment can only settle documents in its own currency.`,
        );
      }
    }

    // 4. 「本次之前」的已核销金额。
    const alreadySettled = await sumSettledByDocument(
      tx,
      context.organizationId,
      documentKind,
      documentIds,
    );

    // 5. 追加明细。
    const items: NewPaymentItem[] = parsed.items.map((item, index) => ({
      paymentId: payment.id,
      invoiceId: documentKind === 'invoice' ? itemDocumentIds[index] : null,
      billId: documentKind === 'bill' ? itemDocumentIds[index] : null,
      amountMinor: itemAmounts[index],
    }));
    await insertPaymentItems(tx, items);

    // 6. 科目与过账。
    const controlCode =
      side === 'receivable' ? POSTING_ACCOUNT_CODES.receivable : POSTING_ACCOUNT_CODES.payable;
    const depositCode = PREPAYMENT_ACCOUNT_CODE[direction];
    const accounts = await resolvePostingAccounts(tx, context.organizationId, [
      controlCode,
      depositCode,
      POSTING_ACCOUNT_CODES.fxGain,
      POSTING_ACCOUNT_CODES.fxLoss,
    ]);
    const controlAccountId = requireAccount(accounts, controlCode);
    const depositAccountId = requireAccount(accounts, depositCode);

    // R2：收款当初记下的那个汇率。本位币收款时不传 manualRate——传了会把
    // rate_source 记成 'manual'，而那笔根本不需要汇率（resolveRate 在
    // currency === baseCurrency 时直接返回 1 并记 'auto'）。
    //
    // 外币时确实会记成 'manual'，尽管这个数不是用户当场敲的。RateSource
    // 只有 'auto' | 'manual' 两个值，没有第三种（'inherited'）能表达「沿用
    // 这笔收款的汇率」——加一个要动 server/domain/exchange-rate.ts，不属于
    // 本次改动，已在报告里记下。
    const manualRate =
      payment.currency === context.baseCurrency
        ? undefined
        : formatScaledRate(payment.exchangeRate);

    const paymentClientUuid = documentClientUuid({ kind: 'payment', id: payment.id });
    const clientUuid = await nextApplicationClientUuid(
      tx,
      context.organizationId,
      paymentClientUuid,
    );

    const description = applicationDescription(direction, payment.reference);

    const posted = await postJournal(tx, context, {
      event: applicationPostingEvent({
        direction,
        depositAccountId,
        controlAccountId,
        amountMinor: applyMinor,
      }),
      occurredOn: parsed.applicationDate,
      description,
      currency: payment.currency,
      manualRate,
      manualRateEntry: PAYMENT_MANUAL_RATE_ENTRY,
      categoryId: null,
      clientUuid,
      sourceType: 'payment',
      sourceId: payment.id,
    });

    // 7. 汇兑调整。分母是本次核销的金额，按 R2 折成本位币——那正是上面
    // 那笔分录贷进应收的数（postJournal 内部用的是同一个 convertToBaseMinor
    // 与同一个汇率，两处不会漂移）。
    const applicationBaseMinor = convertToBaseMinor({
      amountMinor: applyMinor,
      currency: payment.currency,
      baseCurrency: context.baseCurrency,
      scaledRate: payment.exchangeRate,
    });
    const itemBaseAmounts = allocateProRata(applicationBaseMinor, applyMinor, itemAmounts);

    const fxResults = itemDocumentIds.map((documentId, index) => {
      const document = documents.get(documentId) as SettlementDocument;
      if (document.postedBaseAmountMinor === null) return 0n;

      return fxResultMinor({
        side,
        settlementBaseMinor: itemBaseAmounts[index],
        clearedBaseMinor: clearedBaseMinor({
          documentBaseAmountMinor: document.postedBaseAmountMinor,
          documentTotalMinor: document.totalMinor,
          alreadySettledMinor: alreadySettled.get(documentId) ?? 0n,
          settledMinor: itemAmounts[index],
        }),
      });
    });

    const { gainMinor, lossMinor } = summariseFxResults(fxResults);
    const fxAccounts = {
      controlAccountId,
      fxGainAccountId: requireAccount(accounts, POSTING_ACCOUNT_CODES.fxGain),
      fxLossAccountId: requireAccount(accounts, POSTING_ACCOUNT_CODES.fxLoss),
    };

    const fxTransactionIds: string[] = [];
    for (const resultMinor of [gainMinor, -lossMinor]) {
      const plan = planFxAdjustment(resultMinor);
      if (!plan) continue;

      // 由**这一次核销**那笔分录的 client_uuid 再派生一层，而不是由收付款
      // 自己的——同一笔预收可能核销多次，每次都可能有汇兑差额，按收付款
      // 派生会让第二次的调整凭证撞上第一次的 client_uuid，然后被
      // postJournal 当成重放整笔丢掉。
      const adjustment = await postJournal(tx, context, {
        event: fxAdjustmentEvent(plan, fxAccounts),
        occurredOn: parsed.applicationDate,
        description: `${description} — exchange ${plan.kind}`,
        currency: context.baseCurrency,
        manualRateEntry: PAYMENT_MANUAL_RATE_ENTRY,
        categoryId: null,
        clientUuid: fxAdjustmentClientUuid(clientUuid, plan.kind),
        sourceType: 'payment',
        sourceId: payment.id,
      });
      fxTransactionIds.push(adjustment.transactionId);
    }

    // 8. 单据状态。
    await refreshSettlementStatuses(tx, context.organizationId, documentKind, documents);

    // 9. 审计。
    await recordAudit(tx, {
      organizationId: context.organizationId,
      actorUserId: context.userId,
      action: 'payment.applied',
      entityType: 'payment',
      entityId: payment.id,
      before: {
        unappliedMinor: unappliedMinor.toString(),
      },
      after: {
        applicationDate: parsed.applicationDate,
        currency: payment.currency,
        appliedMinor: applyMinor.toString(),
        unappliedMinor: (unappliedMinor - applyMinor).toString(),
        exchangeRate: payment.exchangeRate.toString(),
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

    return { transactionId: posted.transactionId };
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
 * 一笔收款可能产生 1 + 2 + 1 + 3N 笔交易：主分录、它的两笔汇兑调整、
 * 预收腿（部分核销时），以及历次核销各自的一笔分录加两笔汇兑调整。
 * payments 表上只有**一个** transaction_id 列，其余没有任何列指得回来——
 * 所以它们的 client_uuid 全是由 (payment id, 用途) 确定性算出来的，作废时
 * 照同一个公式再算一遍就能找回来。推导见 fx-settlement.ts 的
 * fxAdjustmentClientUuid 与 prepayment.ts 的 prepaymentClientUuid。
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

    // 要找回来的每一笔：主分录 + 它的两笔汇兑调整 + 预收腿 + 历次核销
    // （每次一笔核销分录加两笔汇兑调整）。主分录由 payments.transaction_id
    // 指着，其余只能靠确定性 client_uuid 找回来——payments 上没有能装下
    // 它们的列，见 fx-settlement.ts 的 fxAdjustmentClientUuid。
    //
    // 核销那一串按序号从 0 开始探查，遇到第一个不存在就停：序号连续，
    // 因为每次核销都取当前最小的空位（见 nextApplicationClientUuid）。
    // 探查不到的序号后面不可能还有——真有的话说明有人绕过这个 action 直接
    // 往库里写了分录，而那种情况下这里少作废一笔，比继续扫到上限更好查。
    //
    // voidDocumentPosting 而不是直接 markVoided：它会先查期间是否封账
    // （作废一笔落在已封账月份里的分录等于改动已经出过报表的那个月），
    // 并且写一条 transaction.voided 审计，两件事都不该在这里重写一遍。
    const paymentClientUuid = documentClientUuid({ kind: 'payment', id });
    const clientUuids = [
      paymentClientUuid,
      ...FX_RESULT_KINDS.map((kind) => fxAdjustmentClientUuid(paymentClientUuid, kind)),
      depositLegClientUuid(paymentClientUuid),
    ];

    for (let index = 0; index < MAX_PREPAYMENT_APPLICATIONS; index += 1) {
      const applicationUuid = applicationClientUuid(paymentClientUuid, index);
      const application = await findTransactionByClientUuid(
        tx,
        context.organizationId,
        applicationUuid,
      );
      if (!application) break;
      clientUuids.push(
        applicationUuid,
        ...FX_RESULT_KINDS.map((kind) => fxAdjustmentClientUuid(applicationUuid, kind)),
      );
    }

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
 *   - 也不能两个都不挂。0024 之后 payment_items 的 CHECK 已经允许两列都为空
 *     了，但**这条明细**仍然不允许：挂账金额由「收款总额 − 核销合计」算出来，
 *     不占一条明细（理由见 server/repositories/payments.ts 的
 *     sumAppliedByPayment）。一条两列都空的明细因此是调用方弄错了形状——
 *     想记预收就少送一条 items，而不是送一条指不到任何地方的。
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

function applicationDescription(direction: PaymentDirection, reference: string | null): string {
  const base =
    direction === 'received' ? 'Customer deposit applied' : 'Supplier deposit applied';
  return reference ? `${base} · ${reference}` : base;
}

/**
 * 这笔预收的下一次核销该用哪个 client_uuid。
 *
 * 从 0 号开始逐个探查，返回第一个还没有对应交易的序号所派生的 uuid。
 * 序号因此永远连续，作废时从 0 扫到第一个缺口就能把历次核销全部找回来
 * （见 voidPaymentAction）。
 *
 * 为什么不是「数一数 payment_items 有几条」：一次核销可以同时冲多张发票，
 * 明细条数与分录笔数根本不是一回事。也不是随机 uuid：随机的那些作废时
 * 一个都找不回来，而 payments 上没有列能存它们。
 *
 * 上限撞到就报错而不是继续扫：真有人把一笔定金分成六十几次核销，多半是
 * 界面上出了循环调用，此时报一句话比让每次作废都跑六十几次查询好。
 */
async function nextApplicationClientUuid(
  tx: Tx,
  organizationId: string,
  paymentClientUuid: string,
): Promise<string> {
  for (let index = 0; index < MAX_PREPAYMENT_APPLICATIONS; index += 1) {
    const clientUuid = applicationClientUuid(paymentClientUuid, index);
    const existing = await findTransactionByClientUuid(tx, organizationId, clientUuid);
    if (!existing) return clientUuid;
  }

  throw new LedgerError(
    `This payment has already been applied ${MAX_PREPAYMENT_APPLICATIONS} times. ` +
      'Record the remaining balance as a new payment instead.',
  );
}
