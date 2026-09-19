import { createHash } from 'node:crypto';
import type { Tx } from '@/server/db/transaction';
import type { OrgContext } from '@/server/auth/guard';
import { LedgerError } from '@/server/domain/ledger';
import { assertPeriodOpen } from '@/server/domain/period-lock';
import { currencyExponent, parseDecimalToMinor } from '@/server/domain/money';
import type { PostingEvent } from '@/server/domain/posting-templates';
import type { ManualRateEntry } from '@/server/posting/rate';
import { postJournal, repostJournal } from '@/server/posting/post-journal';
import { recordAudit } from '@/server/repositories/audit-logs';
import { getTransactionDetail, markVoided } from '@/server/repositories/transactions';
import {
  POSTING_ACCOUNT_CODES,
  requireAccount,
  resolvePostingAccounts,
  type PostingAccountCode,
} from '@/server/services/posting-accounts';

/**
 * 单据与记账边界之间的那一层。
 *
 * 这个项目最大的结构性缺陷是：发票、账单这些单据有完整的表、界面和列表页，
 * 却一条 journal_lines 都不产生。于是应收账款、应付账款、应交税金在总账里
 * 永远是零，而同一个产品的应收账龄表上却显示着客户欠着钱——两个页面互相
 * 否认对方。invoices.transaction_id / bills.transaction_id 这两列从 0008
 * 起就存在，从来没有被写入过。
 *
 * 这个文件负责把「单据」翻译成「一次 postJournal 调用」，并且只负责四件
 * 每种单据都要做、做错了后果一样的事：
 *
 *   1. 科目解析——按公司一次查齐，缺哪个就把缺的全列出来；
 *   2. clientUuid 的确定性派生——重复提交不会记成两笔；
 *   3. 过账成功后把 transaction_id 写回单据；
 *   4. 作废单据时连带作废那笔交易。
 *
 * 刻意不做的事：它不知道发票该借哪个科目、账单该贷哪个科目。方向只在
 * server/domain/posting-templates.ts 的 templateFor 里定义一次（见那个文件
 * 的注释：两份方向定义里写反一份，分录照样配平、照样没人看得出来，这正是
 * 本项目出过的那种 bug 的形状）。这里只把单据上的数字装进 PostingEvent。
 *
 * 也刻意不涵盖收付款与贷项通知单：它们是另一条路径上的事，有自己的文件。
 * 复用点是 postDocument / repostDocument / voidDocumentPosting 这三个函数
 * 加 link 回调——把 transaction_id 写回哪张表由调用方的仓储决定，这个文件
 * 不持有任何一张单据表的 SQL，所以接新单据不需要改它。
 */

// ============================================================
// 一、金额与数量：整数运算 + half-up，与换算口径一致
// ============================================================

/**
 * 非负整数的 value * multiplier / divisor，按 half-up 舍入。
 *
 * 为什么必须是 half-up 而不是 BigInt 除法自带的向零截断：
 * server/domain/exchange-rate.ts 的 convertToBaseMinor 用的就是这个式子
 * （(n * 2 + d) / (d * 2)），而一张发票的每一行金额最终都要经过它换算成
 * 本位币。行金额自己按截断算、换算按 half-up 算，等于同一笔钱在同一条
 * 路径上被两种规则处理——差额只有一分，但它会稳定地偏向一侧，累积到
 * 月末的应收账龄表与资产负债表上就是一个对不上的尾数，而且永远查不出
 * 是哪一笔。金额舍入在这个项目里必须全局只有一种。
 *
 * 这个式子只对非负数成立（负数侧 half-up 要另写一支），所以先断言。
 * 单据上的单价、数量、税率、金额全都是非负的；出现负数意味着上游解析
 * 出了问题，此时报错比算出一个看似正常的数要好。
 */
export function mulDivHalfUp(value: bigint, multiplier: bigint, divisor: bigint): bigint {
  if (divisor <= 0n) {
    throw new LedgerError('Cannot divide an amount by zero.');
  }
  if (value < 0n || multiplier < 0n) {
    throw new LedgerError('Document amounts cannot be negative.');
  }
  const numerator = value * multiplier;
  return (numerator * 2n + divisor) / (divisor * 2n);
}

