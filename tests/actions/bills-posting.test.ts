import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { admin } from '@/tests/helpers/db';
import { withTransaction } from '@/server/db/transaction';
import { getBill, listBills } from '@/server/repositories/bills';
import { documentClientUuid } from '@/server/services/document-posting';
import {
  createTestOrgWithSeed,
  createTestUser,
  joinOrg,
  resetTestData,
  seedRate,
} from '@/tests/helpers/test-db';

/**
 * ⚠ 整个文件依赖迁移 0021。
 *
 * bills 直到 0021 才有 subtotal_minor / tax_rate_bps / tax_minor / tax_rate_id
 * 四列——此前只有 total_minor，一张含 6% SST 的供应商账单，税额无处可放，
 * 只能并进费用科目（repositories/tax.ts 里 `0::bigint as tax_minor`、
 * 进项恒为 0，就是这个缺列的直接后果）。insertBill 现在按 0021 的最终形态
 * 写入，所以 0021 执行之前，这个文件里每一条会建账单的用例都会以
 * `column "subtotal_minor" of relation "bills" does not exist` 失败。
 *
 * 这不是测试写错了，而是「代码已经按目标形态写好、库还没跟上」的中间态。
 * 不依赖新列的那部分（税额/行金额的纯函数、幂等键、PostingEvent 的形状）
 * 在 tests/services/document-posting.test.ts 里，那一份现在就能跑绿。
 */

let currentUserId: string | null = null;

