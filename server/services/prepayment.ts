import { createHash } from 'node:crypto';
import { convertToBaseMinor } from '@/server/domain/exchange-rate';
import { LedgerError } from '@/server/domain/ledger';
import { sumMinor } from '@/server/domain/money';
import type { PostingEvent } from '@/server/domain/posting-templates';
import { POSTING_ACCOUNT_CODES } from '@/server/services/posting-accounts';

/**
 * 预收 / 预付款：收到钱的时候还没有单据。
 *
 * ============================================================
 * 问题
 * ============================================================
 * payment_items 上的 payment_items_one_target 原本要求 invoice_id 与 bill_id
 * **恰好一个**非空。于是「客户先付两千块定金，货还没发、票还没开」这件事
 * 在这个产品里没有任何表达方式——而定金、预收货款正是小生意最常见的收款
 * 形式之一。表单此前在用户一张单据都没勾时挡住并说明原因，那是承认做不到。
 *
 * 更隐蔽的是**部分核销**那一支。createPayment 允许核销合计小于收款金额
 * （只拦 `> amountMinor`），而过账时整笔按 customer-receipt 记：
 *
 *     借 银行 10,000 / 贷 应收 10,000
 *
 * 可 payment_items 里只有 3,000。剩下的 7,000 就这样贷进了应收账款——
 * 一个凭空多出来的贷方余额，应收账龄表上看不出来（它按单据算），
 * 资产负债表上也说不清那是什么。它不是应收的减少，是一笔欠客户的债。
 *
 * ============================================================
 * 方案：把一笔收款拆成两条腿，各自成为一笔内部只有一个汇率的交易
 * ============================================================
 * 收款 10,000，其中 3,000 核销了 INV-001：
 *
 *   核销腿（customer-receipt）  借 银行 3,000 / 贷 应收账款 3,000
 *   预收腿（journal）           借 银行 7,000 / 贷 预收账款 7,000
 *
 * 为什么不是一笔三行分录「借银行 10,000 / 贷应收 3,000 / 贷预收 7,000」：
 * 那需要在 server/domain/posting-templates.ts 里新增一种事件类型，而那个
 * 文件不归本次改动。两笔各自配平、各自只有一个汇率，与
 * server/services/fx-settlement.ts 里「汇兑调整必须另起一笔」用的是同一种
 * 结构，不是新发明的做法。代价是交易列表上多一行——在那一行确实描述了
 * 一件独立的事（「这笔钱挂上了预收账款」）的前提下，可以接受。
 *
 * 为什么预收是**负债**而不是收入：钱到手了，货还没交、服务还没做。这时候
 * 确认收入，损益表上的利润就是假的；客户要退定金时，账上也找不到那笔债。
 * 与 deferred-revenue（递延收入）分开：后者已经开了票、按期确认；这个是
 * 连单据都还没有。付款侧对称，落在 supplier-deposits（资产）上——与
 * prepaid-expenses（预付费用，已知用途、按期摊销）同样分开。
 *
 * ============================================================
 * 日后核销：借预收账款 / 贷应收账款
 * ============================================================
 * 只能收定金、不能核销，等于把钱永远挂在负债上。核销这一步不移动任何
 * 现金，它只是把「欠客户的货」换成「客户欠的钱被抵掉」：
 *
 *     借 预收账款 3,000 / 贷 应收账款 3,000
 *
 * 这一笔用的汇率是**收款当初那个 R2**，不是核销当天的牌价。理由：预收
 * 账款上躺着的本位币金额是当初按 R2 记进去的，用别的汇率去借它，那个
 * 科目就永远清不到零——而「这笔定金用完了」必须能在账上看出来。应收侧
 * 因此与 R1 产生差额，那才是真正的汇兑损益，交给 fx-settlement.ts 那套
 * 既有机制处理（借/贷应收 对 fx-gain/fx-loss），不另写第二份。
 *
 * 已知的不精确之处（报告里也记了）：同一笔外币预收分多次核销时，每次
 * convertToBaseMinor(本次金额, R2) 各自半进位，若干次之和可能与当初
 * convertToBaseMinor(未核销金额, R2) 差 1 个最小单位，于是预收账款上会
 * 留下 1 分的尾数。半进位不可加，这是结构性的：要消掉它得让「离开预收
 * 的本位币金额」与「进入应收的本位币金额」在同一笔分录里不相等，而一笔
 * 交易只有一个汇率（见 fx-settlement.ts 顶部关于 I3 的推导）。本位币预收
 * （绝大多数情况）恒为零尾数；外币预收一次核销完也是零。
 */

