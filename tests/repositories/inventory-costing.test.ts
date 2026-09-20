import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { admin } from '@/tests/helpers/db';
import { withTransaction } from '@/server/db/transaction';
import {
  extendQuantity,
  formatScaledQuantity,
  parseQuantityToScaled,
  recordInventoryTransaction,
  getInventoryValuation,
} from '@/server/repositories/inventory';
import {
  createTestOrgWithSeed,
  createTestUser,
  resetTestData,
  type SeededOrg,
} from '@/tests/helpers/test-db';

let currentUserId: string | null = null;

vi.mock('@/server/auth/session', () => ({
  getCurrentUserId: () => Promise.resolve(currentUserId),
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { createInventoryItem, recordInventoryTxnAction } = await import(
  '@/server/actions/inventory'
);

const suffix = randomUUID().slice(0, 8);

let ownerId: string;
let org: SeededOrg;

/** 库存流水不带日期列，分录的日期由 action 传入；固定一天，避开期间锁与时区。 */
const ON = '2026-05-10';

async function newItem(
  sku: string,
  opts: {
    costMethod?: 'fifo' | 'average';
    inventoryAccountId?: string | null;
    cogsAccountId?: string | null;
  } = {},
): Promise<string> {
  currentUserId = ownerId;
  const { id } = await createInventoryItem(org.slug, {
    sku,
    nameEn: sku,
    nameZh: sku,
    unit: 'kg',
    costMethod: opts.costMethod ?? 'average',
    reorderLevel: 0,
    inventoryAccountId:
      opts.inventoryAccountId === null
        ? undefined
        : (opts.inventoryAccountId ?? org.accountsByCode.inventory),
    cogsAccountId:
      opts.cogsAccountId === null ? undefined : (opts.cogsAccountId ?? org.accountsByCode['other-expenses']),
  });
  return id;
}

async function itemRow(id: string) {
  const [row] = await admin`
    select current_quantity, current_avg_cost_minor
    from inventory_items where id = ${id}
  `;
  return row;
}

async function txnRows(itemId: string) {
  return admin`
    select type, quantity, unit_cost_minor, total_cost_minor
    from inventory_transactions
    where inventory_item_id = ${itemId}
    order by created_at, id
  `;
}

async function linesFor(transactionId: string) {
  return admin`
    select a.code, l.direction, l.amount_minor
    from journal_lines l join accounts a on a.id = l.account_id
    where l.transaction_id = ${transactionId}
    order by l.direction
  `;
}

/** 存货科目在总账上的余额（借正贷负，本位币）。 */
async function inventoryAccountBalance(): Promise<bigint> {
  const [row] = await admin`
    select coalesce(sum(
      case when l.direction = 'debit' then l.base_amount_minor else -l.base_amount_minor end
    ), 0) as balance
    from journal_lines l
    join accounts a on a.id = l.account_id
    where l.organization_id = ${org.id} and a.code = 'inventory'
  `;
  return BigInt(row.balance as string);
}

/** 直接走仓储（不经 action），用来量纯成本计算，不牵扯记账。 */
function record(input: Parameters<typeof recordInventoryTransaction>[2]) {
  return withTransaction(ownerId, (tx) => recordInventoryTransaction(tx, org.id, input));
}

beforeAll(async () => {
  ownerId = await createTestUser(`test-owner-inv-${suffix}@example.com`, 'Owner');
  currentUserId = ownerId;
  org = await createTestOrgWithSeed(ownerId, 'Inventory Co', `inv-co-${suffix}`, 'MYR');
});

afterAll(async () => {
  await resetTestData();
  await admin.end();
});

describe('数量的定标整数：为什么不能复用 money.ts', () => {
  // 数量的 scale 由列定义决定（numeric(12,4)），货币的 exponent 由币种决定。
  // 两个概念同名不同义：本位币是 JPY 的公司 currencyExponent 返回 0，用它去
  // 解析数量会把 0.5 kg 判成「小数位过多」或直接抹成 0。
  it('四位小数精确往返', () => {
    expect(parseQuantityToScaled('0.5')).toBe(5000n);
    expect(parseQuantityToScaled('2.5')).toBe(25000n);
    expect(parseQuantityToScaled('1')).toBe(10000n);
    expect(parseQuantityToScaled('0.0001')).toBe(1n);
    expect(formatScaledQuantity(5000n)).toBe('0.5000');
    expect(formatScaledQuantity(1n)).toBe('0.0001');
    expect(formatScaledQuantity(0n)).toBe('0.0000');
  });

  // number 这一支是给 components/settings/inventory-list.tsx 今天传的
  // parseFloat 留的过渡口。它走 toString() 拿最短往返表示，再走与字符串
  // 完全相同的解析，所以不会出现 Math.round(0.1 * 10000) 那种「碰巧对」。
  it('number 入参不经浮点乘法', () => {
    expect(parseQuantityToScaled(0.5)).toBe(5000n);
    expect(parseQuantityToScaled(0.1)).toBe(1000n);
    expect(parseQuantityToScaled(0.3)).toBe(3000n);
    expect(parseQuantityToScaled(29.7)).toBe(297000n);
  });

  it('多余的小数位抛错而不是静默截断', () => {
    expect(() => parseQuantityToScaled('1.23456')).toThrow(/decimal place/i);
    expect(() => parseQuantityToScaled('abc')).toThrow(/valid quantity/i);
    expect(() => parseQuantityToScaled(Number.NaN)).toThrow(/valid quantity/i);
    // 1e-7 的 toString 是 '1e-7'，解析不了——这是想要的：七位小数
    // numeric(12,4) 本来就存不下，不该被悄悄抹成 0。
    expect(() => parseQuantityToScaled(1e-7)).toThrow();
  });

  // 原来是 BigInt(Math.round(quantity * Number(unitCostMinor)))。
  // Number(bigint) 在 2^53 以上静默丢精度，这一条量的就是那个边界。
  it('金额超过 2^53 也不失真', () => {
    const huge = 9007199254740993n; // 2^53 + 1，double 表示不出来
    expect(extendQuantity(huge, 10000n)).toBe(huge);
    // 旧写法：Number(9007199254740993n) === 9007199254740992
    expect(BigInt(Math.round(1 * Number(huge)))).not.toBe(huge);
  });

  it('数量 × 单价按同一套舍入（.5 进位）', () => {
    // 3 × 0.3333 = 0.9999 -> 1（half-up）。与 convertToBaseMinor 同一个表达式。
    expect(extendQuantity(3n, 3333n)).toBe(1n);
    // 100.00 × 0.5 = 50.00
    expect(extendQuantity(10000n, 5000n)).toBe(5000n);
  });
});

describe('加权平均成本：小数数量不再被四舍五入', () => {
  // 旧写法：
  //   const totalValue = currentAvgCost * BigInt(Math.round(currentQty));
  //   const txnValue   = input.unitCostMinor * BigInt(Math.round(input.quantity));
  //   newAvgCost = (totalValue + txnValue) / BigInt(Math.round(newQty));
  // 0.5 被 round 成 1，于是两笔各 0.5 kg 的入库算出来的平均成本是
  // (1000×0 + 2000×1)/1 这种与实际毫无关系的数。
  it('两笔 0.5 kg 的入库给出真正的加权平均', async () => {
    const itemId = await newItem(`half-${suffix}`);

    await record({
      inventoryItemId: itemId,
      type: 'purchase',
      quantityScaled: parseQuantityToScaled('0.5'),
      unitCostMinor: 1000n, // 10.00 / kg
      createdBy: ownerId,
    });

    let row = await itemRow(itemId);
    expect(Number(row.current_quantity)).toBe(0.5);
    expect(row.current_avg_cost_minor).toBe('1000');

    await record({
      inventoryItemId: itemId,
      type: 'purchase',
      quantityScaled: parseQuantityToScaled('0.5'),
      unitCostMinor: 2000n, // 20.00 / kg
      createdBy: ownerId,
    });

    row = await itemRow(itemId);
    // 0.5 + 0.5 = 1.0，平均 (10 + 20) / 2 = 15.00
    expect(Number(row.current_quantity)).toBe(1);
    expect(row.current_avg_cost_minor).toBe('1500');
    // 旧写法在这里给的是 3000（两次 round 之后 (0 + 2000)/1... 或 (1000+2000)/1），
    // 无论哪一种都不是 1500。
    expect(row.current_avg_cost_minor).not.toBe('3000');
  });

  it('流水行上的合计按定标整数算，不经 double', async () => {
    const itemId = await newItem(`ext-${suffix}`);

    await record({
      inventoryItemId: itemId,
      type: 'purchase',
      quantityScaled: parseQuantityToScaled('2.5'),
      unitCostMinor: 333n, // 3.33 / kg
      createdBy: ownerId,
    });

    const [row] = await txnRows(itemId);
    expect(Number(row.quantity)).toBe(2.5);
    // 2.5 × 333 = 832.5 -> 833（half-up）。旧写法 Math.round(2.5 * 333) = 833
    // 也对，但它只是这一次碰巧；量的是这条路径不再经过 double。
    expect(row.total_cost_minor).toBe('833');
  });

  // 0009 没有建任何 FIFO 分层表。旧写法让 fifo 物料在第一次入库之后平均成本
  // 再也不变——进价一涨，估值越错越多。在分层做出来之前用加权平均。
  it('cost_method = fifo 也走加权平均（FIFO 分层未实现）', async () => {
    const itemId = await newItem(`fifo-${suffix}`, { costMethod: 'fifo' });

    await record({
      inventoryItemId: itemId,
      type: 'purchase',
      quantityScaled: parseQuantityToScaled('1'),
      unitCostMinor: 1000n,
      createdBy: ownerId,
    });
    await record({
      inventoryItemId: itemId,
      type: 'purchase',
      quantityScaled: parseQuantityToScaled('1'),
      unitCostMinor: 3000n,
      createdBy: ownerId,
    });

    const row = await itemRow(itemId);
    // 旧写法停在 1000（第一批的价），新写法给 2000。
    expect(row.current_avg_cost_minor).toBe('2000');
  });

  // 界面上「销售」那一栏也让用户填单价，而卖出去的东西值多少钱由进价决定。
  // 用售价冲减存货，最后一件卖完时存货科目会剩下一个等于历年毛利的差额。
  it('出库按加权平均结转，忽略调用方传来的单价', async () => {
    const itemId = await newItem(`sale-${suffix}`);

    await record({
      inventoryItemId: itemId,
      type: 'purchase',
      quantityScaled: parseQuantityToScaled('10'),
      unitCostMinor: 500n, // 5.00 成本
      createdBy: ownerId,
    });

    const sale = await record({
      inventoryItemId: itemId,
      type: 'sale',
      quantityScaled: parseQuantityToScaled('4'),
      unitCostMinor: 9999n, // 用户填的是售价 99.99
      createdBy: ownerId,
    });

    // 结转出去的是 4 × 5.00 = 20.00，不是 4 × 99.99。
    expect(sale.valueDeltaMinor).toBe(-2000n);

    const rows = await txnRows(itemId);
    expect(rows[1].unit_cost_minor).toBe('500');
    expect(rows[1].total_cost_minor).toBe('2000');

    const row = await itemRow(itemId);
    expect(Number(row.current_quantity)).toBe(6);
    expect(row.current_avg_cost_minor).toBe('500');
  });

  it('估值按定标整数算，不再把 0.5 kg 当成 1 kg', async () => {
    const itemId = await newItem(`val-${suffix}`);
    await record({
      inventoryItemId: itemId,
      type: 'purchase',
      quantityScaled: parseQuantityToScaled('0.5'),
      unitCostMinor: 1000n,
      createdBy: ownerId,
    });

    const rows = await withTransaction(ownerId, (tx) => getInventoryValuation(tx, org.id));
    const valued = rows.find((r) => r.itemId === itemId);
    expect(valued?.quantity).toBe('0.5000');
    expect(valued?.quantityScaled).toBe(5000n);
    // 0.5 × 10.00 = 5.00。旧写法 avgCost * BigInt(Math.round(0.5)) 给 1000（10.00）。
    expect(valued?.totalValueMinor).toBe(500n);
  });

  it('负数量被当场拒绝', async () => {
    const itemId = await newItem(`neg-${suffix}`);
    await expect(
      record({
        inventoryItemId: itemId,
        type: 'purchase',
        quantityScaled: -10000n,
        unitCostMinor: 100n,
        createdBy: ownerId,
      }),
    ).rejects.toThrow(/negative/i);
  });
});

describe('库存进总账（P1-1）', () => {
  // 在这之前，inventory_transactions 与加权平均成本是一套自成体系的数字，
  // 一行分录都不产生：库存页面上摆着货值，资产负债表上的「存货」科目恒为 0。
  it('入库：借存货 / 贷进货', async () => {
    const itemId = await newItem(`post-in-${suffix}`);

    currentUserId = ownerId;
    const result = await recordInventoryTxnAction(org.slug, {
      inventoryItemId: itemId,
      type: 'purchase',
      quantity: '4',
      unitCostMinor: '250', // 2.50 / kg -> 合计 10.00
      occurredOn: ON,
    });

    expect(result.transactionId).not.toBeNull();
    expect(await linesFor(result.transactionId as string)).toEqual([
      { code: 'inventory', direction: 'debit', amount_minor: '1000' },
      { code: 'purchases', direction: 'credit', amount_minor: '1000' },
    ]);

    const [head] = await admin`
      select kind, occurred_on, currency, amount_minor, category_id
      from transactions where id = ${result.transactionId}
    `;
    expect(head.kind).toBe('journal');
    expect(head.currency).toBe('MYR');
    expect(head.amount_minor).toBe('1000');
    // 手工凭证不挂分类，与 transactions_category_matches_kind 一致（0014）。
    expect(head.category_id).toBeNull();
  });

  it('出库：借销货成本 / 贷存货，金额是加权平均成本不是售价', async () => {
    const itemId = await newItem(`post-out-${suffix}`);

    currentUserId = ownerId;
    await recordInventoryTxnAction(org.slug, {
      inventoryItemId: itemId,
      type: 'purchase',
      quantity: '10',
      unitCostMinor: '500',
      occurredOn: ON,
    });

    const sale = await recordInventoryTxnAction(org.slug, {
      inventoryItemId: itemId,
      type: 'sale',
      quantity: '4',
      unitCostMinor: '9999',
      occurredOn: ON,
    });

    expect(await linesFor(sale.transactionId as string)).toEqual([
      // cogs_account_id 配的是 other-expenses，用它才分得清是不是退回了
      // purchases 那个临时科目。
      { code: 'other-expenses', direction: 'debit', amount_minor: '2000' },
      { code: 'inventory', direction: 'credit', amount_minor: '2000' },
    ]);
  });

  it('盘点调减：借销货成本 / 贷存货；调平则一行分录都不写', async () => {
    const itemId = await newItem(`post-adj-${suffix}`);

    currentUserId = ownerId;
    await recordInventoryTxnAction(org.slug, {
      inventoryItemId: itemId,
      type: 'purchase',
      quantity: '10',
      unitCostMinor: '100', // 存货价值 10.00
      occurredOn: ON,
    });

    // 盘点结果只有 8 kg，单价不变。价值 10.00 -> 8.00。
    const down = await recordInventoryTxnAction(org.slug, {
      inventoryItemId: itemId,
      type: 'adjustment',
      quantity: '8',
      unitCostMinor: '100',
      occurredOn: ON,
    });
    expect(await linesFor(down.transactionId as string)).toEqual([
      { code: 'other-expenses', direction: 'debit', amount_minor: '200' },
      { code: 'inventory', direction: 'credit', amount_minor: '200' },
    ]);

    // 再盘一次，结果一样——价值没变，不该凭空写一笔金额为零的分录
    // （journal_lines.amount_minor 有 > 0 的 CHECK，写了也会被库拒掉）。
    const flat = await recordInventoryTxnAction(org.slug, {
      inventoryItemId: itemId,
      type: 'adjustment',
      quantity: '8',
      unitCostMinor: '100',
      occurredOn: ON,
    });
    expect(flat.transactionId).toBeNull();
  });

  // 存货科目余额必须恒等于 Σ(在库数量 × 平均成本)。按「价值变化量」记账
  // 而不是按流水合计记账，就是为了让这条不变量在每一次加权平均舍入之后
  // 仍然成立——用流水合计的话，残差会留在科目余额里越积越大。
  it('一串买卖之后，存货科目余额恰好等于估值表合计', async () => {
    const solo = await createTestOrgWithSeed(
      ownerId,
      'Tie Out Co',
      `inv-tie-${suffix}`,
      'MYR',
    );

    currentUserId = ownerId;
    const { id: itemId } = await createInventoryItem(solo.slug, {
      sku: `tie-${suffix}`,
      nameEn: 'Tie out widget',
      nameZh: 'Tie out widget',
      unit: 'kg',
      costMethod: 'average',
      reorderLevel: 0,
      inventoryAccountId: solo.accountsByCode.inventory,
      cogsAccountId: solo.accountsByCode['other-expenses'],
    });

    // 故意选一串除不尽的数，让每一步都产生舍入残差。
    const steps: { type: 'purchase' | 'sale'; quantity: string; unitCostMinor: string }[] = [
      { type: 'purchase', quantity: '3', unitCostMinor: '1000' },
      { type: 'purchase', quantity: '7.3333', unitCostMinor: '337' },
      { type: 'sale', quantity: '2.7', unitCostMinor: '0' },
      { type: 'purchase', quantity: '0.0007', unitCostMinor: '99999' },
      { type: 'sale', quantity: '1.1111', unitCostMinor: '0' },
    ];
    for (const step of steps) {
      await recordInventoryTxnAction(solo.slug, {
        inventoryItemId: itemId,
        type: step.type,
        quantity: step.quantity,
        unitCostMinor: step.unitCostMinor,
        occurredOn: ON,
      });
    }

    const [balanceRow] = await admin`
      select coalesce(sum(
        case when l.direction = 'debit' then l.base_amount_minor else -l.base_amount_minor end
      ), 0) as balance
      from journal_lines l
      join accounts a on a.id = l.account_id
      where l.organization_id = ${solo.id} and a.code = 'inventory'
    `;

    const valuation = await withTransaction(ownerId, (tx) => getInventoryValuation(tx, solo.id));
    const total = valuation.reduce((sum, row) => sum + row.totalValueMinor, 0n);

    expect(BigInt(balanceRow.balance as string)).toBe(total);
    expect(total).toBeGreaterThan(0n);
  });

  // 没配存货科目时当场报错，而不是「记了数量、没记账」——后者会让存货科目
  // 继续停在 0，而用户看到的是保存成功。
  it('物料没配存货科目时拒绝记账，且一行都不写', async () => {
    const itemId = await newItem(`no-acct-${suffix}`, { inventoryAccountId: null });

    currentUserId = ownerId;
    await expect(
      recordInventoryTxnAction(org.slug, {
        inventoryItemId: itemId,
        type: 'purchase',
        quantity: '1',
        unitCostMinor: '100',
        occurredOn: ON,
      }),
    ).rejects.toThrow(/no inventory account configured/i);

    // 整个动作在一个 withTransaction 里，抛错即回滚：流水也不该留下。
    expect(await txnRows(itemId)).toHaveLength(0);
    const row = await itemRow(itemId);
    expect(Number(row.current_quantity)).toBe(0);
  });

  it('封账期内的日期被拒，且库存流水一并回滚', async () => {
    const locked = await createTestOrgWithSeed(
      ownerId,
      'Locked Inv Co',
      `inv-locked-${suffix}`,
      'MYR',
    );

    currentUserId = ownerId;
    const { id: itemId } = await createInventoryItem(locked.slug, {
      sku: `locked-${suffix}`,
      nameEn: 'Locked widget',
      nameZh: 'Locked widget',
      unit: 'kg',
      costMethod: 'average',
      reorderLevel: 0,
      inventoryAccountId: locked.accountsByCode.inventory,
      cogsAccountId: locked.accountsByCode['other-expenses'],
    });

    await admin`update organizations set locked_until = '2026-06-30' where id = ${locked.id}`;

    await expect(
      recordInventoryTxnAction(locked.slug, {
        inventoryItemId: itemId,
        type: 'purchase',
        quantity: '1',
        unitCostMinor: '100',
        occurredOn: ON,
      }),
    ).rejects.toThrow(/locked/i);

    // 库存流水在 postJournal 之前就写了，所以这里量的是整笔回滚，
    // 不是「没走到写入那一步」。
    const rows = await admin`
      select id from inventory_transactions where inventory_item_id = ${itemId}
    `;
    expect(rows).toHaveLength(0);
  });
});

describe('库存流水留下审计', () => {
  it('记下落库的数量、价值变化量与它产生的那笔交易', async () => {
    const itemId = await newItem(`audit-${suffix}`);

    currentUserId = ownerId;
    const result = await recordInventoryTxnAction(org.slug, {
      inventoryItemId: itemId,
      type: 'purchase',
      quantity: '2.5',
      unitCostMinor: '400',
      occurredOn: ON,
    });

    const [row] = await admin`
      select after from audit_logs
      where organization_id = ${org.id}
        and entity_id = ${result.id}
        and action = 'inventory_transaction.recorded'
    `;

    expect(row.after).toMatchObject({
      type: 'purchase',
      // 留下的是落库的那个数（四位小数），不是调用方传来的 double。
      quantity: '2.5000',
      unitCostMinor: '400',
      occurredOn: ON,
      newQuantity: '2.5000',
      newAvgCostMinor: '400',
      valueDeltaMinor: '1000',
      transactionId: result.transactionId,
    });
    // 整个库存账本里存货科目余额始终为正——顺带确认上面这笔真的进了总账。
    expect(await inventoryAccountBalance()).toBeGreaterThan(0n);
  });
});
