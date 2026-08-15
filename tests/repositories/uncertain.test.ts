import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin } from '@/tests/helpers/db';
import { withTransaction } from '@/server/db/transaction';
import { countUncertain, listUncertain, UNCERTAIN_PAGE_MAX } from '@/server/repositories/uncertain';
import { createTestOrgWithSeed, createTestUser, resetTestData } from '@/tests/helpers/test-db';

let ownerId: string;

const suffix = randomUUID().slice(0, 8);

/**
 * 直接插数据，绕过 createJournal，让仓储测试与 action 层解耦
 * （同 tests/repositories/transactions-list.test.ts 的 insertTx）。
 *
 * 两行分录必须一条语句插完：分开插的话每次自动提交都是单边不平衡，
 * journal_lines_balanced 触发器会在提交点回滚。
 */
async function insertJournal(
  organizationId: string,
  args: {
    occurredOn: string;
    amountMinor: number;
    createdBy: string;
    debitAccountId: string;
    creditAccountId: string;
    description: string;
    voided?: boolean;
  },
): Promise<string> {
  const [row] = await admin`
    insert into transactions (
      organization_id, kind, occurred_on, description, currency,
      amount_minor, base_amount_minor, exchange_rate, rate_source,
      category_id, created_by, client_uuid, voided_at, voided_by, void_reason
    ) values (
      ${organizationId}, 'journal', ${args.occurredOn}, ${args.description}, 'MYR',
      ${args.amountMinor}, ${args.amountMinor}, 1, 'auto',
      null, ${args.createdBy}, ${randomUUID()},
      ${args.voided ? admin`now()` : null},
      ${args.voided ? args.createdBy : null},
      ${args.voided ? 'test void' : null}
    )
    returning id
  `;

  await admin`
    insert into journal_lines (transaction_id, organization_id, account_id, direction, amount_minor, base_amount_minor)
    values
      (${row.id}, ${organizationId}, ${args.debitAccountId}, 'debit', ${args.amountMinor}, ${args.amountMinor}),
      (${row.id}, ${organizationId}, ${args.creditAccountId}, 'credit', ${args.amountMinor}, ${args.amountMinor})
  `;

  return row.id as string;
}

beforeAll(async () => {
  ownerId = await createTestUser(`test-owner-unc-${suffix}@example.com`, 'Owner');
});

afterAll(async () => {
  await resetTestData();
  await admin.end();
});

describe('countUncertain / listUncertain', () => {
  let orgId: string;
  let otherOrgId: string;
  let suspenseId: string;
  let bankId: string;
  let rentId: string;
  let suspenseTxId: string;

  beforeAll(async () => {
    const org = await createTestOrgWithSeed(ownerId, 'Uncertain Co', `uncertain-co-${suffix}`, 'MYR');
    orgId = org.id;
    suspenseId = org.accountsByCode.suspense;
    bankId = org.accountsByCode.bank;
    rentId = org.accountsByCode.rent;

    const other = await createTestOrgWithSeed(
      ownerId,
      'Other Uncertain Co',
      `other-uncertain-co-${suffix}`,
      'MYR',
    );
    otherOrgId = other.id;

    // 一笔真正待确认的：钱进了银行账户，来源未知，挂在悬置科目上。
    suspenseTxId = await insertJournal(orgId, {
      occurredOn: '2026-07-15',
      amountMinor: 5000,
      createdBy: ownerId,
      debitAccountId: bankId,
      creditAccountId: suspenseId,
      description: 'Unknown deposit',
    });
    // 更早的一笔待确认，用于验证倒序排序。
    await insertJournal(orgId, {
      occurredOn: '2026-07-01',
      amountMinor: 1200,
      createdBy: ownerId,
      debitAccountId: bankId,
      creditAccountId: suspenseId,
      description: 'Older unknown deposit',
    });
    // 已作废的悬置分录：不应出现。
    await insertJournal(orgId, {
      occurredOn: '2026-07-20',
      amountMinor: 900,
      createdBy: ownerId,
      debitAccountId: bankId,
      creditAccountId: suspenseId,
      description: 'Voided suspense entry',
      voided: true,
    });
    // 手工日记账但没碰悬置科目：不应出现（kind = 'journal' 不等于「待确认」）。
    await insertJournal(orgId, {
      occurredOn: '2026-07-05',
      amountMinor: 300,
      createdBy: ownerId,
      debitAccountId: rentId,
      creditAccountId: bankId,
      description: 'Ordinary manual journal entry',
    });
    // 另一家公司自己的悬置条目：不应泄漏到 orgId 的查询里。
    await insertJournal(otherOrgId, {
      occurredOn: '2026-07-15',
      amountMinor: 700,
      createdBy: ownerId,
      debitAccountId: other.accountsByCode.bank,
      creditAccountId: other.accountsByCode.suspense,
      description: 'Other company unknown deposit',
    });
  });

  it('counts only non-voided entries with a line against this company\'s suspense account', async () => {
    const count = await withTransaction(ownerId, (tx) => countUncertain(tx, orgId));
    expect(count).toBe(2);
  });

  it('lists newest first', async () => {
    const rows = await withTransaction(ownerId, (tx) => listUncertain(tx, orgId));
    expect(rows.map((r) => r.occurredOn)).toEqual(['2026-07-15', '2026-07-01']);
  });

  it('returns date, description, amount, currency and the transaction id', async () => {
    const rows = await withTransaction(ownerId, (tx) => listUncertain(tx, orgId));
    expect(rows[0]).toEqual({
      id: suspenseTxId,
      occurredOn: '2026-07-15',
      description: 'Unknown deposit',
      amountMinor: 5000n,
      currency: 'MYR',
    });
  });

  it('excludes a voided suspense entry', async () => {
    const rows = await withTransaction(ownerId, (tx) => listUncertain(tx, orgId));
    expect(rows.some((r) => r.description === 'Voided suspense entry')).toBe(false);
  });

  it('excludes a manual journal entry that never touched suspense', async () => {
    const rows = await withTransaction(ownerId, (tx) => listUncertain(tx, orgId));
    expect(rows.some((r) => r.description === 'Ordinary manual journal entry')).toBe(false);
  });

  it('never returns another company\'s entries', async () => {
    const otherCount = await withTransaction(ownerId, (tx) => countUncertain(tx, otherOrgId));
    const otherRows = await withTransaction(ownerId, (tx) => listUncertain(tx, otherOrgId));
    expect(otherCount).toBe(1);
    expect(otherRows).toHaveLength(1);
    expect(otherRows[0].description).toBe('Other company unknown deposit');
  });

  it('is zero and empty for a company with no suspense activity at all', async () => {
    const empty = await createTestOrgWithSeed(ownerId, 'Empty Co', `empty-unc-co-${suffix}`, 'MYR');
    const count = await withTransaction(ownerId, (tx) => countUncertain(tx, empty.id));
    const rows = await withTransaction(ownerId, (tx) => listUncertain(tx, empty.id));
    expect(count).toBe(0);
    expect(rows).toEqual([]);
  });
});

