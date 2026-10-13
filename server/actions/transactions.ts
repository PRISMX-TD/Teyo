'use server';

import { revalidatePath } from 'next/cache';
import {
  createJournalSchema,
  createTransactionSchema,
  parseOrThrow,
  updateTransactionSchema,
  voidTransactionSchema,
} from '@/lib/schemas';
import { withTransaction, type Tx } from '@/server/db/transaction';
import { requirePermission } from '@/server/auth/guard';
import { LedgerError, type UserEntryKind } from '@/server/domain/ledger';
import { currencyExponent, parseDecimalToMinor } from '@/server/domain/money';
import type { PostingEvent } from '@/server/domain/posting-templates';
import { assertPeriodOpen } from '@/server/domain/period-lock';
import { canEditTransaction } from '@/server/domain/permissions';
import { findAccount, getMoneyAccount } from '@/server/repositories/accounts';
import { getCategoryWithAccount } from '@/server/repositories/categories';
import { recordAudit } from '@/server/repositories/audit-logs';
import { AuthError, type OrgContext } from '@/server/auth/guard';
import { moveTransactionAttachments } from '@/server/repositories/attachments';
import {
  findTransactionByClientUuid,
  findTransactionSource,
  getTransactionDetail,
  markVoided,
  type TransactionSource,
} from '@/server/repositories/transactions';
import { postJournal, repostJournal } from '@/server/posting/post-journal';

export type CreateTransactionInput = {
  kind: UserEntryKind;
  occurredOn: string;
  amount: string;
  currency: string;
  moneyAccountId: string;
  counterAccountId?: string;
  categoryId?: string;
  /** 交易归属的项目，可选。见 lib/schemas.ts 里 projectId 的注释。 */
  projectId?: string;
  description?: string;
  exchangeRate?: string;
  clientUuid: string;
};

/**
 * 解析出这笔交易的对方科目。
 *
 * 转账的对方是另一个资金账户；收支的对方是分类背后的记账科目。
 * 两条分支都必须重新按公司维度查库校验，不能相信客户端传来的 id。
 */
async function resolveCounterAccountId(
  tx: Tx,
  organizationId: string,
  input: {
    kind: UserEntryKind;
    moneyAccountId: string;
    counterAccountId?: string;
    categoryId?: string;
  },
): Promise<string> {
  if (input.kind === 'journal') {
    // Journal entries use two arbitrary accounts, no category needed.
    // This function shouldn't be called for journal - the caller should handle it.
    throw new LedgerError('Journal entries do not use categories.');
  }

  if (input.kind === 'transfer') {
    if (!input.counterAccountId) {
      // counterAccountId 是转出方（表单标签 t.transaction.sourceAccount，
      // 「从哪个账户转出」）；转入方是 moneyAccountId，前面已经查过了。
      throw new LedgerError('A transfer needs a source account.');
    }
    const counter = await getMoneyAccount(tx, organizationId, input.counterAccountId);
    // 转账两端必须是不同账户。templateFor 里有同一条断言兜底，这一层留着
    // 是因为它更早触发、且此时还知道是哪个字段填错了。
    if (counter.id === input.moneyAccountId) {
      throw new LedgerError('This operation requires two different accounts.');
    }
    return counter.id;
  }

  if (!input.categoryId) {
    throw new LedgerError('Income and expense records need a category.');
  }

  const category = await getCategoryWithAccount(tx, organizationId, input.categoryId, input.kind);
  return category.accountId;
}

/**
 * 把「资金账户 + 对方科目」这套用户视角的说法翻译成 PostingEvent。
 *
 * 收入的对方是收入科目，支出的对方是费用科目。
 *
 * 转账这一对是反的，务必看清：表单里 moneyAccountId 那个选择器的标签是
 * transaction.destinationAccount，counterAccountId 的标签是
 * sourceAccount（见 transaction-form.tsx 的 transfer 分支）——资金账户是
 * 转入方，对方科目才是转出方。所以这里必须映射成
 * toAccountId = moneyAccountId / fromAccountId = counterAccountId，而
 * templateFor 的 transfer 分支再把 toAccountId 记借方、fromAccountId 记贷方
 * （见 server/domain/posting-templates.ts 的 accountPair——那是记账方向的
 * 唯一定义）。掉个个儿的分录照样配平，看板上的总额也一分不差。
 */
