import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { admin } from '@/tests/helpers/db';
import { createTestOrgWithSeed, createTestUser, resetTestData } from '@/tests/helpers/test-db';

/**
 * 预收款的完整生命周期：收定金 → 挂预收账款 → 开票 → 核销。
 *
 * 在 0024 之前，payment_items_one_target 要求每条核销明细恰好指向一张
 * 发票或一张账单，于是「客户先付定金，票还没开」在这个产品里**没有任何
 * 表达方式**——表单挡在前面并说明原因，那是承认做不到。
 *
 * 这一份钉的是做到之后的三件事：
 *   1. 不核销任何单据的收款，钱挂在**预收账款（负债）**上，不是收入；
 *   2. 日后核销时碰的是**应收账款**，不是收入科目——收入在开票那一刻就
 *      已经确认过了，再碰一次就是重复计算，而两笔分录各自都配平；
 *   3. 全程账是平的，而且预收账款最终归零。
 */

let currentUserId: string | null = null;
vi.mock('@/server/auth/session', () => ({
  getCurrentUserId: () => Promise.resolve(currentUserId),
  requireUserId: () => Promise.resolve(currentUserId),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { createPayment, applyPrepayment } = await import('@/server/actions/payments');
const { createInvoice, issueInvoice } = await import('@/server/actions/invoices');

const suffix = randomUUID().slice(0, 8);
const DAY = '2033-04-10';

let ownerId = '';
let orgId = '';
let orgSlug = '';
let customerId = '';

/** 某个科目在本公司的余额（借正贷负，本位币）。 */
async function balanceOf(code: string): Promise<bigint> {
  const [row] = await admin`
    select coalesce(sum(case when l.direction = 'debit' then l.base_amount_minor
                             else -l.base_amount_minor end), 0) as net
    from journal_lines l
    join transactions t on t.id = l.transaction_id
    join accounts a on a.id = l.account_id
    where l.organization_id = ${orgId} and a.code = ${code} and t.voided_at is null
  `;
  return BigInt(row.net as string);
}

beforeAll(async () => {
  ownerId = await createTestUser(`test-owner-prepay-${suffix}@example.com`, 'Owner');
  const org = await createTestOrgWithSeed(ownerId, 'Prepay Co', `prepay-${suffix}`, 'MYR');
  orgId = org.id;
  orgSlug = org.slug;
  currentUserId = ownerId;


  const contact = await admin`
    insert into contacts (organization_id, type, name)
    values (${orgId}, 'customer', 'Deposit Customer') returning id
  `;
  customerId = contact[0].id as string;
});

afterAll(async () => {
  await resetTestData();
});

describe('预收款生命周期', () => {
  let paymentId = '';
  let invoiceId = '';

  it('不核销任何单据的收款挂在预收账款上，不碰收入', async () => {
    const before = {
      bank: await balanceOf('bank'),
      deposits: await balanceOf('customer-deposits'),
      sales: await balanceOf('sales'),
    };

    const payment = await createPayment(orgSlug, {
      contactId: customerId,
      type: 'received',
      amount: '1000.00',
      currency: 'MYR',
      paymentDate: DAY,
      method: 'bank_transfer',
      // 一张单据都不勾——这正是 0024 之前录不进来的那种收款。
      items: [],
    });
    paymentId = payment.id;

    // 借银行 1000（资产增加） / 贷预收账款 1000（负债增加）。
    expect(await balanceOf('bank')).toBe(before.bank + 100_000n);
    // 预收账款是负债，贷方余额 —— 借正贷负的口径下是负数。
    expect(await balanceOf('customer-deposits')).toBe(before.deposits - 100_000n);
    // 收入一分都没动：货还没交付，这笔钱还不是收入。
    expect(await balanceOf('sales')).toBe(before.sales);
  });

  it('核销到发票上时碰的是应收账款，不是收入', async () => {
    const invoice = await createInvoice(orgSlug, {
      contactId: customerId,
      issueDate: DAY,
      dueDate: DAY,
      currency: 'MYR',
      items: [{ description: 'Goods', quantity: '1', unitPrice: '1000.00' }],
    });
    invoiceId = invoice.id;
    await issueInvoice(orgSlug, invoiceId);

    const afterIssue = {
      receivable: await balanceOf('accounts-receivable'),
      sales: await balanceOf('sales'),
      deposits: await balanceOf('customer-deposits'),
    };
    // 开票确认了收入：借应收 1000 / 贷收入 1000。
    expect(afterIssue.receivable).toBe(100_000n);
    expect(afterIssue.sales).toBe(-100_000n);

    await applyPrepayment(orgSlug, {
      paymentId,
      applicationDate: DAY,
      items: [{ invoiceId, amount: '1000.00' }],
    });

    // 借预收账款 1000（负债消掉） / 贷应收账款 1000（债权消掉）。
    expect(await balanceOf('customer-deposits')).toBe(afterIssue.deposits + 100_000n);
    expect(await balanceOf('accounts-receivable')).toBe(afterIssue.receivable - 100_000n);
    // **收入一分都没再动。** 核销若碰了收入科目，这一笔生意会在损益表上
    // 出现两次，而两笔分录各自都配平、没有任何报错。
    expect(await balanceOf('sales')).toBe(afterIssue.sales);
  });

  it('走完整个生命周期之后，预收账款与应收账款都归零', async () => {
    expect(await balanceOf('customer-deposits')).toBe(0n);
    expect(await balanceOf('accounts-receivable')).toBe(0n);
    // 剩下的是这门生意真实的样子：收到 1000 现金、确认 1000 收入。
    expect(await balanceOf('bank')).toBe(100_000n);
    expect(await balanceOf('sales')).toBe(-100_000n);
  });

  it('全公司每一笔交易都配平', async () => {
    const [row] = await admin`
      select count(*)::int as n from (
        select t.id
        from transactions t join journal_lines l on l.transaction_id = t.id
        where t.organization_id = ${orgId}
        group by t.id
        having sum(case when l.direction = 'debit' then l.base_amount_minor
                        else -l.base_amount_minor end) <> 0
      ) unbalanced
    `;
    expect(row.n).toBe(0);
  });

  it('核销金额超过这笔款剩余额度时报错', async () => {
    // 上面已经把这 1000 全部核销掉了，再核销任何金额都是凭空核销一笔
    // 没收到的钱。
    await expect(
      applyPrepayment(orgSlug, {
        paymentId,
        applicationDate: DAY,
        items: [{ invoiceId, amount: '0.01' }],
      }),
    ).rejects.toThrow();
  });
});
