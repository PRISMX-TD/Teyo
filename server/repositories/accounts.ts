import type { Tx } from '@/server/db/transaction';

export type AccountRow = {
  id: string;
  code: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  isMoneyAccount: boolean;
  isActive: boolean;
};

export class AccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountError';
  }
}

function mapAccount(row: Record<string, unknown>): AccountRow {
  return {
    id: row.id as string,
    code: row.code as string,
    type: row.type as AccountRow['type'],
    isMoneyAccount: row.is_money_account as boolean,
    isActive: row.is_active as boolean,
  };
}

/**
 * 按 id 取科目，并强制收窄到本公司。
 *
 * organization_id 条件不能省。RLS 只在调用方不是该公司成员时才挡得住；
 * 一旦用户同时属于两家公司（谁都能再建一家），仅凭 id 查询就会命中另一家
 * 公司的科目，把别人的账户混进本公司的分录里。
 */
export async function findAccount(
  tx: Tx,
  organizationId: string,
  accountId: string,
): Promise<AccountRow | null> {
  const rows = await tx`
    select id, code, type, is_money_account, is_active
    from accounts
    where id = ${accountId} and organization_id = ${organizationId}
  `;
  const row = rows.at(0);
  return row ? mapAccount(row) : null;
}

/** 取资金账户（现金/银行一类）。用于交易的资金侧，必须是 is_money_account。 */
export async function getMoneyAccount(
  tx: Tx,
  organizationId: string,
  accountId: string,
): Promise<AccountRow> {
  const account = await findAccount(tx, organizationId, accountId);

  if (!account) {
    throw new AccountError('The selected account does not exist in this company.');
  }
  if (!account.isMoneyAccount) {
    throw new AccountError(`Account ${account.code} is not a cash or bank account.`);
  }
  if (!account.isActive) {
    throw new AccountError(`Account ${account.code} is archived.`);
  }

  return account;
}
