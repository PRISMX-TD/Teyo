import type { Tx } from '@/server/db/transaction';

export type AccountRow = {
  id: string;
  code: string;
  nameEn: string | null;
  nameZh: string | null;
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
    nameEn: (row.name_en as string | null) ?? null,
    nameZh: (row.name_zh as string | null) ?? null,
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
    select id, code, name_en, name_zh, type, is_money_account, is_active
    from accounts
    where id = ${accountId} and organization_id = ${organizationId}
  `;
  const row = rows.at(0);
  return row ? mapAccount(row) : null;
}

/** 按 id 取科目，取不到就抛错。改名与停用都要先读旧值写审计，故单列一个。 */
export async function getAccount(
  tx: Tx,
  organizationId: string,
  accountId: string,
): Promise<AccountRow> {
  const account = await findAccount(tx, organizationId, accountId);
  if (!account) {
    throw new AccountError('This account was not found in this company.');
  }
  return account;
}

/** 列出所有活跃资金账户，供交易表单选择。按 sort_order 排序保证 UI 稳定。 */
export async function listMoneyAccounts(
  tx: Tx,
  organizationId: string,
): Promise<Array<{ id: string; nameEn: string | null; nameZh: string | null }>> {
  const rows = await tx`
    select id, name_en, name_zh
    from accounts
    where organization_id = ${organizationId}
      and is_money_account = true
      and is_active = true
    order by sort_order
  `;
  return rows.map((row) => ({
    id: row.id as string,
    nameEn: (row.name_en as string) ?? null,
    nameZh: (row.name_zh as string) ?? null,
  }));
}

export async function insertAccount(
  tx: Tx,
  row: {
    organizationId: string;
    code: string;
    nameEn: string | null;
    nameZh: string | null;
    type: AccountRow['type'];
    isMoneyAccount: boolean;
    sortOrder: number;
  },
): Promise<{ id: string }> {
  const [inserted] = await tx`
    insert into accounts (
      organization_id, code, name_en, name_zh, type,
      is_money_account, is_system, is_active, sort_order
    ) values (
      ${row.organizationId}, ${row.code}, ${row.nameEn}, ${row.nameZh}, ${row.type},
      ${row.isMoneyAccount}, false, true, ${row.sortOrder}
    )
    returning id
  `;
  return { id: inserted.id as string };
}

export async function updateAccountNames(
  tx: Tx,
  organizationId: string,
  accountId: string,
  names: { nameEn: string | null; nameZh: string | null },
): Promise<void> {
  const result = await tx`
    update accounts
    set name_en = ${names.nameEn}, name_zh = ${names.nameZh}
    where id = ${accountId} and organization_id = ${organizationId}
  `;
  if (result.count === 0) {
    throw new AccountError('This account was not found in this company.');
  }
}

export async function updateAccountActive(
  tx: Tx,
  organizationId: string,
  accountId: string,
  isActive: boolean,
): Promise<void> {
  const result = await tx`
    update accounts set is_active = ${isActive}
    where id = ${accountId} and organization_id = ${organizationId}
  `;
  if (result.count === 0) {
    throw new AccountError('This account was not found in this company.');
  }
}

/** 本公司仍处于启用状态的资金账户数量。用于阻止停用最后一个资金账户。 */
export async function countActiveMoneyAccounts(
  tx: Tx,
  organizationId: string,
): Promise<number> {
  const [row] = await tx`
    select count(*)::int as n
    from accounts
    where organization_id = ${organizationId} and is_money_account and is_active
  `;
  return Number(row.n);
}

/** 自定义科目的 code 由名称派生，冲突时加序号，保证 (organization_id, code) 唯一。 */
export async function nextAvailableCode(
  tx: Tx,
  organizationId: string,
  base: string,
): Promise<string> {
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const candidate = slug.length > 0 ? slug : 'account';

  // 中文名派生出的 slug 会被清成空串，此时退回 'account' 再走去重，
  // 所以纯中文命名的账户拿到的是 account、account-2 这样的编码。
  const rows = await tx`
    select code from accounts
    where organization_id = ${organizationId} and code like ${`${candidate}%`}
  `;
  const taken = new Set(rows.map((r) => r.code as string));

  if (!taken.has(candidate)) return candidate;
  for (let n = 2; n < 1000; n += 1) {
    const next = `${candidate}-${n}`;
    if (!taken.has(next)) return next;
  }
  throw new AccountError(`Could not derive a unique account code from "${base}".`);
}

/** 新建科目排到同类型末尾。 */
export async function nextAccountSortOrder(
  tx: Tx,
  organizationId: string,
  type: AccountRow['type'],
): Promise<number> {
  const [row] = await tx`
    select coalesce(max(sort_order), 0) + 10 as next
    from accounts
    where organization_id = ${organizationId} and type = ${type}
  `;
  return Number(row.next);
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
