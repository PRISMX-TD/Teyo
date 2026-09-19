'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { parseOrThrow } from '@/lib/schemas';
import { withTransaction } from '@/server/db/transaction';
import { requirePermission, AuthError } from '@/server/auth/guard';
import { currencyExponent } from '@/server/domain/money';
import { getMoneyAccount } from '@/server/repositories/accounts';
import {
  BankImportError,
  parseCsvBuffer,
  parseOfxBuffer,
  parseQifBuffer,
  type ParsedTransaction,
  type StatementDateFormat,
} from '@/server/services/bank_import_parser';
import {
  insertImportedTransactions,
  matchImportedTransaction,
  ignoreImportedTransaction,
  resetImportedTransaction,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ROWS,
} from '@/server/repositories/bank_import';

const uploadSchema = z
  .object({
    moneyAccountId: z.string().uuid('Pick the bank account this statement belongs to.'),
    // 日期写法由用户指定；不指定时解析器自己从文件里推导，推导不出来会报错
    // 要求指定，绝不猜（见 bank_import_parser.ts 的 StatementDateFormat）。
    dateFormat: z.enum(['iso', 'dmy', 'mdy']).optional(),
  })
  .strict();

function detectFormat(fileName: string): 'csv' | 'ofx' | 'qif' {
  const ext = fileName.split('.').pop()?.toLowerCase();
  if (ext === 'csv') return 'csv';
  if (ext === 'ofx' || ext === 'qfx') return 'ofx';
  if (ext === 'qif') return 'qif';
  throw new BankImportError(
    `Teyo cannot read a .${ext ?? ''} file. Export your statement as .csv, .ofx, .qfx or .qif.`,
  );
}

export async function uploadBankStatement(
  orgSlug: string,
  formData: FormData,
): Promise<{ count: number }> {
  const context = await requirePermission(orgSlug, 'transaction:create');

  const file = formData.get('file');
  if (!file || !(file instanceof File)) {
    throw new BankImportError('Choose a statement file to import.');
  }

  // 大小检查排在 arrayBuffer() 之前。放在后面就等于先把文件整个读进内存，
  // 再决定要不要拒绝它——那时候该占的内存已经占完了。
  if (file.size > MAX_IMPORT_BYTES) {
    throw new BankImportError(
      `That file is ${Math.ceil(file.size / 1024 / 1024)}MB. ` +
        `Statements need to be under ${MAX_IMPORT_BYTES / 1024 / 1024}MB — ` +
        'export a shorter date range and import it in parts.',
    );
  }

  const raw = formData.get('dateFormat');
  const parsedInput = parseOrThrow(
    uploadSchema,
    {
      moneyAccountId: formData.get('moneyAccountId'),
      ...(typeof raw === 'string' && raw !== '' ? { dateFormat: raw } : {}),
    },
    (m) => new BankImportError(m),
  );

  const format = detectFormat(file.name);

  // 小数位数取本位币的，不是硬写 2。JPY/VND/KRW 是零小数币种，按 2 位解析
  // 会把「1200 日元」记成 12 日元。
  const exponent = currencyExponent(context.baseCurrency);
  const options = {
    exponent,
    dateFormat: parsedInput.dateFormat as StatementDateFormat | undefined,
  };

  const buffer = Buffer.from(await file.arrayBuffer());

  let parsed: ParsedTransaction[];
  if (format === 'csv') {
    parsed = parseCsvBuffer(buffer, options);
  } else if (format === 'ofx') {
    parsed = parseOfxBuffer(buffer, options);
  } else {
    parsed = parseQifBuffer(buffer, options);
  }

  if (parsed.length === 0) {
    throw new BankImportError(
      'No entries were found in that file. Check that it is the statement you meant to upload.',
    );
  }

  if (parsed.length > MAX_IMPORT_ROWS) {
    throw new BankImportError(
      `That statement has ${parsed.length} entries. Teyo imports up to ${MAX_IMPORT_ROWS} at a ` +
        'time — export a shorter date range and import it in parts.',
    );
  }

  const count = await withTransaction(context.userId, async (tx) => {
    // 资金账户必须按公司维度查回来，而且必须真的是资金账户。
    //
    // 之前这里只检查了 `typeof moneyAccountId === 'string'`，而
    // imported_transactions.money_account_id 的外键只指向 accounts(id)，
    // 没有公司维度（0008 迁移）。也就是说，把另一家公司的账户 id 传进来，
    // 数据库会照单全收：整份对账单挂到别人的银行账户底下，之后出现在对方的
    // 对账界面上。RLS 对这一种是无感的——请求者确实是某家公司的成员，
    // 而这个应用里谁都能再建一家公司。
    const moneyAccount = await getMoneyAccount(tx, context.organizationId, parsedInput.moneyAccountId);

    await insertImportedTransactions(
      tx,
      parsed.map((entry) => ({
        organizationId: context.organizationId,
        moneyAccountId: moneyAccount.id,
        source: format,
        rawData: entry.rawRow,
        transactionDate: entry.date,
        description: entry.description || null,
        // 金额已经是 bigint 了，解析在 bank_import_parser.ts 里一次做完。
        //
        // 这里原来有一段 `try { ... } catch { minor = 0n; }`：任何一行解析
        // 不出来，就被静默记成金额 0。用户看到的是「导入成功，123 笔」，
        // 而其中若干笔的金额是编出来的——对账这件事的全部意义就是核对，
        // 一笔编出来的 0 会让「账面和银行对得上」变成一句假话。现在解析
        // 失败会带着行号抛到用户面前，整份文件一笔都不导入。
        amountMinor: entry.amountMinor,
        createdBy: context.userId,
      })),
    );

    return parsed.length;
  });

  revalidatePath(`/${orgSlug}/bank-import`);
  return { count };
}

