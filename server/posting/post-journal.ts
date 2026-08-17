import type { Tx } from '@/server/db/transaction';
import type { OrgContext } from '@/server/auth/guard';
import { assertPeriodOpen } from '@/server/domain/period-lock';
import {
  buildCheckedLines,
  LedgerError,
  type DraftJournalLine,
  type TransactionKind,
} from '@/server/domain/ledger';
import { templateFor, type PostingEvent } from '@/server/domain/posting-templates';
import { parseRateToScaled, type RateSource } from '@/server/domain/exchange-rate';
import { resolveRate, type ManualRateEntry } from '@/server/posting/rate';
import { recordAudit } from '@/server/repositories/audit-logs';
import {
  findTransactionByClientUuid,
  updateTransactionHead,
} from '@/server/repositories/transactions';
import {
  deleteJournalLines,
  insertJournalLines,
  insertTransaction,
  loadJournalLines,
  type AccountCodesById,
} from '@/server/posting/insert';

/** 两个入口共有的记账内容：记什么、记多少、记在哪一天。 */
type PostingCore = {
  event: PostingEvent;
  occurredOn: string; // YYYY-MM-DD
  description: string;
  currency: string;
  /** 用户手工输入的汇率；未提供时由 resolveRate 查缓存。 */
  manualRate?: string;
  /**
   * 这个入口的界面上有没有能填汇率的地方。查不到缓存汇率时，那句报错要
   * 据此告诉用户接下来做什么——见 server/posting/rate.ts 上的 ManualRateEntry。
   * 必填：只有调用方知道自己的表单长什么样。
   */
  manualRateEntry: ManualRateEntry;
  categoryId: string | null;
};

export type PostJournalInput = PostingCore & {
  clientUuid: string;
  sourceType?: string | null;
  sourceId?: string | null;
};

/**
 * 记账凭证的唯一写入出口。
 *
 * 在这之前，insertTransaction/insertJournalLines 在三个地方各自被直接调用
 * （createTransaction、createJournal、generateDueRecurring、postDepreciation），
 * 行级不变量与账户归属校验是否执行，全凭每个调用方自己记得——这是约定，
 * 不是结构性保证，任何新写入点都可能漏掉。postJournal 把这十个步骤钉死
 * 成固定顺序，往后任何记账都必须经过这里。
 *
 * 内部固定顺序（不可跳步、不可重排）：
 *   1. assertPeriodOpen  —— 先判期间是否封账。
 *   2. clientUuid 幂等查询 —— 命中则直接返回，不做任何写入。
 *   3. resolveRate —— 查不到即抛错，绝不回退 1。
 *   4. templateFor(event) —— 映射成一对草稿分录。
 *   5-6. buildCheckedLines —— 换算本位币金额（内部已做 assertBalanced），
 *      再核对行级不变量。两步绑成一个函数，且必须在任何 insert 之前。
 *   7. insertTransaction —— 写交易表头。
 *   8. insertJournalLines —— 写分录行；写入前会核实每个 accountId 属于本公司
 *      （PostgreSQL 的外键校验不受 RLS 约束，这一步不能省，见 insert.ts）。
 *   9. recordAudit —— 与业务写入同事务，回滚时一起回滚。
 *   10. 返回 { transactionId, deduplicated: false }。
 *
 * 第 3-6 步在 buildValidatedLines 里，与编辑路径 repostJournal 共用同一份
 * 实现——见那个函数的注释。
 *
 * 两处顺序尤其不能挪动：
 *
 * 幂等查询必须夹在期间检查之后、汇率解析之前。放在期间检查之前，一次
 * 重放就能绕开封账；放在汇率解析之后，一笔根本不需要再写入的重放会
 * 白白查一次汇率——汇率缓存缺失时，还会把一笔早已成功的重放变成报错，
 * 三种排序里这是最差的结果：用户看到的是一条明明成功过的记录突然失败。
 *
 * assertBalanced（buildLines 内部）与 assertLineInvariants 必须都在任何
 * insert 之前跑完，而不是先插入部分行、指望 withTransaction 的回滚去
 * 撤销。回滚确实能保证数据库最终状态正确，但那是「出错后清理」，不是
 * 「从未构造出错误的行」——先validate 再 insert 才是本任务要把约定
 * 变成结构的地方。
 */
