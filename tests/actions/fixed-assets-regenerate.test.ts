import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { admin } from '@/tests/helpers/db';
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

const { createFixedAsset, postDepreciationAction, updateFixedAssetAction } = await import(
  '@/server/actions/fixed_assets'
);

const suffix = randomUUID().slice(0, 8);

let ownerId: string;
let org: SeededOrg;

/** 本文件建过的公司，清理时要先把折旧排程对交易的引用摘掉，见 afterAll。 */
const orgIds: string[] = [];

// 直线法、4 个月、1200.00 无残值 —— 每期正好 300.00，
// 排程落在 2026-01-01 / 02-01 / 03-01 / 04-01 四期上。
const PURCHASE_DATE = '2026-01-01';

async function newAsset(
  name: string,
  overrides: { cost?: string; usefulLifeMonths?: number } = {},
): Promise<string> {
  currentUserId = ownerId;
  const { id } = await createFixedAsset(org.slug, {
    name,
    description: null,
    purchaseDate: PURCHASE_DATE,
    cost: overrides.cost ?? '1200.00',
    salvageValue: '0',
    usefulLifeMonths: overrides.usefulLifeMonths ?? 4,
    method: 'straight_line',
    decliningRateBps: null,
    assetAccountId: org.accountsByCode.equipment,
    depnExpenseAccountId: org.accountsByCode.depreciation,
    depnAccumAccountId: org.accountsByCode['ad-equipment'],
  });
  return id;
}

async function schedule(assetId: string) {
  return admin`
    select to_char(period, 'YYYY-MM-DD') as period, depreciation_minor,
           accumulated_minor, book_value_minor, is_posted, transaction_id
    from depreciation_schedules
    where fixed_asset_id = ${assetId}
    order by period
  `;
}

async function transactionsFor(assetId: string) {
  return admin`
    select t.id, t.amount_minor, t.occurred_on
    from transactions t
    where t.organization_id = ${org.id}
      and t.id in (
        select transaction_id from depreciation_schedules
        where fixed_asset_id = ${assetId} and transaction_id is not null
      )
    order by t.occurred_on
  `;
}

/** 某条资产在总账里实际留下的折旧分录（不依赖排程行，直接按来源查审计）。 */
async function postedLineTotal(assetId: string): Promise<bigint> {
  const rows = await admin`
    select coalesce(sum(l.amount_minor), 0) as total
    from journal_lines l
    join audit_logs a on a.entity_id = l.transaction_id
    where a.organization_id = ${org.id}
      and a.action = 'transaction.created'
      and a.after->>'sourceType' = 'fixed_asset'
      and a.after->>'sourceId' = ${assetId}
      and l.direction = 'debit'
  `;
  return BigInt(rows[0].total as string);
}

beforeAll(async () => {
  ownerId = await createTestUser(`test-owner-regen-${suffix}@example.com`, 'Owner');
  currentUserId = ownerId;
  org = await createTestOrgWithSeed(ownerId, 'Regen Co', `regen-co-${suffix}`, 'MYR');
  orgIds.push(org.id);
});

