import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { admin } from '@/tests/helpers/db';
import type { OrgContext } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { postJournal } from '@/server/posting/post-journal';
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

const {
  createFixedAsset,
  postDepreciationAction,
  disposeFixedAssetAction,
  undoFixedAssetDisposalAction,
} = await import('@/server/actions/fixed-assets');

const suffix = randomUUID().slice(0, 8);

let ownerId: string;
const orgIds: string[] = [];

// 直线法、4 个月、1200.00 无残值 —— 每期正好 300.00。
const PURCHASE_DATE = '2026-01-01';

async function newOrg(label: string): Promise<SeededOrg> {
  const org = await createTestOrgWithSeed(ownerId, `Disposal ${label} Co`, `disp-${label}-${suffix}`, 'MYR');
  orgIds.push(org.id);
  return org;
}

/**
 * 建一条资产，并像真实账本那样先把购入记进去（借固定资产 / 贷银行）：
 * 只有这样，「处置之后资产科目净额归零」才是对整本账成立的断言，而不是
 * 只对处置分录自己成立。
 */
async function newAsset(org: SeededOrg, name: string): Promise<string> {
  currentUserId = ownerId;
  const { id } = await createFixedAsset(org.slug, {
    name,
    description: null,
    purchaseDate: PURCHASE_DATE,
    cost: '1200.00',
    salvageValue: '0',
    usefulLifeMonths: 4,
    method: 'straight_line',
    decliningRateBps: null,
    assetAccountId: org.accountsByCode.equipment,
    depnExpenseAccountId: org.accountsByCode.depreciation,
    depnAccumAccountId: org.accountsByCode['ad-equipment'],
  });

  const ctx: OrgContext = {
    userId: ownerId,
    organizationId: org.id,
    orgSlug: org.slug,
    role: 'owner',
    baseCurrency: 'MYR',
    lockedUntil: null,
    timezone: 'Asia/Kuala_Lumpur',
  };
  await withTransaction(ownerId, (tx) =>
    postJournal(tx, ctx, {
      event: {
        type: 'journal',
        debitAccountId: org.accountsByCode.equipment,
        creditAccountId: org.accountsByCode.bank,
        amountMinor: 120000n,
      },
      occurredOn: PURCHASE_DATE,
      description: `Purchase: ${name}`,
      currency: 'MYR',
      manualRateEntry: 'unavailable',
      categoryId: null,
      clientUuid: randomUUID(),
    }),
  );
  return id;
}

beforeAll(async () => {
  ownerId = await createTestUser(`test-owner-disp-${suffix}@example.com`, 'Owner');
  currentUserId = ownerId;
});

afterAll(async () => {
  // 同 fixed-assets-depreciation.test.ts：排程对交易的引用没有级联，先摘掉。
  if (orgIds.length > 0) {
    await admin`
      update depreciation_schedules set transaction_id = null
      where fixed_asset_id in (
        select id from fixed_assets where organization_id = any(${orgIds})
      )
    `;
  }
  await resetTestData();
  await admin.end();
});

async function linesFor(transactionId: string) {
  return admin`
    select a.code, l.direction, l.amount_minor, l.base_amount_minor
    from journal_lines l join accounts a on a.id = l.account_id
    where l.transaction_id = ${transactionId}
    order by l.direction desc, a.code
  `;
}

/** 某科目在整本账上（不含作废交易）的借方减贷方。 */
async function balanceOf(orgId: string, code: string): Promise<bigint> {
  const [row] = await admin`
    select coalesce(sum(case when l.direction = 'debit' then l.base_amount_minor
                             else -l.base_amount_minor end), 0) as net
    from journal_lines l
    join transactions t on t.id = l.transaction_id
    join accounts a on a.id = l.account_id
    where t.organization_id = ${orgId} and t.voided_at is null and a.code = ${code}
  `;
  return BigInt(row.net as string);
}

async function assertBalanced(transactionId: string) {
  const [row] = await admin`
    select
      sum(base_amount_minor) filter (where direction = 'debit') as dr,
      sum(base_amount_minor) filter (where direction = 'credit') as cr
    from journal_lines where transaction_id = ${transactionId}
  `;
  expect(row.dr).toBe(row.cr);
}

async function assetRow(id: string) {
  const [row] = await admin`
    select is_active, disposed_at, disposal_transaction_id, disposal_proceeds_minor
    from fixed_assets where id = ${id}
  `;
  return row;
}

