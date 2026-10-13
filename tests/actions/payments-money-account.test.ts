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

const { createPayment } = await import('@/server/actions/payments');
const { listPayments } = await import('@/server/repositories/payments');
const { withTransaction } = await import('@/server/db/transaction');

/**
 * 收付款记到用户选的那个资金账户上（0037）。
 *
 * 原来资金科目只由「方式」推：现金进 cash，其余一律进 bank。公司另建的
 * Maybank、PayPal 一类户口在收付款上选不到，真正收到钱的户口余额不动。
 *
 * 全部用不核销任何单据的预收款（items: []）：要测的只是钱落在哪个户口，
 * 发票那一侧与这里无关。
 */

let ownerId: string;
let org: SeededOrg;
let otherOrg: SeededOrg;
let customerId: string;
let maybankId: string;
let archivedId: string;

const suffix = randomUUID().slice(0, 8);
const DAY = '2033-05-20';

beforeAll(async () => {
  ownerId = await createTestUser(`owner-moneyacct-${suffix}@example.com`, 'Owner');
  currentUserId = ownerId;
  org = await createTestOrgWithSeed(ownerId, 'Money Account Co', `money-acct-${suffix}`, 'MYR');
  otherOrg = await createTestOrgWithSeed(ownerId, 'Other Co', `money-other-${suffix}`, 'MYR');

  const [contact] = await admin`
    insert into contacts (organization_id, type, name)
    values (${org.id}, 'customer', 'Prompt Payer')
    returning id
  `;
  customerId = contact.id as string;
  maybankId = await moneyAccount(org.id, 'maybank', 'Maybank', true);
  archivedId = await moneyAccount(org.id, 'old-bank', 'Old Bank', false);
});

afterAll(async () => {
  // 与 payments-posting.test.ts 同样的理由：先删收付款，组织删除才做得下去。
  await admin`delete from payments where organization_id = any(${[org.id, otherOrg.id]})`;
  await resetTestData();
  await admin.end();
});

async function moneyAccount(
  organizationId: string,
  code: string,
  name: string,
  isActive: boolean,
): Promise<string> {
  const [row] = await admin`
    insert into accounts (
      organization_id, code, name_en, name_zh, type,
      is_money_account, is_system, is_active, sort_order
    ) values (${organizationId}, ${code}, ${name}, null, 'asset', true, false, ${isActive}, 900)
    returning id
  `;
  return row.id as string;
}

function receive(input: { method?: 'cash' | 'bank_transfer' | 'online'; moneyAccountId?: string }) {
  return createPayment(org.slug, {
    contactId: customerId,
    type: 'received',
    amount: '80.00',
    currency: 'MYR',
    paymentDate: DAY,
    method: input.method ?? 'bank_transfer',
    moneyAccountId: input.moneyAccountId,
    items: [],
  });
}

/** 这笔收付款存下的账户，以及它的分录里挂在资金账户上的那一行的科目。 */
async function landedOn(paymentId: string) {
  const [row] = await admin`
    select p.money_account_id, a.code as posted_code
    from payments p
    join journal_lines l on l.transaction_id = p.transaction_id
    join accounts a on a.id = l.account_id and a.is_money_account
    where p.id = ${paymentId}
  `;
  return { stored: row.money_account_id as string, postedCode: row.posted_code as string };
}

async function paymentCount(): Promise<number> {
  const [row] = await admin`select count(*)::int as n from payments where organization_id = ${org.id}`;
  return row.n as number;
}

describe('createPayment — 资金账户', () => {
  it('posts to the account the user picked and stores it on the payment', async () => {
    const { id } = await receive({ moneyAccountId: maybankId });
    expect(await landedOn(id)).toEqual({ stored: maybankId, postedCode: 'maybank' });
  });

  it('keeps the account the user picked even when the method would default elsewhere', async () => {
    // 方式是现金，但钱进的是 Maybank——用户说了算。
    const { id } = await receive({ method: 'cash', moneyAccountId: maybankId });
    expect((await landedOn(id)).postedCode).toBe('maybank');
  });

  it('falls back to the built-in account for the method when none is sent', async () => {
    const cash = await receive({ method: 'cash' });
    expect(await landedOn(cash.id)).toEqual({
      stored: org.accountsByCode.cash,
      postedCode: 'cash',
    });
    const online = await receive({ method: 'online' });
    expect((await landedOn(online.id)).postedCode).toBe('bank');
  });

  it('refuses an account that is not a cash or bank account', async () => {
    const before = await paymentCount();
    await expect(receive({ moneyAccountId: org.accountsByCode.sales })).rejects.toThrow(
      /not a cash or bank account/,
    );
    expect(await paymentCount()).toBe(before);
  });

  it('refuses an archived account', async () => {
    const before = await paymentCount();
    await expect(receive({ moneyAccountId: archivedId })).rejects.toThrow(/archived/);
    expect(await paymentCount()).toBe(before);
  });

  it('refuses another company’s account', async () => {
    const before = await paymentCount();
    await expect(receive({ moneyAccountId: otherOrg.accountsByCode.bank })).rejects.toThrow(
      /does not exist in this company/,
    );
    expect(await paymentCount()).toBe(before);
  });

  it('lists each payment with the name of its account', async () => {
    const { id } = await receive({ moneyAccountId: maybankId });
    const rows = await withTransaction(ownerId, (tx) => listPayments(tx, org.id));
    expect(rows.find((row) => row.id === id)).toMatchObject({
      moneyAccountId: maybankId,
      moneyAccountNameEn: 'Maybank',
    });
  });
});

describe('payments.money_account_id — 数据库层', () => {
  it('cannot point at another company’s account', async () => {
    // 应用层之外的第二道：0037 的复合外键。延迟检查，所以错误出在提交时。
    const { id } = await receive({ moneyAccountId: maybankId });
    await expect(
      admin.begin(async (sql) => {
        await sql`
          update payments set money_account_id = ${otherOrg.accountsByCode.bank}
          where id = ${id}
        `;
      }),
    ).rejects.toThrow(/payments_money_account_same_org/);
  });
});