describe('listUncertain pagination and validation', () => {
  let orgId: string;

  beforeAll(async () => {
    const org = await createTestOrgWithSeed(ownerId, 'Uncertain Page Co', `uncertain-page-co-${suffix}`, 'MYR');
    orgId = org.id;
    const suspenseId = org.accountsByCode.suspense;
    const bankId = org.accountsByCode.bank;

    for (let i = 0; i < 12; i += 1) {
      const day = String(i + 1).padStart(2, '0');
      await insertJournal(orgId, {
        occurredOn: `2026-05-${day}`,
        amountMinor: 100 * (i + 1),
        createdBy: ownerId,
        debitAccountId: bankId,
        creditAccountId: suspenseId,
        description: `Deposit ${i + 1}`,
      });
    }
  });

  it('pages through results without overlap', async () => {
    const first = await withTransaction(ownerId, (tx) => listUncertain(tx, orgId, 5, 0));
    const second = await withTransaction(ownerId, (tx) => listUncertain(tx, orgId, 5, 5));
    expect(first).toHaveLength(5);
    expect(second).toHaveLength(5);
    const overlap = first.map((r) => r.id).filter((id) => second.some((s) => s.id === id));
    expect(overlap).toHaveLength(0);
  });

  it('caps an oversized limit instead of running an unbounded scan', async () => {
    const rows = await withTransaction(ownerId, (tx) => listUncertain(tx, orgId, 100_000, 0));
    expect(rows.length).toBeLessThanOrEqual(UNCERTAIN_PAGE_MAX);
  });

  it('defaults to a full page when limit/offset are omitted', async () => {
    const rows = await withTransaction(ownerId, (tx) => listUncertain(tx, orgId));
    expect(rows).toHaveLength(12);
  });

  it('rejects a negative or non-integer limit', async () => {
    await expect(
      withTransaction(ownerId, (tx) => listUncertain(tx, orgId, -1, 0)),
    ).rejects.toThrow(/limit/i);
    await expect(
      withTransaction(ownerId, (tx) => listUncertain(tx, orgId, 1.5, 0)),
    ).rejects.toThrow(/limit/i);
  });

  it('rejects a negative or non-integer offset', async () => {
    await expect(
      withTransaction(ownerId, (tx) => listUncertain(tx, orgId, 10, -5)),
    ).rejects.toThrow(/offset/i);
    await expect(
      withTransaction(ownerId, (tx) => listUncertain(tx, orgId, 10, 2.5)),
    ).rejects.toThrow(/offset/i);
  });
});