function toPostingEvent(
  kind: UserEntryKind,
  moneyAccountId: string,
  counterAccountId: string,
  amountMinor: bigint,
): PostingEvent {
  switch (kind) {
    case 'income':
      return { type: 'income', moneyAccountId, revenueAccountId: counterAccountId, amountMinor };
    case 'expense':
      return { type: 'expense', moneyAccountId, expenseAccountId: counterAccountId, amountMinor };
    case 'transfer':
      return {
        type: 'transfer',
        fromAccountId: counterAccountId, // 转出方
        toAccountId: moneyAccountId, // 转入方
        amountMinor,
      };
    case 'journal':
      // 到不了：resolveCounterAccountId 对 journal 先抛错。createJournal 自己
      // 组装 journal 事件，不经过这里。
      throw new LedgerError('Journal entries do not use categories.');
  }
}

/**
 * 创建一笔交易：金额解析、汇率、分录生成、期间锁定与审计，全部在一个事务内完成。
 *
 * 幂等：同一 client_uuid 重复提交不报错，直接返回已有记录并置 deduplicated=true，
 * 这样 PWA 的离线重试队列不会造成重复账目。
 */
export async function createTransaction(
  orgSlug: string,
  input: CreateTransactionInput,
): Promise<{ id: string; deduplicated: boolean }> {
  const context = await requirePermission(orgSlug, 'transaction:create');

  // 入参校验在最前面，早于期间锁定与任何数据库往返。
  //
  // CreateTransactionInput 是 TypeScript 类型，运行时不存在——Server Action
  // 收到的是网络上的任意 JSON，形状由调用方说了算。下面这一路的每一步都
  // 默认入参「至少是那个形状」：resolveCounterAccountId 只在 kind 上分支，
  // 不管 transfer 有没有同时带着 categoryId；parseDecimalToMinor 只认小数串，
  // 拿到 undefined 会抛一句提到变量名的报错。createTransactionSchema 把这些
  // 前提一次性验完，且给的是完整句子而不是 zod 默认文案（见 parseOrThrow）。
  const parsed = parseOrThrow(createTransactionSchema, input, (m) => new LedgerError(m));

  // 期间锁定在进事务前先判，省掉一次注定要回滚的写入。
  assertPeriodOpen(parsed.occurredOn, context.lockedUntil, context.role);

  const result = await withTransaction(context.userId, (tx) =>
    insertUserEntry(tx, context, parsed),
  );

  revalidatePath(`/${orgSlug}/transactions`);
  return result;
}

type ParsedCreateTransaction = ReturnType<typeof createTransactionSchema.parse>;

/**
 * createTransaction 在事务里的那一段，replaceTransaction 也用它——两条路径
 * 建出来的交易必须是同一个形状，不能一条带项目、另一条漏掉。
 */
async function insertUserEntry(
  tx: Tx,
  context: OrgContext,
  parsed: ParsedCreateTransaction,
): Promise<{ id: string; deduplicated: boolean }> {
  // 幂等短路留在解析入参之前，而不是全部交给 postJournal 的第 2 步：
  // 离线队列重放的是几分钟前就已入账成功的那一笔，若期间分类被停用或
  // 删除，先解析入参会让这次重放报错——用户看到的是一条明明成功过的
  // 记录突然失败。postJournal 里的那次查询仍在，是结构性兜底。
  const existing = await findTransactionByClientUuid(
    tx,
    context.organizationId,
    parsed.clientUuid,
  );
  if (existing) {
    return { id: existing.id, deduplicated: true };
  }

  const moneyAccount = await getMoneyAccount(tx, context.organizationId, parsed.moneyAccountId);
  const counterAccountId = await resolveCounterAccountId(tx, context.organizationId, {
    kind: parsed.kind,
    moneyAccountId: moneyAccount.id,
    counterAccountId: parsed.counterAccountId,
    categoryId: parsed.categoryId,
  });

  const amountMinor = parseDecimalToMinor(parsed.amount, currencyExponent(parsed.currency));

  const posted = await postJournal(tx, context, {
    event: toPostingEvent(parsed.kind, moneyAccount.id, counterAccountId, amountMinor),
    occurredOn: parsed.occurredOn,
    description: parsed.description,
    currency: parsed.currency,
    manualRate: parsed.exchangeRate,
    // 交易表单上就有 RateField，查不到缓存汇率时让用户当场填一个。
    manualRateEntry: 'available',
    categoryId: parsed.categoryId ?? null,
    projectId: parsed.projectId ?? null,
    clientUuid: parsed.clientUuid,
  });

  return { id: posted.transactionId, deduplicated: posted.deduplicated };
}

