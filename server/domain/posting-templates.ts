import { LedgerError, type DraftLineSpec, type TransactionKind } from './ledger';
import { sumMinor } from './money';

/**
 * 一笔记账事件。方向（谁借谁贷）只在这个文件里定义一次——见 templateFor
 * 下面那段注释。任何新单据接进总账，都必须在这里加一个事件类型，而不是
 * 在自己的 action 里手写一对分录。
 *
 * 前四种是用户直接发起的动作（收入/支出/转账/手工凭证），一借一贷。
 * 后面五种是单据过账：发票、账单、收款、付款、贷项通知单。它们可能出
 * 三行（净额 + 税额 + 总额），这正是 ledger.ts 的 buildLines 当初写成
 * 「n >= 2 而不是恰好 2」时预留的场景。
 */
export type PostingEvent =
  | { type: 'income'; moneyAccountId: string; revenueAccountId: string; amountMinor: bigint }
  | { type: 'expense'; moneyAccountId: string; expenseAccountId: string; amountMinor: bigint }
  | { type: 'transfer'; fromAccountId: string; toAccountId: string; amountMinor: bigint }
  | { type: 'journal'; debitAccountId: string; creditAccountId: string; amountMinor: bigint }
  /** 开销售发票：借应收 / 贷收入 / 贷销项税。 */
  | {
      type: 'invoice';
      receivableAccountId: string;
      revenueAccountId: string;
      taxAccountId: string | null;
      netMinor: bigint;
      taxMinor: bigint;
      amountMinor: bigint;
    }
  /** 收到供应商账单：借费用 / 借进项税 / 贷应付。 */
  | {
      type: 'bill';
      payableAccountId: string;
      expenseAccountId: string;
      taxAccountId: string | null;
      netMinor: bigint;
      taxMinor: bigint;
      amountMinor: bigint;
    }
  /** 收到客户货款：借资金账户 / 贷应收。 */
  | { type: 'customer-receipt'; moneyAccountId: string; receivableAccountId: string; amountMinor: bigint }
  /** 付款给供应商：借应付 / 贷资金账户。 */
  | { type: 'supplier-payment'; moneyAccountId: string; payableAccountId: string; amountMinor: bigint }
  /**
   * 年结：把一整个财年的损益科目余额结转到留存收益。
   *
   * 这是唯一一种由调用方给出全部分录行的事件，也是唯一一种行数不定的
   * 事件——一个财年通常有十几个有余额的损益科目，而上面每一种事件的
   * 行数与科目角色都是写死的。
   *
   * 「方向只在这个文件里定义」这条规矩在这里怎么算数：年结没有「哪一侧
   * 是收入、哪一侧是费用」这种可以预先写下来的映射，方向完全由每个科目
   * 当时的余额符号决定（收入科目是贷方余额，结转时借它；费用相反）。
   * 能写在这里的规则只有「必须配平」「必须落成 kind = 'closing'」，
   * 这两条都在下面。真正决定每一行方向的是
   * server/services/year-end-close.ts 的 buildClosingPlan，它那一份也是
   * 唯一的一份——没有第二处在算年结的方向。
   */
  | { type: 'closing'; lines: readonly DraftLineSpec[]; amountMinor: bigint }
  /** 开贷项通知单（销售退回/折让）：借收入 / 借销项税 / 贷应收。发票的反向。 */
  | {
      type: 'credit-note';
      receivableAccountId: string;
      revenueAccountId: string;
      taxAccountId: string | null;
      netMinor: bigint;
      taxMinor: bigint;
      amountMinor: bigint;
    };

/** 带净额/税额拆分的单据事件。三种共用同一套校验与同一种拆行方式。 */
type TaxSplitEvent = Extract<PostingEvent, { netMinor: bigint }>;

/**
 * 把一个记账事件映射成一组配平的草稿分录。
 *
 * 借方永远排在前面。postJournal 不再依赖 lines[0]（那在三行事件上是错的，
 * 见那个函数里 baseAmountMinor 的注释），但审计快照与 loadJournalLines 的
 * 排序都按「借方在前」读，保持一致。
 *
 * 这个文件是全项目唯一定义记账方向的地方。ledger.ts 里曾经还有第二份
 * （buildJournalLines），已经删掉——两份方向定义里写反一份，分录照样配平、
 * 照样没人看得出来，这正是本项目出过的那种 bug 的形状。
 */