describe('disposeFixedAssetAction - the entry it writes', () => {
  it('scraps a partly depreciated asset: the whole book value is a loss', async () => {
    const org = await newOrg('scrap');
    const assetId = await newAsset(org, 'Old printer');
    currentUserId = ownerId;
    await postDepreciationAction(org.slug, assetId, '2026-01-01');
    await postDepreciationAction(org.slug, assetId, '2026-02-01');

    const { transactionId } = await disposeFixedAssetAction(org.slug, assetId, {
      disposalDate: '2026-02-20',
      proceeds: '0',
    });

    // 累计 600、账面净值 600、收入 0 → 损失 600。没有资金行、没有收益行。
    expect(await linesFor(transactionId)).toEqual([
      { code: 'ad-equipment', direction: 'debit', amount_minor: '60000', base_amount_minor: '60000' },
      { code: 'other-expenses', direction: 'debit', amount_minor: '60000', base_amount_minor: '60000' },
      { code: 'equipment', direction: 'credit', amount_minor: '120000', base_amount_minor: '120000' },
    ]);
    await assertBalanced(transactionId);

    const [head] = await admin`
      select kind, occurred_on, currency, amount_minor, base_amount_minor, category_id
      from transactions where id = ${transactionId}
    `;
    expect(head.kind).toBe('journal');
    expect(head.currency).toBe('MYR');
    expect(head.amount_minor).toBe('120000');
    expect(head.base_amount_minor).toBe('120000');
    expect(head.category_id).toBeNull();

    const row = await assetRow(assetId);
    expect(row.is_active).toBe(false);
    expect(row.disposed_at).not.toBeNull();
    expect(row.disposal_transaction_id).toBe(transactionId);
    expect(row.disposal_proceeds_minor).toBe('0');

    // 处置之后这台资产在资产科目与累计折旧科目上都不再留任何余额。
    expect(await balanceOf(org.id, 'equipment')).toBe(0n);
    expect(await balanceOf(org.id, 'ad-equipment')).toBe(0n);
    // 余下两期不再能过账。
    await expect(postDepreciationAction(org.slug, assetId, '2026-03-01')).rejects.toThrow(/disposed/i);
  });

  it('sells above book value: the excess is a gain', async () => {
    const org = await newOrg('gain');
    const assetId = await newAsset(org, 'Forklift');
    currentUserId = ownerId;
    await postDepreciationAction(org.slug, assetId, '2026-01-01');

    const { transactionId } = await disposeFixedAssetAction(org.slug, assetId, {
      disposalDate: '2026-01-31',
      proceeds: '1000.00',
      moneyAccountId: org.accountsByCode.bank,
    });

    // 累计 300、账面净值 900、收入 1000 → 收益 100。
    expect(await linesFor(transactionId)).toEqual([
      { code: 'ad-equipment', direction: 'debit', amount_minor: '30000', base_amount_minor: '30000' },
      { code: 'bank', direction: 'debit', amount_minor: '100000', base_amount_minor: '100000' },
      { code: 'equipment', direction: 'credit', amount_minor: '120000', base_amount_minor: '120000' },
      { code: 'other-income', direction: 'credit', amount_minor: '10000', base_amount_minor: '10000' },
    ]);
    await assertBalanced(transactionId);
    expect((await assetRow(assetId)).disposal_proceeds_minor).toBe('100000');

    expect(await balanceOf(org.id, 'equipment')).toBe(0n);
    expect(await balanceOf(org.id, 'ad-equipment')).toBe(0n);
    expect(await balanceOf(org.id, 'other-income')).toBe(-10000n);
  });

  it('sells below book value: the shortfall is a loss', async () => {
    const org = await newOrg('loss');
    const assetId = await newAsset(org, 'Laptop');
    currentUserId = ownerId;

    const { transactionId } = await disposeFixedAssetAction(org.slug, assetId, {
      disposalDate: '2026-01-15',
      proceeds: '500',
      moneyAccountId: org.accountsByCode.cash,
    });

    // 没有计提过折旧：没有累计折旧行。账面净值 1200、收入 500 → 损失 700。
    expect(await linesFor(transactionId)).toEqual([
      { code: 'cash', direction: 'debit', amount_minor: '50000', base_amount_minor: '50000' },
      { code: 'other-expenses', direction: 'debit', amount_minor: '70000', base_amount_minor: '70000' },
      { code: 'equipment', direction: 'credit', amount_minor: '120000', base_amount_minor: '120000' },
    ]);
    await assertBalanced(transactionId);
    expect(await balanceOf(org.id, 'equipment')).toBe(0n);
    expect(await balanceOf(org.id, 'ad-equipment')).toBe(0n);
  });

  it('counts only depreciation that is still in the books (voided periods are excluded)', async () => {
    const org = await newOrg('voided');
    const assetId = await newAsset(org, 'Projector');
    currentUserId = ownerId;
    const jan = await postDepreciationAction(org.slug, assetId, '2026-01-01');
    await postDepreciationAction(org.slug, assetId, '2026-02-01');
    await admin`
      update transactions
      set voided_at = now(), voided_by = ${ownerId}, void_reason = 'test'
      where id = ${jan.transactionId}
    `;

    const { transactionId } = await disposeFixedAssetAction(org.slug, assetId, {
      disposalDate: '2026-02-28',
      proceeds: '0',
    });
    const lines = await linesFor(transactionId);
    expect(lines.find((l) => l.code === 'ad-equipment')?.amount_minor).toBe('30000');
    expect(await balanceOf(org.id, 'ad-equipment')).toBe(0n);
    expect(await balanceOf(org.id, 'equipment')).toBe(0n);
  });
});

