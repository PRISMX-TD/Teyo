import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { admin } from '@/tests/helpers/db';
import type { OrgContext } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { postJournal } from '@/server/posting/post-journal';
import {
  loadDepreciationPosting,
  markDepreciationPosted,
} from '@/server/repositories/fixed_assets';
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

const { createFixedAsset, postDepreciationAction } = await import(
  '@/server/actions/fixed_assets'
);

const suffix = randomUUID().slice(0, 8);

let ownerId: string;
let org: SeededOrg;
let assetId: string;

/** 本文件建过的公司，清理时要先把折旧排程对交易的引用摘掉，见 afterAll。 */
const orgIds: string[] = [];

// 直线法、4 个月、1200.00 无残值 —— 每期正好 300.00，
// 排程落在 2026-01-01 / 02-01 / 03-01 / 04-01 四期上。
const PURCHASE_DATE = '2026-01-01';
const PER_PERIOD_MINOR = '30000';

async function newAsset(
  target: SeededOrg,
  name: string,
  accounts: { expense: string; accum: string },
): Promise<string> {
  currentUserId = ownerId;
  const { id } = await createFixedAsset(target.slug, {
    name,
    description: null,
    purchaseDate: PURCHASE_DATE,
    cost: '1200.00',
    salvageValue: '0',
    usefulLifeMonths: 4,
    method: 'straight_line',
    decliningRateBps: null,
    assetAccountId: target.accountsByCode.equipment,
    depnExpenseAccountId: accounts.expense,
    depnAccumAccountId: accounts.accum,
  });
  return id;
}

beforeAll(async () => {
  ownerId = await createTestUser(`test-owner-depn-${suffix}@example.com`, 'Owner');
  currentUserId = ownerId;

  org = await createTestOrgWithSeed(ownerId, 'Depreciation Co', `depn-co-${suffix}`, 'MYR');
  orgIds.push(org.id);
  assetId = await newAsset(org, 'Espresso machine', {
    expense: org.accountsByCode.depreciation,
    accum: org.accountsByCode['ad-equipment'],
  });
});

