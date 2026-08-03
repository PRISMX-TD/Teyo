import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { sql } from '@/server/db/client';
import { withTransaction } from '@/server/db/transaction';
import { admin } from '@/tests/helpers/db';
import {
  buildAccountSummaryRows,
  buildCsv,
  buildTransactionDetailRows,
  buildXlsx,
  ExportError,
  MAX_EXPORT_ROWS,
} from '@/server/services/export-builder';
import { createTestOrgWithSeed, createTestUser, joinOrg, resetTestData } from '@/tests/helpers/test-db';

let currentUserId: string | null = null;

vi.mock('@/server/auth/session', () => ({
  getCurrentUserId: () => Promise.resolve(currentUserId),
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { createTransaction, voidTransaction } = await import('@/server/actions/transactions');
const { exportReport } = await import('@/server/actions/export');

let ownerId: string;
let orgId: string;
let orgSlug: string;
let cashId: string;
let rentCategoryId: string;

beforeAll(async () => {
  ownerId = await createTestUser('owner-exp@example.com', 'Owner');

  const org = await createTestOrgWithSeed(ownerId, 'Export Co', `export-co-${Date.now()}`, 'MYR');
  orgId = org.id;
  orgSlug = org.slug;
  cashId = org.accountsByCode['cash'];
  rentCategoryId = org.categoriesByAccountCode['rent'];
  currentUserId = ownerId;

  await createTransaction(orgSlug, {
    kind: 'expense',
    occurredOn: '2026-08-03',
    amount: '1200.50',
    currency: 'MYR',
    moneyAccountId: cashId,
    categoryId: rentCategoryId,
    description: '八月租金, 含水电',
    clientUuid: randomUUID(),
  });

  await createTransaction(orgSlug, {
    kind: 'income',
    occurredOn: '2026-08-04',
    amount: '5000.00',
    currency: 'MYR',
    moneyAccountId: org.accountsByCode['bank'],
    categoryId: org.categoriesByAccountCode['sales'],
    description: 'Shop sales',
    clientUuid: randomUUID(),
  });

  const voided = await createTransaction(orgSlug, {
    kind: 'expense',
    occurredOn: '2026-08-05',
    amount: '77.00',
    currency: 'MYR',
    moneyAccountId: cashId,
    categoryId: org.categoriesByAccountCode['marketing'],
    description: 'Wrong entry',
    clientUuid: randomUUID(),
  });
  await voidTransaction(orgSlug, voided.id, 'Duplicate');

  // 第二家公司必须与第一家同一个 owner。换成别人的公司时 RLS 本身就会挡掉，
  // 查询里漏了公司收窄也照样测过，等于白测。同 owner 才能真正验出漏收窄。
  const second = await createTestOrgWithSeed(
    ownerId,
    'Second Co',
    `second-co-${Date.now()}`,
    'MYR',
  );
  await createTransaction(second.slug, {
    kind: 'expense',
    occurredOn: '2026-08-03',
    amount: '999.00',
    currency: 'MYR',
    moneyAccountId: second.accountsByCode['cash'],
    categoryId: second.categoriesByAccountCode['rent'],
    description: 'Second company rent',
    clientUuid: randomUUID(),
  });
});

afterAll(async () => {
  await resetTestData();
  await sql.end();
  await admin.end();
});

describe('buildCsv', () => {
  it('starts with a UTF-8 BOM so Excel reads Chinese correctly', () => {
    const buffer = buildCsv(['名称'], [['租金']]);
    expect(buffer.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  });

  it('quotes fields containing commas, quotes and newlines', () => {
    const text = buildCsv(['a', 'b', 'c'], [['x,y', 'say "hi"', 'line1\nline2']]).toString('utf8');
    expect(text).toContain('"x,y"');
    expect(text).toContain('"say ""hi"""');
    expect(text).toContain('"line1\nline2"');
  });

  it('uses CRLF line endings', () => {
    const text = buildCsv(['a'], [['1'], ['2']]).toString('utf8');
    expect(text).toContain('a\r\n1\r\n2');
  });

  it('leaves plain values unquoted', () => {
    const text = buildCsv(['a'], [['plain']]).toString('utf8');
    expect(text).toContain('\r\nplain');
    expect(text).not.toContain('"plain"');
  });

  // 以 = + - @ 开头的字段在 Excel 里会被当公式执行，导出数据可能来自用户输入的
  // 说明字段，必须中和掉，否则等于把公式注入送给打开文件的会计。
  it('neutralises values Excel would treat as a formula', () => {
    const text = buildCsv(['a'], [['=1+1'], ['+x'], ['-y'], ['@z']]).toString('utf8');
    expect(text).toContain("'=1+1");
    expect(text).toContain("'+x");
    expect(text).toContain("'-y");
    expect(text).toContain("'@z");
  });
});

describe('buildXlsx', () => {
  it('produces a readable workbook with a header row', async () => {
    const buffer = await buildXlsx('Detail', ['Date', 'Amount'], [['2026-08-03', '1200.50']]);

    const workbook = new ExcelJS.Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await workbook.xlsx.load(buffer as any);
    const sheet = workbook.getWorksheet('Detail');

    expect(sheet).toBeDefined();
    expect(sheet!.getRow(1).getCell(1).value).toBe('Date');
    expect(sheet!.getRow(2).getCell(2).value).toBe('1200.50');
  });
});

describe('buildTransactionDetailRows', () => {
  it('includes every column named in the spec', async () => {
    const { headers } = await withTransaction(ownerId, (tx) =>
      buildTransactionDetailRows(tx, orgId, {}, 'en'),
    );

    expect(headers).toEqual([
      'Date',
      'Type',
      'Note',
      'Category',
      'Money account',
      'Amount',
      'Currency',
      'Exchange rate',
      'Amount (MYR)',
      'Added by',
      'Attachments',
    ]);
  });

  it('exports amounts as decimal strings, not minor units', async () => {
    const { rows } = await withTransaction(ownerId, (tx) =>
      buildTransactionDetailRows(tx, orgId, {}, 'en'),
    );

    const rent = rows.find((r) => r[2] === '八月租金, 含水电');
    expect(rent?.[5]).toBe('1200.50');
    expect(rent?.[8]).toBe('1200.50');
  });

  it('excludes voided records by default', async () => {
    const { rows } = await withTransaction(ownerId, (tx) =>
      buildTransactionDetailRows(tx, orgId, {}, 'en'),
    );
    expect(rows.some((r) => r[2] === 'Wrong entry')).toBe(false);
    expect(rows).toHaveLength(2);
  });

  it('adds status and void reason columns when voided records are included', async () => {
    const { headers, rows } = await withTransaction(ownerId, (tx) =>
      buildTransactionDetailRows(tx, orgId, { includeVoided: true }, 'en'),
    );

    expect(headers).toContain('Status');
    expect(headers).toContain('Void reason');

    const wrong = rows.find((r) => r[2] === 'Wrong entry');
    expect(wrong?.at(-2)).toBe('Voided');
    expect(wrong?.at(-1)).toBe('Duplicate');

    // 未作废的行状态列留空，不要也标成 Voided
    const rent = rows.find((r) => r[2] === '八月租金, 含水电');
    expect(rent?.at(-2)).toBe('');
    expect(rent?.at(-1)).toBe('');
  });

  it('respects the date filter', async () => {
    const { rows } = await withTransaction(ownerId, (tx) =>
      buildTransactionDetailRows(tx, orgId, { from: '2026-08-04', to: '2026-08-04' }, 'en'),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0][2]).toBe('Shop sales');
  });

  it('uses Chinese headers and names for the zh locale', async () => {
    const { headers, rows } = await withTransaction(ownerId, (tx) =>
      buildTransactionDetailRows(tx, orgId, {}, 'zh'),
    );

    expect(headers[0]).toBe('日期');
    expect(headers[8]).toBe('本位币金额 (MYR)');
    const rent = rows.find((r) => r[2] === '八月租金, 含水电');
    expect(rent?.[3]).toBe('租金');
    expect(rent?.[1]).toBe('支出');
  });

  it('never returns the base currency placeholder verbatim', async () => {
    for (const locale of ['en', 'zh'] as const) {
      const { headers } = await withTransaction(ownerId, (tx) =>
        buildTransactionDetailRows(tx, orgId, {}, locale),
      );
      expect(headers.some((h) => h.includes('BASE'))).toBe(false);
    }
  });

  it('keeps rows scoped to the requested company', async () => {
    const { rows } = await withTransaction(ownerId, (tx) =>
      buildTransactionDetailRows(tx, orgId, {}, 'en'),
    );
    expect(rows.some((r) => r[2] === 'Second company rent')).toBe(false);
    expect(rows).toHaveLength(2);
  });
});

describe('buildAccountSummaryRows', () => {
  const period = { from: '2026-08-01', to: '2026-08-31' };

  it('groups debits and credits by account with a net column', async () => {
    const { headers, rows } = await withTransaction(ownerId, (tx) =>
      buildAccountSummaryRows(tx, orgId, period, 'en'),
    );

    expect(headers).toEqual([
      'Account code',
      'Account',
      'Type',
      'Debit total',
      'Credit total',
      'Net',
    ]);

    const rent = rows.find((r) => r[0] === 'rent');
    expect(rent?.[3]).toBe('1200.50');
    expect(rent?.[4]).toBe('0.00');
    // 费用是借方科目，净额取借减贷
    expect(rent?.[5]).toBe('1200.50');

    const sales = rows.find((r) => r[0] === 'sales');
    expect(sales?.[3]).toBe('0.00');
    expect(sales?.[4]).toBe('5000.00');
    // 收入是贷方科目，净额取贷减借，在其自然方向上为正
    expect(sales?.[5]).toBe('5000.00');
  });

  it('shows a negative net when an account sits against its natural side', async () => {
    // 给现金记一笔支出，现金（资产、借方科目）当期贷方大于借方，净额应为负
    const { rows } = await withTransaction(ownerId, (tx) =>
      buildAccountSummaryRows(tx, orgId, period, 'en'),
    );

    const cash = rows.find((r) => r[0] === 'cash');
    expect(cash?.[4]).toBe('1200.50');
    expect(cash?.[5]).toBe('-1200.50');
  });

  it('keeps total debits equal to total credits', async () => {
    const { rows } = await withTransaction(ownerId, (tx) =>
      buildAccountSummaryRows(tx, orgId, period, 'en'),
    );

    const sum = (index: number) =>
      rows.reduce((acc, row) => acc + Math.round(Number(row[index]) * 100), 0);

    expect(sum(3)).toBe(sum(4));
    expect(sum(3)).toBeGreaterThan(0);
  });

  it('excludes voided records', async () => {
    const { rows } = await withTransaction(ownerId, (tx) =>
      buildAccountSummaryRows(tx, orgId, period, 'en'),
    );
    expect(rows.some((r) => r[0] === 'marketing')).toBe(false);
  });

  it('includes voided records when asked', async () => {
    const { rows } = await withTransaction(ownerId, (tx) =>
      buildAccountSummaryRows(tx, orgId, { ...period, includeVoided: true }, 'en'),
    );
    expect(rows.some((r) => r[0] === 'marketing')).toBe(true);
  });

  it('respects the period', async () => {
    const { rows } = await withTransaction(ownerId, (tx) =>
      buildAccountSummaryRows(tx, orgId, { from: '2026-08-04', to: '2026-08-04' }, 'en'),
    );
    expect(rows.some((r) => r[0] === 'sales')).toBe(true);
    expect(rows.some((r) => r[0] === 'rent')).toBe(false);
  });

  it('keeps totals scoped to the requested company', async () => {
    const { rows } = await withTransaction(ownerId, (tx) =>
      buildAccountSummaryRows(tx, orgId, period, 'en'),
    );
    // 第二家公司（同一个 owner）预置了同样的科目编码，也有 999.00 的租金支出。
    // 漏掉公司收窄时会多出一行同编码的 rent，所以这里断编码唯一 ——
    // 只用 find() 取第一行是抓不到的，它会开心地拿到本公司那行。
    const codes = rows.map((r) => r[0]);
    expect(new Set(codes).size).toBe(codes.length);

    const rent = rows.filter((r) => r[0] === 'rent');
    expect(rent).toHaveLength(1);
    expect(rent[0][3]).toBe('1200.50');
  });

  it('uses Chinese labels for the zh locale', async () => {
    const { headers, rows } = await withTransaction(ownerId, (tx) =>
      buildAccountSummaryRows(tx, orgId, period, 'zh'),
    );
    expect(headers[0]).toBe('科目编码');
    const rent = rows.find((r) => r[0] === 'rent');
    expect(rent?.[1]).toBe('租金');
    expect(rent?.[2]).toBe('费用');
  });
});

describe('exportReport', () => {
  const period = { from: '2026-08-01', to: '2026-08-31' } as const;

  it('returns a csv file with a descriptive name', async () => {
    currentUserId = ownerId;
    const result = await exportReport(orgSlug, {
      kind: 'transaction-detail',
      format: 'csv',
      ...period,
      locale: 'en',
    });

    expect(result.contentType).toBe('text/csv; charset=utf-8');
    expect(result.fileName).toBe('teyo-transaction-detail-2026-08-01-to-2026-08-31.csv');

    const decoded = Buffer.from(result.body, 'base64');
    expect(decoded.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(decoded.toString('utf8')).toContain('Shop sales');
  });

  it('returns an xlsx file for the account summary', async () => {
    currentUserId = ownerId;
    const result = await exportReport(orgSlug, {
      kind: 'account-summary',
      format: 'xlsx',
      ...period,
      locale: 'en',
    });

    expect(result.contentType).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(result.fileName).toMatch(/\.xlsx$/);

    const workbook = new ExcelJS.Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await workbook.xlsx.load(Buffer.from(result.body, 'base64') as any);
    expect(workbook.worksheets).toHaveLength(1);
    expect(workbook.getWorksheet('Summary')).toBeDefined();
  });

  it('writes an audit entry recording what was exported', async () => {
    currentUserId = ownerId;
    await exportReport(orgSlug, {
      kind: 'transaction-detail',
      format: 'csv',
      ...period,
      locale: 'en',
      includeVoided: true,
    });

    const [entry] = await admin`
      select after from audit_logs
      where organization_id = ${orgId} and action = 'report.exported'
      order by created_at desc limit 1
    `;

    expect(entry.after.kind).toBe('transaction-detail');
    expect(entry.after.format).toBe('csv');
    expect(entry.after.from).toBe('2026-08-01');
    expect(entry.after.includeVoided).toBe(true);
    expect(entry.after.rowCount).toBe(3);
  });

  it('lets a viewer export', async () => {
    const viewerId = await createTestUser('viewer-exp@example.com', 'Viewer');
    await joinOrg(viewerId, orgId, 'viewer');

    currentUserId = viewerId;
    await expect(
      exportReport(orgSlug, {
        kind: 'transaction-detail',
        format: 'csv',
        ...period,
        locale: 'en',
      }),
    ).resolves.toBeTruthy();
    currentUserId = ownerId;
  });

  it('refuses a non-member', async () => {
    const outsiderId = await createTestUser('outsider-exp@example.com', 'Outsider');
    currentUserId = outsiderId;

    await expect(
      exportReport(orgSlug, {
        kind: 'transaction-detail',
        format: 'csv',
        ...period,
        locale: 'en',
      }),
    ).rejects.toThrow();
    currentUserId = ownerId;
  });

  it('rejects a period that ends before it starts', async () => {
    currentUserId = ownerId;
    await expect(
      exportReport(orgSlug, {
        kind: 'transaction-detail',
        format: 'csv',
        from: '2026-08-31',
        to: '2026-08-01',
        locale: 'en',
      }),
    ).rejects.toThrow();
  });

  it('carries the row cap message through i18n, not a hardcoded string', () => {
    // 上限提示面向用户，必须两种语言都有，且占位符一致。
    const error = new ExportError('exportTooManyRows', { count: 30000, limit: MAX_EXPORT_ROWS });
    expect(error.messageKey).toBe('exportTooManyRows');
    expect(error.values.limit).toBe(20000);
    expect(error.localize('en')).toContain('30000');
    expect(error.localize('en')).toContain('20000');
    expect(error.localize('zh')).toContain('30000');
    expect(error.localize('zh')).not.toMatch(/[{}]/);
  });
});