export async function postJournal(
  tx: Tx,
  ctx: OrgContext,
  input: PostJournalInput,
): Promise<{ transactionId: string; deduplicated: boolean }> {
  // 1. 期间检查——省掉一次注定要回滚的写入。
  assertPeriodOpen(input.occurredOn, ctx.lockedUntil, ctx.role);

  // 2. 幂等查询。命中直接返回，不碰 resolveRate，也不写任何行。
  const existing = await findTransactionByClientUuid(tx, ctx.organizationId, input.clientUuid);
  if (existing) {
    return { transactionId: existing.id, deduplicated: true };
  }

  // 3-6. 汇率 -> 模板 -> 换算 -> 行级不变量，全部在任何 insert 之前。
  const { lines, scaledRate, rateSource } = await buildValidatedLines(tx, ctx, {
    event: input.event,
    occurredOn: input.occurredOn,
    currency: input.currency,
    manualRate: input.manualRate,
    manualRateEntry: input.manualRateEntry,
  });

  const kind = input.event.type;
  const categoryId = categoryForKind(kind, input.categoryId);

  // 取自分录行而非另算一遍：表头金额与分录必须同源，否则两者可能不一致，
  // 而数据库的平衡触发器只看分录、看不到表头。templateFor 的四种模板都把
  // 借方放在第一行，所以 lines[0] 就是这笔交易的本位币金额。
  const baseAmountMinor = lines[0].baseAmountMinor;

  // 7. 写交易表头。
  const { id: transactionId } = await insertTransaction(tx, {
    organizationId: ctx.organizationId,
    kind,
    occurredOn: input.occurredOn,
    description: input.description,
    currency: input.currency,
    amountMinor: input.event.amountMinor,
    baseAmountMinor,
    scaledRate,
    rateSource,
    categoryId,
    createdBy: ctx.userId,
    clientUuid: input.clientUuid,
  });

  // 8. 写分录行。insertJournalLines 内部会先核实每个 accountId 属于本公司，
  // 并把那次查询顺手取到的 id -> code 带回来给审计用。
  const accountCodes = await insertJournalLines(tx, ctx.organizationId, transactionId, lines);

  // 9. 审计，与业务写入同事务。
  await recordAudit(tx, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: 'transaction.created',
    entityType: 'transaction',
    entityId: transactionId,
    after: {
      kind,
      occurredOn: input.occurredOn,
      description: input.description,
      currency: input.currency,
      // bigint 不能直接进 JSON，统一转字符串，保持 jsonb 可查询。
      amountMinor: input.event.amountMinor.toString(),
      baseAmountMinor: baseAmountMinor.toString(),
      rateSource,
      categoryId,
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      lines: auditLines(lines, accountCodes),
    },
  });

  // 10. 返回。
  return { transactionId, deduplicated: false };
}

/** 编辑前这一行的样子。全部取自调用方已经查过的那条记录，绝不在这里重查。 */
export type ExistingTransactionRow = {
  occurredOn: string; // YYYY-MM-DD
  description: string;
  currency: string;
  amountMinor: bigint;
  baseAmountMinor: bigint;
  categoryId: string | null;
  /** 库里存的十进制字符串（numeric(20,8)），由 parseRateToScaled 转回定标整数。 */
  exchangeRate: string;
  rateSource: RateSource;
};

export type RepostJournalInput = PostingCore & {
  transactionId: string;
  existing: ExistingTransactionRow;
};

/**
 * 编辑一笔已有交易的记账出口。
 *
 * 为什么不是 postJournal 加一个 replace 参数，而是另一个函数：加参数意味着
 * 十个步骤里的每一步读者都要先判断走的是哪一条分支，某一支漏掉的校验在另
 * 一支里看不出来。两个各自线性的函数共用 buildValidatedLines 一个私有实现，
 * 校验序列只有一份，两个入口谁也漂移不了。
 *
 * 与 postJournal 恰好差四处：
 *
 * 1. 没有 clientUuid 幂等查询。被编辑的这一行本来就带着那个 clientUuid，
 *    照 postJournal 的顺序走一遍必然命中，返回 deduplicated 然后一个字节
 *    都不写——用户的修改看起来保存成功，实际什么也没发生。
 *
 *    重复提交靠的是别的东西。这里原来写的是「乐观并发」——代码里没有这个
 *    东西：transactions 上没有版本列，updateTransactionHead 的 where 只有
 *    id 与 organization_id，没有任何「你读到的还是不是这一版」的条件。
 *    真正起作用的是第 7 步排在第 8 步之前：那条 update 会在这一行上取到
 *    行级排他锁，于是同一笔交易的两次并发保存被串起来，后一次要等前一次
 *    提交才动得了分录。反过来先删后插再改表头的话，两个事务可以在谁都还
 *    没拿到表头锁之前各自重建一遍分录行。而每次保存都是整体替换（表头覆盖
 *    + 分录全删全插），串起来之后跑两遍与跑一遍的结果相同。
 * 2. 期间检查查两个日期。只查其一就能把一条记录搬进或搬出锁定区间：
 *    只查新日期，锁定期内的记录可以被改到开放日期；只查原日期，开放期的
 *    记录可以被塞进锁定期。
 * 3. updateTransactionHead 而不是 insertTransaction —— 改的是原来那一行。
 * 4. 分录先删后插。journal_lines 的配平触发器是延迟约束，同一事务内
 *    删完再插不会中途报错，提交时才校验最终状态。两个调用都留在边界内：
 *    server/actions/ 同样不该直接持有 deleteJournalLines。
 */