afterAll(async () => {
  // depreciation_schedules.transaction_id 指向 transactions(id)，而且没有
  // on delete cascade —— 0016 只补了那一批 organization_id 外键。于是任何一家
  // 过过折旧的公司都删不掉：删公司时 transactions 与 depreciation_schedules
  // 各自被级联删除，而 NO ACTION 的完整性检查与 CASCADE 同在一条语句的触发器
  // 队列里，检查排在前面就会看到还没删掉的排程行，把整句 delete 顶回来。
  // 这是生产里同样存在的洞，指向 transactions 的六条外键都是这个形状，
  // 0020_transaction_fk_cascade.sql 一并扫掉，等人工执行。在那之前清理必须
  // 自己先把引用摘掉。
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
    order by l.direction
  `;
}

async function scheduleRow(asset: string, period: string) {
  const [row] = await admin`
    select is_posted, transaction_id, depreciation_minor
    from depreciation_schedules
    where fixed_asset_id = ${asset} and period = ${period}::date
  `;
  return row;
}

describe('postDepreciationAction - the entry it writes', () => {
  // 折旧借费用、贷累计折旧。累计折旧是资产的备抵科目，贷方增加——写反
  // 不会有任何报错（一借一贷照样配平，两个科目也都属于本公司），只会让
  // 资产负债表两头同时错，所以这里必须断言到科目代码，而不只是金额。
  it('debits depreciation expense and credits accumulated depreciation', async () => {
    currentUserId = ownerId;
    const { transactionId } = await postDepreciationAction(org.slug, assetId, '2026-01-01');

    expect(await linesFor(transactionId)).toEqual([
      { code: 'depreciation', direction: 'debit', amount_minor: PER_PERIOD_MINOR, base_amount_minor: PER_PERIOD_MINOR },
      { code: 'ad-equipment', direction: 'credit', amount_minor: PER_PERIOD_MINOR, base_amount_minor: PER_PERIOD_MINOR },
    ]);

    const [row] = await admin`
      select kind, occurred_on, description, currency, amount_minor,
             base_amount_minor, exchange_rate, rate_source, category_id
      from transactions where id = ${transactionId}
    `;
    expect(row.kind).toBe('journal');
    expect(row.description).toBe('Depreciation: Espresso machine (2026-01-01)');
    expect(row.currency).toBe('MYR');
    expect(row.amount_minor).toBe(PER_PERIOD_MINOR);
    expect(row.base_amount_minor).toBe(PER_PERIOD_MINOR);
    // 排程金额本就是本位币（cost_minor 是本位币，原币三个字段只作购入留痕，
    // 见 0011 迁移），所以 resolveRate 走同币种那一支直接返回 1，不查缓存。
    expect(Number(row.exchange_rate)).toBe(1);
    expect(row.rate_source).toBe('auto');
    // 手工凭证不挂分类，与 transactions_category_matches_kind 一致（0014 迁移）。
    expect(row.category_id).toBeNull();
  });

  it('marks the schedule posted and links it to that transaction', async () => {
    currentUserId = ownerId;
    const { transactionId } = await postDepreciationAction(org.slug, assetId, '2026-02-01');

    const row = await scheduleRow(assetId, '2026-02-01');
    expect(row.is_posted).toBe(true);
    expect(row.transaction_id).toBe(transactionId);
  });
});

describe('postDepreciationAction - the audit trail it never had', () => {
  // 迁移之前这条路径一行审计都不写（阶段 1A 审计确认），所以没有「原来的
  // 形状」要保住——这里量的是走进边界之后新拿到的东西：一条 transaction.created，
  // 带 source 指回资产，且每行分录都带上事发当时的科目代码（任务 4 加的，
  // 日后翻日志的人认得 'depreciation'，认不得一串 uuid）。
  it('records one audit entry carrying the account codes and the asset it came from', async () => {
    currentUserId = ownerId;
    const { transactionId } = await postDepreciationAction(org.slug, assetId, '2026-03-01');

    const rows = await admin`
      select action, entity_type, after from audit_logs
      where entity_id = ${transactionId} and action = 'transaction.created'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].entity_type).toBe('transaction');
    expect(rows[0].after).toMatchObject({
      kind: 'journal',
      currency: 'MYR',
      amountMinor: PER_PERIOD_MINOR,
      baseAmountMinor: PER_PERIOD_MINOR,
      rateSource: 'auto',
      categoryId: null,
      sourceType: 'fixed_asset',
      sourceId: assetId,
      description: 'Depreciation: Espresso machine (2026-03-01)',
    });

    const after = rows[0].after as {
      lines: { accountId: string; accountCode: string; direction: string; amountMinor: string }[];
    };
    expect(after.lines.map((line) => [line.direction, line.accountCode, line.amountMinor])).toEqual([
      ['debit', 'depreciation', PER_PERIOD_MINOR],
      ['credit', 'ad-equipment', PER_PERIOD_MINOR],
    ]);
    // 代码没有顶替掉 uuid，两者并存。
    expect(after.lines.every((line) => typeof line.accountId === 'string')).toBe(true);
  });
});

describe('postDepreciationAction - the period lock it never checked', () => {
  // 独立一家公司：这样「什么都没写」可以断言成绝对的零行，而不是
  // 「和刚才一样多」。
  it('refuses a period inside the lock and writes nothing at all', async () => {
    const locked = await createTestOrgWithSeed(
      ownerId,
      'Locked Books Co',
      `depn-locked-${suffix}`,
      'MYR',
    );
    orgIds.push(locked.id);
    const lockedAssetId = await newAsset(locked, 'Delivery van', {
      expense: locked.accountsByCode.depreciation,
      accum: locked.accountsByCode['ad-vehicles'],
    });

    await admin`update organizations set locked_until = '2026-02-28' where id = ${locked.id}`;

    currentUserId = ownerId;
    await expect(
      postDepreciationAction(locked.slug, lockedAssetId, '2026-02-01'),
    ).rejects.toThrow(/locked/i);

    // 抛错不等于没写：这条路径以前根本不查期间锁，所以量的是最终状态。
    const txns = await admin`
      select id from transactions where organization_id = ${locked.id}
    `;
    expect(txns).toHaveLength(0);
    const lines = await admin`
      select id from journal_lines where organization_id = ${locked.id}
    `;
    expect(lines).toHaveLength(0);
    const audits = await admin`
      select id from audit_logs
      where organization_id = ${locked.id} and action = 'transaction.created'
    `;
    expect(audits).toHaveLength(0);

    const row = await scheduleRow(lockedAssetId, '2026-02-01');
    expect(row.is_posted).toBe(false);
    expect(row.transaction_id).toBeNull();

    // 解锁之后同一期照样过得了账——被拒的是锁，不是这条排程。
    await admin`update organizations set locked_until = null where id = ${locked.id}`;
    const { transactionId } = await postDepreciationAction(locked.slug, lockedAssetId, '2026-02-01');
    expect(await linesFor(transactionId)).toEqual([
      { code: 'depreciation', direction: 'debit', amount_minor: PER_PERIOD_MINOR, base_amount_minor: PER_PERIOD_MINOR },
      { code: 'ad-vehicles', direction: 'credit', amount_minor: PER_PERIOD_MINOR, base_amount_minor: PER_PERIOD_MINOR },
    ]);
  });
});

