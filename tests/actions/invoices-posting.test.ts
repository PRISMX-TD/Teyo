import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { admin } from '@/tests/helpers/db';
import { documentClientUuid } from '@/server/services/document-posting';
import {
  createTestOrgWithSeed,
  createTestUser,
  joinOrg,
  resetTestData,
  seedRate,
} from '@/tests/helpers/test-db';

let currentUserId: string | null = null;

vi.mock('@/server/auth/session', () => ({
  getCurrentUserId: () => Promise.resolve(currentUserId),
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { createInvoice, issueInvoice, updateInvoice, voidInvoice } = await import(
  '@/server/actions/invoices'
);

let ownerId: string;
let viewerId: string;
let bookkeeperId: string;
let orgId: string;
let orgSlug: string;
let customerId: string;

const suffix = randomUUID().slice(0, 8);

/**
 * exchange_rates 是全局共享表，没有公司维度隔离，各测试文件之间只能靠日期
 * 错开。2032-04 这一格没有别的文件用。
 */
const DAY = '2032-04-10';
const DUE = '2032-05-10';

beforeAll(async () => {
  ownerId = await createTestUser(`test-owner-inv-${suffix}@example.com`, 'Owner');
  viewerId = await createTestUser(`test-viewer-inv-${suffix}@example.com`, 'Viewer');
  bookkeeperId = await createTestUser(`test-book-inv-${suffix}@example.com`, 'Bookkeeper');

  const org = await createTestOrgWithSeed(ownerId, 'Invoice Co', `invoice-co-${suffix}`, 'MYR');
  orgId = org.id;
  orgSlug = org.slug;

  await joinOrg(viewerId, orgId, 'viewer');
  await joinOrg(bookkeeperId, orgId, 'bookkeeper');

  const [contact] = await admin`
    insert into contacts (organization_id, type, name)
    values (${orgId}, 'customer', 'Test Customer')
    returning id
  `;
  customerId = contact.id as string;
});

afterAll(async () => {
  await resetTestData();
  await admin.end();
});

function invoiceInput(overrides: Record<string, unknown> = {}) {
  return {
    contactId: customerId,
    issueDate: DAY,
    dueDate: DUE,
    currency: 'MYR',
    taxRatePercent: '0',
    items: [{ description: 'Consulting', quantity: '1', unitPrice: '100.00' }],
    ...overrides,
  };
}

async function invoiceRow(id: string) {
  const [row] = await admin`
    select status, currency, subtotal_minor, tax_rate_bps, tax_minor, total_minor,
           transaction_id, voided_at
    from invoices where id = ${id}
  `;
  return row;
}

/**
 * 分录行，按「借方在前」排。journal_direction 是枚举，order by 按声明顺序
 * （'debit', 'credit'，见 0001 迁移）而不是字母序——写成 desc 会把贷方排到
 * 前面，与 templateFor 生成的顺序正好相反。
 */
async function linesFor(transactionId: string) {
  return admin`
    select a.code, l.direction, l.amount_minor, l.base_amount_minor
    from journal_lines l join accounts a on a.id = l.account_id
    where l.transaction_id = ${transactionId}
    order by l.direction, l.amount_minor desc
  `;
}

async function transactionRow(id: string) {
  const [row] = await admin`
    select kind, category_id, occurred_on::text as occurred_on, description, currency, amount_minor,
           base_amount_minor, exchange_rate, client_uuid, voided_at, voided_by, void_reason
    from transactions where id = ${id}
  `;
  return row;
}

async function auditActions(entityId: string) {
  const rows = await admin`
    select action from audit_logs where entity_id = ${entityId} order by created_at
  `;
  return rows.map((row) => row.action as string);
}

describe('createInvoice - 草稿不进总账', () => {
  /**
   * 收入确认的时点是开具，不是起草。把草稿记进总账，等于每敲一次键盘就动
   * 一次收入与应收，而作废一张从未发出的草稿还要在总账上留一笔冲销。
   */
  it('creates a draft with no ledger entry at all', async () => {
    currentUserId = ownerId;
    const { id, transactionId } = await createInvoice(orgSlug, invoiceInput());

    expect(transactionId).toBeNull();

    const row = await invoiceRow(id);
    expect(row.status).toBe('draft');
    expect(row.transaction_id).toBeNull();
    expect(row.total_minor).toBe('10000');

    const lines = await admin`
      select l.id from journal_lines l
      join transactions t on t.id = l.transaction_id
      where t.organization_id = ${orgId} and t.description = ${'Invoice ' + id}
    `;
    expect(lines).toHaveLength(0);
  });

  /**
   * 币种缺省必须是本位币，不是 USD。0008 的列默认值与 invoice-form.tsx 里
   * 的 useState('USD') 都写着 USD，而这是给马来西亚商户做的产品。
   */
  it('defaults the currency to the company base currency, not USD', async () => {
    currentUserId = ownerId;
    const { id } = await createInvoice(orgSlug, invoiceInput({ currency: undefined }));
    expect((await invoiceRow(id)).currency).toBe('MYR');
  });

  it('writes an audit entry, which this module never did before', async () => {
    currentUserId = ownerId;
    const { id } = await createInvoice(orgSlug, invoiceInput());
    expect(await auditActions(id)).toEqual(['invoice.created']);
  });
});

describe('createInvoice - 单号并发', () => {
  /**
   * 单号是「读出当前最大号，加一」。两个并发创建会读到同一个最大号、算出
   * 同一个下一号，然后撞 invoices_org_number 唯一约束——用户看到的是一句
   * 裸的 Postgres 报错，而他做的只是同时开了两张发票。
   *
   * 这一条真的并发跑（Promise.all 两个各自独立的 withTransaction），不是
   * 顺序跑两次然后假装它是并发。撞上时靠 withDocumentNumberRetry 整笔重来
   * ——失败的事务已经整体回滚，重跑会读到新的最大号。
   *
   * 它是概率性的，这里说清楚：把 DOCUMENT_NUMBER_ATTEMPTS 改成 1（等于关掉
   * 重试）实测五轮里有三轮以 duplicate key 失败——也就是说它确实撞得到，但
   * 不保证每一轮都撞。真正把重试逻辑钉死的是
   * tests/services/document-posting.test.ts 里那组不连数据库的用例（只认
   * 那一个约束名、重试有限次），这一条量的是「那套逻辑真的接在创建路径上」。
   *
   * 并发度停在 2 而不是更高：每个并发都会从应用连接池多占一条连接，而这套
   * 测试连的是共享的 Supabase pooler（pool_size 15，见 vitest.config.mts 里
   * 关于 EMAXCONNSESSION 的注释）。开到 3 个时，四个测试文件并行跑就会把
   * 连接打满，失败的文件每轮都不一样——那种噪音比这条测试本身更贵。
   *
   * 为什么不是行锁：READ COMMITTED 下 FOR UPDATE 挡不住 INSERT 造成的幻读，
   * 等锁的那个事务拿到锁后只重读被锁的那一行，不会重跑整个查询去发现新插入
   * 的行，于是它读到的仍是同一个最大号。论证写在 withDocumentNumberRetry 上。
   */
  it('gives two concurrent creates two different invoice numbers', async () => {
    currentUserId = ownerId;

    const created = await Promise.all([
      createInvoice(orgSlug, invoiceInput()),
      createInvoice(orgSlug, invoiceInput()),
    ]);

    const rows = await admin`
      select invoice_number from invoices
      where id = any(${created.map((row) => row.id)})
    `;
    const numbers = rows.map((row) => row.invoice_number as string);

    expect(numbers).toHaveLength(2);
    expect(new Set(numbers).size).toBe(2);
    for (const number of numbers) expect(number).toMatch(/^INV-\d{5}$/);
  });

  /**
   * 号码不合 INV-NNNNN 形状的历史数据（库里现在就有 'INV-7eaba18b-2' 这种）
   * 不该把整个序列打回 INV-00001——那个号通常早就被用掉了，于是下一次创建
   * 必然撞唯一约束。旧写法「按 created_at 取最近一张、解析失败就返回
   * INV-00001」正是这个行为。
   */
  it('ignores a non-conforming number instead of resetting the sequence to 1', async () => {
    currentUserId = ownerId;
    const first = await createInvoice(orgSlug, invoiceInput());
    const [{ invoice_number: firstNumber }] = await admin`
      select invoice_number from invoices where id = ${first.id}
    `;

    // 插一张号码形状完全不同、且 created_at 最新的发票。
    await admin`
      insert into invoices (organization_id, contact_id, invoice_number, status,
                            issue_date, due_date, currency, subtotal_minor,
                            tax_rate_bps, tax_minor, total_minor)
      values (${orgId}, ${customerId}, ${`INV-legacy-${suffix}`}, 'draft',
              ${DAY}, ${DUE}, 'MYR', 100, 0, 0, 100)
    `;

    const next = await createInvoice(orgSlug, invoiceInput());
    const [{ invoice_number: nextNumber }] = await admin`
      select invoice_number from invoices where id = ${next.id}
    `;

    expect(nextNumber).not.toBe(firstNumber);
    expect(Number((nextNumber as string).slice(4))).toBeGreaterThan(
      Number((firstNumber as string).slice(4)),
    );
  });
});

describe('createInvoice - 金额计算', () => {
  /**
   * 行金额 = 单价 × 数量，half-up。旧算法 (unitBig * qtyBig) / 10000n
   * 向零截断：3.33 × 1.5 = 4.995 应当是 5.00，截断给 4.99。
   */
  it('rounds a line extension half up instead of truncating', async () => {
    currentUserId = ownerId;
    const { id } = await createInvoice(
      orgSlug,
      invoiceInput({ items: [{ description: 'Hours', quantity: '1.5', unitPrice: '3.33' }] }),
    );

    const row = await invoiceRow(id);
    expect(row.subtotal_minor).toBe('500');
    expect(row.total_minor).toBe('500');
  });

  /** 税额同样 half-up：1.25 的 6% 是 0.075，应当进位成 0.08。 */
  it('rounds tax half up instead of truncating', async () => {
    currentUserId = ownerId;
    const { id } = await createInvoice(
      orgSlug,
      invoiceInput({
        taxRatePercent: '6',
        items: [{ description: 'Item', quantity: '1', unitPrice: '1.25' }],
      }),
    );

    const row = await invoiceRow(id);
    expect(row.subtotal_minor).toBe('125');
    expect(row.tax_rate_bps).toBe(600);
    expect(row.tax_minor).toBe('8');
    expect(row.total_minor).toBe('133');
  });

  /**
   * 旧写法的 `parseFloat(x) || 0` 会把这三种输入都变成 0 税率，
   * 于是一张本该含税的发票静默地免了税。
   */
  it('refuses a malformed tax rate instead of silently zeroing it', async () => {
    currentUserId = ownerId;
    for (const taxRatePercent of ['abc', '6%', '6,5']) {
      await expect(createInvoice(orgSlug, invoiceInput({ taxRatePercent }))).rejects.toThrow();
    }
  });

  it('refuses a malformed quantity instead of reading only its numeric prefix', async () => {
    currentUserId = ownerId;
    await expect(
      createInvoice(
        orgSlug,
        invoiceInput({ items: [{ description: 'x', quantity: '2abc', unitPrice: '1.00' }] }),
      ),
    ).rejects.toThrow();
  });
});

describe('issueInvoice - 开具即进总账', () => {
  /**
   * 这是本次改动的核心：invoices.transaction_id 从 0008 建表起就存在，
   * 到这次为止从未被写入过任何一行，应收账款在总账里结构性地永远为零。
   */
  it('posts debit receivable / credit revenue / credit output tax and links the transaction', async () => {
    currentUserId = ownerId;
    const { id } = await createInvoice(
      orgSlug,
      invoiceInput({
        taxRatePercent: '6',
        items: [{ description: 'Goods', quantity: '2', unitPrice: '500.00' }],
      }),
    );

    const { transactionId } = await issueInvoice(orgSlug, id);

    const row = await invoiceRow(id);
    expect(row.status).toBe('sent');
    expect(row.transaction_id).toBe(transactionId);
    expect(row.subtotal_minor).toBe('100000');
    expect(row.tax_minor).toBe('6000');
    expect(row.total_minor).toBe('106000');

    expect(await linesFor(transactionId)).toEqual([
      {
        code: 'accounts-receivable',
        direction: 'debit',
        amount_minor: '106000',
        base_amount_minor: '106000',
      },
      { code: 'sales', direction: 'credit', amount_minor: '100000', base_amount_minor: '100000' },
      {
        code: 'tax-payable',
        direction: 'credit',
        amount_minor: '6000',
        base_amount_minor: '6000',
      },
    ]);
  });

  /**
   * 单据事件一律落成 transaction_kind = 'journal' 且不带分类——理由在
   * server/domain/posting-templates.ts 的 kindFor 上：开一张发票不是
   * 「收到钱」，而 transactions_category_matches_kind 约束要求 income
   * 必须带分类，那等于凭空编一个用户没选过的归类。
   */
  it('records the posting as a journal with no category and the invoice date', async () => {
    currentUserId = ownerId;
    const { id } = await createInvoice(orgSlug, invoiceInput());
    const { transactionId } = await issueInvoice(orgSlug, id);

    const row = await transactionRow(transactionId);
    expect(row.kind).toBe('journal');
    expect(row.category_id).toBeNull();
    expect(row.occurred_on).toBe(DAY);
    expect(row.amount_minor).toBe('10000');
  });

  /**
   * clientUuid 必须由发票 id 确定性派生。随机生成等于关掉 postJournal 的
   * 幂等：一次双击就是两笔应收，而两笔各自配平，触发器与不变量校验没有
   * 一道看得出问题。
   */
  it('uses a client uuid derived from the invoice id', async () => {
    currentUserId = ownerId;
    const { id } = await createInvoice(orgSlug, invoiceInput());
    const { transactionId } = await issueInvoice(orgSlug, id);

    const row = await transactionRow(transactionId);
    expect(row.client_uuid).toBe(documentClientUuid({ kind: 'invoice', id }));
  });

  it('refuses to issue the same invoice twice', async () => {
    currentUserId = ownerId;
    const { id } = await createInvoice(orgSlug, invoiceInput());
    await issueInvoice(orgSlug, id);

    await expect(issueInvoice(orgSlug, id)).rejects.toThrow(/already been issued/i);

    const rows = await admin`
      select id from transactions
      where organization_id = ${orgId}
        and client_uuid = ${documentClientUuid({ kind: 'invoice', id })}
    `;
    expect(rows).toHaveLength(1);
  });

  it('can create and issue in one call', async () => {
    currentUserId = ownerId;
    const { id, transactionId } = await createInvoice(orgSlug, invoiceInput({ issue: true }));

    expect(transactionId).not.toBeNull();
    expect((await invoiceRow(id)).status).toBe('sent');
    expect(await auditActions(id)).toEqual(['invoice.created']);
  });

  /**
   * 一张发票的净额与税额可以恰好都为零吗？不能——transactions.amount_minor
   * 与 journal_lines.amount_minor 都有 > 0 的 CHECK。挡在应用层，让用户
   * 读到一句话而不是一条约束报错。
   */
  it('refuses to post a zero-total invoice with a readable message', async () => {
    currentUserId = ownerId;
    const { id } = await createInvoice(
      orgSlug,
      invoiceInput({ items: [{ description: 'Freebie', quantity: '1', unitPrice: '0' }] }),
    );

    await expect(issueInvoice(orgSlug, id)).rejects.toThrow(/greater than zero/i);
  });
});

describe('issueInvoice - 外币', () => {
  /**
   * 三行外币分录：逐行换算之后借贷两侧的本位币合计可能差一个最小单位，
   * buildLines 会把残差吸收进短边最大的那一行。
   * server/domain/ledger.ts 与 buildCheckedLines 的注释都写着「第一笔三行
   * 外币事件（阶段 4 的发票）会在自己的边界上撞出一条假的 I3 错误」——
   * 这一条就是那笔发票，从数据库这一头量它没有撞。
   *
   * 净额 1.01、税率 6.93%（税额 0.07）、总额 1.08，汇率 1.5：
   *   应收  1.08 USD × 1.5 = 1.62 MYR（精确）
   *   收入  1.01 USD × 1.5 = 1.515 -> 1.52 MYR
   *   销项税 0.07 USD × 1.5 = 0.105 -> 0.11 MYR
   * 贷方合计 1.63 比借方多一分，残差被吸收进借方最大的那一行（应收），
   * 于是应收记 1.63 MYR——它故意不等于自己的 convertToBaseMinor，
   * 而 assertLineInvariants 恰好允许这一行、这一个幅度。
   */
  it('absorbs the per-line rounding residual into the largest short-side line', async () => {
    await seedRate('USD', 'MYR', 150000000n, DAY);

    currentUserId = ownerId;
    const { id } = await createInvoice(
      orgSlug,
      invoiceInput({
        currency: 'USD',
        taxRatePercent: '6.93',
        items: [{ description: 'Export', quantity: '1', unitPrice: '1.01' }],
      }),
    );

    const row = await invoiceRow(id);
    expect(row.subtotal_minor).toBe('101');
    expect(row.tax_minor).toBe('7');
    expect(row.total_minor).toBe('108');

    const { transactionId } = await issueInvoice(orgSlug, id);

    expect(await linesFor(transactionId)).toEqual([
      {
        code: 'accounts-receivable',
        direction: 'debit',
        amount_minor: '108',
        base_amount_minor: '163',
      },
      { code: 'sales', direction: 'credit', amount_minor: '101', base_amount_minor: '152' },
      { code: 'tax-payable', direction: 'credit', amount_minor: '7', base_amount_minor: '11' },
    ]);

    // 表头的本位币金额取自借方合计，不是 lines[0]——见 post-journal.ts 的
    // headerBaseAmount：三行事件上 lines[0] 是净额，用它会让表头比单据总额
    // 少一个税额，而四道校验没有一道看得出来。
    const head = await transactionRow(transactionId);
    expect(head.base_amount_minor).toBe('163');
    expect(head.currency).toBe('USD');
    expect(String(head.exchange_rate)).toMatch(/^1\.5/);
  });

  /**
   * 发票表单上没有汇率输入框，所以查不到缓存汇率时那句报错不能叫用户
   * 「在这里填一个」——他面前没有那个框。见 server/posting/rate.ts。
   */
  it('does not tell the user to type a rate the invoice form does not have', async () => {
    currentUserId = ownerId;
    const { id } = await createInvoice(
      orgSlug,
      invoiceInput({ currency: 'EUR', issueDate: '2032-04-25', dueDate: '2032-05-25' }),
    );

    await expect(issueInvoice(orgSlug, id)).rejects.toThrow(
      /Record this entry yourself under Transactions/,
    );
    await expect(issueInvoice(orgSlug, id)).rejects.not.toThrow(/Enter one manually/);
  });
});

describe('updateInvoice - 编辑后重新过账', () => {
  it('rebuilds the journal of an already posted invoice', async () => {
    currentUserId = ownerId;
    const { id } = await createInvoice(orgSlug, invoiceInput({ issue: true }));
    const before = await invoiceRow(id);
    const transactionId = before.transaction_id as string;

    await updateInvoice(
      orgSlug,
      id,
      invoiceInput({
        taxRatePercent: '6',
        items: [{ description: 'Consulting', quantity: '1', unitPrice: '200.00' }],
      }),
    );

    const after = await invoiceRow(id);
    // 同一笔交易被改写，而不是新记一笔。
    expect(after.transaction_id).toBe(transactionId);
    expect(after.total_minor).toBe('21200');

    expect(await linesFor(transactionId)).toEqual([
      {
        code: 'accounts-receivable',
        direction: 'debit',
        amount_minor: '21200',
        base_amount_minor: '21200',
      },
      { code: 'sales', direction: 'credit', amount_minor: '20000', base_amount_minor: '20000' },
      {
        code: 'tax-payable',
        direction: 'credit',
        amount_minor: '1200',
        base_amount_minor: '1200',
      },
    ]);

    expect(await transactionRow(transactionId)).toMatchObject({ amount_minor: '21200' });
    expect(await auditActions(id)).toEqual(['invoice.created', 'invoice.updated']);
  });

  /** 草稿没有分录，编辑只改单据。 */
  it('leaves a draft unposted when it is edited', async () => {
    currentUserId = ownerId;
    const { id } = await createInvoice(orgSlug, invoiceInput());

    await updateInvoice(
      orgSlug,
      id,
      invoiceInput({ items: [{ description: 'x', quantity: '1', unitPrice: '55.00' }] }),
    );

    const row = await invoiceRow(id);
    expect(row.transaction_id).toBeNull();
    expect(row.total_minor).toBe('5500');
  });
});

describe('voidInvoice - 作废连带作废分录', () => {
  /**
   * 原来只把 status 改成 'voided'：voided_at 留空（而列表与税务报表读的
   * 是 voided_at），对应的交易完全不动。现在发票真的有交易了，不一起作废
   * 就等于总账上留着一笔永远收不回来的应收。
   */
  it('voids the invoice and its transaction together, with the reason on the transaction', async () => {
    currentUserId = ownerId;
    const { id } = await createInvoice(orgSlug, invoiceInput({ issue: true }));
    const transactionId = (await invoiceRow(id)).transaction_id as string;

    await voidInvoice(orgSlug, id, 'Customer cancelled the order');

    const invoice = await invoiceRow(id);
    expect(invoice.status).toBe('voided');
    expect(invoice.voided_at).not.toBeNull();

    const transaction = await transactionRow(transactionId);
    // transactions_void_fields_together 要求三者同时存在且理由非空白。
    expect(transaction.voided_at).not.toBeNull();
    expect(transaction.voided_by).toBe(ownerId);
    expect(transaction.void_reason).toBe('Customer cancelled the order');

    // 分录保留不动：账目要可追溯，删掉就查不出当初记了什么。
    expect(await linesFor(transactionId)).toHaveLength(2);

    expect(await auditActions(id)).toEqual(['invoice.created', 'invoice.voided']);
    const transactionAudits = await auditActions(transactionId);
    expect(transactionAudits).toContain('transaction.voided');
  });

  it('refuses a blank reason', async () => {
    currentUserId = ownerId;
    const { id } = await createInvoice(orgSlug, invoiceInput({ issue: true }));
    await expect(voidInvoice(orgSlug, id, '   ')).rejects.toThrow(/reason/i);
    expect((await invoiceRow(id)).status).toBe('sent');
  });

  it('refuses to void the same invoice twice', async () => {
    currentUserId = ownerId;
    const { id } = await createInvoice(orgSlug, invoiceInput({ issue: true }));
    await voidInvoice(orgSlug, id, 'Duplicate');
    await expect(voidInvoice(orgSlug, id, 'Duplicate')).rejects.toThrow(/already voided/i);
  });

  it('refuses to edit a voided invoice', async () => {
    currentUserId = ownerId;
    const { id } = await createInvoice(orgSlug, invoiceInput({ issue: true }));
    await voidInvoice(orgSlug, id, 'Wrong customer');

    await expect(updateInvoice(orgSlug, id, invoiceInput())).rejects.toThrow(/voided/i);
  });
});

describe('权限', () => {
  /**
   * 这四个动作原来用的都是 transaction:read——viewer 也有这个 Action
   * （见 server/domain/permissions.ts 的 MATRIX），等于用只读权限守卫写操作。
   * 挡住 viewer 的只有 invoices 表的 RLS `with check`，而用户读到的是一句
   * 裸的 Postgres 策略报错，不是「你的角色不能做这件事」。
   */
  it('refuses a viewer with a role message, not a raw RLS error', async () => {
    currentUserId = viewerId;
    await expect(createInvoice(orgSlug, invoiceInput())).rejects.toThrow(
      /role \(viewer\) cannot perform transaction:create/,
    );
  });

  /** 作废是不可逆的写操作，用 transaction:edit:any（只有 owner/admin 有）。 */
  it('refuses a bookkeeper to void, which only owner and admin may do', async () => {
    currentUserId = ownerId;
    const { id } = await createInvoice(orgSlug, invoiceInput({ issue: true }));

    currentUserId = bookkeeperId;
    await expect(voidInvoice(orgSlug, id, 'nope')).rejects.toThrow(
      /role \(bookkeeper\) cannot perform transaction:edit:any/,
    );
  });
});