export type CreateJournalInput = {
  occurredOn: string;
  amount: string;
  currency?: string;
  debitAccountId: string;
  creditAccountId: string;
  /**
   * 交易归属的项目，可选。「不确定」场景的表单上有项目下拉
   * （transaction-form.tsx），这里原来没有这个字段，选了也被静默丢掉。
   */
  projectId?: string;
  description?: string;
  clientUuid: string;
};

/**
 * 通用记账凭证：任意两个科目之间的借贷分录。
 *
 * 不限制一方必须是资金账户——用户可以把任何科目配成一对：
 *   现金 → 无形资产（资本化研发投入）
 *   预付费用 → 现金（预付一年租金）
 *   折旧 → 累计折旧（非现金的折旧分录）
 *
 * 与 createTransaction 一样享有幂等保护。
 *
 * currency 可省，省略即本位币，此时 resolveRate 不查表直接返回 1。真的传了
 * 外币，就跟别的写入点走同一条路：查缓存汇率，查不到即报错。以前这里是
 * 硬写 scaledRate = RATE_SCALE、rateSource = 'auto'，等于把一笔外币凭证按
 * 编造出来的 1:1 记进账，事后从数据里也看不出来。
 */
export async function createJournal(
  orgSlug: string,
  input: CreateJournalInput,
): Promise<{ id: string; deduplicated: boolean }> {
  const context = await requirePermission(orgSlug, 'transaction:create');

  // 与 createTransaction 同理：入参是网络上的任意 JSON，先验形状再做别的。
  // 原来这里一个字段都不验，日期是什么串就拿什么串去判封账。
  const parsed = parseOrThrow(createJournalSchema, input, (m) => new LedgerError(m));
  assertPeriodOpen(parsed.occurredOn, context.lockedUntil, context.role);

  const clientUuid = parsed.clientUuid;
  const baseCurrency = context.baseCurrency;

  const result = await withTransaction(context.userId, async (tx) => {
    // 与 createTransaction 同理：幂等短路排在解析科目之前，重放不该因为
    // 某个科目事后被停用而报错。postJournal 里的那次查询是结构性兜底。
    const existing = await findTransactionByClientUuid(tx, context.organizationId, clientUuid);
    if (existing) {
      return { id: existing.id, deduplicated: true };
    }

    const debitAccount = await findAccount(tx, context.organizationId, parsed.debitAccountId);
    if (!debitAccount) throw new LedgerError('The debit account was not found.');
    if (!debitAccount.isActive) throw new LedgerError(`Account ${debitAccount.code} is archived.`);

    const creditAccount = await findAccount(tx, context.organizationId, parsed.creditAccountId);
    if (!creditAccount) throw new LedgerError('The credit account was not found.');
    if (!creditAccount.isActive) throw new LedgerError(`Account ${creditAccount.code} is archived.`);

    if (parsed.debitAccountId === parsed.creditAccountId) {
      throw new LedgerError('Debit and credit must be different accounts.');
    }

    const currency = parsed.currency ?? baseCurrency;
    const amountMinor = parseDecimalToMinor(parsed.amount, currencyExponent(currency));

    const posted = await postJournal(tx, context, {
      event: {
        type: 'journal',
        debitAccountId: debitAccount.id,
        creditAccountId: creditAccount.id,
        amountMinor,
      },
      occurredOn: parsed.occurredOn,
      description: parsed.description,
      currency,
      // 手工凭证没有汇率输入框：CreateJournalInput 里根本没有 exchangeRate，
      // journal-form.tsx 与 transaction-form.tsx 的 not-sure 分支都硬传本位币。
      manualRateEntry: 'unavailable',
      categoryId: null,
      projectId: parsed.projectId ?? null,
      clientUuid,
    });

    return { id: posted.transactionId, deduplicated: posted.deduplicated };
  });

  revalidatePath(`/${orgSlug}/transactions`);
  revalidatePath(`/${orgSlug}/reports`);
  return result;
}

/** 拒绝信息里给人看的单据名称，与详情页「由……生成」那行说的是同一张单据。 */
const SOURCE_NOUN: Record<TransactionSource['type'], string> = {
  invoice: 'invoice',
  bill: 'bill',
  credit_note: 'credit note',
  payment: 'payment',
  depreciation: 'depreciation run of fixed asset',
  year_end: 'year-end close',
  asset_disposal: 'disposal of fixed asset',
};