describe('postDepreciationAction - is_posted is the real idempotency guard', () => {
  // clientUuid 每次都新随机一个，postJournal 自己那道幂等查询在这条路径上
  // 永远命中不了。挡住第二笔的只能是排程行上的 is_posted 加那把行锁。
  it('refuses a second posting of the same period', async () => {
    currentUserId = ownerId;
    const { transactionId } = await postDepreciationAction(org.slug, assetId, '2026-04-01');

    await expect(
      postDepreciationAction(org.slug, assetId, '2026-04-01'),
    ).rejects.toThrow(/already been posted/i);

    const rows = await admin`
      select id from transactions
      where organization_id = ${org.id}
        and description = 'Depreciation: Espresso machine (2026-04-01)'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(transactionId);
  });

  // 没有 for update 时，READ COMMITTED 下两边都读到 is_posted = false，
  // 都过一笔，同一期折旧记两遍——账面照样配平，界面上也不会有任何提示。
  // 与任务 5 给定期规则修掉的是同一个缺陷。
  //
  // 单纯 Promise.all 两个 Server Action 量不到这件事：两次调用谁先跑完由
  // 网络抖动决定，实测同一个用例在整份文件里跑会「碰巧」串行、单独跑才复现，
  // 也就是说它有一半的时候在没有锁的情况下照样通过——那种用例挡不住回归。
  // 这里改成显式交错：第一笔在事务里拿到锁之后停住，第二笔（走真正的
  // Server Action）必须在这段时间里挂住，不能读完就走。
  it('a second posting blocks on the row lock instead of reading a stale is_posted', async () => {
    const twin = await newAsset(org, 'Server rack', {
      expense: org.accountsByCode.depreciation,
      accum: org.accountsByCode['ad-equipment'],
    });
    const period = '2026-01-01';

    const ctx: OrgContext = {
      userId: ownerId,
      organizationId: org.id,
      orgSlug: org.slug,
      role: 'owner',
      baseCurrency: 'MYR',
      lockedUntil: null,
    };

    let lockTaken!: () => void;
    const holdsLock = new Promise<void>((resolve) => {
      lockTaken = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });

    // 第一笔：手写一遍 postDepreciationAction 的三步，只为了能在中间停住——
    // Server Action 自己开事务、自己提交，没法从外面按住。
    const first = withTransaction(ownerId, async (tx) => {
      const pending = await loadDepreciationPosting(tx, org.id, twin, period);
      lockTaken();
      await released;

      const { transactionId } = await postJournal(tx, ctx, {
        event: {
          type: 'journal',
          debitAccountId: pending.depnExpenseAccountId,
          creditAccountId: pending.depnAccumAccountId,
          amountMinor: pending.depreciationMinor,
        },
        occurredOn: period,
        description: `Depreciation: ${pending.assetName} (${period})`,
        currency: 'MYR',
        manualRateEntry: 'unavailable',
        categoryId: null,
        clientUuid: randomUUID(),
        sourceType: 'fixed_asset',
        sourceId: twin,
      });
      await markDepreciationPosted(tx, org.id, pending.scheduleId, transactionId);
      return transactionId;
    });

    await holdsLock;

    let secondSettled = false;
    let secondError: unknown = null;
    currentUserId = ownerId;
    const second = postDepreciationAction(org.slug, twin, period).then(
      () => {
        secondSettled = true;
      },
      (error: unknown) => {
        secondSettled = true;
        secondError = error;
      },
    );

    // finally 不能省：断言一旦失败就直接抛出，第一笔那个事务会一直开着、
    // 一直攥着行锁，afterAll 里清理用的那句 UPDATE 随即挂在同一行上，
    // 一个失败的断言会变成一整份挂死的测试文件。这个用例针对的那次回归
    // （没有锁）正好走不到这一步，但任何别的早退都会。
    try {
      // 第二笔要做的只是两条 select，没有锁的话远早于这个时限就返回了
      // （实测在几十毫秒内）。留 3 秒是给远端库的余量：这个等待偏长只会让
      // 用例变慢或变红，不会让缺陷混过去。
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      expect(secondSettled).toBe(false);
    } finally {
      release();
    }

    const firstTransactionId = await first;
    await second;

    // 锁放开之后，第二笔用 EvalPlanQual 拿到的是提交后的那一版，is_posted
    // 已经是 true——于是它抛错，而不是照着一份过期的读数再记一笔。
    expect((secondError as Error).message).toMatch(/already been posted/i);

    const rows = await admin`
      select id from transactions
      where organization_id = ${org.id}
        and description = 'Depreciation: Server rack (2026-01-01)'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(firstTransactionId);

    const row = await scheduleRow(twin, period);
    expect(row.is_posted).toBe(true);
    expect(row.transaction_id).toBe(firstTransactionId);
  }, 30_000);
});