/** 收款还是付款。两侧的预收/预付科目与借贷方向都对称。 */
export type PaymentDirection = 'received' | 'made';

/**
 * 这个方向的「还没有单据的钱」挂在哪个科目上。
 *
 * 写成一张表而不是散在 if 里，是为了让「收款→负债、付款→资产」这一对
 * 对称关系在一个地方看得见；两个 code 都取自 POSTING_ACCOUNT_CODES，
 * 拼错的字符串在运行时只表现为「找不到科目」，看不出是谁拼错的。
 */
export const PREPAYMENT_ACCOUNT_CODE = {
  received: POSTING_ACCOUNT_CODES.customerDeposits,
  made: POSTING_ACCOUNT_CODES.supplierDeposits,
} as const;

/**
 * 预收/预付腿的记账事件：借资金账户 / 贷预收账款（收款侧）。
 *
 * 用通用的 'journal' 事件而不是新增一种事件类型——这一笔在会计上就是一笔
 * 一借一贷的手工凭证，方向仍然只在 server/domain/posting-templates.ts 的
 * templateFor 里定义一次，这里只是选哪两个科目。哪一侧是借方由本函数说了
 * 算，所以两个方向各写一遍、不共用一个三元表达式：谁借谁贷是这个文件里
 * 最值得读清楚的四行。
 */
export function depositPostingEvent(args: {
  direction: PaymentDirection;
  moneyAccountId: string;
  depositAccountId: string;
  amountMinor: bigint;
}): PostingEvent {
  const { direction, moneyAccountId, depositAccountId, amountMinor } = args;

  if (direction === 'received') {
    // 收到定金：钱进了银行（资产增加），同时欠客户一笔货（负债增加）。
    return {
      type: 'journal',
      debitAccountId: moneyAccountId,
      creditAccountId: depositAccountId,
      amountMinor,
    };
  }

  // 付出定金：钱出了银行（资产减少），换来供应商欠的一批货（资产增加）。
  return {
    type: 'journal',
    debitAccountId: depositAccountId,
    creditAccountId: moneyAccountId,
    amountMinor,
  };
}

/**
 * 把一笔已经挂账的预收/预付核销到单据上：借预收账款 / 贷应收账款。
 *
 * 付款侧是完全的镜像：借应付账款 / 贷预付账款——这笔账单不用再付钱了，
 * 因为当初的定金抵掉了它。
 *
 * 注意两侧用的都是**控制科目**（应收/应付），不是收入或费用科目：收入在
 * 开票那一刻就已经确认过了，这里再碰一次损益表就是重复计算。
 */
export function applicationPostingEvent(args: {
  direction: PaymentDirection;
  depositAccountId: string;
  controlAccountId: string;
  amountMinor: bigint;
}): PostingEvent {
  const { direction, depositAccountId, controlAccountId, amountMinor } = args;

  if (direction === 'received') {
    return {
      type: 'journal',
      debitAccountId: depositAccountId,
      creditAccountId: controlAccountId,
      amountMinor,
    };
  }

  return {
    type: 'journal',
    debitAccountId: controlAccountId,
    creditAccountId: depositAccountId,
    amountMinor,
  };
}

/** 一笔收付款拆成的两条腿。两条都可能为零，但不会同时为零。 */
export type PaymentLegs = {
  /** 核销到单据上的原币金额。 */
  appliedMinor: bigint;
  /** 没有单据、挂在预收/预付上的原币金额。 */
  unappliedMinor: bigint;
  appliedBaseMinor: bigint;
  unappliedBaseMinor: bigint;
  /**
   * 写进 payments.base_amount_minor 的值：**两条腿之和**，不是整笔再换算
   * 一次。半进位不可加，convertToBaseMinor(3000) + convertToBaseMinor(7000)
   * 与 convertToBaseMinor(10000) 可能差一分；而总账里实际躺着的是前者
   * （两笔分录各自换算）。payments 上那一列若取后者，它与总账就永远差着
   * 那一分，而没有任何页面能解释这一分是什么。
   */
  baseAmountMinor: bigint;
};

/**
 * 按核销明细把一笔收付款拆成「核销腿」与「预收腿」。
 *
 * 全部核销时 unappliedMinor 为零、baseAmountMinor 恰好等于整笔换算的结果
 * （只有一条腿，没有可加性问题），与改动之前逐字相同——这是这个函数必须
 * 保持的性质：已有的收付款不因为加了预收功能而改变一分钱。
 */