/** invoice_items.quantity 是 numeric(12,4)：四位小数，按 10^4 定标成整数处理。 */
export const QUANTITY_EXPONENT = 4;
const QUANTITY_SCALE = 10n ** BigInt(QUANTITY_EXPONENT);

/** 税率以基点存（tax_rate_bps）：1% = 100 bps，也就是百分数的两位小数。 */
const BPS_SCALE = 10000n;

/** 税率上限 100%。见 parseTaxRateBps 的注释。 */
const MAX_TAX_RATE_BPS = 10000;

/**
 * 明细行金额 = 单价 × 数量，全程整数、half-up。
 *
 * 原来的写法是
 *   const qtyBig = BigInt(qtyWhole) * 10000n + BigInt(qtyFrac);
 *   const amountMinor = (unitBig * qtyBig) / 10000n;
 * 数量的解析是手搓的（`(qtyParts[1] ?? '').padEnd(4,'0').slice(0,4)` 会把
 * 「0.00005」悄悄截成 0、把「abc」变成 BigInt 抛出的原始 SyntaxError），
 * 而那个除法是向零截断的：单价 3.33、数量 1.5 应当是 4.995 → 5.00，
 * 截断得到的是 4.99。每一行少一分，一张十行的发票就与客户对不上账。
 *
 * 数量交给 parseDecimalToMinor(quantity, 4) 解析：它是这个项目里唯一
 * 一处十进制字符串到定标整数的实现，拒绝负数、拒绝超过四位小数、拒绝
 * 任何非数字，报的是 MoneyError 而不是一个看不懂的 SyntaxError。
 */
export function lineAmountMinor(unitPriceMinor: bigint, quantity: string): bigint {
  const scaledQuantity = parseDecimalToMinor(quantity, QUANTITY_EXPONENT);
  if (scaledQuantity <= 0n) {
    // numeric(12,4) 本身允许 0，但一行数量为零的明细在发票上没有意义，
    // 而它会让整张发票的总额凭空少一块——挡在这里，让用户自己删掉那一行。
    throw new LedgerError(`A line quantity must be greater than zero, received ${quantity}.`);
  }
  return mulDivHalfUp(unitPriceMinor, scaledQuantity, QUANTITY_SCALE);
}

/**
 * 百分数字符串 → 基点整数。
 *
 * 原来的写法是 `parseFloat(input) * 100` 再 Math.round。三个问题，按危害
 * 从大到小：
 *
 * 1. `|| 0` 把非法输入静默变成 0 税率。parseFloat 是前缀解析，不是校验：
 *    'abc' 得到 NaN 然后被 || 0 变成 0，'6%' 得到 6，'6,5'（用逗号做小数点
 *    的地区写法）得到 6。一张本该含 6% SST 的发票就这样静默地变成免税发票
 *    开了出去，而用户看不到任何提示——这正是「不变量优先于便利」要挡住的
 *    那类事。
 * 2. 走浮点。parseFloat('8.2') * 100 得到 819.9999999999999，
 *    parseFloat('2.55') * 100 得到 254.99999999999997。两位小数的百分数
 *    恰好每一个都被 Math.round 修回来了，所以今天还没算错过一个税率——
 *    但那是运气，不是设计。本项目的约定是金额相关的计算一律不经浮点，
 *    靠「这次恰好 round 对了」维持正确性，下一次改动就不一定。
 * 3. 没有上界。tax_rate_bps 是 int4，一个手滑的 '1000000000' 会在数据库
 *    层面溢出，用户读到的是 Postgres 的原始报错。
 *
 * 改成 parseDecimalToMinor(input, 2)：百分数的两位小数恰好就是基点，一次
 * 转换既得到 bps 又顺带拒绝了「6.001% 这种基点表示不了的精度」。
 *
 * 逗号要在委托之前单独拦下来。parseDecimalToMinor 会把逗号当千分位直接
 * 删掉（那对金额是对的：'1,000.00'），而对税率是错的：用逗号做小数点的
 * '6,5' 会变成 '65'，也就是 65% 的税率——一个既不报错、又完全不是用户
 * 意思的数。税率上没有千分位可言，见到逗号就是写法有歧义。
 *
 * 空字符串与 undefined 当 0 处理：没填税率就是不收税，这是用户明确的意思，
 * 不是猜的。'abc' 不是——那是填错了，必须报错。
 *
 * 上限 100%：超过 100% 的销售税率在实务上一律是打错（把 6.00 敲成 600），
 * 报一句说得清的话比记一张税额六倍于货款的发票要好。
 */