describe('markDepreciationPosted - fails closed when it matches nothing', () => {
  // 公司那一层 where 是为「日后别的调用方」加的，而它同时也多了一条
  // 「一行都没匹配上」的路。UPDATE 匹配零行不报错，走到这里时 postJournal
  // 已经把分录写完了——静默的空更新会留下「交易在账上、排程仍未过账」，
  // 用户再点一次就是第二笔，两笔各自配平，没人看得出来。
  it('throws on a mismatched organisation instead of leaving the schedule unposted', async () => {
    const asset = await newAsset(org, 'Fail closed rig', {
      expense: org.accountsByCode.depreciation,
      accum: org.accountsByCode['ad-equipment'],
    });

    currentUserId = ownerId;
    const { transactionId } = await postDepreciationAction(org.slug, asset, '2026-01-01');

    const [target] = await admin`
      select id from depreciation_schedules
      where fixed_asset_id = ${asset} and period = '2026-02-01'::date
    `;

    await expect(
      withTransaction(ownerId, (tx) =>
        // 一个语法合法但不是这家公司的 id。
        markDepreciationPosted(tx, randomUUID(), target.id as string, transactionId),
      ),
    ).rejects.toThrow(/0 rows matched/i);

    const row = await scheduleRow(asset, '2026-02-01');
    expect(row.is_posted).toBe(false);
    expect(row.transaction_id).toBeNull();
  });
});

