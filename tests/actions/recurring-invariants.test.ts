// 需要迁移 0012_drop_stale_rls_policies.sql 才能通过。
// 该迁移由人工在本计划末尾批量执行，在此之前 recurring_transactions 上
// 残留的旧 RLS 策略会导致本文件的用例失败，报错为
// `unrecognized configuration parameter "app.current_org_id"`。
// 这是已知且预期的失败，不要绕过或重写用例来规避它。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, createTestUser, deleteTestUser, deleteTestOrganizations } from '@/tests/helpers/db';
import { withTransaction } from '@/server/db/transaction';
import { getDueRecurring } from '@/server/repositories/recurring';
import { assertLineInvariants, LedgerError } from '@/server/domain/ledger';
import { RATE_SCALE } from '@/server/domain/exchange-rate';

let userId: string;
let orgId: string;

beforeAll(async () => {
  const user = await createTestUser('Recurring Invariants');
  userId = user.id;

  const [org] = await admin`
    insert into organizations (name, slug, base_currency, created_by)
    values ('Inv Co', ${'inv-' + Date.now()}, 'MYR', ${userId})
    returning id
  `;
  orgId = org.id as string;

  await admin`
    insert into memberships (user_id, organization_id, role, status)
    values (${userId}, ${orgId}, 'owner', 'active')
  `;

  const [debit] = await admin`
    insert into accounts (organization_id, code, name_en, type)
    values (${orgId}, 'software', 'Software', 'expense') returning id
  `;
  const [credit] = await admin`
    insert into accounts (organization_id, code, name_en, type, is_money_account)
    values (${orgId}, 'cash', 'Cash', 'asset', true) returning id
  `;

  await admin`
    insert into recurring_transactions
      (organization_id, kind, description, amount, currency,
       debit_account_id, credit_account_id, frequency, interval,
       start_date, next_due_date)
    values (${orgId}, 'expense', 'USD subscription', '500.00', 'USD',
       ${debit.id}, ${credit.id}, 'monthly', 1,
       '2026-01-01', '2026-01-01')
  `;
});

afterAll(async () => {
  await deleteTestOrganizations([orgId]);
  await deleteTestUser(userId);
  await admin.end();
});

describe('recurring generation guards against a fabricated 1:1 rate', () => {
  it('the shape recurring currently produces is rejected by the invariant', async () => {
    const due = await withTransaction(userId, (tx) =>
      getDueRecurring(tx, orgId, '2026-02-01'),
    );
    expect(due.length).toBeGreaterThan(0);

    const entry = due[0];
    expect(entry.currency).toBe('USD');

    // 复刻 generateDueRecurring 修改前的写法
    const amountMinor = 50000n;
    const lines = [
      { accountId: entry.debitAccountId, direction: 'debit' as const, amountMinor, baseAmountMinor: amountMinor },
      { accountId: entry.creditAccountId, direction: 'credit' as const, amountMinor, baseAmountMinor: amountMinor },
    ];

    expect(() =>
      assertLineInvariants(lines, {
        currency: entry.currency,
        baseCurrency: 'MYR',
        scaledRate: RATE_SCALE,
        rateSource: 'auto',
      }),
    ).toThrow(LedgerError);
  });
});