export function parseTaxRateBps(input: string | undefined): number {
  const raw = (input ?? '').trim();
  if (raw === '') return 0;

  if (raw.includes(',')) {
    throw new LedgerError(
      `A tax rate cannot contain a comma. Write ${raw.replace(/,/g, '.')} with a dot if you meant a decimal.`,
    );
  }

  const bps = parseDecimalToMinor(raw, 2);
  if (bps > BigInt(MAX_TAX_RATE_BPS)) {
    throw new LedgerError(
      `A tax rate of ${raw}% looks like a typo. Enter the rate as a percentage, for example 6 for 6%.`,
    );
  }
  return Number(bps);
}

/**
 * 税额 = 净额 × 税率，half-up。
 *
 * 原来是 `(subTotalMinor * BigInt(taxRateBps)) / 10000n`——同样是向零截断。
 * 净额 1.25、税率 6% 精确值是 0.075，应当进位成 0.08，截断得到 0.07。
 * 税额算少一分的后果不止是账不平：税务报表交出去的销项税是错的。
 */
export function taxMinorFor(subtotalMinor: bigint, taxRateBps: number): bigint {
  if (!Number.isInteger(taxRateBps) || taxRateBps < 0 || taxRateBps > MAX_TAX_RATE_BPS) {
    throw new LedgerError(`Invalid tax rate ${taxRateBps} basis points.`);
  }
  return mulDivHalfUp(subtotalMinor, BigInt(taxRateBps), BPS_SCALE);
}

/**
 * 这张单据记在哪个币种下。
 *
 * 0008/0009 给 invoices/bills/payments 的 currency 列写的是
 * `text not null default 'USD'`，而 organizations.timezone 的默认值是
 * 'Asia/Kuala_Lumpur'——这是给马来西亚商户做的产品，本位币通常是 MYR。
 * 0021 把那个默认值删掉了，缺省币种从此必须由应用侧给，而唯一正确的
 * 缺省是这家公司的本位币：用本位币记账不需要汇率，用 USD 记账需要，
 * 而发票表单上根本没有填汇率的地方。
 *
 * 顺手大写归一（'myr' -> 'MYR'）：0021 的 CHECK 是 ^[A-Z]{3}$，小写会被
 * 数据库拒绝，而用户读到的是一条约束报错。大小写不改变这是哪个币种，
 * 所以归一不是「猜一个值」。真正非法的（'US'、'RM'）交给 currencyExponent
 * 抛 MoneyError，那句话里带着用户填的原文。
 */
export function resolveDocumentCurrency(input: string | undefined, baseCurrency: string): string {
  const raw = (input ?? '').trim().toUpperCase();
  const currency = raw === '' ? baseCurrency : raw;
  // 这一句的作用是校验，不是取指数：非法币种在这里就抛，而不是等到
  // 写库时撞 CHECK 约束。
  currencyExponent(currency);
  return currency;
}

// ============================================================
// 二、幂等键：由单据 id 确定性派生
// ============================================================

/**
 * 能被过账的单据。这里只是一个标签：它进入 clientUuid 的派生名与审计的
 * sourceType，不对应任何一张表的 SQL——写回哪张表由调用方的 link 回调
 * 决定（见 postDocument）。列出四种而不是两种，是为了让收付款与贷项
 * 通知单那条路径能直接复用这三个函数，而不必改动这个文件。
 */
export type DocumentKind = 'invoice' | 'bill' | 'payment' | 'credit-note';

export type DocumentRef = { kind: DocumentKind; id: string };

/**
 * uuidv5 的命名空间。随便换一个值，所有既有单据的 clientUuid 都会变，
 * 于是每一张已过账的单据都能被再过账一次——所以这个常量一旦定下就不能动。
 */
const DOCUMENT_POSTING_NAMESPACE = '9b5f7f0e-4a2c-4d7b-8a6e-2f1c0d3e5b71';

