import { type DraftLineSpec } from './ledger';

export type PostingEvent =
  | { type: 'income'; moneyAccountId: string; revenueAccountId: string; amountMinor: bigint }
  | { type: 'expense'; moneyAccountId: string; expenseAccountId: string; amountMinor: bigint }
  | { type: 'transfer'; fromAccountId: string; toAccountId: string; amountMinor: bigint }
  | { type: 'journal'; debitAccountId: string; creditAccountId: string; amountMinor: bigint };

/**
 * Maps a posting event to a pair of balanced draft journal lines.
 *
 * income   debit money account   / credit revenue account
 * expense  debit expense account / credit money account
 * transfer debit destination     / credit source
 * journal  debit account         / credit account
 */
export function templateFor(event: PostingEvent): DraftLineSpec[] {
  switch (event.type) {
    case 'income':
      return [
        { accountId: event.moneyAccountId, direction: 'debit', amountMinor: event.amountMinor },
        { accountId: event.revenueAccountId, direction: 'credit', amountMinor: event.amountMinor },
      ];

    case 'expense':
      return [
        { accountId: event.expenseAccountId, direction: 'debit', amountMinor: event.amountMinor },
        { accountId: event.moneyAccountId, direction: 'credit', amountMinor: event.amountMinor },
      ];

    case 'transfer':
      return [
        { accountId: event.toAccountId, direction: 'debit', amountMinor: event.amountMinor },
        { accountId: event.fromAccountId, direction: 'credit', amountMinor: event.amountMinor },
      ];

    case 'journal':
      return [
        { accountId: event.debitAccountId, direction: 'debit', amountMinor: event.amountMinor },
        { accountId: event.creditAccountId, direction: 'credit', amountMinor: event.amountMinor },
      ];
  }
}