/**
 * 单据生成的分录只能从单据那一侧改或撤销。
 *
 * 发票、账单、贷项通知单、收付款、折旧、年结、资产处置都是单据反向指着
 * 交易（transactions 上没有来源列，见 findTransactionSource）。从交易页把
 * 分录单独作废或改掉，单据却还停在「已开具 / 已付款 / 已计提」，应收应付
 * 明细账与总账从此对不上，而且单据自己的作废路径再走一遍时会撞上
 * 「already voided」。单据的作废（voidInvoice、voidBill……）走的是
 * voidDocumentPosting → markVoided，不经过这两个 Action，所以拦在这里
 * 不会误伤它们。
 */
async function assertNotDocumentGenerated(
  tx: Tx,
  organizationId: string,
  id: string,
  verb: 'voided' | 'edited',
): Promise<void> {
  const source = await findTransactionSource(tx, organizationId, id);
  if (!source) return;
  const noun = SOURCE_NOUN[source.type];
  const named = source.label ? `${noun} ${source.label}` : noun;
  throw new LedgerError(
    `This entry was generated by ${named} and cannot be ${verb} here. Change or void it from that document instead.`,
  );
}

export type UpdateTransactionInput = {
  occurredOn: string;
  amount: string;
  currency: string;
  moneyAccountId: string;
  counterAccountId?: string;
  categoryId?: string;
  /** 交易归属的项目，可选。见 lib/schemas.ts 里 projectId 的注释。 */
  projectId?: string;
  description?: string;
  exchangeRate?: string;
};

/**
 * 编辑一笔交易。
 *
 * 只要 transaction:read 就能进来，真正的授权靠 canEditTransaction：
 * bookkeeper 只能改自己录的，owner/admin 可以改任何人的。用
 * transaction:create 做门槛是不对的——viewer 与 bookkeeper 的区别不在能否
 * 创建，而在能否改哪些记录。
 *
 * 这里只做入参解析与授权：作废判定、canEditTransaction、kind 不可改、
 * 资金账户与对方科目的公司维度校验。期间检查、汇率决策、分录重建与审计
 * 全在 repostJournal 里——包括「未改币种与日期时复用既有汇率」那条规则，
 * 它必须由边界依据 existing 行自己判断，而不是由调用方算好汇率传进去。
 */