export async function repostJournal(
  tx: Tx,
  ctx: OrgContext,
  input: RepostJournalInput,
): Promise<{ transactionId: string }> {
  const { existing } = input;

  // 1. 期间检查——原日期与新日期都必须落在开放区间内。
  assertPeriodOpen(existing.occurredOn, ctx.lockedUntil, ctx.role);
  assertPeriodOpen(input.occurredOn, ctx.lockedUntil, ctx.role);

  // 2. 汇率：没提交手工汇率、且币种和日期都没变时，直接沿用这笔交易当初记的
  // 汇率与来源，不再重新解析。RateField 在这种情况下就是这么显示的（见
  // rate-field.tsx 的 initialRate/initialSource）——如果每次保存都重新解析，
  // 两边就会对不上：exchange_rates 只由每天的 cron upsert「今天」这一格
  // （见 app/api/cron/exchange-rates/route.ts），所以早上记一笔外币交易时
  // findRate 的 7 天回溯会命中前一个营业日的汇率并存成 auto；同一天晚些
  // 时候 cron 把「今天」这一格填上后，若只是改个备注就保存，重新解析会查到
  // 当天的精确汇率，把汇率和本位币金额悄悄换成屏幕上从未展示过的另一个值。
  //
  // 这个判断必须留在边界内部、只依据传进来的 existing 行来做。若改成由调用
  // 方算好汇率再传进来，任何调用方都能注入一个任意的 scaledRate——边界就漏了。
  // 币种或日期真的变了、或者用户主动填了手工汇率，才应该重新解析，那三种
  // 情况都会让这个条件为 false，直接落回 resolveRate。
  const reuseStoredRate =
    input.manualRate === undefined &&
    input.currency === existing.currency &&
    input.occurredOn === existing.occurredOn;

  // 3-6. 汇率 -> 模板 -> 换算 -> 行级不变量，与创建路径同一份实现。
  const { lines, scaledRate, rateSource } = await buildValidatedLines(tx, ctx, {
    event: input.event,
    occurredOn: input.occurredOn,
    currency: input.currency,
    manualRate: input.manualRate,
    manualRateEntry: input.manualRateEntry,
    storedRate: reuseStoredRate
      ? { scaledRate: parseRateToScaled(existing.exchangeRate), source: existing.rateSource }
      : undefined,
  });

  const kind = input.event.type;
  const categoryId = categoryForKind(kind, input.categoryId);
  // 与创建路径同理：表头金额取自分录，数据库的平衡触发器看不到表头。
  const baseAmountMinor = lines[0].baseAmountMinor;

  // 7. 改表头。
  await updateTransactionHead(tx, ctx.organizationId, input.transactionId, {
    occurredOn: input.occurredOn,
    description: input.description,
    currency: input.currency,
    amountMinor: input.event.amountMinor,
    baseAmountMinor,
    scaledRate,
    rateSource,
    categoryId,
  });

  // 8. 分录整体重建，而不是原地改。
  //
  // 先把旧分录读出来给审计的 before 用——删掉之后就读不到了。放在 delete
  // 前一行而不是函数开头，是为了让这个先后关系在读代码时是看得见的。
  const previousLines = await loadJournalLines(tx, ctx.organizationId, input.transactionId);
  await deleteJournalLines(tx, ctx.organizationId, input.transactionId);
  const accountCodes = await insertJournalLines(
    tx,
    ctx.organizationId,
    input.transactionId,
    lines,
  );

  // 9. 审计，与业务写入同事务。before 全部来自调用方已查过的 existing 行。
  await recordAudit(tx, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: 'transaction.updated',
    entityType: 'transaction',
    entityId: input.transactionId,
    before: {
      occurredOn: existing.occurredOn,
      description: existing.description,
      currency: existing.currency,
      amountMinor: existing.amountMinor.toString(),
      baseAmountMinor: existing.baseAmountMinor.toString(),
      rateSource: existing.rateSource,
      categoryId: existing.categoryId,
      // 改科目是编辑里最常见的一种，而只记表头的话它完全看不出来：把一笔
      // 支出从「水电」改挂到「交通」，before 与 after 的每一个表头字段都
      // 一模一样。after 一直带着分录与科目代码，before 补齐才对称。
      lines: previousLines,
    },
    after: {
      occurredOn: input.occurredOn,
      description: input.description,
      currency: input.currency,
      amountMinor: input.event.amountMinor.toString(),
      baseAmountMinor: baseAmountMinor.toString(),
      rateSource,
      categoryId,
      lines: auditLines(lines, accountCodes),
    },
  });

  // 10. 返回。
  return { transactionId: input.transactionId };
}

