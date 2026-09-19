import { createHash } from 'node:crypto';
import { MoneyError } from '@/server/domain/money';
import type { PostingEvent } from '@/server/domain/posting-templates';

/**
 * 单据结算的汇兑损益。
 *
 * ============================================================
 * 问题
 * ============================================================
 * 一张 1,000 USD 的发票，开票日汇率 R1 = 4.70，于是总账里记的是
 * 「借应收 4,700 MYR / 贷收入 4,700 MYR」——应收账款这一格里躺着的是
 * **4,700 本位币**，不是「1,000 美元」这个抽象。
 *
 * 收款日汇率 R2 = 4.50。银行实际入账 4,500 MYR。如果收款只记
 * 「借银行 4,500 / 贷应收 4,500」，应收上就永远剩下 200 MYR——发票在业务上
 * 已经全额收讫，账上却挂着一个谁也清不掉的尾数，而且它会随着每一张外币
 * 发票不断累积。那 200 MYR 不是应收，是这两个月里马币升值造成的损失，
 * 必须落进损益表。
 *
 * ============================================================
 * 为什么不是「一笔交易里两个汇率」
 * ============================================================
 * 最直觉的做法是让同一笔收款分录的两行各用各的汇率：资金行按 R2 记
 * 4,500，应收行按 R1 记 4,700，差额再补一行 fx-loss 200。这在 T 型账上
 * 说得通，在本仓库的不变量体系里却过不去——不是因为校验写得严，而是因为
 * 一笔交易的表头只有**一个** exchange_rate 列，两个汇率根本无处安放。
 *
 * server/domain/ledger.ts 的 assertLineInvariants（I3）拿表头记下的那**一个**
 * scaledRate 把每一行重新 convertToBaseMinor 一遍，逐条对照。假设表头记 R2：
 *
 *   1. 资金行 1,000 USD × 4.50 = 4,500 ✓；
 *   2. 应收行 1,000 USD × 4.50 = 4,500，而我们写的是 4,700 ✗；
 *   3. fx-loss 行是本位币金额，原币一栏写什么都会与 R2 不自洽 ✗。
 *
 * 于是 deviations.length >= 2，直接撞上那句
 * 「N journal lines disagree with the recorded rate; at most one may absorb
 * the rounding residual」。
 *
 * 就算凑成只有一行偏离（比如省掉 fx 行、只让应收行带 R1），也过不去：
 *
 *   - I3 第 2 条把单行偏离量的上界钉在 n - 1 个最小单位（逐行半进位的
 *     残差绝对值必然小于 n/2，n - 1 是保守上界）。两行分录上界是 1 分，
 *     而 200 MYR = 20,000 分。汇兑差额在量级上就不是舍入残差。
 *   - 即使差额恰好是 1 分，I3 第 3 条仍然会拦下：借方本位币合计 4,500、
 *     贷方 4,700，两边不等。
 *
 * 这三条不是可以放宽的容差，而是「一笔交易只记了一个汇率」这件事的直接
 * 推论。想让两个汇率共存于一笔交易，要改的不是校验，是 transactions 表和
 * 整套不变量的含义——用一个会计惯例问题去换掉账本最硬的那条规则，不划算。
 *
 * ============================================================
 * 采用的方案：两笔交易，每笔内部只有一个汇率
 * ============================================================
 * 第一笔——收款本身，整笔按 R2 过账：
 *
 *     借 银行  1,000 USD → 4,500 MYR
 *     贷 应收  1,000 USD → 4,500 MYR
 *
 * 表头 exchange_rate = R2，两行都与 R2 自洽，I3 三条全过，残差恒为 0。
 *
 * 第二笔——汇兑调整，纯本位币凭证：
 *
 *     借 fx-loss   200 MYR
 *     贷 应收      200 MYR
 *
 * currency = ctx.baseCurrency、exchange_rate = 1。这一笔里 currency 等于
 * 本位币，convertToBaseMinor 走的是恒等分支，两行都精确自洽；I4
 * （「外币交易的自动汇率不得恰好为 1」）的第一个合取项 currency !== baseCurrency
 * 为假，所以它根本不会触发——这是 I4 写成检查汇率本身而不是检查两个金额
 * 是否相等的直接好处。
 *
 * 两笔合起来，应收被清掉 4,500 + 200 = 4,700，正好等于开票时记进去的数。
 * 两笔在同一个 withTransaction 里，要么都成、要么都不成。
 *
 * ============================================================
 * R1 从哪里来
 * ============================================================
 * invoices / bills 表上**没有** exchange_rate，也没有 base_amount_minor
 * （0008 建表时就没有，0021 也没有补）。R1 的唯一权威来源是这张单据过账
 * 时写下的那一笔交易：transactions.exchange_rate 与 transactions.base_amount_minor。
 *
 * 这其实比单据上挂一个冗余列更对：汇兑差额要对齐的是**总账里实际躺着的
 * 那个数**，不是单据自己声称的汇率。两者一旦不同（比如单据过账后有人改
 * 过那笔交易），按总账走才能让应收真正归零。
 *
 * 单据还没过账（transaction_id 为 null）时没有 R1 可言——应收从未被借过，
 * 也就没有任何东西需要被真平。那种情况下本模块返回「无差额」，收款照 R2
 * 记它自己的账。
 */