vi.mock('@/server/auth/session', () => ({
  getCurrentUserId: () => Promise.resolve(currentUserId),
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { createBill, receiveBill, updateBill, voidBill } = await import('@/server/actions/bills');

let ownerId: string;
let viewerId: string;
let orgId: string;
let orgSlug: string;
let vendorId: string;

const suffix = randomUUID().slice(0, 8);

/** exchange_rates 没有公司维度隔离，各测试文件只能靠日期错开。2032-05 这一格没人用。 */
const DAY = '2032-05-12';
const DUE = '2032-06-12';

beforeAll(async () => {
  ownerId = await createTestUser(`test-owner-bill-${suffix}@example.com`, 'Owner');
  viewerId = await createTestUser(`test-viewer-bill-${suffix}@example.com`, 'Viewer');

  const org = await createTestOrgWithSeed(ownerId, 'Bill Co', `bill-co-${suffix}`, 'MYR');
  orgId = org.id;
  orgSlug = org.slug;

  await joinOrg(viewerId, orgId, 'viewer');

  const [contact] = await admin`
    insert into contacts (organization_id, type, name)
    values (${orgId}, 'vendor', 'Test Vendor')
    returning id
  `;
  vendorId = contact.id as string;
});

afterAll(async () => {
  await resetTestData();
  await admin.end();
});

function billInput(overrides: Record<string, unknown> = {}) {
  return {
    contactId: vendorId,
    issueDate: DAY,
    dueDate: DUE,
    currency: 'MYR',
    items: [{ description: 'Stock purchase', amount: '100.00' }],
    ...overrides,
  };
}

async function billRow(id: string) {
  const [row] = await admin`
    select status, currency, subtotal_minor, tax_rate_bps, tax_minor, total_minor,
           tax_rate_id, transaction_id, voided_at
    from bills where id = ${id}
  `;
  return row;
}

/** 借方在前。journal_direction 是枚举，order by 按声明顺序而不是字母序。 */
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
    select kind, category_id, occurred_on::text as occurred_on, description, currency,
           amount_minor, base_amount_minor, client_uuid, voided_at, voided_by, void_reason
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

describe('createBill - 收到账单即入账', () => {
  /**
   * 账单与发票的过账时机不同。发票默认建成 draft（还没发给客户的底稿，
   * 收入尚未确认），而 'received' 这个词本身的意思就是「供应商的账单已经
   * 收到了」——负债已经成立、费用已经发生，权责发生制下这一刻就该入账。
   *
   * 这一条同时是本次改动的核心：bills.transaction_id 从 0008 起就存在，
   * 到这次为止从未被写入过，应付账款在总账里结构性地永远为零。
   */
  it('posts debit purchases / credit payable and links the transaction', async () => {
    currentUserId = ownerId;
    const { id, transactionId } = await createBill(orgSlug, billInput());

    expect(transactionId).not.toBeNull();

    const row = await billRow(id);
    expect(row.status).toBe('received');
    expect(row.transaction_id).toBe(transactionId);
    expect(row.subtotal_minor).toBe('10000');
    expect(row.tax_minor).toBe('0');
    expect(row.total_minor).toBe('10000');

    expect(await linesFor(transactionId as string)).toEqual([
      { code: 'purchases', direction: 'debit', amount_minor: '10000', base_amount_minor: '10000' },
      {
        code: 'accounts-payable',
        direction: 'credit',
        amount_minor: '10000',
        base_amount_minor: '10000',
      },
    ]);
  });

  /**
   * 含税账单的三行形状。进项税挂 tax-receivable（资产）而不是 tax-payable
   * （负债）——挂反了，报表上「应缴税款 = 销项 - 进项」会变成「销项 + 进项」，
   * 而分录照样配平。
   */
  it('splits a taxed bill into expense, input tax and payable', async () => {
    currentUserId = ownerId;
    const { id, transactionId } = await createBill(
      orgSlug,
      billInput({ taxRatePercent: '6', items: [{ description: 'Stock', amount: '1000.00' }] }),
    );

    const row = await billRow(id);
    expect(row.subtotal_minor).toBe('100000');
    expect(row.tax_rate_bps).toBe(600);
    expect(row.tax_minor).toBe('6000');
    expect(row.total_minor).toBe('106000');

    expect(await linesFor(transactionId as string)).toEqual([
      {
        code: 'purchases',
        direction: 'debit',
        amount_minor: '100000',
        base_amount_minor: '100000',
      },
      {
        code: 'tax-receivable',
        direction: 'debit',
        amount_minor: '6000',
        base_amount_minor: '6000',
      },
      {
        code: 'accounts-payable',
        direction: 'credit',
        amount_minor: '106000',
        base_amount_minor: '106000',
      },
    ]);
  });

  it('records the posting as a journal with no category, on the bill date', async () => {
    currentUserId = ownerId;
    const { transactionId } = await createBill(orgSlug, billInput());

    const row = await transactionRow(transactionId as string);
    expect(row.kind).toBe('journal');
    expect(row.category_id).toBeNull();
    expect(row.occurred_on).toBe(DAY);
  });

  /** 幂等键由账单 id 派生，理由见 documentClientUuid。 */
  it('uses a client uuid derived from the bill id', async () => {
    currentUserId = ownerId;
    const { id, transactionId } = await createBill(orgSlug, billInput());

    const row = await transactionRow(transactionId as string);
    expect(row.client_uuid).toBe(documentClientUuid({ kind: 'bill', id }));
  });

  /** 币种缺省是本位币，不是 0008 列默认值里那个 USD。 */
  it('defaults the currency to the company base currency, not USD', async () => {
    currentUserId = ownerId;
    const { id } = await createBill(orgSlug, billInput({ currency: undefined }));
    expect((await billRow(id)).currency).toBe('MYR');
  });

  /** 这个模块此前一次都没调用过 recordAudit，整个应付模块在审计日志里不可见。 */
  it('writes an audit entry', async () => {
    currentUserId = ownerId;
    const { id } = await createBill(orgSlug, billInput());
    expect(await auditActions(id)).toEqual(['bill.created']);
  });

  it('refuses a malformed tax rate instead of silently zeroing it', async () => {
    currentUserId = ownerId;
    for (const taxRatePercent of ['abc', '6%', '6,5']) {
      await expect(createBill(orgSlug, billInput({ taxRatePercent }))).rejects.toThrow();
    }
  });

  it('refuses to post a zero-total bill with a readable message', async () => {
    currentUserId = ownerId;
    await expect(
      createBill(orgSlug, billInput({ items: [{ description: 'Free sample', amount: '0' }] })),
    ).rejects.toThrow(/greater than zero/i);
  });
});

/**
 * 这一组**不依赖 0021**，迁移执行前后都必须绿。
 *
 * 写入侧按 0021 的最终形态写死，所以迁移执行前新建账单一定失败——这没法
 * 绕过：含税账单的税额在缺列的库里根本无处可放，伪造一个只会把税额悄悄
 * 并进费用，正是 0021 要修的那个 bug。但读取侧不能跟着一起挂：列表页、
 * 账龄表、报表读的是既有账单，让它们在迁移窗口期变成 500，用户只是想看
 * 一眼自己的旧数据。所以 listBills / getBill 对缺列容错（见 bills.ts 的
 * taxColumns），回退值与 0021 自己的回填逐字一致：整张单都是净额，税额为 0。
 */
describe('读取路径对 0021 之前的库容错', () => {
  it('reads a bill written without the new tax columns, in either schema era', async () => {
    const hasNewColumns =
      (
        await admin`
          select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'bills'
            and column_name = 'subtotal_minor'
        `
      ).length > 0;

    const billNumber = `BILL-legacy-${suffix}`;
    // 迁移之后 bills_total_is_net_plus_tax 要求三个数自洽，所以列存在时必须
    // 把净额一起写上；列不存在时这一段就是 0021 之前真实数据的样子。
    const [legacy] = hasNewColumns
      ? await admin`
          insert into bills (organization_id, contact_id, bill_number, status,
                             issue_date, due_date, currency, total_minor,
                             subtotal_minor, tax_minor)
          values (${orgId}, ${vendorId}, ${billNumber}, 'received',
                  ${DAY}, ${DUE}, 'MYR', 25000, 25000, 0)
          returning id
        `
      : await admin`
          insert into bills (organization_id, contact_id, bill_number, status,
                             issue_date, due_date, currency, total_minor)
          values (${orgId}, ${vendorId}, ${billNumber}, 'received',
                  ${DAY}, ${DUE}, 'MYR', 25000)
          returning id
        `;

    const detail = await withTransaction(ownerId, (tx) =>
      getBill(tx, orgId, legacy.id as string),
    );
    expect(detail).not.toBeNull();
    expect(detail?.totalMinor).toBe(25000n);
    // 缺列时净额回退成总额、税额回退成 0；列存在时读到的是真值。
    // 两种情况下这条等式都必须成立——它正是 0021 加的那条 CHECK。
    expect((detail?.subtotalMinor ?? 0n) + (detail?.taxMinor ?? 0n)).toBe(detail?.totalMinor);

    const list = await withTransaction(ownerId, (tx) => listBills(tx, orgId));
    const listed = list.find((row) => row.id === legacy.id);
    expect(listed).toBeDefined();
    expect(listed?.totalMinor).toBe(25000n);
    expect((listed?.subtotalMinor ?? 0n) + (listed?.taxMinor ?? 0n)).toBe(listed?.totalMinor);
  });
});

describe('createBill - 单号并发', () => {
  /**
   * 与发票那一侧同一件事：单号是「读最大号 + 1」，并发创建会算出同一个号
   * 并撞 bills_org_number。真的并发跑两个，靠 withDocumentNumberRetry
   * 整笔重来。它同样是概率性的，并发度为什么停在 2、以及为什么 FOR UPDATE
   * 在这里挡不住，见 invoices-posting.test.ts 的同名用例与
   * withDocumentNumberRetry 的注释。
   */
  it('gives two concurrent creates two different bill numbers', async () => {
    currentUserId = ownerId;

    const created = await Promise.all([
      createBill(orgSlug, billInput()),
      createBill(orgSlug, billInput()),
    ]);

    const rows = await admin`
      select bill_number from bills where id = any(${created.map((row) => row.id)})
    `;
    const numbers = rows.map((row) => row.bill_number as string);

    expect(numbers).toHaveLength(2);
    expect(new Set(numbers).size).toBe(2);
    for (const number of numbers) expect(number).toMatch(/^BILL-\d{5}$/);
  });
});

describe('createBill - 草稿不进总账', () => {
  it('leaves a draft bill out of the ledger until it is received', async () => {
    currentUserId = ownerId;
    const { id, transactionId } = await createBill(orgSlug, billInput({ status: 'draft' }));

    expect(transactionId).toBeNull();
    expect((await billRow(id)).transaction_id).toBeNull();

    const received = await receiveBill(orgSlug, id);
    const row = await billRow(id);
    expect(row.status).toBe('received');
    expect(row.transaction_id).toBe(received.transactionId);

    expect(await auditActions(id)).toEqual(['bill.created', 'bill.received']);
  });

  it('refuses to receive the same bill twice', async () => {
    currentUserId = ownerId;
    const { id } = await createBill(orgSlug, billInput({ status: 'draft' }));
    await receiveBill(orgSlug, id);
    await expect(receiveBill(orgSlug, id)).rejects.toThrow(/already been posted/i);
  });
});

describe('createBill - 外币', () => {
  /**
   * 三行外币账单，与发票那一侧对称：逐行换算后借贷两侧的本位币合计差一个
   * 最小单位，buildLines 把残差吸收进短边最大的那一行。
   *
   * 净额 1.01、税 0.07、总额 1.08，汇率 1.5：
   *   进货   1.01 × 1.5 = 1.515 -> 1.52
   *   进项税 0.07 × 1.5 = 0.105 -> 0.11   借方合计 1.63
   *   应付   1.08 × 1.5 = 1.62（精确）    贷方 1.62
   * 贷方短一分，残差吸收进贷方最大的那一行（应付），于是应付记 1.63。
   */
  it('absorbs the per-line rounding residual into the largest short-side line', async () => {
    await seedRate('USD', 'MYR', 150000000n, DAY);

    currentUserId = ownerId;
    const { id, transactionId } = await createBill(
      orgSlug,
      billInput({
        currency: 'USD',
        taxRatePercent: '6.93',
        items: [{ description: 'Import', amount: '1.01' }],
      }),
    );

    const row = await billRow(id);
    expect(row.subtotal_minor).toBe('101');
    expect(row.tax_minor).toBe('7');
    expect(row.total_minor).toBe('108');

    expect(await linesFor(transactionId as string)).toEqual([
      { code: 'purchases', direction: 'debit', amount_minor: '101', base_amount_minor: '152' },
      { code: 'tax-receivable', direction: 'debit', amount_minor: '7', base_amount_minor: '11' },
      {
        code: 'accounts-payable',
        direction: 'credit',
        amount_minor: '108',
        base_amount_minor: '163',
      },
    ]);

    // 表头的本位币金额是借方合计（见 post-journal.ts 的 headerBaseAmount）。
    const head = await transactionRow(transactionId as string);
    expect(head.base_amount_minor).toBe('163');
  });

  /** 账单表单上没有汇率输入框，报错不能叫用户在那里填一个。 */
  it('does not tell the user to type a rate the bill form does not have', async () => {
    currentUserId = ownerId;
    await expect(
      createBill(
        orgSlug,
        billInput({ currency: 'EUR', issueDate: '2032-05-28', dueDate: '2032-06-28' }),
      ),
    ).rejects.toThrow(/Record this entry yourself under Transactions/);
  });
});

describe('updateBill - 编辑后重新过账', () => {
  it('rebuilds the journal of an already posted bill', async () => {
    currentUserId = ownerId;
    const { id, transactionId } = await createBill(orgSlug, billInput());

    await updateBill(
      orgSlug,
      id,
      billInput({ taxRatePercent: '6', items: [{ description: 'Stock', amount: '200.00' }] }),
    );

    const row = await billRow(id);
    // 同一笔交易被改写，而不是新记一笔。
    expect(row.transaction_id).toBe(transactionId);
    expect(row.total_minor).toBe('21200');

    expect(await linesFor(transactionId as string)).toEqual([
      {
        code: 'purchases',
        direction: 'debit',
        amount_minor: '20000',
        base_amount_minor: '20000',
      },
      {
        code: 'tax-receivable',
        direction: 'debit',
        amount_minor: '1200',
        base_amount_minor: '1200',
      },
      {
        code: 'accounts-payable',
        direction: 'credit',
        amount_minor: '21200',
        base_amount_minor: '21200',
      },
    ]);

    expect(await auditActions(id)).toEqual(['bill.created', 'bill.updated']);
  });
});

describe('voidBill - 作废连带作废分录', () => {
  it('voids the bill and its transaction together, with the reason on the transaction', async () => {
    currentUserId = ownerId;
    const { id, transactionId } = await createBill(orgSlug, billInput());

    await voidBill(orgSlug, id, 'Vendor issued a credit note');

    const bill = await billRow(id);
    expect(bill.status).toBe('voided');
    expect(bill.voided_at).not.toBeNull();

    const transaction = await transactionRow(transactionId as string);
    expect(transaction.voided_at).not.toBeNull();
    expect(transaction.voided_by).toBe(ownerId);
    expect(transaction.void_reason).toBe('Vendor issued a credit note');

    // 分录保留不动：账目要可追溯。
    expect(await linesFor(transactionId as string)).toHaveLength(2);

    expect(await auditActions(id)).toEqual(['bill.created', 'bill.voided']);
    expect(await auditActions(transactionId as string)).toContain('transaction.voided');
  });

  it('refuses a blank reason', async () => {
    currentUserId = ownerId;
    const { id } = await createBill(orgSlug, billInput());
    await expect(voidBill(orgSlug, id, '  ')).rejects.toThrow(/reason/i);
    expect((await billRow(id)).status).toBe('received');
  });

  it('refuses to void or edit a bill twice', async () => {
    currentUserId = ownerId;
    const { id } = await createBill(orgSlug, billInput());
    await voidBill(orgSlug, id, 'Duplicate entry');

    await expect(voidBill(orgSlug, id, 'Duplicate entry')).rejects.toThrow(/already voided/i);
    await expect(updateBill(orgSlug, id, billInput())).rejects.toThrow(/voided/i);
  });
});

describe('权限', () => {
  /**
   * 原来这四个动作用的都是 transaction:read——viewer 也有。挡住 viewer 的
   * 只有 bills 表的 RLS `with check`，用户读到的是一句裸的 Postgres 策略报错。
   */
  it('refuses a viewer with a role message, not a raw RLS error', async () => {
    currentUserId = viewerId;
    await expect(createBill(orgSlug, billInput())).rejects.toThrow(
      /role \(viewer\) cannot perform transaction:create/,
    );
  });
});
