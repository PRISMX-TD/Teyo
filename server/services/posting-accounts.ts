import type { Tx } from '@/server/db/transaction';
import { LedgerError } from '@/server/domain/ledger';
import { POSTING_ACCOUNT_CODES } from '@/server/services/account-seed';

/**
 * 单据过账要用的那几个科目，按公司一次查齐。
 *
 * 为什么不是每个 action 各自 findAccountByCode 一遍：一张含税发票要三个
 * 科目（应收 / 收入 / 销项税），逐个查是三次往返；更要紧的是，缺科目时
 * 三次查询会在第一个 null 上抛出一句只提到那一个科目的错误，而真正的
 * 情况通常是「这家公司建于 0021 之前，三个新科目都没有」。一次查齐才能
 * 把缺的全列出来。
 *
 * 科目代码不从调用方传入字符串，而是取自 POSTING_ACCOUNT_CODES——一个拼错
 * 的 code 在运行时只表现为「找不到科目」，看不出是谁拼错的。
 */
export type PostingAccountCode = (typeof POSTING_ACCOUNT_CODES)[keyof typeof POSTING_ACCOUNT_CODES];

export type PostingAccounts = ReadonlyMap<PostingAccountCode, string>;

/**
 * 取这几个 code 在本公司对应的科目 id。任何一个缺失都抛错，绝不返回
 * undefined 让调用方自己判断——一个 undefined 的 accountId 传进
 * postJournal，最终表现为 insertJournalLines 那句「Account(s) not found」，
 * 里面只有一串 uuid（实际上是字符串 "undefined"），完全看不出是哪个科目
 * 没配。
 *
 * 也断言科目是启用状态之外的事：停用的科目仍然可以被过账。停用只影响它
 * 出不出现在选择器里，不影响系统自动记账——否则用户停用一个「进项税」
 * 科目就会让全公司的账单无法录入，而他做的只是整理一下科目表。
 */
export async function resolvePostingAccounts(
  tx: Tx,
  organizationId: string,
  codes: readonly PostingAccountCode[],
): Promise<PostingAccounts> {
  const unique = [...new Set(codes)];
  if (unique.length === 0) return new Map();

  const rows = await tx`
    select id, code from accounts
    where organization_id = ${organizationId} and code = any(${unique}::text[])
  `;

  const byCode = new Map<PostingAccountCode, string>();
  for (const row of rows) {
    byCode.set(row.code as PostingAccountCode, row.id as string);
  }

  const missing = unique.filter((code) => !byCode.has(code));
  if (missing.length > 0) {
    throw new LedgerError(
      `This company is missing the account(s) needed to post this document: ${missing.join(', ')}. ` +
        'Ask an owner or admin to restore them under Settings › Chart of accounts.',
    );
  }

  return byCode;
}

/** 取一个必定存在的 code——调用方已经在 codes 里要过它。 */
export function requireAccount(accounts: PostingAccounts, code: PostingAccountCode): string {
  const id = accounts.get(code);
  if (!id) {
    // resolvePostingAccounts 已经保证不会走到这里；留着这句是为了让这个
    // 函数保持全函数，而不是用一个非空断言把类型系统糊过去。
    throw new LedgerError(`Account ${code} was not resolved before posting.`);
  }
  return id;
}

export { POSTING_ACCOUNT_CODES };