/** 汇兑差额的方向。收益进 fx-gain，损失进 fx-loss。 */
export type FxResultKind = 'gain' | 'loss';

/** 被结算的是应收还是应付。两者的差额符号相反，见 fxResultMinor。 */
export type SettlementSide = 'receivable' | 'payable';

/**
 * 按比例分摊一个本位币金额，整数运算 + half-up。
 *
 * 写法照抄 server/domain/exchange-rate.ts 的 convertToBaseMinor 最后那一行
 * ——(numerator * 2 + denominator) / (denominator * 2) 就是 half-up，不是
 * 另起一套舍入。全仓的舍入只应该有这一种形状。
 *
 * 三个参数都必须非负、且 totalMinor > 0：比例分摊在 total 为零时没有定义，
 * 静默返回 0 会把一个上游 bug 变成一笔悄悄算错的汇兑损益。
 */
function proRataHalfUp(amountMinor: bigint, partMinor: bigint, totalMinor: bigint): bigint {
  if (amountMinor < 0n || partMinor < 0n) {
    throw new MoneyError('Pro-rata allocation needs non-negative amounts.');
  }
  if (totalMinor <= 0n) {
    throw new MoneyError('Pro-rata allocation needs a document total greater than zero.');
  }

  const numerator = amountMinor * partMinor;
  const denominator = totalMinor;
  return (numerator * 2n + denominator) / (denominator * 2n);
}

/**
 * 把一个本位币总额按各份额的比例拆开，且拆出来的各份之和精确可控。
 *
 * 为什么需要它：一笔收款可能同时核销三张发票。如果每张发票各自
 * convertToBaseMinor 一遍，三份之和未必等于这笔收款整体换算出来的本位币
 * 金额——半进位不满足可加性（汇率 4.505 时，100 分换 451，两笔 100 分
 * 换 902，而 200 分一起换只有 901）。而**记进应收的贷方金额是整笔算的
 * 那一个数**，汇兑调整却是逐张发票算的。两者差一分，应收上就永远留一分。
 *
 * 累计之差同样解决这个问题：alloc_i = f(cum_i) - f(cum_{i-1})，
 * f(x) = half_up(totalMinor × x / denominatorMinor)。各份之和恒等于
 * f(Σparts)，当 Σparts = denominatorMinor 时那就是 totalMinor 本身，
 * 一分不多一分不少；有一部分没有核销任何单据（挂账预收）时，未分摊的
 * 那一截正好是它应得的份额。
 *
 * denominatorMinor 必须大于零、各 part 必须非负且合计不超过它。
 */
export function allocateProRata(
  totalMinor: bigint,
  denominatorMinor: bigint,
  parts: readonly bigint[],
): bigint[] {
  if (denominatorMinor <= 0n) {
    throw new MoneyError('Pro-rata allocation needs a denominator greater than zero.');
  }

  let cumulative = 0n;
  let previous = 0n;
  const allocated: bigint[] = [];

  for (const part of parts) {
    if (part < 0n) {
      throw new MoneyError('Pro-rata allocation needs non-negative shares.');
    }
    cumulative += part;
    if (cumulative > denominatorMinor) {
      throw new MoneyError(
        `Pro-rata shares (${cumulative}) exceed the amount being split (${denominatorMinor}).`,
      );
    }
    const current = proRataHalfUp(totalMinor, cumulative, denominatorMinor);
    allocated.push(current - previous);
    previous = current;
  }

  return allocated;
}

export type ClearedBaseArgs = {
  /** 这张单据过账时记进应收/应付的本位币金额（R1 的产物）。 */
  documentBaseAmountMinor: bigint;
  /** 单据原币总额。分摊的分母。 */
  documentTotalMinor: bigint;
  /** 本次之前已核销的原币金额（同一单据上未作废的收付款合计）。 */
  alreadySettledMinor: bigint;
  /** 本次核销的原币金额。 */
  settledMinor: bigint;
};