afterAll(async () => {
  // 与 fixed-assets-depreciation.test.ts 同一个理由：
  // depreciation_schedules.transaction_id 指向 transactions(id) 且不是
  // on delete cascade（0020 等人工执行），不先摘掉引用就删不掉公司。
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

describe('generateDepreciationSchedule - 改参数不会让已过账的期间被记第二笔', () => {
  // 这是本次要修的那个 P0：
  //
  // 排程的 upsert 原来写着 `do update set ..., is_posted = false`，而
  // updateFixedAssetAction 在 cost/salvage/life/method/purchaseDate 任一变动时
  // 都会重新生成排程。于是一期折旧过账之后改一下原值，那一期的 is_posted 被
  // 重置回 false、金额被覆盖，transaction_id 却原样留着——分录还在账上。
  // 随后 loadDepreciationPosting 里的 `if (schedule.is_posted)` 顺利通过，
  // 同一期折旧记第二笔。两笔各自一借一贷，数据库的配平触发器、assertBalanced、
  // 行级不变量、账户归属校验四道校验没有任何一道会发现。
  //
  // 所以这个用例量的是最终状态（排程行、分录合计、再过一次账的结果），
  // 不是「没有抛错」。
  it('已过账的那一期原样保留，再点一次过账仍然被拒', async () => {
    const assetId = await newAsset('Repriced lathe');

    currentUserId = ownerId;
    const first = await postDepreciationAction(org.slug, assetId, '2026-01-01');

    // 改原值 1200 -> 2400。这一步会触发重新生成排程。
    const { keptPostedPeriods } = await updateFixedAssetAction(org.slug, assetId, {
      cost: '2400.00',
    });
    expect(keptPostedPeriods).toEqual(['2026-01-01']);

    const rows = await schedule(assetId);

    // 第一期：金额、is_posted、transaction_id 三者一个字节都没变。
    expect(rows[0].period).toBe('2026-01-01');
    expect(rows[0].depreciation_minor).toBe('30000');
    expect(rows[0].is_posted).toBe(true);
    expect(rows[0].transaction_id).toBe(first.transactionId);

    // 剩下三期按**剩余账面净值**重摊：(2400 - 300) / 3 = 700。
    // 若只是跳过已过账期间、剩下的照新参数从头算（2400/4 = 600），
    // 全生命周期合计会是 300 + 600×3 = 2100，这台资产永远折不完。
    expect(rows.slice(1).map((r) => r.depreciation_minor)).toEqual(['70000', '70000', '70000']);

    // 合计恰好等于新的成本减残值。
    const total = rows.reduce((sum, r) => sum + BigInt(r.depreciation_minor as string), 0n);
    expect(total).toBe(240000n);

    // 最后一期的账面净值归零。
    expect(rows[rows.length - 1].book_value_minor).toBe('0');

    // 再点一次「过账」照样被拒——is_posted 没有被重置。
    await expect(
      postDepreciationAction(org.slug, assetId, '2026-01-01'),
    ).rejects.toThrow(/already been posted/i);

    // 账上这条资产只有一笔折旧分录，金额还是原来那 300。
    expect(await transactionsFor(assetId)).toHaveLength(1);
    expect(await postedLineTotal(assetId)).toBe(30000n);
  });

  it('连过三期之后改参数，三期全部冻结，只有最后一期被重摊', async () => {
    const assetId = await newAsset('Long runner');

    currentUserId = ownerId;
    await postDepreciationAction(org.slug, assetId, '2026-01-01');
    await postDepreciationAction(org.slug, assetId, '2026-02-01');
    await postDepreciationAction(org.slug, assetId, '2026-03-01');

    const { keptPostedPeriods } = await updateFixedAssetAction(org.slug, assetId, {
      cost: '1500.00',
    });
    expect(keptPostedPeriods).toEqual(['2026-01-01', '2026-02-01', '2026-03-01']);

    const rows = await schedule(assetId);
    expect(rows.map((r) => [r.depreciation_minor, r.is_posted])).toEqual([
      ['30000', true],
      ['30000', true],
      ['30000', true],
      // 1500 - 900 = 600 全部落在唯一剩下的那一期上。
      ['60000', false],
    ]);

    const total = rows.reduce((sum, r) => sum + BigInt(r.depreciation_minor as string), 0n);
    expect(total).toBe(150000n);

    // 三笔分录，一期一笔，没有第四笔。
    expect(await transactionsFor(assetId)).toHaveLength(3);
    expect(await postedLineTotal(assetId)).toBe(90000n);
  });

  it('缩短年限之后，落在新年限之外且未过账的期间再也过不了账', async () => {
    const assetId = await newAsset('Shortened life', { usefulLifeMonths: 4 });

    currentUserId = ownerId;
    await postDepreciationAction(org.slug, assetId, '2026-01-01');

    // 4 个月改成 2 个月。原来的写法只 upsert 新算出来的两期，3/4 月那两行
    // 原样留在表里、is_posted 仍是 false，排程页照样列出来、照样点得动
    // 「过账」——一台早已折完的资产可以继续折下去。
    await updateFixedAssetAction(org.slug, assetId, { usefulLifeMonths: 2 });

    const rows = await schedule(assetId);
    expect(rows.map((r) => [r.period, r.depreciation_minor])).toEqual([
      ['2026-01-01', '30000'],
      // 1200 - 300 = 900 全部落在第二期。
      ['2026-02-01', '90000'],
      // 多出来的两期被清零。loadDepreciationPosting 的第四条校验是
      // 「金额必须为正」，清零之后它们过不了账。
      ['2026-03-01', '0'],
      ['2026-04-01', '0'],
    ]);

    await expect(
      postDepreciationAction(org.slug, assetId, '2026-03-01'),
    ).rejects.toThrow(/greater than zero/i);

    expect(await postedLineTotal(assetId)).toBe(30000n);
  });

  it('改购入日之后，已过账的旧期间仍然算在累计折旧里', async () => {
    const assetId = await newAsset('Moved purchase date');

    currentUserId = ownerId;
    await postDepreciationAction(org.slug, assetId, '2026-01-01');

    // 购入日整体后移一个月：新的四期是 2026-02 ~ 2026-05，
    // 已过账的 2026-01 完全掉出新列表。
    const { keptPostedPeriods } = await updateFixedAssetAction(org.slug, assetId, {
      purchaseDate: '2026-02-01',
    });
    expect(keptPostedPeriods).toEqual(['2026-01-01']);

    const rows = await schedule(assetId);

    // 掉出新列表的那一期必须留着——它的分录在账上。
    expect(rows[0].period).toBe('2026-01-01');
    expect(rows[0].is_posted).toBe(true);
    expect(rows[0].depreciation_minor).toBe('30000');

    // 剩下四期摊的是 1200 - 300 = 900，不是完整的 1200。只按新期间列表算的话
    // 会从 1200 重新摊起，那 300 就被记了两遍，只是换了个期间名字。
    const unposted = rows.filter((r) => r.is_posted === false);
    expect(unposted).toHaveLength(4);
    const remaining = unposted.reduce(
      (sum, r) => sum + BigInt(r.depreciation_minor as string),
      0n,
    );
    expect(remaining).toBe(90000n);

    const total = rows.reduce((sum, r) => sum + BigInt(r.depreciation_minor as string), 0n);
    expect(total).toBe(120000n);
  });

  it('只改名字不会触发重算，也不会碰任何一行排程', async () => {
    const assetId = await newAsset('Renamed only');

    currentUserId = ownerId;
    await postDepreciationAction(org.slug, assetId, '2026-01-01');
    const before = await schedule(assetId);

    const { keptPostedPeriods } = await updateFixedAssetAction(org.slug, assetId, {
      name: 'Renamed once',
    });
    // needsRegen 为 false，根本没去查已过账集合。
    expect(keptPostedPeriods).toEqual([]);

    expect(await schedule(assetId)).toEqual(before);
  });
});

describe('余额递减法：切换到直线法的那一刻', () => {
  async function decliningAsset(name: string, cost = '1200.00'): Promise<string> {
    currentUserId = ownerId;
    const { id } = await createFixedAsset(org.slug, {
      name,
      description: null,
      purchaseDate: PURCHASE_DATE,
      cost,
      salvageValue: '0',
      usefulLifeMonths: 12,
      method: 'declining_balance',
      decliningRateBps: 20000, // 200%
      assetAccountId: org.accountsByCode.equipment,
      depnExpenseAccountId: org.accountsByCode.depreciation,
      depnAccumAccountId: org.accountsByCode['ad-equipment'],
    });
    return id;
  }

  // 把整条排程逐期钉死。切换判断的分母从 `remainingMonths - 1` 改成了「含本期
  // 在内还剩几期未过账」，这是本次唯一改动余额递减法的地方；写死每一期是为了
  // 让下一次改动它的人当场看到影响，而不是只看到一个仍然等于成本的合计——
  // 合计永远等于成本（最后一期吸收余额），它挡不住任何分布上的错误。
  it('十二期的排程逐期固定，合计恰好折完，末期账面净值归零', async () => {
    const id = await decliningAsset('Declining rig');

    const rows = await schedule(id);
    const amounts = rows.map((r) => r.depreciation_minor as string);

    // 200% / 12 个月 = 每月账面净值的 1/6。1200.00 的 1/6 是 200.00，
    // 之后逐期递减，直到直线额反超（第 7 期起持平在 66.98），
    // 最后一期吸收整除剩下的那一分。
    expect(amounts).toEqual([
      '20000', '16666', '13889', '11574', '9645', '8037',
      '6698', '6698', '6698', '6698', '6698', '6699',
    ]);

    const total = amounts.reduce((sum, a) => sum + BigInt(a), 0n);
    expect(total).toBe(120000n);
    expect(rows[rows.length - 1].book_value_minor).toBe('0');
  });

  // 余额递减法与已过账期间的相互作用：切换判断的分母必须是「还剩几期要摊」，
  // 不是「还剩几个月」。把已过账的期间也数进分母，剩下的每一期都会摊少，
  // 最后一期再一次性补齐，形成一个谁也解释不了的尾巴。
  it('过账之后改原值，已过账期间冻结，剩余期间仍然折完新的成本', async () => {
    const id = await decliningAsset('Declining repriced');

    currentUserId = ownerId;
    await postDepreciationAction(org.slug, id, '2026-01-01');
    await postDepreciationAction(org.slug, id, '2026-02-01');

    const { keptPostedPeriods } = await updateFixedAssetAction(org.slug, id, {
      cost: '2400.00',
    });
    expect(keptPostedPeriods).toEqual(['2026-01-01', '2026-02-01']);

    const rows = await schedule(id);
    // 前两期原样。
    expect(rows[0].depreciation_minor).toBe('20000');
    expect(rows[1].depreciation_minor).toBe('16666');
    expect(rows.slice(0, 2).every((r) => r.is_posted === true)).toBe(true);

    // 合计仍然恰好等于新的成本：已入账的 366.66 加上剩下十期摊掉的余额。
    const total = rows.reduce((sum, r) => sum + BigInt(r.depreciation_minor as string), 0n);
    expect(total).toBe(240000n);
    expect(rows[rows.length - 1].book_value_minor).toBe('0');

    // 账上仍然只有两笔折旧分录。
    expect(await transactionsFor(id)).toHaveLength(2);
    expect(await postedLineTotal(id)).toBe(36666n);
  });
});

describe('updateFixedAssetAction - 审计留下改之前的样子', () => {
  // before 原来是空的。改资产参数会改写往后每一期折旧金额，只记 after 的话，
  // 事后对账时唯一想知道的「改之前原值是多少」恰好查不到。
  it('记下原值、年限，以及哪些期间因为已入账而被保留', async () => {
    const assetId = await newAsset('Audited asset');

    currentUserId = ownerId;
    await postDepreciationAction(org.slug, assetId, '2026-01-01');
    await updateFixedAssetAction(org.slug, assetId, { cost: '1800.00', usefulLifeMonths: 6 });

    const [row] = await admin`
      select before, after from audit_logs
      where organization_id = ${org.id}
        and entity_id = ${assetId}
        and action = 'fixed_asset.updated'
      order by created_at desc limit 1
    `;

    expect(row.before).toMatchObject({
      costMinor: '120000',
      usefulLifeMonths: 4,
      method: 'straight_line',
    });
    expect(row.after).toMatchObject({
      cost: '1800.00',
      usefulLifeMonths: 6,
      regenerated: true,
      keptPostedPeriods: ['2026-01-01'],
    });
  });
});