export async function updateTransaction(
  orgSlug: string,
  id: string,
  input: UpdateTransactionInput,
): Promise<void> {
  const context = await requirePermission(orgSlug, 'transaction:read');

  await withTransaction(context.userId, async (tx) => {
    const existing = await getTransactionDetail(tx, context.organizationId, id);

    if (existing.voidedAt) {
      throw new AuthError('forbidden', 'This record is voided and can no longer be edited.');
    }

    if (!canEditTransaction(context.role, existing.createdBy === context.userId)) {
      throw new AuthError('forbidden', 'Your role cannot edit this record.');
    }

    // 单据生成的分录排在 kind 判断之前：发票、账单的分录 kind 都是 journal，
    // 不先拦，用户拿到的是下面那句「Journal entries do not use categories.」，
    // 说的是对的，却没告诉他该去哪里改。
    await assertNotDocumentGenerated(tx, context.organizationId, id, 'edited');

    // kind 不可改：改了就等于换一笔账，分录方向、分类与对方账户全都得重来，
    // 让用户作废重录更清晰，也让审计留下两条独立记录。
    const kind = existing.kind;

    // journal 在这里先单独挡下来。updateTransactionSchema 的 kind 是
    // income/expense/transfer 三选一，把 'journal' 喂进去只会得到一句
    // 「Invalid enum value」——而用户真正需要知道的是「这类记录不能编辑」。
    // 界面上本来就不渲染 journal 的编辑表单（见 app/(app)/[orgSlug]/
    // transactions/[id]/page.tsx），所以走到这里的只可能是直接调 Action 的人。
    if (kind === 'journal') {
      throw new LedgerError('Journal entries do not use categories.');
    }

    // 年结分录同理，而且理由更硬：它是一整个财年损益的结转，改动它等于
    // 悄悄改写已经定案的年度利润。要撤销只能走
    // server/actions/year-end.ts 的 undoFiscalYearCloseAction——那条路径会
    // 连同 fiscal_year_closings 的登记一起撤掉，两边不会各说各的。
    if (kind === 'closing') {
      throw new LedgerError(
        'Year-end closing entries cannot be edited. Undo the year-end close instead.',
      );
    }

    // 校验放在读出 existing 之后，原因只有一个：kind 由库里那一行说了算，
    // 不由客户端说了算，而「收支必须有分类、转账必须有对方账户」这组规则
    // 恰恰要按 kind 分支。先读后验，验的才是这笔账真实的形状。
    //
    // 注意这个顺序也决定了错误的优先级：不存在 / 已作废 / 无权编辑这三条
    // 依然排在字段校验前面——它们说的是「这件事你做不了」，比「这个字段
    // 填错了」更该先说。
    const parsed = parseOrThrow(
      updateTransactionSchema,
      { ...input, id, kind },
      (m) => new LedgerError(m),
    );

    const moneyAccount = await getMoneyAccount(tx, context.organizationId, parsed.moneyAccountId);
    const counterAccountId = await resolveCounterAccountId(tx, context.organizationId, {
      kind,
      moneyAccountId: moneyAccount.id,
      counterAccountId: parsed.counterAccountId,
      categoryId: parsed.categoryId,
    });

    const amountMinor = parseDecimalToMinor(parsed.amount, currencyExponent(parsed.currency));

    await repostJournal(tx, context, {
      transactionId: id,
      event: toPostingEvent(kind, moneyAccount.id, counterAccountId, amountMinor),
      occurredOn: parsed.occurredOn,
      description: parsed.description,
      currency: parsed.currency,
      manualRate: parsed.exchangeRate,
      // 编辑走的是同一张表单，RateField 同样在。
      manualRateEntry: 'available',
      categoryId: parsed.categoryId ?? null,
      projectId: parsed.projectId ?? null,
      existing: {
        occurredOn: existing.occurredOn,
        description: existing.description,
        currency: existing.currency,
        amountMinor: existing.amountMinor,
        baseAmountMinor: existing.baseAmountMinor,
        categoryId: existing.categoryId,
        projectId: existing.projectId,
        exchangeRate: existing.exchangeRate,
        rateSource: existing.rateSource,
      },
    });
  });

  revalidatePath(`/${orgSlug}`);
  revalidatePath(`/${orgSlug}/transactions`);
  revalidatePath(`/${orgSlug}/transactions/${id}`);
}

/**
 * 作废一笔交易。分录保留不动——账目要可追溯，删掉分录就查不出当初记了什么。
 * 数据库层也没有 delete 策略，硬删除在那一层就不可能。
 */
export async function voidTransaction(
  orgSlug: string,
  id: string,
  reason: string,
): Promise<void> {
  const context = await requirePermission(orgSlug, 'transaction:read');

  // 原来这里只有一句 reason.trim() === ''，id 则是一路裸传到 SQL。
  // voidTransactionSchema 把两件事一起管住：理由非空且不超过 300 字
  // （void_reason 列的长度），id 必须是 uuid。
  const { reason: cleanReason } = parseOrThrow(
    voidTransactionSchema,
    { id, reason },
    (m) => new LedgerError(m),
  );

  await withTransaction(context.userId, (tx) => voidUserEntry(tx, context, id, cleanReason));

  revalidatePath(`/${orgSlug}`);
  revalidatePath(`/${orgSlug}/transactions`);
  revalidatePath(`/${orgSlug}/transactions/${id}`);
}

/**
 * voidTransaction 在事务里的那一段。replaceTransaction 作废原交易时走同一条，
 * 所以「已作废的不能再作废」「年结与单据分录不能单独作废」「封账期内不能动」
 * 这几道门不会因为换了个入口就少一道。
 *
 * extraAudit 并进审计记录的 after：换类型重录时记下接替它的那一笔是谁。
 */
