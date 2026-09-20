import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { admin } from '@/tests/helpers/db';
import { withTransaction } from '@/server/db/transaction';
import { getBill } from '@/server/repositories/bills';
import { createTestOrgWithSeed, createTestUser, resetTestData } from '@/tests/helpers/test-db';

/**
 * bills.tax_rate_id 的归属校验。
 *
 * 这一列 0021 就建好了，但 createBill 一直写死 `taxRateId: null`——界面上
 * 没有税率选择器，服务端拿不到值。界面补上之后它才第一次真的被写入，而
 * 「这条税率属于哪家公司」必须在写入路径上被检查：
 *
 *   bills.tax_rate_id -> tax_rates(id) 这条外键只保证那一行**存在**，不检查
 *   它属于谁，而 RLS 不对外键校验生效。跟 journal_lines.account_id、
 *   transactions.project_id 是同一类洞——那两处分别由 insert.ts 里的
 *   assertAccountsBelongToOrg 与 assertProjectBelongsToOrg 堵住。
 *
 * 「下拉里只列出本公司的税率」是一句约定，不是结构性保证：表单可以被改，
 * id 可以被拼错，跨公司复制粘贴的脚本更不会去看下拉框。
 */

let currentUserId: string | null = null;

vi.mock('@/server/auth/session', () => ({
  getCurrentUserId: () => Promise.resolve(currentUserId),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { createBill, updateBill } = await import('@/server/actions/bills');

const suffix = randomUUID().slice(0, 8);
const DAY = '2032-07-08';
const DUE = '2032-08-08';

let ownerId = '';
let orgId = '';
let orgSlug = '';
let vendorId = '';
let ownTaxRateId = '';
let foreignTaxRateId = '';

beforeAll(async () => {
  ownerId = await createTestUser(`test-owner-billtax-${suffix}@example.com`, 'Owner');
  const org = await createTestOrgWithSeed(ownerId, 'Bill Tax Co', `bill-tax-${suffix}`, 'MYR');
  orgId = org.id;
  orgSlug = org.slug;
  currentUserId = ownerId;

  const vendor = await admin`
    insert into contacts (organization_id, type, name)
    values (${orgId}, 'vendor', 'Supplier') returning id
  `;
  vendorId = vendor[0].id as string;

  const own = await admin`
    insert into tax_rates (organization_id, name_en, name_zh, rate_bps)
    values (${orgId}, 'SST 6%', '销售税 6%', 600) returning id
  `;
  ownTaxRateId = own[0].id as string;

  // 另一家公司的税率——外键会放行它（那一行确实存在），挡住它的只有
  // assertTaxRateBelongsToOrg。
  const otherOwnerId = await createTestUser(`test-other-billtax-${suffix}@example.com`, 'Other');
  const otherOrg = await createTestOrgWithSeed(
    otherOwnerId,
    'Other Co',
    `other-bill-tax-${suffix}`,
    'MYR',
  );
  const foreign = await admin`
    insert into tax_rates (organization_id, name_en, name_zh, rate_bps)
    values (${otherOrg.id}, 'Not Yours', '不是你的', 1000) returning id
  `;
  foreignTaxRateId = foreign[0].id as string;
});

afterAll(async () => {
  await resetTestData();
});

function billInput(overrides: Record<string, unknown> = {}) {
  return {
    contactId: vendorId,
    issueDate: DAY,
    dueDate: DUE,
    currency: 'MYR',
    taxRatePercent: '6',
    items: [{ description: 'Stock', amount: '1000.00' }],
    ...overrides,
  };
}

describe('bills.tax_rate_id', () => {
  it('stores the tax rate record the user picked', async () => {
    const { id } = await createBill(orgSlug, billInput({ taxRateId: ownTaxRateId }));

    const rows = await admin`select tax_rate_id, tax_rate_bps from bills where id = ${id}`;
    expect(rows[0].tax_rate_id).toBe(ownTaxRateId);
    // 税率数值与税率记录是两件事，两者都要存下来：税率记录会被改名、
    // 被停用，税率本身也会调整（SST 从 6% 调到 8% 时，历史账单上的 6%
    // 必须留在 tax_rate_bps 里不动）。
    expect(rows[0].tax_rate_bps).toBe(600);
  });

  it('leaves it null when the caller does not pick one', async () => {
    const { id } = await createBill(orgSlug, billInput());

    const rows = await admin`select tax_rate_id from bills where id = ${id}`;
    expect(rows[0].tax_rate_id).toBeNull();
  });

  it("refuses another company's tax rate on create", async () => {
    await expect(
      createBill(orgSlug, billInput({ taxRateId: foreignTaxRateId })),
    ).rejects.toThrow(/tax rate was not found in this company/i);

    // 校验排在任何写入之前——一个字节都没落库。
    const rows = await admin`
      select count(*)::int as n from bills
      where organization_id = ${orgId} and tax_rate_id = ${foreignTaxRateId}
    `;
    expect(rows[0].n).toBe(0);
  });

  it("refuses another company's tax rate on edit", async () => {
    const { id } = await createBill(orgSlug, billInput({ taxRateId: ownTaxRateId }));

    await expect(
      updateBill(orgSlug, id, billInput({ taxRateId: foreignTaxRateId })),
    ).rejects.toThrow(/tax rate was not found in this company/i);

    const rows = await admin`select tax_rate_id from bills where id = ${id}`;
    expect(rows[0].tax_rate_id).toBe(ownTaxRateId);
  });

  it('updates the picked record on edit', async () => {
    // 编辑路径原来根本不传这一列，于是改税率只改掉税率数值，
    // 「选的是哪一条」永远停在创建时的那个值。
    const { id } = await createBill(orgSlug, billInput());

    await updateBill(orgSlug, id, billInput({ taxRateId: ownTaxRateId }));

    const detail = await withTransaction(ownerId, (tx) => getBill(tx, orgId, id));
    expect(detail?.taxRateId).toBe(ownTaxRateId);
  });
});
