import { LedgerError, type DraftLineSpec } from './ledger';

export type PostingEvent =
  | { type: 'income'; moneyAccountId: string; revenueAccountId: string; amountMinor: bigint }
  | { type: 'expense'; moneyAccountId: string; expenseAccountId: string; amountMinor: bigint }
  | { type: 'transfer'; fromAccountId: string; toAccountId: string; amountMinor: bigint }
  | { type: 'journal'; debitAccountId: string; creditAccountId: string; amountMinor: bigint };

/**
 * Maps a posting event to a pair of balanced draft journal lines.
 *
 * 借方永远是第一行。postJournal 的表头金额取 lines[0].baseAmountMinor，
 * 依赖的就是这个顺序。
 */
export function templateFor(event: PostingEvent): DraftLineSpec[] {
  const { debitAccountId, creditAccountId } = accountPair(event);

  // 一借一贷落在同一个科目上照样配平：assertBalanced 拦不住，账户归属校验
  // 也拦不住，最后落库的是一笔毫无意义的对冲分录。buildJournalLines 以前
  // 顺手挡着这条，改走模板后它没了，于是补在这里。
  //
  // 挡在 templateFor 而不是 buildLines/assertLineInvariants：后两者收的是
  // 任意 n 行的 DraftLineSpec[]，多行同侧命中同一科目在 n 行事件里是合法的
  // （阶段 4 的发票、资产处置都会这样）。只有这四种「恰好一借一贷」的模板
  // 才能断言借贷两端必须不同。
  if (debitAccountId === creditAccountId) {
    throw new LedgerError('This operation requires two different accounts.');
  }

  return [
    { accountId: debitAccountId, direction: 'debit', amountMinor: event.amountMinor },
    { accountId: creditAccountId, direction: 'credit', amountMinor: event.amountMinor },
  ];
}

/**
 * 每种事件的借贷两端各是哪个科目。
 *
 * income   debit money account   / credit revenue account
 * expense  debit expense account / credit money account
 * transfer debit destination     / credit source
 * journal  debit account         / credit account
 */
function accountPair(event: PostingEvent): { debitAccountId: string; creditAccountId: string } {
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