/**
 * 本次收/付款清掉的那一部分应收/应付，原本是按 R1 记了多少本位币。
 *
 * 为什么是「累计之差」而不是「本次金额 × 比例」：
 *
 * 后者每次各自舍入，三次不等额收款分摊 4,700 时可能得到
 * 1,567 + 1,567 + 1,567 = 4,701 或 4,699——最后一笔收完，应收上还剩
 * ±1 分。一分钱的尾数清不掉，与本模块要解决的那个 200 MYR 尾数是同一种
 * 病，只是小了四个数量级；而应收账龄表只会显示「这张发票还欠 0.01」，
 * 没有任何人看得出它是舍入造成的。
 *
 * 累计之差没有这个问题：alloc(x) = half_up(base × x / total) 是一个确定
 * 的函数，本次分摊 = alloc(已核销 + 本次) - alloc(已核销)。全部收完时
 * 最后一项是 alloc(total) = half_up(base × total / total) = base（精确
 * 整除，不经舍入），于是逐次分摊之和**恒等于** base，与分几次、每次多少
 * 完全无关。最后一笔自然把所有尾数吃干净，不需要额外写一条「如果是最后
 * 一笔就补差」的特例——特例正是这种地方最容易写错的东西。
 *
 * 超额核销（客户多付）时累计被截到 documentTotalMinor 为止：多出来的钱
 * 背后没有任何应收，也就没有汇率差可言，它只是让应收出现一个贷方余额，
 * 而那正是「客户多付了」在复式记账里应有的样子。不在这里抛错，是因为
 * 多收一分钱不该让整笔收款无法录入。
 */
export function clearedBaseMinor(args: ClearedBaseArgs): bigint {
  const { documentBaseAmountMinor, documentTotalMinor, alreadySettledMinor, settledMinor } = args;

  if (settledMinor < 0n || alreadySettledMinor < 0n) {
    throw new MoneyError('Settled amounts cannot be negative.');
  }

  const clamp = (value: bigint) => (value > documentTotalMinor ? documentTotalMinor : value);

  const before = clamp(alreadySettledMinor);
  const after = clamp(alreadySettledMinor + settledMinor);

  return (
    proRataHalfUp(documentBaseAmountMinor, after, documentTotalMinor) -
    proRataHalfUp(documentBaseAmountMinor, before, documentTotalMinor)
  );
}

export type FxResultArgs = {
  side: SettlementSide;
  /** 本次实际收到/付出的钱，按结算日汇率 R2 折成的本位币金额。 */
  settlementBaseMinor: bigint;
  /** 被清掉的那部分应收/应付按 R1 记录的本位币金额（clearedBaseMinor 的结果）。 */
  clearedBaseMinor: bigint;
};

/**
 * 汇兑差额，正数为收益、负数为损失、零为无差额。
 *
 * 两侧符号相反，推导各走一遍：
 *
 * 应收：这部分应收带着 clearedBase 的借方余额，收款按 settlementBase 贷掉
 * 它，剩余 = clearedBase - settlementBase。收到的本位币比当初记的多
 * （settlementBase > clearedBase），应收被贷过头，剩下一个贷方余额——
 * 那是**收益**。所以 result = settlementBase - clearedBase。
 *
 * 应付：这部分应付带着 clearedBase 的贷方余额，付款按 settlementBase 借掉
 * 它。付出去的本位币比当初记的少（settlementBase < clearedBase），说明
 * 这笔债变便宜了——那是**收益**。所以 result = clearedBase - settlementBase。
 *
 * 两条推导合起来还有一个好处：无论哪一侧，收益都是「借控制科目 / 贷
 * fx-gain」，损失都是「借 fx-loss / 贷控制科目」，见 fxAdjustmentEvent。
 */
export function fxResultMinor(args: FxResultArgs): bigint {
  const { side, settlementBaseMinor, clearedBaseMinor: cleared } = args;

  return side === 'receivable'
    ? settlementBaseMinor - cleared
    : cleared - settlementBaseMinor;
}

export type FxAdjustmentPlan = {
  kind: FxResultKind;
  /** 调整金额的绝对值，恒大于零——等于零时 planFxAdjustment 返回 null。 */
  amountMinor: bigint;
};

/**
 * 把一个带符号的差额变成「要不要出一笔调整凭证、出哪一种」。
 *
 * 差额为零时返回 null 而不是一个金额为 0 的计划：journal_lines.amount_minor
 * 有 > 0 的 CHECK，一笔零额凭证会被数据库拒绝，而用户看到的是一条读不懂的
 * 约束报错。同币种收款、以及外币收款恰好碰上同一个汇率时，走的都是这一支。
 */
export function planFxAdjustment(resultMinor: bigint): FxAdjustmentPlan | null {
  if (resultMinor === 0n) return null;

  return resultMinor > 0n
    ? { kind: 'gain', amountMinor: resultMinor }
    : { kind: 'loss', amountMinor: -resultMinor };
}