async function voidUserEntry(
  tx: Tx,
  context: OrgContext,
  id: string,
  cleanReason: string,
  extraAudit: Record<string, unknown> = {},
): Promise<void> {
  const existing = await getTransactionDetail(tx, context.organizationId, id);

  if (existing.voidedAt) {
    throw new AuthError('forbidden', 'This record is already voided.');
  }

  if (!canEditTransaction(context.role, existing.createdBy === context.userId)) {
    throw new AuthError('forbidden', 'Your role cannot void this record.');
  }

  // 年结分录不能单独作废，理由与 updateTransaction 里那一条相同：作废它等于
  // 把一整年的损益结转悄悄撤掉，而 fiscal_year_closings 里那条登记还在，
  // 两边从此各说各的。撤销只能走 undoFiscalYearCloseAction。
  if (existing.kind === 'closing') {
    throw new LedgerError(
      'Year-end closing entries cannot be voided. Undo the year-end close instead.',
    );
  }

  // 其余单据生成的分录（发票、账单、收付款、折旧……）同理，见
  // assertNotDocumentGenerated。年结分录在 fiscal_year_closings 里也有登记，
  // 上面那条已经先给出了更具体的说法。
  await assertNotDocumentGenerated(tx, context.organizationId, id, 'voided');

  assertPeriodOpen(existing.occurredOn, context.lockedUntil, context.role);

  await markVoided(tx, context.organizationId, id, context.userId, cleanReason);

  await recordAudit(tx, {
    organizationId: context.organizationId,
    actorUserId: context.userId,
    action: 'transaction.voided',
    entityType: 'transaction',
    entityId: id,
    before: { voidedAt: null },
    after: { voidedAt: new Date().toISOString(), voidReason: cleanReason, ...extraAudit },
  });
}

export type ReplaceTransactionInput = CreateTransactionInput & {
  /** 写进原交易的作废理由。表单按当前语言拼好，服务端照常校验。 */
  voidReason: string;
};

/**
 * 换类型重录：新建一笔、把收据挪过去、作废原来那笔，三件事一个事务。
 *
 * updateTransaction 不让改 kind（理由在那里：换了 kind 就是换了一笔账，分录
 * 方向、分类与对方账户全得重来）。于是想把记成「支出」的一笔改成「转账」，
 * 原来只能自己先作废、再从头录一遍——中间任何一步断了，作废了却没重录、
 * 或者重录了却忘了作废，账上就少一笔或多一笔，而且没有任何东西会提醒他。
 * 放进同一个事务，这两种半途状态就不存在了。
 *
 * 审计里仍然是两条独立的记录（新建一条、transaction.voided 一条），作废那条
 * 的 after 记着 replacedBy，日后查得到这两笔说的是同一件事。
 *
 * 幂等：clientUuid 撞上已有记录时直接返回它，不再作废第二次——那一笔若是
 * 由这里建出来的，原交易在同一个事务里已经作废了。
 */
export async function replaceTransaction(
  orgSlug: string,
  originalId: string,
  input: ReplaceTransactionInput,
): Promise<{ id: string; deduplicated: boolean }> {
  const context = await requirePermission(orgSlug, 'transaction:create');

  const { voidReason, ...entry } = input;
  const parsed = parseOrThrow(createTransactionSchema, entry, (m) => new LedgerError(m));
  const { reason: cleanReason } = parseOrThrow(
    voidTransactionSchema,
    { id: originalId, reason: voidReason },
    (m) => new LedgerError(m),
  );
  assertPeriodOpen(parsed.occurredOn, context.lockedUntil, context.role);

  const result = await withTransaction(context.userId, async (tx) => {
    const original = await getTransactionDetail(tx, context.organizationId, originalId);
    // 单据生成的分录排在 kind 判断之前，理由同 updateTransaction：它们的 kind
    // 都是 journal，不先拦，用户听到的是下面那句「只有收支转能换」——说的
    // 是对的，却没告诉他该回哪张单据去改。
    await assertNotDocumentGenerated(tx, context.organizationId, originalId, 'edited');
    // 凭证与年结分录没有「收、支、转」可换。年结 voidUserEntry 自己会拒；凭证
    // 在这里先挡，它在界面上本来就没有换类型的入口。
    if (original.kind === 'journal' || original.kind === 'closing') {
      throw new LedgerError(
        'Only money-in, money-out and transfer records can be re-entered as another type.',
      );
    }

    const created = await insertUserEntry(tx, context, parsed);
    if (created.deduplicated) return created;

    const moved = await moveTransactionAttachments(
      tx,
      context.organizationId,
      originalId,
      created.id,
    );
    await voidUserEntry(tx, context, originalId, cleanReason, {
      replacedBy: created.id,
      attachmentsMoved: moved,
    });
    return created;
  });

  revalidatePath(`/${orgSlug}`);
  revalidatePath(`/${orgSlug}/transactions`);
  revalidatePath(`/${orgSlug}/transactions/${originalId}`);
  return result;
}