export function templateFor(event: PostingEvent): DraftLineSpec[] {
  switch (event.type) {
    case 'income':
    case 'expense':
    case 'transfer':
    case 'journal': {
      const { debitAccountId, creditAccountId } = accountPair(event);

      // 一借一贷落在同一个科目上照样配平：assertBalanced 拦不住，账户归属
      // 校验也拦不住，最后落库的是一笔毫无意义的对冲分录。
      //
      // 挡在这里而不是 buildLines/assertLineInvariants：后两者收的是任意 n 行
      // 的 DraftLineSpec[]，多行同侧命中同一科目在 n 行事件里是合法的（一张
      // 发票的净额与税额可以都挂在同一个收入科目下，如果用户没配税）。
      // 只有这四种「恰好一借一贷」的模板才能断言借贷两端必须不同。
      if (debitAccountId === creditAccountId) {
        throw new LedgerError('This operation requires two different accounts.');
      }

      return [
        { accountId: debitAccountId, direction: 'debit', amountMinor: event.amountMinor },
        { accountId: creditAccountId, direction: 'credit', amountMinor: event.amountMinor },
      ];
    }

    case 'invoice': {
      assertTaxSplit(event);
      // 借应收（总额） / 贷收入（净额） / 贷销项税（税额）
      return [
        { accountId: event.receivableAccountId, direction: 'debit', amountMinor: event.amountMinor },
        ...splitCreditLines(event, event.revenueAccountId),
      ];
    }

    case 'credit-note': {
      assertTaxSplit(event);
      // 发票的完全反向：借收入（净额） / 借销项税（税额） / 贷应收（总额）
      return [
        ...splitDebitLines(event, event.revenueAccountId),
        { accountId: event.receivableAccountId, direction: 'credit', amountMinor: event.amountMinor },
      ];
    }

    case 'bill': {
      assertTaxSplit(event);
      // 借费用（净额） / 借进项税（税额） / 贷应付（总额）
      return [
        ...splitDebitLines(event, event.expenseAccountId),
        { accountId: event.payableAccountId, direction: 'credit', amountMinor: event.amountMinor },
      ];
    }

    case 'customer-receipt': {
      if (event.moneyAccountId === event.receivableAccountId) {
        throw new LedgerError('This operation requires two different accounts.');
      }
      // 借资金账户 / 贷应收
      return [
        { accountId: event.moneyAccountId, direction: 'debit', amountMinor: event.amountMinor },
        { accountId: event.receivableAccountId, direction: 'credit', amountMinor: event.amountMinor },
      ];
    }

    case 'closing': {
      if (event.lines.length < 2) {
        throw new LedgerError('A closing entry needs at least two journal lines.');
      }

      // 表头金额必须等于借方合计。postJournal 把 event.amountMinor 原样写进
      // transactions.amount_minor，而本位币那一列取的是分录的借方合计
      // （headerBaseAmount）。年结是纯本位币分录，两者必须是同一个数——
      // 不等的话表头与分录就对不上，而数据库的配平触发器只看分录、看不到
      // 表头，它会放行。
      const debitTotal = sumMinor(
        event.lines.filter((line) => line.direction === 'debit').map((line) => line.amountMinor),
      );
      if (debitTotal !== event.amountMinor) {
        throw new LedgerError(
          `Closing entry total ${event.amountMinor} does not equal its debit side ${debitTotal}.`,
        );
      }

      // 配平、金额为正、行数下限由 buildLines 统一把关（它对任意 n 行都
      // 成立），这里不再重复一遍——重复的校验会在两处各自演化，最后谁也
      // 不知道哪一份才是真的。
      return [...event.lines];
    }

    case 'supplier-payment': {
      if (event.moneyAccountId === event.payableAccountId) {
        throw new LedgerError('This operation requires two different accounts.');
      }
      // 借应付 / 贷资金账户
      return [
        { accountId: event.payableAccountId, direction: 'debit', amountMinor: event.amountMinor },
        { accountId: event.moneyAccountId, direction: 'credit', amountMinor: event.amountMinor },
      ];
    }
  }
}

/**
 * 这笔事件应该以哪种 transaction_kind 落库。
 *
 * 五种单据事件一律落成 'journal'：
 *
 * 一是数据库的 transactions_category_matches_kind 约束（见 0014 迁移）要求
 * income/expense 必须带 category_id，而单据的对方科目由单据自己指定，套一个
 * 分类上去等于凭空编一个用户没选过的归类。transfer/journal 这一支不带分类，
 * 正好是单据需要的形状。
 *
 * 二是语义：开一张发票不是「收到钱」，收一笔货款也不是「产生收入」（收入在
 * 开票时就已确认）。把它们记成 income 会让「收入」这个词在界面上同时指两件
 * 不同的事。
 *
 * 三是编辑权限：交易详情页对 kind = 'journal' 的记录只读（见
 * app/(app)/[orgSlug]/transactions/[id]），这正是单据分录该有的行为——
 * 要改就去改单据本身，然后由单据重新过账，而不是绕过单据直接改分录。
 */