/**
 * 这张单据过账时用哪个 clientUuid。
 *
 * postJournal 的幂等完全建立在 clientUuid 上（见它的第 2 步：命中直接返回，
 * 一个字节都不写）。单据这条路径上没有像交易表单那样的客户端生成的 uuid
 * ——用户点的是「开具」按钮，一次双击、一次断网重发、一次 Server Action
 * 重试，都会带着同样的单据 id 再来一次。随机生成 clientUuid 等于关掉幂等：
 * 同一张发票会记两笔应收，而两笔都各自配平，触发器与不变量校验全都看不出
 * 任何问题。
 *
 * 所以从单据 id 确定性派生。用 uuidv5 而不是直接复用单据 id：
 *   - client_uuid 的唯一约束是 (organization_id, client_uuid)，直接复用
 *     单据 id 也能工作，但那样「这个 uuid 是发票还是交易」在数据里就没有
 *     区分了；kind 进了派生名，发票与账单即使 id 相同也不会撞。
 *   - 日后同一张单据可能需要第二笔分录（外币结算的汇兑损益就是一笔独立
 *     的分录），那时只要换一个派生名，不必给单据加列。
 */
export function documentClientUuid(document: DocumentRef): string {
  return uuidV5(`${document.kind}:${document.id}`, DOCUMENT_POSTING_NAMESPACE);
}

/**
 * RFC 4122 的 uuidv5（SHA-1 + 命名空间）。项目里没有 uuid 依赖，而这个
 * 算法只有八行，比为它引一个包更好审：sha1(命名空间的 16 字节 || 名字)，
 * 取前 16 字节，钉死版本号与 variant 位。
 */