describe('disposeFixedAssetAction - what it refuses', () => {
  let org: SeededOrg;
  let assetId: string;

  beforeAll(async () => {
    org = await newOrg('refuse');
    assetId = await newAsset(org, 'Guarded asset');
    currentUserId = ownerId;
    await postDepreciationAction(org.slug, assetId, '2026-01-01');
    await postDepreciationAction(org.slug, assetId, '2026-02-01');
  });

  async function nothingWritten() {
    const rows = await admin`
      select id from transactions
      where organization_id = ${org.id} and description like 'Disposal:%'
    `;
    expect(rows).toHaveLength(0);
    expect((await assetRow(assetId)).is_active).toBe(true);
  }

  it('refuses a disposal date before the purchase date', async () => {
    await expect(
      disposeFixedAssetAction(org.slug, assetId, { disposalDate: '2025-12-31', proceeds: '0' }),
    ).rejects.toThrow(/before the purchase date/i);
    await nothingWritten();
  });

  it('refuses when depreciation is already posted after the disposal date', async () => {
    await expect(
      disposeFixedAssetAction(org.slug, assetId, { disposalDate: '2026-01-20', proceeds: '0' }),
    ).rejects.toThrow(/after the disposal date/i);
    await nothingWritten();
  });

  it('refuses proceeds without a receiving account', async () => {
    await expect(
      disposeFixedAssetAction(org.slug, assetId, { disposalDate: '2026-02-20', proceeds: '10' }),
    ).rejects.toThrow(/received the sale proceeds/i);
    await nothingWritten();
  });

  it('refuses a receiving account that is not a money account', async () => {
    await expect(
      disposeFixedAssetAction(org.slug, assetId, {
        disposalDate: '2026-02-20',
        proceeds: '10',
        moneyAccountId: org.accountsByCode.sales,
      }),
    ).rejects.toThrow(/money accounts/i);
    await nothingWritten();
  });

  it("refuses another company's money account", async () => {
    const other = await newOrg('other');
    await expect(
      disposeFixedAssetAction(org.slug, assetId, {
        disposalDate: '2026-02-20',
        proceeds: '10',
        moneyAccountId: other.accountsByCode.bank,
      }),
    ).rejects.toThrow(/money accounts/i);
    await nothingWritten();
  });

  it('refuses a disposal date inside the locked period', async () => {
    await admin`update organizations set locked_until = '2026-02-28' where id = ${org.id}`;
    try {
      await expect(
        disposeFixedAssetAction(org.slug, assetId, { disposalDate: '2026-02-20', proceeds: '0' }),
      ).rejects.toThrow(/locked/i);
      await nothingWritten();
    } finally {
      await admin`update organizations set locked_until = null where id = ${org.id}`;
    }
  });

  it('refuses to dispose twice', async () => {
    await disposeFixedAssetAction(org.slug, assetId, { disposalDate: '2026-02-20', proceeds: '0' });
    await expect(
      disposeFixedAssetAction(org.slug, assetId, { disposalDate: '2026-02-21', proceeds: '0' }),
    ).rejects.toThrow(/already disposed/i);
  });
});

describe('undoFixedAssetDisposalAction', () => {
  it('voids the disposal entry and makes the asset active again', async () => {
    const org = await newOrg('undo');
    const assetId = await newAsset(org, 'Delivery bike');
    currentUserId = ownerId;
    await postDepreciationAction(org.slug, assetId, '2026-01-01');

    const { transactionId } = await disposeFixedAssetAction(org.slug, assetId, {
      disposalDate: '2026-01-31',
      proceeds: '1000.00',
      moneyAccountId: org.accountsByCode.bank,
    });
    expect(await balanceOf(org.id, 'equipment')).toBe(0n);

    await undoFixedAssetDisposalAction(org.slug, assetId);

    const row = await assetRow(assetId);
    expect(row.is_active).toBe(true);
    expect(row.disposed_at).toBeNull();
    expect(row.disposal_transaction_id).toBeNull();
    expect(row.disposal_proceeds_minor).toBeNull();

    const [txn] = await admin`select voided_at, void_reason from transactions where id = ${transactionId}`;
    expect(txn.voided_at).not.toBeNull();

    // 账回到处置之前：原值还在，累计折旧还是那一期的 300。
    expect(await balanceOf(org.id, 'equipment')).toBe(120000n);
    expect(await balanceOf(org.id, 'ad-equipment')).toBe(-30000n);
    expect(await balanceOf(org.id, 'other-income')).toBe(0n);

    // 恢复之后可以继续折旧，也可以再处置一次。
    await postDepreciationAction(org.slug, assetId, '2026-02-01');
    const again = await disposeFixedAssetAction(org.slug, assetId, {
      disposalDate: '2026-02-15',
      proceeds: '0',
    });
    await assertBalanced(again.transactionId);
    expect(await balanceOf(org.id, 'equipment')).toBe(0n);
    expect(await balanceOf(org.id, 'ad-equipment')).toBe(0n);
  });

  it('refuses to undo an asset that is not disposed', async () => {
    const org = await newOrg('undo-active');
    const assetId = await newAsset(org, 'Still in use');
    currentUserId = ownerId;
    await expect(undoFixedAssetDisposalAction(org.slug, assetId)).rejects.toThrow(/not been disposed/i);
  });
});