export function splitPaymentLegs(args: {
  amountMinor: bigint;
  itemAmounts: readonly bigint[];
  currency: string;
  baseCurrency: string;
  scaledRate: bigint;
}): PaymentLegs {
  const { amountMinor, itemAmounts, currency, baseCurrency, scaledRate } = args;

  if (amountMinor <= 0n) {
    throw new LedgerError('Transaction amount must be greater than zero.');
  }

  // sumMinor 收的是 bigint[]，而入参刻意是 readonly——这个函数不该有任何
  // 机会改到调用方的数组。复制一份比把签名放宽成可变数组安全。
  const appliedMinor = sumMinor([...itemAmounts]);
  if (appliedMinor > amountMinor) {
    throw new LedgerError(
      'The amounts applied to documents add up to more than this payment.',
    );
  }
  const unappliedMinor = amountMinor - appliedMinor;

  const toBase = (minor: bigint) =>
    minor === 0n
      ? 0n
      : convertToBaseMinor({ amountMinor: minor, currency, baseCurrency, scaledRate });

  const appliedBaseMinor = toBase(appliedMinor);
  const unappliedBaseMinor = toBase(unappliedMinor);

  return {
    appliedMinor,
    unappliedMinor,
    appliedBaseMinor,
    unappliedBaseMinor,
    baseAmountMinor: appliedBaseMinor + unappliedBaseMinor,
  };
}

/**
 * 同一笔收付款最多能派生出多少笔核销分录。
 *
 * 作废一笔预收款时要把它派生出来的每一笔分录都反过账，而这些分录的
 * client_uuid 是按序号确定性算出来的（见 applicationClientUuid）。反过账
 * 时从 0 号开始逐个探查、遇到第一个不存在就停——序号连续是因为每次核销
 * 都取当前最小的空位。这个上限只是探查的兜底：真要有人把一笔定金分成
 * 六十几次核销，那多半是界面上出了循环调用，报一句话比无限探查下去好。
 */
export const MAX_PREPAYMENT_APPLICATIONS = 64;

/**
 * 由收付款自己那一笔的 client_uuid 派生出附属分录的 client_uuid。
 *
 * 为什么必须是确定性的：payments 表上只有**一个** transaction_id 列，而一笔
 * 预收款可能产生 1（预收腿）+ N（历次核销）+ 2N（各次核销的汇兑调整）笔
 * 分录——没有任何列指得回来。作废时照同一个公式再算一遍就能把它们全部
 * 找出来，不必加表也不必加列。这与 server/services/fx-settlement.ts 的
 * fxAdjustmentClientUuid 是同一个办法，理由也逐字相同。
 *
 * 为什么不直接复用 fxAdjustmentClientUuid：它的派生名写死了 `:fx:${kind}`，
 * 表达不了「预收腿」和「第 3 次核销」。名字进哈希是这套办法唯一的维度，
 * 所以要另开一个函数，而不是给那个函数加参数（改的是别人的文件，且那会
 * 改变已有汇兑调整的 uuid——每一笔已过账的调整都会变成「找不到」）。
 *
 * 形状按 RFC 4122 v5 摆（sha1 前 16 字节，改写版本位与变体位），不是为了
 * 与任何标准命名空间互通，只因为 client_uuid 列是 uuid 类型。
 */
export function prepaymentClientUuid(paymentClientUuid: string, purpose: string): string {
  const digest = createHash('sha1')
    .update(`${paymentClientUuid}:prepayment:${purpose}`)
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));

  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant

  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/**
 * 预收腿那一笔分录的 client_uuid。
 *
 * 只在「既核销了一部分、又留了一部分挂账」时才用得上：纯预收（一张单据
 * 都没核销）时预收腿就是这笔收款的主分录，走 documentClientUuid，
 * payments.transaction_id 指向的正是它。规则是「主分录 = 存在的第一条腿，
 * 顺序为 核销腿、预收腿」，见 server/actions/payments.ts 的 createPayment。
 */
export function depositLegClientUuid(paymentClientUuid: string): string {
  return prepaymentClientUuid(paymentClientUuid, 'deposit');
}

/** 第 index 次核销那一笔分录的 client_uuid。index 从 0 开始，连续。 */
export function applicationClientUuid(paymentClientUuid: string, index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new LedgerError(`A prepayment application index must be a whole number, got ${index}.`);
  }
  return prepaymentClientUuid(paymentClientUuid, `apply:${index}`);
}