/**
 * 把多笔单据各自的汇兑差额汇总成最多两笔调整凭证要用的金额。
 *
 * 为什么按符号分组而不是直接相加成一个净额：fx-gain 是收入科目、fx-loss
 * 是费用科目。一笔收款同时清掉三张开票日汇率各不相同的发票时，其中有的
 * 赚有的亏完全正常；净额相抵会让损益表上这两个科目同时少计，而净额本身
 * 无论落在哪一个科目下都是错的。
 *
 * 为什么也不是「一张单据一笔调整凭证」：那样一次收款能生出五六笔几分钱的
 * 交易，交易列表被噪音淹没。按符号分组把凭证数钉在 <= 2，而「哪张发票
 * 贡献了多少」仍然可以从 payment_items 与各自单据的过账倒推出来。
 */
export function summariseFxResults(resultsMinor: readonly bigint[]): {
  gainMinor: bigint;
  lossMinor: bigint;
} {
  let gainMinor = 0n;
  let lossMinor = 0n;

  for (const result of resultsMinor) {
    if (result > 0n) gainMinor += result;
    else if (result < 0n) lossMinor += -result;
  }

  return { gainMinor, lossMinor };
}

export type FxAccountIds = {
  /** 被真平的控制科目：应收或应付。 */
  controlAccountId: string;
  fxGainAccountId: string;
  fxLossAccountId: string;
};

/**
 * 调整凭证的记账事件。
 *
 * 用的是通用的 'journal' 事件而不是新增一种事件类型：这一笔在会计上就是
 * 一笔手工凭证——一借一贷、本位币、不挂分类（kindFor('journal') = 'journal'，
 * categoryForKind 因此不要求 categoryId）。方向仍然只在
 * server/domain/posting-templates.ts 里定义一次，这里只是选哪两个科目。
 *
 * 收益：借控制科目 / 贷 fx-gain。
 * 损失：借 fx-loss   / 贷控制科目。
 * 两侧（应收/应付）共用这一对方向，推导见 fxResultMinor 的注释。
 */
export function fxAdjustmentEvent(
  plan: FxAdjustmentPlan,
  accounts: FxAccountIds,
): PostingEvent {
  return plan.kind === 'gain'
    ? {
        type: 'journal',
        debitAccountId: accounts.controlAccountId,
        creditAccountId: accounts.fxGainAccountId,
        amountMinor: plan.amountMinor,
      }
    : {
        type: 'journal',
        debitAccountId: accounts.fxLossAccountId,
        creditAccountId: accounts.controlAccountId,
        amountMinor: plan.amountMinor,
      };
}

/**
 * 汇兑调整那一笔交易的 client_uuid，由单据自己那一笔的 client_uuid 派生。
 *
 * 为什么必须是确定性的：postJournal 的幂等完全建立在
 * (organization_id, client_uuid) 上（见它的第 2 步：命中直接返回，一个字节
 * 都不写）。更要紧的是作废——一笔收款最多产生三笔交易（收款本身、汇兑收益、
 * 汇兑损失），而 payments 表上只有**一个** transaction_id 列，后两笔没有
 * 任何列指得回来。确定性派生之后，作废时照同一个公式再算一遍就能把它们找
 * 出来，不必加表也不必加列。
 *
 * 为什么从 documentClientUuid 的结果再派生一次，而不是自己从单据 id 算：
 * server/services/document-posting.ts 的 documentClientUuid 只收
 * (kind, id)，没有「第几笔」这个维度——它自己的注释也写着「日后同一张单据
 * 可能需要第二笔分录（外币结算的汇兑损益就是一笔独立的分录），那时只要换
 * 一个派生名」，但那个参数还不存在，而那个文件不属于本次改动。把它的输出
 * 当成输入再哈希一次，既拿到了缺的那个维度，又在结构上保证不可能与单据
 * 自己那一笔撞号（撞号意味着汇兑调整会被当成收款的重放而整笔丢失）。
 *
 * 形状按 RFC 4122 v5 摆（sha1 前 16 字节，改写版本位与变体位）——不是为了
 * 与任何标准命名空间互通，只是 client_uuid 列是 uuid 类型，值必须长得像
 * 一个 uuid。
 */
export function fxAdjustmentClientUuid(documentClientUuid: string, kind: FxResultKind): string {
  const digest = createHash('sha1').update(`${documentClientUuid}:fx:${kind}`).digest();
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

/** 汇兑调整的两种方向。作废时按这两个值把两笔调整凭证都找回来。 */
export const FX_RESULT_KINDS: readonly FxResultKind[] = ['gain', 'loss'];