function uuidV5(name: string, namespace: string): string {
  const namespaceBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  if (namespaceBytes.length !== 16) {
    throw new Error(`uuidV5 namespace must be a UUID, received "${namespace}".`);
  }

  const digest = createHash('sha1').update(namespaceBytes).update(name, 'utf8').digest();
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

// ============================================================
// 三、科目解析
// ============================================================

/**
 * 一张发票要用到的科目：应收（借）、销售收入（贷）、销项税（贷）。
 *
 * 只在真的有税额时才去要 tax-payable：resolvePostingAccounts 对任何一个
 * 缺失的 code 都抛错，无条件要税科目会让一家没配税的公司连一张免税发票
 * 都开不出来。
 */
export async function resolveInvoiceAccounts(
  tx: Tx,
  organizationId: string,
  hasTax: boolean,
): Promise<{ receivableAccountId: string; revenueAccountId: string; taxAccountId: string | null }> {
  const codes: PostingAccountCode[] = [POSTING_ACCOUNT_CODES.receivable, POSTING_ACCOUNT_CODES.revenue];
  if (hasTax) codes.push(POSTING_ACCOUNT_CODES.outputTax);

  const accounts = await resolvePostingAccounts(tx, organizationId, codes);
  return {
    receivableAccountId: requireAccount(accounts, POSTING_ACCOUNT_CODES.receivable),
    revenueAccountId: requireAccount(accounts, POSTING_ACCOUNT_CODES.revenue),
    taxAccountId: hasTax ? requireAccount(accounts, POSTING_ACCOUNT_CODES.outputTax) : null,
  };
}

/**
 * 一张账单要用到的科目：进货费用（借）、进项税（借）、应付（贷）。
 *
 * 进项税用的是 tax-receivable 而不是 tax-payable——它是资产（政府欠这家
 * 公司的），不是负债。两者挂反了，报表上「应缴税款 = 销项 - 进项」会变成
 * 「销项 + 进项」，而分录照样配平。
 */
export async function resolveBillAccounts(
  tx: Tx,
  organizationId: string,
  hasTax: boolean,
): Promise<{ payableAccountId: string; expenseAccountId: string; taxAccountId: string | null }> {
  const codes: PostingAccountCode[] = [POSTING_ACCOUNT_CODES.payable, POSTING_ACCOUNT_CODES.purchases];
  if (hasTax) codes.push(POSTING_ACCOUNT_CODES.inputTax);

  const accounts = await resolvePostingAccounts(tx, organizationId, codes);
  return {
    payableAccountId: requireAccount(accounts, POSTING_ACCOUNT_CODES.payable),
    expenseAccountId: requireAccount(accounts, POSTING_ACCOUNT_CODES.purchases),
    taxAccountId: hasTax ? requireAccount(accounts, POSTING_ACCOUNT_CODES.inputTax) : null,
  };
}

// ============================================================
// 四、单据金额 -> PostingEvent
// ============================================================

/** 单据上那三个数。netMinor + taxMinor 必须恰好等于 totalMinor。 */
export type DocumentAmounts = {
  subtotalMinor: bigint;
  taxMinor: bigint;
  totalMinor: bigint;
};

export function invoicePostingEvent(
  accounts: { receivableAccountId: string; revenueAccountId: string; taxAccountId: string | null },
  amounts: DocumentAmounts,
): PostingEvent {
  return {
    type: 'invoice',
    receivableAccountId: accounts.receivableAccountId,
    revenueAccountId: accounts.revenueAccountId,
    taxAccountId: accounts.taxAccountId,
    netMinor: amounts.subtotalMinor,
    taxMinor: amounts.taxMinor,
    amountMinor: amounts.totalMinor,
  };
}

export function billPostingEvent(
  accounts: { payableAccountId: string; expenseAccountId: string; taxAccountId: string | null },
  amounts: DocumentAmounts,
): PostingEvent {
  return {
    type: 'bill',
    payableAccountId: accounts.payableAccountId,
    expenseAccountId: accounts.expenseAccountId,
    taxAccountId: accounts.taxAccountId,
    netMinor: amounts.subtotalMinor,
    taxMinor: amounts.taxMinor,
    amountMinor: amounts.totalMinor,
  };
}

// ============================================================
// 五、过账 / 重过账 / 反过账
// ============================================================

/** 过账一张单据需要知道的全部东西。方向不在这里，在 templateFor。 */
export type DocumentPosting = {
  document: DocumentRef;
  event: PostingEvent;
  /** 单据日期。发票用开票日，账单用收到日——不是今天。 */
  occurredOn: string;
  description: string;
  currency: string;
  manualRate?: string;
  /**
   * 这个入口的界面上有没有能填汇率的地方。发票与账单表单上没有
   * （CreateInvoiceInput / CreateBillInput 里都没有 exchangeRate，
   * 表单上也没有那一栏），所以调用方传的是 'unavailable'。
   * 必填的理由见 server/posting/rate.ts。
   */
  manualRateEntry: ManualRateEntry;
  /**
   * 把 transaction_id 写回这张单据。
   *
   * 为什么是回调而不是这个文件里的一条 update：那样这个文件就得持有
   * invoices / bills / payments / credit_notes 四张表的 SQL，而单据表的
   * 读写本来就分散在各自的仓储里。回调让「接一种新单据」这件事不需要
   * 改这个文件——收付款与贷项通知单那条路径传自己的仓储函数进来即可。
   */
  link: (tx: Tx, transactionId: string) => Promise<void>;
};

/**
 * 把一张单据过账，并把 transaction_id 写回单据。
 *
 * 必须与单据自己的写入在同一个 tx 里调用：单据落了库而分录没落，或者反过来，
 * 都会让「应收账龄表显示欠款、资产负债表显示零」这个缺陷以另一种形式回来。
 *
 * 幂等由 clientUuid 承担（见 documentClientUuid）。重放命中时 postJournal
 * 返回 deduplicated 且一个字节都不写，这里仍然执行一次 link——它是幂等的
 * update，而且能修好「上一次过账成功、写回失败」这种理论上的中间态。
 */
export async function postDocument(
  tx: Tx,
  ctx: OrgContext,
  posting: DocumentPosting,
): Promise<{ transactionId: string; deduplicated: boolean }> {
  assertPostableTotal(posting.event.amountMinor);

  const posted = await postJournal(tx, ctx, {
    event: posting.event,
    occurredOn: posting.occurredOn,
    description: posting.description,
    currency: posting.currency,
    manualRate: posting.manualRate,
    manualRateEntry: posting.manualRateEntry,
    // 单据事件一律落成 transaction_kind = 'journal'，不带分类——理由写在
    // server/domain/posting-templates.ts 的 kindFor 上。传 null 是那个约定
    // 的调用侧的一半，不是省略。
    categoryId: null,
    clientUuid: documentClientUuid(posting.document),
    sourceType: posting.document.kind,
    sourceId: posting.document.id,
  });

  await posting.link(tx, posted.transactionId);

  return posted;
}

/**
 * 单据被编辑之后，把它那笔分录整体重建。
 *
 * 不能走 postDocument：clientUuid 是由单据 id 派生的，postJournal 的幂等
 * 查询必然命中，于是用户改了金额、保存成功、账上一分钱都没变。
 * repostJournal 没有那次查询，改的就是原来那一行（见它自己的注释）。
 */
export async function repostDocument(
  tx: Tx,
  ctx: OrgContext,
  reposting: {
    transactionId: string;
    event: PostingEvent;
    occurredOn: string;
    description: string;
    currency: string;
    manualRate?: string;
    manualRateEntry: ManualRateEntry;
  },
): Promise<void> {
  assertPostableTotal(reposting.event.amountMinor);

  const existing = await getTransactionDetail(tx, ctx.organizationId, reposting.transactionId);

  if (existing.voidedAt) {
    // 已作废的分录不该被改回来。单据那边要么先解除作废（目前没有这个动作），
    // 要么重开一张——两种都比悄悄把一笔作废记录改活好。
    throw new LedgerError('This document was voided; its ledger entry can no longer be changed.');
  }

  await repostJournal(tx, ctx, {
    transactionId: reposting.transactionId,
    event: reposting.event,
    occurredOn: reposting.occurredOn,
    description: reposting.description,
    currency: reposting.currency,
    manualRate: reposting.manualRate,
    manualRateEntry: reposting.manualRateEntry,
    categoryId: null,
    existing: {
      occurredOn: existing.occurredOn,
      description: existing.description,
      currency: existing.currency,
      amountMinor: existing.amountMinor,
      baseAmountMinor: existing.baseAmountMinor,
      categoryId: existing.categoryId,
      // 单据没有「项目」这个概念，但重新过账时必须原样带回交易上已有的值——
      // 传 null 会把用户手工挂上去的项目在每次改单据时悄悄清掉。
      projectId: existing.projectId,
      exchangeRate: existing.exchangeRate,
      rateSource: existing.rateSource,
    },
  });
}

/**
 * 作废单据时连带作废它那笔分录。
 *
 * 只作废、不删除：账目要可追溯，删掉分录就查不出当初记了什么，
 * 而且 journal_lines 在数据库层面也没有 delete 策略。与
 * server/actions/transactions.ts 的 voidTransaction 同一套做法。
 *
 * 三个字段必须一起写：transactions_void_fields_together 要求
 * voided_at / voided_by / void_reason 同时存在且理由非空白（见 0001 迁移），
 * 所以 reason 在这里就先 trim 判空，而不是让用户读到一条 CHECK 约束报错。
 *
 * 期间锁定要查：一笔落在已封账月份里的应收，作废它就等于改动了已经出过
 * 报表的那个月。这与 voidTransaction 的判断逐字相同。
 *
 * 已经作废过则直接返回，不报错：用户的意图是「作废这张单据」，重放一次
 * 不该失败。markVoided 的 update 本身也是幂等的，但那样会覆盖掉原来的
 * 作废时间与理由，所以在这里短路。
 */
export async function voidDocumentPosting(
  tx: Tx,
  ctx: OrgContext,
  args: { transactionId: string; reason: string },
): Promise<void> {
  const reason = args.reason.trim();
  if (reason === '') {
    throw new LedgerError('Voiding a record needs a reason.');
  }

  const existing = await getTransactionDetail(tx, ctx.organizationId, args.transactionId);
  if (existing.voidedAt) return;

  assertPeriodOpen(existing.occurredOn, ctx.lockedUntil, ctx.role);

  await markVoided(tx, ctx.organizationId, args.transactionId, ctx.userId, reason);

  await recordAudit(tx, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: 'transaction.voided',
    entityType: 'transaction',
    entityId: args.transactionId,
    before: { voidedAt: null },
    after: { voidedAt: new Date().toISOString(), voidReason: reason },
  });
}

