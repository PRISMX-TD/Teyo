import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { admin } from '@/tests/helpers/db';
import {
  createTestOrgWithSeed,
  createTestUser,
  joinOrg,
  resetTestData,
  type SeededOrg,
} from '@/tests/helpers/test-db';

let currentUserId: string | null = null;

vi.mock('@/server/auth/session', () => ({
  getCurrentUserId: () => Promise.resolve(currentUserId),
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { createPurchaseOrder, updatePurchaseOrderAction, setPoStatusAction } = await import(
  '@/server/actions/purchase_orders'
);

const suffix = randomUUID().slice(0, 8);

let ownerId: string;
let bookkeeperId: string;
let viewerId: string;
let org: SeededOrg;
let vendorId: string;

const ISSUE_DATE = '2026-04-01';

/** 一行 2 件 × 150.00 = 300.00 的明细。 */
const ONE_LINE = [{ description: 'Widget', quantity: 2, unitPriceMinor: '15000' }];

async function poRow(id: string) {
  const [row] = await admin`
    select po_number, status, currency, exchange_rate, base_total_minor, voided_at
    from purchase_orders where id = ${id}
  `;
  return row;
}

async function poItems(id: string) {
  return admin`
    select description, quantity, unit_price_minor, amount_minor
    from po_items where po_id = ${id} order by id
  `;
}

beforeAll(async () => {
  ownerId = await createTestUser(`test-owner-po-${suffix}@example.com`, 'Owner');
  bookkeeperId = await createTestUser(`test-book-po-${suffix}@example.com`, 'Bookkeeper');
  viewerId = await createTestUser(`test-view-po-${suffix}@example.com`, 'Viewer');
  currentUserId = ownerId;

  org = await createTestOrgWithSeed(ownerId, 'PO Co', `po-co-${suffix}`, 'MYR');
  await joinOrg(bookkeeperId, org.id, 'bookkeeper');
  await joinOrg(viewerId, org.id, 'viewer');

  const [vendor] = await admin`
    insert into contacts (organization_id, type, name)
    values (${org.id}, 'vendor', 'Acme Supplies')
    returning id
  `;
  vendorId = vendor.id as string;
});

afterAll(async () => {
  await resetTestData();
  await admin.end();
});

describe('createPurchaseOrder - 汇率不再被当成定标整数', () => {
  // 原来写的是 `input.exchangeRate ? BigInt(input.exchangeRate) : RATE_SCALE`。
  // purchase_orders.exchange_rate 是放大 10^8 的 bigint，而表单上那个数是
  // 「1 USD = ? MYR」的十进制写法。两者直接划等号有两种后果：
  //   '1.5' -> BigInt('1.5') 抛 SyntaxError，用户看到一句 JS 报错；
  //   '15'  -> 被当成 0.00000015，一张三百块的采购单折成本位币是 0.00 分。
  // 后者不报任何错。
  it("'4.35' 这种十进制汇率不再抛 SyntaxError", async () => {
    currentUserId = ownerId;
    const { id } = await createPurchaseOrder(org.slug, {
      contactId: vendorId,
      issueDate: ISSUE_DATE,
      currency: 'USD',
      exchangeRate: '4.35',
      items: ONE_LINE,
    });

    const row = await poRow(id);
    expect(row.currency.trim()).toBe('USD');
    // 4.35 放大 10^8。
    expect(row.exchange_rate).toBe('435000000');
    // 300.00 USD × 4.35 = 1305.00 MYR。旧写法把 '4.35' 喂给 BigInt 直接抛错；
    // 就算传 '435' 蒙混过去，也会被当成 0.00000435 的汇率。
    expect(row.base_total_minor).toBe('130500');
  });

  it("'15' 不再被当成 0.00000015 的汇率", async () => {
    currentUserId = ownerId;
    const { id } = await createPurchaseOrder(org.slug, {
      contactId: vendorId,
      issueDate: ISSUE_DATE,
      currency: 'USD',
      exchangeRate: '15',
      items: ONE_LINE,
    });

    const row = await poRow(id);
    expect(row.exchange_rate).toBe('1500000000');
    // 300.00 × 15 = 4500.00。旧写法给的是 0（300_00 × 15 / 10^8 向下取整）。
    expect(row.base_total_minor).toBe('450000');
  });

  // base_total_minor 这一列名里的 base 是「本位币」。原来直接写单据币种下的
  // 合计，一张 USD 的采购单在 MYR 的公司里记成「MYR 三百」。今天没有报表读
  // 这一列，所以谁也发现不了。
  it('本位币与单据币种相同时，两者恰好相等', async () => {
    currentUserId = ownerId;
    const { id } = await createPurchaseOrder(org.slug, {
      contactId: vendorId,
      issueDate: ISSUE_DATE,
      items: ONE_LINE,
    });

    const row = await poRow(id);
    // 币种缺省取本位币，不是 0009 里那个写死的 'USD'（0021 已把这些列的
    // default 去掉，并注明「默认值改由应用侧传本位币」）。
    expect(row.currency.trim()).toBe('MYR');
    expect(row.exchange_rate).toBe('100000000');
    expect(row.base_total_minor).toBe('30000');
  });

  // 与 resolveRate 拒绝回退 1:1 是同一条规矩：宁可当场报错，也不写一个
  // 事后看不出来的数。
  it('外币却不给汇率时当场报错，而不是按 1:1 记', async () => {
    currentUserId = ownerId;
    await expect(
      createPurchaseOrder(org.slug, {
        contactId: vendorId,
        issueDate: ISSUE_DATE,
        currency: 'USD',
        items: ONE_LINE,
      }),
    ).rejects.toThrow(/USD to MYR rate/i);
  });

  it('非法汇率被 parseRateToScaled 拒绝', async () => {
    currentUserId = ownerId;
    await expect(
      createPurchaseOrder(org.slug, {
        contactId: vendorId,
        issueDate: ISSUE_DATE,
        currency: 'USD',
        exchangeRate: 'abc',
        items: ONE_LINE,
      }),
    ).rejects.toThrow(/Invalid exchange rate/i);
  });
});

describe('createPurchaseOrder - 编号与数量', () => {
  // getNextPoNumber 的正则写在 JS 模板字符串里：`'^PO-\d+$'`。模板字符串里
  // 的 \d 不是正则的 \d，而是一个未被识别的转义，JS 求值成字母 d——发给
  // Postgres 的是 '^PO-d+$'，永远匹配不到 'PO-00001'。查询恒返回零行，
  // 于是这个函数**永远返回 PO-00001**，第二张单必定撞 po_org_number 唯一约束。
  it('第二张单拿到 PO-00002 而不是撞唯一约束', async () => {
    const fresh = await createTestOrgWithSeed(
      ownerId,
      'Numbering Co',
      `po-num-${suffix}`,
      'MYR',
    );
    const [vendor] = await admin`
      insert into contacts (organization_id, type, name)
      values (${fresh.id}, 'vendor', 'Numbering vendor')
      returning id
    `;

    currentUserId = ownerId;
    const first = await createPurchaseOrder(fresh.slug, {
      contactId: vendor.id as string,
      issueDate: ISSUE_DATE,
      items: ONE_LINE,
    });
    const second = await createPurchaseOrder(fresh.slug, {
      contactId: vendor.id as string,
      issueDate: ISSUE_DATE,
      items: ONE_LINE,
    });

    expect(first.poNumber).toBe('PO-00001');
    expect(second.poNumber).toBe('PO-00002');
  });

  // 编号涨到六位时 'PO-100000' 在字典序里排在 'PO-99999' 前面。按整数取 max
  // 才不会从此每次都撞唯一约束。
  it('编号跨过五位数之后仍然按数值递增', async () => {
    const fresh = await createTestOrgWithSeed(
      ownerId,
      'Six Digit Co',
      `po-six-${suffix}`,
      'MYR',
    );
    const [vendor] = await admin`
      insert into contacts (organization_id, type, name)
      values (${fresh.id}, 'vendor', 'Six digit vendor')
      returning id
    `;
    await admin`
      insert into purchase_orders
        (organization_id, contact_id, po_number, issue_date, currency,
         exchange_rate, base_total_minor, created_by)
      values
        (${fresh.id}, ${vendor.id}, 'PO-99999', ${ISSUE_DATE}, 'MYR', 100000000, 0, ${ownerId}),
        (${fresh.id}, ${vendor.id}, 'PO-100000', ${ISSUE_DATE}, 'MYR', 100000000, 0, ${ownerId})
    `;

    currentUserId = ownerId;
    const next = await createPurchaseOrder(fresh.slug, {
      contactId: vendor.id as string,
      issueDate: ISSUE_DATE,
      items: ONE_LINE,
    });
    expect(next.poNumber).toBe('PO-100001');
  });

  // 原来是 `BigInt(unitPriceMinor) * BigInt(Math.round(quantity))`：
  // 采购 2.5 吨按 3 吨计价，单据金额与明细行各自自洽。
  it('小数数量不再被四舍五入成整数', async () => {
    currentUserId = ownerId;
    const { id } = await createPurchaseOrder(org.slug, {
      contactId: vendorId,
      issueDate: ISSUE_DATE,
      items: [{ description: 'Sand', quantity: '2.5', unitPriceMinor: '10000' }],
    });

    const items = await poItems(id);
    expect(Number(items[0].quantity)).toBe(2.5);
    // 2.5 × 100.00 = 250.00。旧写法给 300.00。
    expect(items[0].amount_minor).toBe('25000');
    expect((await poRow(id)).base_total_minor).toBe('25000');
  });

  it('一张没有明细的采购单被拒', async () => {
    currentUserId = ownerId;
    await expect(
      createPurchaseOrder(org.slug, {
        contactId: vendorId,
        issueDate: ISSUE_DATE,
        items: [],
      }),
    ).rejects.toThrow(/at least one line/i);
  });
});

describe('updatePurchaseOrderAction - 不再把两个 not null 列写成 NULL', () => {
  // exchange_rate 与 base_total_minor 都是 not null（0009），而原来那句
  // UPDATE 对它们写的是 `= ${x ?? null}::bigint`，没有 coalesce。于是任何
  // 一次「只改备注」的保存都会撞 not-null 违反。这个 action 今天没有界面
  // 入口，所以这条路径从来没被走过。
  it('只改备注时汇率与本位币合计原样保留', async () => {
    currentUserId = ownerId;
    const { id } = await createPurchaseOrder(org.slug, {
      contactId: vendorId,
      issueDate: ISSUE_DATE,
      currency: 'USD',
      exchangeRate: '4.35',
      items: ONE_LINE,
    });

    await updatePurchaseOrderAction(org.slug, id, { notes: 'Rush order' });

    const row = await poRow(id);
    expect(row.exchange_rate).toBe('435000000');
    expect(row.base_total_minor).toBe('130500');
  });

  it('只改汇率时本位币合计跟着重算', async () => {
    currentUserId = ownerId;
    const { id } = await createPurchaseOrder(org.slug, {
      contactId: vendorId,
      issueDate: ISSUE_DATE,
      currency: 'USD',
      exchangeRate: '4.00',
      items: ONE_LINE,
    });

    await updatePurchaseOrderAction(org.slug, id, { exchangeRate: '5.00' });

    const row = await poRow(id);
    expect(row.exchange_rate).toBe('500000000');
    // 300.00 × 5 = 1500.00。不重算的话这里会停在 1200.00，而汇率列上写的是 5。
    expect(row.base_total_minor).toBe('150000');
  });
});

describe('setPoStatusAction - 作废要同时写 voided_at', () => {
  // 原来只改 status。于是「这张单作废了没有」在库里有两个互不相干的记号，
  // 而 listPurchaseOrders 与报表读的都是那个从来没人写的 voided_at。
  it('置为 voided 时写上 voided_at，撤销时清掉', async () => {
    currentUserId = ownerId;
    const { id } = await createPurchaseOrder(org.slug, {
      contactId: vendorId,
      issueDate: ISSUE_DATE,
      items: ONE_LINE,
    });

    expect((await poRow(id)).voided_at).toBeNull();

    await setPoStatusAction(org.slug, id, 'voided');
    const voided = await poRow(id);
    expect(voided.status).toBe('voided');
    expect(voided.voided_at).not.toBeNull();

    await setPoStatusAction(org.slug, id, 'draft');
    const restored = await poRow(id);
    expect(restored.status).toBe('draft');
    expect(restored.voided_at).toBeNull();
  });
});

describe('采购单的权限与发票/收款对齐', () => {
  // 原来三个同类模块用三种权限：采购单 account:manage（owner/admin）、
  // 发票 transaction:read（连 viewer 都有）、收款 transaction:create。
  // 采购单这一头是反过来的：记账员的日常工作就是录采购单，却被挡在外面。
  // 记账员不再被应用层的权限判断挡住。数据库侧还挡着：0010 那条 `for all`
  // 策略把这批表的写入限死在 owner/admin，要等 0022（另一位代理正在写，
  // 见 server/domain/permissions.ts 的 TABLE_ACCESS，purchase_orders 的
  // insert 是 document:create，含记账员）才会放开。
  //
  // 这个用例因此接受两种结局，但只接受这两种：要么写进去了，要么被 RLS
  // 挡下。**不接受**的是「你的角色不能执行 ...」——那说明应用层还在自己
  // 挡，而这正是本次改动要去掉的那一层。0022 执行之后它会稳定走第一支。
  it('记账员不再被应用层挡住（数据库侧待 0022 放开）', async () => {
    currentUserId = bookkeeperId;

    await createPurchaseOrder(org.slug, {
      contactId: vendorId,
      issueDate: ISSUE_DATE,
      items: ONE_LINE,
    }).then(
      async (created) => {
        expect((await poRow(created.id)).base_total_minor).toBe('30000');
      },
      (error: unknown) => {
        const message = (error as Error).message;
        expect(message).toMatch(/row-level security/i);
        expect(message).not.toMatch(/cannot perform/i);
      },
    );
  });

  it('只读用户建不了', async () => {
    currentUserId = viewerId;
    await expect(
      createPurchaseOrder(org.slug, {
        contactId: vendorId,
        issueDate: ISSUE_DATE,
        items: ONE_LINE,
      }),
    ).rejects.toThrow(/cannot perform transaction:create/i);
  });

  it('状态变更要 transaction:edit:any，记账员没有', async () => {
    currentUserId = ownerId;
    const { id } = await createPurchaseOrder(org.slug, {
      contactId: vendorId,
      issueDate: ISSUE_DATE,
      items: ONE_LINE,
    });

    currentUserId = bookkeeperId;
    await expect(setPoStatusAction(org.slug, id, 'sent')).rejects.toThrow(
      /cannot perform transaction:edit:any/i,
    );

    currentUserId = ownerId;
    await setPoStatusAction(org.slug, id, 'sent');
    expect((await poRow(id)).status).toBe('sent');
  });
});

describe('采购单留下审计', () => {
  it('创建时记下汇率与两个口径的合计', async () => {
    currentUserId = ownerId;
    const { id, poNumber } = await createPurchaseOrder(org.slug, {
      contactId: vendorId,
      issueDate: ISSUE_DATE,
      currency: 'USD',
      exchangeRate: '4.35',
      items: ONE_LINE,
    });

    const [row] = await admin`
      select after from audit_logs
      where organization_id = ${org.id}
        and entity_id = ${id} and action = 'purchase_order.created'
    `;
    expect(row.after).toMatchObject({
      poNumber,
      currency: 'USD',
      exchangeRate: '4.35',
      documentTotalMinor: '30000',
      baseTotalMinor: '130500',
      itemCount: 1,
    });
  });
});
