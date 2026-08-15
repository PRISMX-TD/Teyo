// 这些用例依赖 supabase/migrations/0012_drop_stale_rls_policies.sql 已被应用。
// 在该迁移落地前，recurring_transactions 上残留的旧 RLS 策略会让本文件里
// 的每一次写入都抛出 `unrecognized configuration parameter
// "app.current_org_id"`（与本文件要验证的占位符缺陷无关）。若看到这个
// 报错而不是断言失败，说明是环境未迁移，不是代码回归。

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, createTestUser, deleteTestUser, deleteTestOrganizations } from '@/tests/helpers/db';
import { toIsoDate } from '@/lib/format';
import { withTransaction } from '@/server/db/transaction';
import { updateRecurring } from '@/server/repositories/recurring';

let userId: string;
let orgId: string;
let recurringId: string;

beforeAll(async () => {
  const user = await createTestUser('Recurring Update');
  userId = user.id;

  const [org] = await admin`
    insert into organizations (name, slug, base_currency, created_by)
    values ('Recurring Co', ${'recur-' + Date.now()}, 'MYR', ${userId})
    returning id
  `;
  orgId = org.id as string;

  await admin`
    insert into memberships (user_id, organization_id, role, status)
    values (${userId}, ${orgId}, 'owner', 'active')
  `;

  const [debit] = await admin`
    insert into accounts (organization_id, code, name_en, type)
    values (${orgId}, 'rent', 'Rent', 'expense') returning id
  `;
  const [credit] = await admin`
    insert into accounts (organization_id, code, name_en, type, is_money_account)
    values (${orgId}, 'cash', 'Cash', 'asset', true) returning id
  `;

  const [row] = await admin`
    insert into recurring_transactions
      (organization_id, kind, description, amount, currency,
       debit_account_id, credit_account_id, frequency, interval,
       start_date, next_due_date)
    values (${orgId}, 'expense', 'Monthly rent', '1200.00', 'MYR',
       ${debit.id}, ${credit.id}, 'monthly', 1,
       '2026-01-01', '2026-01-01')
    returning id
  `;
  recurringId = row.id as string;
});

afterAll(async () => {
  await deleteTestOrganizations([orgId]);
  await deleteTestUser(userId);
  await admin.end();
});

describe('updateRecurring', () => {
  it('advances next_due_date without throwing', async () => {
    await withTransaction(userId, async (tx) => {
      await updateRecurring(tx, orgId, recurringId, { nextDueDate: '2026-02-01' });
    });

    const [row] = await admin`
      select next_due_date from recurring_transactions where id = ${recurringId}
    `;
    // postgres.js 把 date 列解析成 Date 对象，String(d).slice(0,10) 得到的是
    // "Sun Feb 01" 而不是 ISO 日期 —— 与 getGeneralLedger 里修掉的是同一个坑。
    expect(toIsoDate(row.next_due_date as Date)).toBe('2026-02-01');
  });

  it('updates a non-date column', async () => {
    await withTransaction(userId, async (tx) => {
      await updateRecurring(tx, orgId, recurringId, { description: 'Updated rent' });
    });

    const [row] = await admin`
      select description from recurring_transactions where id = ${recurringId}
    `;
    expect(row.description).toBe('Updated rent');
  });

  it('is a no-op when no fields are supplied', async () => {
    await withTransaction(userId, async (tx) => {
      await updateRecurring(tx, orgId, recurringId, {});
    });

    const [row] = await admin`
      select description from recurring_transactions where id = ${recurringId}
    `;
    expect(row.description).toBe('Updated rent');
  });
});