// ============================================================
// 六、单号的并发安全
// ============================================================

/** 同一张单据最多重算几次单号。见 withDocumentNumberRetry。 */
const DOCUMENT_NUMBER_ATTEMPTS = 5;

/**
 * 单号冲突时整笔重来。
 *
 * 问题：getNextInvoiceNumber / getNextBillNumber 是「读出当前最大号，加一」。
 * 两个并发的创建各自读到同一个最大号，于是算出同一个下一号，一个成功、
 * 另一个撞 invoices_org_number / bills_org_number 唯一约束。用户看到的是一句
 * 裸的 Postgres 约束报错，而他做的只是同时开了两张发票。发票接进总账之后
 * 这条路走得更频繁了，撞上的概率也就更高。
 *
 * 为什么不用 `select ... for update` 锁住「当前最大号那一行」——本仓库另外
 * 两处并发保护（0005 迁移的 app_accept_invitation、fixed_assets.ts 的
 * loadDepreciationPosting）用的都是这一招，看起来顺理成章，但在这里它**不成立**：
 *
 *   那两处锁的是一条「已经存在、且正是要改的」行，行锁确实挡得住并发修改。
 *   单号不是。这里要防的是 INSERT——而 READ COMMITTED 下 FOR UPDATE 挡不住
 *   幻读：T2 在那一行上等锁，T1 提交后 T2 拿到锁、用新快照重读**那一行**，
 *   但它不会重跑整个查询去发现 T1 新插入的行。于是 T2 读到的仍是同一个
 *   最大号，算出同一个下一号，冲突照撞。要靠锁解决，得锁一个所有创建者
 *   都会争用的**稳定**对象（比如 organizations 上那一行，或一个咨询锁），
 *   那等于把一家公司的开票串行化，还要额外依赖 organizations 的 UPDATE
 *   权限与 RLS 策略——为一个每天发生几次的操作引入这些，不划算。
 *
 * 所以用重试：冲突时整个事务已经回滚，一个字节都没写，重跑一遍会读到新的
 * 最大号。重跑包含过账也没有关系——clientUuid 由单据 id 派生，而上一次的
 * 单据 id 随事务一起消失了，重试拿到的是一个全新的 id，不存在把同一笔账
 * 记两次的可能。
 *
 * 只认这一个约束名。任何别的 23505（比如 transactions 上的
 * (organization_id, client_uuid)）都必须原样抛出去：那是幂等键真的撞了，
 * 重试只会把一个该被看见的问题变成一次沉默的重放。
 */