/**
 * 汇率 -> 模板 -> 换算 -> 行级不变量，两个入口唯一被允许构造分录行的地方。
 *
 * 抽出来是为了让这四步只存在一份：postJournal 与 repostJournal 各写一遍的话，
 * 任何一边漏掉 assertLineInvariants，从另一边完全看不出来。
 *
 * storedRate 只有编辑路径复用既有汇率时才传，传了就整个跳过 resolveRate；
 * 其余情况一律现查，查不到即抛错，绝不回退 1。
 */
async function buildValidatedLines(
  tx: Tx,
  ctx: OrgContext,
  args: {
    event: PostingEvent;
    occurredOn: string;
    currency: string;
    manualRate?: string;
    manualRateEntry: ManualRateEntry;
    storedRate?: { scaledRate: bigint; source: RateSource };
  },
): Promise<{ lines: DraftJournalLine[]; scaledRate: bigint; rateSource: RateSource }> {
  const { scaledRate, source: rateSource } =
    args.storedRate ??
    (await resolveRate(tx, {
      currency: args.currency,
      baseCurrency: ctx.baseCurrency,
      occurredOn: args.occurredOn,
      manualRate: args.manualRate,
      manualRateEntry: args.manualRateEntry,
    }));

  // 换算 + 行级不变量。这两步在 buildCheckedLines 里，不在这里各写一句：
  // 它们互相配套（前者故意让一行偏离自己的换算结果，后者按吸收之后的样子
  // 核对），拆成相邻两句写过一次，结果是两句互斥、且只有三行以上的外币
  // 分录才撞得到。见 server/domain/ledger.ts 上那个函数的注释。
  const lines = buildCheckedLines(templateFor(args.event), {
    currency: args.currency,
    baseCurrency: ctx.baseCurrency,
    scaledRate,
    rateSource,
  });

  return { lines, scaledRate, rateSource };
}

/**
 * 转账与手工凭证不挂分类，与 transactions_category_matches_kind 约束一致
 * （见 0014 迁移）；收支两种事件必须带分类。
 *
 * 缺分类这一条以前只由数据库那个 CHECK 约束兜着。任务 3 把这条断言判为
 * 够不着而搁置：当时唯一走到这里的 server/actions/transactions.ts 会先抛
 * 「Income and expense records need a category.」，postJournal 拿到的
 * categoryId 不可能为 null。
 *
 * 任务 5 把定期规则接进这个边界之后它就够得着了：
 * recurring_transactions.category_id 上没有 not null 约束（见 0008 迁移），
 * 一条不挂分类的收入规则会带着 categoryId: null 一路走到这里。少了这一句，
 * 用户看到的是 Postgres 那条 CHECK 约束的原始报错，而不是一句能读懂的
 * LedgerError——而定期生成还会把它当成「意料之外的错误」，说不出到底哪里
 * 不对。文案与 transactions.ts 里那句逐字相同：同一件事无论从哪个入口发生，
 * 用户都该读到同一句话。
 */
function categoryForKind(kind: TransactionKind, categoryId: string | null): string | null {
  if (kind === 'transfer' || kind === 'journal') return null;

  if (categoryId === null) {
    throw new LedgerError('Income and expense records need a category.');
  }

  return categoryId;
}

/**
 * 分录行的审计快照。bigint 不能直接进 JSON，统一转字符串，保持 jsonb 可查询。
 *
 * accountCode 与 accountId 并列：日后翻审计日志的人认得 'cash'，认不得
 * 一串 uuid，而科目可能早已改名甚至停用。代码取自 insertJournalLines 刚
 * 跑完的那次归属校验，不额外查库。校验通不过就抛错了，所以这里 get 必中；
 * ?? null 只是让这个函数保持全函数，不留一个隐式 undefined 进 jsonb。
 */
function auditLines(lines: DraftJournalLine[], codesById: AccountCodesById) {
  return lines.map((line) => ({
    accountId: line.accountId,
    accountCode: codesById.get(line.accountId) ?? null,
    direction: line.direction,
    amountMinor: line.amountMinor.toString(),
  }));
}