describe('createFixedAsset - a zero-decimal purchase currency', () => {
  // JPY 没有分币（money.ts 的 ZERO_DECIMAL_CURRENCIES），JPY 150,000 就是
  // 150000 minor。这条路径以前用一个自己写的 parseMinor，无论币种一律补两位
  // 小数，于是 150000 先被读成 15,000,000 minor，convertToBaseMinor 又按
  // fromExponent = 0 再乘一次 100 折算——0.031 的汇率下账面原值成了
  // MYR 465,000 而不是 MYR 4,650，而且资产表、排程表、每一期折旧分录全都
  // 照着这个数走，账面处处配平，没有任何地方看得出来错了一百倍。
  //
  // 购入币种下拉框列的就是 SUPPORTED_CURRENCIES，JPY 与 VND 都在里面
  // （见 app/(app)/[orgSlug]/fixed-assets/new/page.tsx），从界面上点得到。
  //
  // 因此这里断言的是落库的那个数，不是「没有抛错」。
  const JPY_COST = '150000';
  const RATE = '0.031';
  const EXPECTED_COST_MINOR = '465000'; // MYR 4,650.00；旧解析给的是 46500000
  const EXPECTED_PER_PERIOD = '116250'; // 4 期直线法，每期 MYR 1,162.50

  it('books the base-currency cost the purchase-date rate actually gives', async () => {
    currentUserId = ownerId;
    const { id } = await createFixedAsset(org.slug, {
      name: 'Tokyo lathe',
      description: null,
      purchaseDate: PURCHASE_DATE,
      cost: JPY_COST,
      originalCurrency: 'JPY',
      originalCostMinor: JPY_COST,
      exchangeRate: RATE,
      salvageValue: '0',
      usefulLifeMonths: 4,
      method: 'straight_line',
      decliningRateBps: null,
      assetAccountId: org.accountsByCode.equipment,
      depnExpenseAccountId: org.accountsByCode.depreciation,
      depnAccumAccountId: org.accountsByCode['ad-equipment'],
    });

    const [asset] = await admin`
      select cost_minor, original_cost_minor, original_currency, purchase_exchange_rate
      from fixed_assets where id = ${id}
    `;
    expect(asset.cost_minor).toBe(EXPECTED_COST_MINOR);
    // 原币金额同样按 JPY 的小数位读，不补两位。
    expect(asset.original_cost_minor).toBe(JPY_COST);
    expect(asset.original_currency).toBe('JPY');
    expect(Number(asset.purchase_exchange_rate)).toBe(0.031);

    // 排程是照 cost_minor 摊的，错一百倍会一路传下去，所以连着量。
    const schedule = await admin`
      select depreciation_minor from depreciation_schedules
      where fixed_asset_id = ${id} order by period
    `;
    expect(schedule.map((row) => row.depreciation_minor)).toEqual(
      Array(4).fill(EXPECTED_PER_PERIOD),
    );

    // 一路到分录：这才是用户最后在账上看到的数。
    const { transactionId } = await postDepreciationAction(org.slug, id, PURCHASE_DATE);
    expect(await linesFor(transactionId)).toEqual([
      { code: 'depreciation', direction: 'debit', amount_minor: EXPECTED_PER_PERIOD, base_amount_minor: EXPECTED_PER_PERIOD },
      { code: 'ad-equipment', direction: 'credit', amount_minor: EXPECTED_PER_PERIOD, base_amount_minor: EXPECTED_PER_PERIOD },
    ]);
  });

  it('refuses a fraction the currency cannot express instead of truncating it', async () => {
    currentUserId = ownerId;

    const base = {
      description: null,
      purchaseDate: PURCHASE_DATE,
      salvageValue: '0',
      usefulLifeMonths: 4,
      method: 'straight_line' as const,
      decliningRateBps: null,
      assetAccountId: org.accountsByCode.equipment,
      depnExpenseAccountId: org.accountsByCode.depreciation,
      depnAccumAccountId: org.accountsByCode['ad-equipment'],
    };

    // JPY 填了小数：旧解析读成 15000010 minor，用户看不出多了什么。
    await expect(
      createFixedAsset(org.slug, {
        ...base,
        name: 'Fractional yen',
        cost: '150000.1',
        originalCurrency: 'JPY',
        originalCostMinor: '150000.1',
        exchangeRate: RATE,
      }),
    ).rejects.toThrow(/decimal place/i);

    // 本位币填了三位小数：旧解析 slice(0,2) 悄悄把 100.999 记成 100.99。
    await expect(
      createFixedAsset(org.slug, { ...base, name: 'Truncated ringgit', cost: '100.999' }),
    ).rejects.toThrow(/decimal place/i);

    const rows = await admin`
      select id from fixed_assets
      where organization_id = ${org.id} and name in ('Fractional yen', 'Truncated ringgit')
    `;
    expect(rows).toHaveLength(0);
  });

  // 原币不是本位币、却没带汇率时，这条路径以前落回「直接用 cost」那一支，
  // 把一笔 JPY 的成本原样记成 MYR。与 resolveRate 拒绝回退 1:1 是同一条规矩。
  it('refuses a foreign purchase currency with no rate rather than treating it as base', async () => {
    currentUserId = ownerId;
    await expect(
      createFixedAsset(org.slug, {
        name: 'Rateless yen',
        description: null,
        purchaseDate: PURCHASE_DATE,
        cost: JPY_COST,
        originalCurrency: 'JPY',
        originalCostMinor: JPY_COST,
        salvageValue: '0',
        usefulLifeMonths: 4,
        method: 'straight_line',
        decliningRateBps: null,
        assetAccountId: org.accountsByCode.equipment,
        depnExpenseAccountId: org.accountsByCode.depreciation,
        depnAccumAccountId: org.accountsByCode['ad-equipment'],
      }),
    ).rejects.toThrow(/rate on the purchase date/i);
  });
});

describe('postDepreciationAction - an asset whose two accounts are the same', () => {
  // 任务 4 把「借贷不能是同一个科目」的断言放进了 templateFor，走进边界之后
  // 这种资产就会抛错，而不是像以前那样记一笔毫无意义的对冲分录。
  //
  // 这样的行建得出来：库里没有约束（0009 只有两条 references accounts(id)），
  // createFixedAsset 的 zod schema 也只校验两个字段各自是 uuid。界面上碰不到
  // 是因为两个下拉框一个列 asset、一个列 expense，天然不相交——但那是界面的
  // 巧合，不是结构性保证，Server Action 收的是网络上的任意 payload。
  it('is rejected by the distinct-account rule instead of posting a wash entry', async () => {
    const washId = await newAsset(org, 'Wash entry asset', {
      expense: org.accountsByCode['ad-equipment'],
      accum: org.accountsByCode['ad-equipment'],
    });

    currentUserId = ownerId;
    await expect(
      postDepreciationAction(org.slug, washId, '2026-01-01'),
    ).rejects.toThrow(/different accounts/i);

    const rows = await admin`
      select id from transactions
      where organization_id = ${org.id}
        and description = 'Depreciation: Wash entry asset (2026-01-01)'
    `;
    expect(rows).toHaveLength(0);

    const row = await scheduleRow(washId, '2026-01-01');
    expect(row.is_posted).toBe(false);
  });
});