export async function withDocumentNumberRetry<T>(
  constraintName: string,
  attempt: () => Promise<T>,
): Promise<T> {
  for (let remaining = DOCUMENT_NUMBER_ATTEMPTS; remaining > 0; remaining -= 1) {
    try {
      return await attempt();
    } catch (error) {
      if (remaining === 1 || !isUniqueViolation(error, constraintName)) throw error;
      // 落到下一轮：上一次的事务已整体回滚，重跑会读到新的最大号。
    }
  }

  // 走不到：上面的循环要么 return，要么在最后一轮把错误抛出去。留着这句是
  // 为了让函数保持全函数，而不是靠一个 never 断言把类型系统糊过去。
  throw new LedgerError('Could not allocate a document number. Please try again.');
}

/** postgres.js 把 Postgres 的 ErrorResponse 字段按 snake_case 挂在错误对象上。 */
function isUniqueViolation(error: unknown, constraintName: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const pgError = error as { code?: unknown; constraint_name?: unknown };
  return pgError.code === '23505' && pgError.constraint_name === constraintName;
}

/**
 * 总额必须为正才过得了账。
 *
 * transactions.amount_minor 与 journal_lines.amount_minor 都有 > 0 的 CHECK，
 * 所以一张零额单据最终一定会失败——差别只在用户读到的是这一句，还是一条
 * 提到 journal_lines 的 Postgres 约束报错。
 */
function assertPostableTotal(amountMinor: bigint): void {
  if (amountMinor <= 0n) {
    throw new LedgerError('A document needs a total greater than zero before it can be posted.');
  }
}