/** 这三个 Action 的 id 都来自客户端，先验成 uuid 再进 SQL。 */
const idSchema = z.object({ id: z.string().uuid('That entry could not be found.') }).strict();

export async function matchTransaction(
  orgSlug: string,
  id: string,
  matchedTransactionId: string,
): Promise<void> {
  const context = await requirePermission(orgSlug, 'transaction:create');

  const parsed = parseOrThrow(
    z
      .object({
        id: z.string().uuid('That entry could not be found.'),
        matchedTransactionId: z.string().uuid('Pick a record to match this entry to.'),
      })
      .strict(),
    { id, matchedTransactionId },
    (m) => new BankImportError(m),
  );

  await withTransaction(context.userId, async (tx) => {
    // 被匹配的交易也必须属于本公司：imported_transactions.matched_transaction_id
    // 的外键同样没有公司维度，不查一次就能把别家公司的交易挂进来。
    // 写法照抄 server/actions/attachments.ts 的「先确认交易属于本公司」。
    const rows = await tx`
      select id from transactions
      where id = ${parsed.matchedTransactionId} and organization_id = ${context.organizationId}
    `;
    if (rows.length === 0) {
      throw new AuthError('not_found', 'That record was not found in this company.');
    }

    await matchImportedTransaction(
      tx,
      context.organizationId,
      parsed.id,
      parsed.matchedTransactionId,
    );
  });

  revalidatePath(`/${orgSlug}/bank-import`);
}

export async function ignoreImportedAction(orgSlug: string, id: string): Promise<void> {
  const context = await requirePermission(orgSlug, 'transaction:create');
  const parsed = parseOrThrow(idSchema, { id }, (m) => new BankImportError(m));

  await withTransaction(context.userId, async (tx) => {
    await ignoreImportedTransaction(tx, context.organizationId, parsed.id);
  });

  revalidatePath(`/${orgSlug}/bank-import`);
}

export async function resetImportedAction(orgSlug: string, id: string): Promise<void> {
  const context = await requirePermission(orgSlug, 'transaction:create');
  const parsed = parseOrThrow(idSchema, { id }, (m) => new BankImportError(m));

  await withTransaction(context.userId, async (tx) => {
    await resetImportedTransaction(tx, context.organizationId, parsed.id);
  });

  revalidatePath(`/${orgSlug}/bank-import`);
}