export function kindFor(event: PostingEvent): TransactionKind {
  switch (event.type) {
    case 'income':
    case 'expense':
    case 'transfer':
    case 'journal':
      return event.type;
    case 'invoice':
    case 'bill':
    case 'customer-receipt':
    case 'supplier-payment':
    case 'credit-note':
      return 'journal';
    // 年结必须落成自己的 kind，不能并进 'journal'：损益表正是靠它把年结
    // 排除在外（见 server/repositories/reports.ts 的 getProfitLoss）。
    // 用 'journal' 顶上的话，刚结转过的那一年损益表会变成全零。
    case 'closing':
      return 'closing';
  }
}

/**
 * 净额 + 税额必须恰好等于总额，且都不能为负。
 *
 * 为什么在这里断言而不是信任调用方：amountMinor 会成为交易表头的
 * amount_minor，净额与税额成为分录行。这三个数一旦不自洽，表头与分录就
 * 对不上，而数据库的配平触发器只看分录、看不到表头——它会放行。
 *
 * taxMinor 为 0 是合法的（没配税率的公司），那种情况下不出税行：
 * journal_lines.amount_minor 有 > 0 的 CHECK 约束，一条金额为零的税行
 * 会被数据库直接拒绝，而用户看到的是一条读不懂的约束报错。
 */
function assertTaxSplit(event: TaxSplitEvent): void {
  if (event.netMinor < 0n || event.taxMinor < 0n) {
    throw new LedgerError('Document amounts cannot be negative.');
  }
  if (event.netMinor + event.taxMinor !== event.amountMinor) {
    throw new LedgerError(
      `Document total ${event.amountMinor} does not equal net ${event.netMinor} plus tax ${event.taxMinor}.`,
    );
  }
  if (event.taxMinor > 0n && event.taxAccountId === null) {
    throw new LedgerError('A tax amount was recorded but no tax account is configured.');
  }
}

/** 净额与税额两条贷方行；税额为零时只出净额一行。 */
function splitCreditLines(event: TaxSplitEvent, netAccountId: string): DraftLineSpec[] {
  return splitLines(event, netAccountId, 'credit');
}

/** 净额与税额两条借方行；税额为零时只出净额一行。 */
function splitDebitLines(event: TaxSplitEvent, netAccountId: string): DraftLineSpec[] {
  return splitLines(event, netAccountId, 'debit');
}

function splitLines(
  event: TaxSplitEvent,
  netAccountId: string,
  direction: 'debit' | 'credit',
): DraftLineSpec[] {
  const lines: DraftLineSpec[] = [];

  if (event.netMinor > 0n) {
    lines.push({ accountId: netAccountId, direction, amountMinor: event.netMinor });
  }
  if (event.taxMinor > 0n) {
    // assertTaxSplit 已经保证税额非零时 taxAccountId 不为 null。
    lines.push({ accountId: event.taxAccountId as string, direction, amountMinor: event.taxMinor });
  }

  // 净额与税额同时为零意味着总额也是零，而 transactions.amount_minor 有
  // > 0 的 CHECK。挡在这里，报一句用户读得懂的话。
  if (lines.length === 0) {
    throw new LedgerError('Transaction amount must be greater than zero.');
  }

  // 拆行之后必须仍然等于总额。assertTaxSplit 已经查过一次 net + tax，
  // 这里查的是「实际发出去的行」的合计——两者之间隔着 > 0n 的过滤，
  // 补这一句才说得上是对落库的那组行成立。
  if (sumMinor(lines.map((line) => line.amountMinor)) !== event.amountMinor) {
    throw new LedgerError('Document lines do not sum to the document total.');
  }

  return lines;
}

/**
 * 四种基础事件的借贷两端各是哪个科目。
 *
 * income   debit money account   / credit revenue account
 * expense  debit expense account / credit money account
 * transfer debit destination     / credit source
 * journal  debit account         / credit account
 */
function accountPair(
  event: Extract<PostingEvent, { type: 'income' | 'expense' | 'transfer' | 'journal' }>,
): { debitAccountId: string; creditAccountId: string } {
  switch (event.type) {
    case 'income':
      return { debitAccountId: event.moneyAccountId, creditAccountId: event.revenueAccountId };

    case 'expense':
      return { debitAccountId: event.expenseAccountId, creditAccountId: event.moneyAccountId };

    case 'transfer':
      return { debitAccountId: event.toAccountId, creditAccountId: event.fromAccountId };

    case 'journal':
      return { debitAccountId: event.debitAccountId, creditAccountId: event.creditAccountId };
  }
}
