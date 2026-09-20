'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { parseOrThrow } from '@/lib/schemas';
import { withTransaction, type Tx } from '@/server/db/transaction';
import { requirePermission, AuthError, type OrgContext } from '@/server/auth/guard';
import { currencyExponent } from '@/server/domain/money';
import type { PostingEvent } from '@/server/domain/posting-templates';
import { postJournal } from '@/server/posting/post-journal';
import { getMoneyAccount } from '@/server/repositories/accounts';
import { getCategoryWithAccount } from '@/server/repositories/categories';
import { recordAudit } from '@/server/repositories/audit-logs';
import {
  BankImportError,
  parseCsvBuffer,
  parseOfxBuffer,
  parseQifBuffer,
  type ParsedTransaction,
  type StatementDateFormat,
} from '@/server/services/bank_import_parser';
import {
  getImportedTransaction,
  importedTransactionClientUuid,
  insertImportedTransactions,
  matchImportedTransaction,
  ignoreImportedTransaction,
  resetImportedTransaction,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ROWS,
  MAX_POSTABLE_IMPORT_ROWS,
  type ImportedTransactionRow,
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

const postImportedSchema = z
  .object({
    entries: z
      .array(
        z
          .object({
            importedTransactionId: z.string().uuid('That entry could not be found.'),
            categoryId: z.string().uuid('Pick a category for this entry.'),
          })
          .strict(),
      )
      .min(1, 'Pick at least one statement line to record.')
      .max(
        MAX_POSTABLE_IMPORT_ROWS,
        `Teyo records up to ${MAX_POSTABLE_IMPORT_ROWS} statement lines at a time — tick fewer and repeat.`,
      ),
  })
  .strict();

export type PostImportedInput = z.infer<typeof postImportedSchema>;

/**
 * 从对账单行**生成**交易。
 *
 * ============================================================
 * 为什么这个文件此前一笔账都不记
 * ============================================================
 * 改动之前，本文件全文没有一次 postJournal 调用：导进来的对账单行只能
 * 「对号入座」——匹配到用户已经手工记过的交易。也就是说，银行导入在这个
 * 产品里的用法是「先把每一笔都自己记一遍，再导进来核对一次」。而银行导入
 * 最省事的用法恰恰是反过来：对账单上有的，直接变成一笔账，人只需要回答
 * 「这是什么开销」。少了这一条，导入功能对一个刚开始记账的人几乎没有价值。
 *
 * ============================================================
 * 一条流水变成一笔交易，需要回答的问题
 * ============================================================
 *   - 记在哪个资金账户上？导入时就选过了（money_account_id），这里只重新
 *     按公司维度校验一遍——外键不带公司维度，RLS 对外键校验也不生效。
 *   - 收入还是支出？**金额的正负决定**，不由用户再选一次：对账单上的符号
 *     是银行说的，让用户选等于给了一个把它说反的机会，而说反之后金额依然
 *     配平，报表上只是利润多了两倍。
 *   - 对方科目是什么？用户选的分类背后那个科目（getCategoryWithAccount
 *     顺带校验分类的 kind 与收支方向一致，且分类属于本公司、未归档）。
 *   - 什么日期？流水自己的 transaction_date，不是今天。
 *   - 什么币种？本位币。imported_transactions 上没有币种列，导入时金额就是
 *     按 `currencyExponent(context.baseCurrency)` 解析的（见 uploadBankStatement）。
 *     币种等于本位币意味着这条路径上根本不需要汇率——resolveRate 直接返回
 *     1 并把 rate_source 记成 'auto'，manualRateEntry 因此填 'unavailable'
 *     （这个界面上确实没有填汇率的地方，而它也永远不会被问到）。
 *
 * ============================================================
 * 幂等与批量
 * ============================================================
 * client_uuid 由导入行的 id 确定性派生（见 importedTransactionClientUuid），
 * 所以重放必然命中 postJournal 的幂等短路，一个字节都不会多写。再加一道
 * 「只处理 status = 'pending' 的行」：已经匹配过的（无论是匹配到手工记的
 * 交易，还是上一次就是在这里生成的）与已忽略的一律跳过，不报错也不覆盖
 * 它现有的 matched_transaction_id。
 *
 * 整批在**同一个** withTransaction 里，一条失败整批不落库。为什么不逐条
 * 独立提交、失败的跳过：用户勾了三十行点一次按钮，看到「成功 28 条」之后
 * 无从知道是哪两条、也无从重试；而「第 3 行（2026-03-11 GRAB）：这个分类
 * 已归档」是他改一下就能继续的。批量的失败必须指出是哪一条。
 */
export async function postImportedTransactions(
  orgSlug: string,
  input: PostImportedInput,
): Promise<{ created: number; skipped: number }> {
  const context = await requirePermission(orgSlug, 'transaction:create');
  const parsed = parseOrThrow(postImportedSchema, input, (m) => new BankImportError(m));

  // 同一条导入行在一批里出现两次，第二次会被「只处理 pending」挡掉，但那
  // 依赖于第一次已经把 status 改成 'matched'——一个靠副作用生效的去重。
  // 先在这里拒掉，报的是调用方真正犯的错。
  const ids = parsed.entries.map((entry) => entry.importedTransactionId);
  if (new Set(ids).size !== ids.length) {
    throw new BankImportError('The same statement line was listed twice.');
  }

  const result = await withTransaction(context.userId, async (tx) => {
    let created = 0;
    let skipped = 0;

    for (const [position, entry] of parsed.entries.entries()) {
      const row = await getImportedTransaction(
        tx,
        context.organizationId,
        entry.importedTransactionId,
      );
      // 查不到有两种可能：不存在，或属于别家公司。两种都不把 id 回显出去
      // ——那等于确认了「这个 id 在别处存在」。
      if (!row) {
        throw new AuthError('not_found', 'One of those statement lines was not found.');
      }

      if (row.status !== 'pending' || row.matchedTransactionId !== null) {
        skipped += 1;
        continue;
      }

      try {
        const transactionId = await postImportedRow(tx, context, row, entry.categoryId);
        await matchImportedTransaction(tx, context.organizationId, row.id, transactionId);

        await recordAudit(tx, {
          organizationId: context.organizationId,
          actorUserId: context.userId,
          action: 'imported_transaction.posted',
          entityType: 'imported_transaction',
          entityId: row.id,
          before: { status: row.status, matchedTransactionId: null },
          after: {
            status: 'matched',
            matchedTransactionId: transactionId,
            categoryId: entry.categoryId,
            transactionDate: row.transactionDate,
            // bigint 不能直接进 JSON，统一转字符串，保持 jsonb 可查询。
            amountMinor: row.amountMinor.toString(),
            currency: context.baseCurrency,
          },
        });

        created += 1;
      } catch (error) {
        // 批量里的失败必须指出是哪一条：用户勾了三十行，「这个分类已归档」
        // 单独出现时他没法知道该改哪一行。原文一字不改地保留在后面——
        // 那些话（缺科目、分类 kind 不匹配、期间已封账）本来就是写给用户
        // 读的，重写一遍只会把信息弄丢。
        const label = `${row.transactionDate} ${row.description ?? ''}`.trim();
        throw new BankImportError(
          `Line ${position + 1} (${label}): ${(error as Error).message}`,
        );
      }
    }

    return { created, skipped };
  });

  revalidatePath(`/${orgSlug}/bank-import`);
  revalidatePath(`/${orgSlug}/transactions`);
  return result;
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

/**
 * 一条对账单流水 -> 一笔过账好的交易，返回交易 id。
 *
 * 借贷方向不在这里定义：它只把「资金账户 + 分类科目 + 金额」装进一个
 * PostingEvent，方向由 server/domain/posting-templates.ts 的 templateFor
 * 说了算（收入 借资金账户/贷收入科目，支出 借费用科目/贷资金账户）。
 * 这个文件里再写一遍方向，就是本仓库反复警告的那种「第二份实现」。
 */
async function postImportedRow(
  tx: Tx,
  context: OrgContext,
  row: ImportedTransactionRow,
  categoryId: string,
): Promise<string> {
  // 金额为零的流水（有些银行会把手续费返还写成 0.00）没有对应的交易：
  // transactions.amount_minor 与 journal_lines.amount_minor 都有 > 0 的
  // CHECK，硬记下去用户读到的是一条裸的 Postgres 约束报错。
  if (row.amountMinor === 0n) {
    throw new BankImportError(
      'This line has no amount, so there is nothing to record. Ignore it instead.',
    );
  }

  // 正负决定收支，绝对值是金额。BigInt 取绝对值要自己写——Math.abs 只吃
  // number，把一个 bigint 交给它是 TypeError，而先 Number() 再取绝对值会在
  // 超过 2^53 的金额上悄悄丢精度。
  const kind = row.amountMinor > 0n ? 'income' : 'expense';
  const amountMinor = row.amountMinor > 0n ? row.amountMinor : -row.amountMinor;

  // 两个 id 都来自库里那一行，但仍要按公司维度重查：money_account_id 的
  // 外键不带公司维度（0008），而这一行本身是很久以前导入的——期间账户
  // 可能已经被归档，或者（在导入那一步还没有这道校验的年代）压根就不属于
  // 本公司。getMoneyAccount 同时挡住「记到一个不是资金账户的科目上」：
  // 那样分录照样配平，只有看报表的人会发现银行余额从来不动。
  const moneyAccount = await getMoneyAccount(tx, context.organizationId, row.moneyAccountId);
  const category = await getCategoryWithAccount(tx, context.organizationId, categoryId, kind);

  const event: PostingEvent =
    kind === 'income'
      ? { type: 'income', moneyAccountId: moneyAccount.id, revenueAccountId: category.accountId, amountMinor }
      : { type: 'expense', moneyAccountId: moneyAccount.id, expenseAccountId: category.accountId, amountMinor };

  // 摘要留空的流水（OFX 的某些导出就是这样）也得有一句话：交易列表按摘要
  // 搜索，一行空白在里面既找不到也认不出。
  const description = (row.description ?? '').trim() || `Bank import ${row.transactionDate}`;

  const posted = await postJournal(tx, context, {
    event,
    occurredOn: row.transactionDate,
    description,
    // 本位币。理由见 postImportedTransactions 的注释：导入时金额就是按
    // 本位币的小数位解析的，这里换一个币种等于把同一个数读成另一个意思。
    currency: context.baseCurrency,
    manualRateEntry: 'unavailable',
    categoryId: category.id,
    clientUuid: importedTransactionClientUuid(row.id),
    sourceType: 'imported_transaction',
    sourceId: row.id,
  });

  return posted.transactionId;
}
