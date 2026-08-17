import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { admin } from '@/tests/helpers/db';
import { withTransaction } from '@/server/db/transaction';
import { getTransactionDetail } from '@/server/repositories/transactions';
import {
  createTestOrgWithSeed,
  createTestUser,
  joinOrg,
  resetTestData,
} from '@/tests/helpers/test-db';

let currentUserId: string | null = null;

vi.mock('@/server/auth/session', () => ({
  getCurrentUserId: () => Promise.resolve(currentUserId),
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { createJournal } = await import('@/server/actions/transactions');

let ownerId: string;
let viewerId: string;
let orgSlug: string;
let orgId: string;
let cashAccountId: string;
let suspenseAccountId: string;

// slug 全局唯一，固定值会让上一轮的残留数据卡死后续所有测试。
const suffix = randomUUID().slice(0, 8);

beforeAll(async () => {
  ownerId = await createTestUser(`test-owner-jnl-${suffix}@example.com`, 'Owner');
  viewerId = await createTestUser(`test-viewer-jnl-${suffix}@example.com`, 'Viewer');

  const org = await createTestOrgWithSeed(ownerId, 'Journal Co', `journal-co-${suffix}`, 'MYR');
  orgId = org.id;
  orgSlug = org.slug;
  cashAccountId = org.accountsByCode.cash;
  suspenseAccountId = org.accountsByCode.suspense;

  await joinOrg(viewerId, orgId, 'viewer');
});

afterAll(async () => {
  await resetTestData();
  await admin.end();
});

const DAY = '2026-09-05';

function journalInput(overrides: Record<string, unknown> = {}) {
  return {
    occurredOn: DAY,
    amount: '150.00',
    debitAccountId: cashAccountId,
    creditAccountId: suspenseAccountId,
    description: 'Unsorted counter deposit',
    clientUuid: randomUUID(),
    ...overrides,
  };
}

async function linesFor(id: string) {
  return admin`
    select a.code, l.direction, l.amount_minor
    from journal_lines l join accounts a on a.id = l.account_id
    where l.transaction_id = ${id}
    order by l.direction
  `;
}

describe('createJournal - direction chain', () => {
  // The "not sure" scenario derives debit/credit from the user's answer to
  // "did the money come in or go out" (see transaction-form.tsx): money in
  // debits the money account and credits suspense; money out reverses it.
  // createJournal itself just posts whatever debit/credit pair it is given,
  // so these two cases exercise both directions the client can produce and
  // pin down that templateFor's 'journal' branch (see accountPair in
  // server/domain/posting-templates.ts) really does debit = debitAccountId /
  // credit = creditAccountId, not the reverse.
  it('money in: debits the money account and credits suspense', async () => {
    currentUserId = ownerId;
    const { id } = await createJournal(
      orgSlug,
      journalInput({ debitAccountId: cashAccountId, creditAccountId: suspenseAccountId }),
    );

    expect(await linesFor(id)).toEqual([
      { code: 'cash', direction: 'debit', amount_minor: '15000' },
      { code: 'suspense', direction: 'credit', amount_minor: '15000' },
    ]);
  });

  it('money out: debits suspense and credits the money account', async () => {
    currentUserId = ownerId;
    const { id } = await createJournal(
      orgSlug,
      journalInput({ debitAccountId: suspenseAccountId, creditAccountId: cashAccountId }),
    );

    // journal_lines.direction is a Postgres enum declared debit-before-credit,
    // so `order by direction` sorts debit first regardless of account code.
    expect(await linesFor(id)).toEqual([
      { code: 'suspense', direction: 'debit', amount_minor: '15000' },
      { code: 'cash', direction: 'credit', amount_minor: '15000' },
    ]);
  });

  it('produces a balanced pair regardless of which account is which side', async () => {
    currentUserId = ownerId;
    const { id } = await createJournal(orgSlug, journalInput());

    const [row] = await admin`
      select
        coalesce(sum(amount_minor) filter (where direction = 'debit'), 0) as d,
        coalesce(sum(amount_minor) filter (where direction = 'credit'), 0) as c
      from journal_lines where transaction_id = ${id}
    `;
    expect(row.d).toBe(row.c);
  });
});

describe('createJournal - amounts, kind and category', () => {
  it('stores the head row with kind journal, base-currency amount and no category', async () => {
    currentUserId = ownerId;
    const { id } = await createJournal(orgSlug, journalInput());

    const [row] = await admin`
      select kind, currency, amount_minor, base_amount_minor, category_id, description
      from transactions where id = ${id}
    `;
    expect(row.kind).toBe('journal');
    expect(row.currency).toBe('MYR');
    expect(row.amount_minor).toBe('15000');
    expect(row.base_amount_minor).toBe('15000');
    expect(row.category_id).toBeNull();
    expect(row.description).toBe('Unsorted counter deposit');
  });

  it('writes an audit entry recording both account codes', async () => {
    currentUserId = ownerId;
    const { id } = await createJournal(orgSlug, journalInput());

    const [row] = await admin`
      select after from audit_logs
      where entity_id = ${id} and action = 'transaction.created'
    `;
    expect(row.after).toMatchObject({ kind: 'journal' });

    // 科目代码从 after.debitAccount / after.creditAccount 搬到了每一条分录
    // 行上（after.lines[].accountCode），四种 kind 一视同仁，不再只有手工
    // 凭证才有。借方永远是第一行——见 templateFor。
    const after = row.after as { lines: { accountCode: string; direction: string }[] };
    expect(after.lines).toHaveLength(2);
    expect(after.lines[0]).toMatchObject({ direction: 'debit', accountCode: 'cash' });
    expect(after.lines[1]).toMatchObject({ direction: 'credit', accountCode: 'suspense' });
  });
});

describe('createJournal - offline idempotency', () => {
  // This is the dedupe path that Critical 1 makes live: createJournal used
  // to mint its own clientUuid server-side on every call, so this lookup
  // could never hit and a lost response + resubmit always posted twice.
  it('returns the existing record when the same client uuid is submitted twice', async () => {
    currentUserId = ownerId;
    const input = journalInput();

    const first = await createJournal(orgSlug, input);
    const second = await createJournal(orgSlug, input);

    expect(second.id).toBe(first.id);
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);

    const rows = await admin`
      select id from transactions
      where organization_id = ${orgId} and client_uuid = ${input.clientUuid}
    `;
    expect(rows).toHaveLength(1);
  });

  it('does not write a second audit entry or a second pair of lines for a deduplicated submission', async () => {
    currentUserId = ownerId;
    const input = journalInput();

    const { id } = await createJournal(orgSlug, input);
    await createJournal(orgSlug, input);

    const auditRows = await admin`
      select id from audit_logs where entity_id = ${id} and action = 'transaction.created'
    `;
    expect(auditRows).toHaveLength(1);

    const lineRows = await admin`select id from journal_lines where transaction_id = ${id}`;
    expect(lineRows).toHaveLength(2);
  });

  it('scopes the idempotency key per company', async () => {
    const otherOwner = await createTestUser(`test-other-jnl-${suffix}@example.com`, 'Other');
    const other = await createTestOrgWithSeed(
      otherOwner,
      'Other Journal Co',
      `other-journal-${suffix}`,
      'MYR',
    );

    const shared = randomUUID();

    currentUserId = ownerId;
    const mine = await createJournal(orgSlug, journalInput({ clientUuid: shared }));

    currentUserId = otherOwner;
    const theirs = await createJournal(other.slug, {
      occurredOn: DAY,
      amount: '10.00',
      debitAccountId: other.accountsByCode.cash,
      creditAccountId: other.accountsByCode.suspense,
      description: 'Theirs',
      clientUuid: shared,
    });

    expect(theirs.id).not.toBe(mine.id);
    expect(theirs.deduplicated).toBe(false);
  });
});

describe('createJournal - validation', () => {
  it('rejects the same account for debit and credit', async () => {
    currentUserId = ownerId;
    await expect(
      createJournal(
        orgSlug,
        journalInput({ debitAccountId: cashAccountId, creditAccountId: cashAccountId }),
      ),
    ).rejects.toThrow(/different accounts/i);
  });

  it('rejects an unknown debit account', async () => {
    currentUserId = ownerId;
    await expect(
      createJournal(orgSlug, journalInput({ debitAccountId: randomUUID() })),
    ).rejects.toThrow(/debit account was not found/i);
  });

  it('rejects an unknown credit account', async () => {
    currentUserId = ownerId;
    await expect(
      createJournal(orgSlug, journalInput({ creditAccountId: randomUUID() })),
    ).rejects.toThrow(/credit account was not found/i);
  });

  it('rejects an account from another company the same user also owns', async () => {
    const other = await createTestOrgWithSeed(
      ownerId,
      'Another Journal Co',
      `another-journal-${suffix}`,
      'MYR',
    );

    currentUserId = ownerId;
    await expect(
      createJournal(orgSlug, journalInput({ creditAccountId: other.accountsByCode.suspense })),
    ).rejects.toThrow(/credit account was not found/i);
  });

  it('rejects an archived account', async () => {
    await admin`update accounts set is_active = false where id = ${suspenseAccountId}`;

    currentUserId = ownerId;
    await expect(createJournal(orgSlug, journalInput())).rejects.toThrow(/archived/i);

    await admin`update accounts set is_active = true where id = ${suspenseAccountId}`;
  });

  it('rejects a zero or negative amount', async () => {
    currentUserId = ownerId;
    await expect(createJournal(orgSlug, journalInput({ amount: '0.00' }))).rejects.toThrow();
    await expect(createJournal(orgSlug, journalInput({ amount: '-5.00' }))).rejects.toThrow();
  });

  it('leaves nothing behind when the write fails partway', async () => {
    // 同一 clientUuid 先被账面记录占用后，同名再入会走 dedupe 分支而不会
    // 触发失败；这里用一个必然会在写入表头之后失败的输入（借贷方相同）
    // 来验证整条路径确实包在一个事务里。
    currentUserId = ownerId;
    const input = journalInput({
      debitAccountId: cashAccountId,
      creditAccountId: cashAccountId,
      clientUuid: randomUUID(),
    });

    await expect(createJournal(orgSlug, input)).rejects.toThrow();

    const rows = await admin`
      select id from transactions
      where organization_id = ${orgId} and client_uuid = ${input.clientUuid}
    `;
    expect(rows).toHaveLength(0);
  });
});

describe('getTransactionDetail - lines carry account names for read-only display', () => {
  // The uncertain queue's detail page (transactions/[id]/page.tsx) renders a
  // read-only view of a journal entry instead of the broken editable form
  // (kind 'journal' can never save through updateTransaction). That view
  // needs the debit/credit account *names*, not just their codes, so this
  // pins down that getTransactionDetail's lines actually carry them.
  it('includes accountNameEn/accountNameZh alongside accountCode on each line', async () => {
    currentUserId = ownerId;
    const { id } = await createJournal(
      orgSlug,
      journalInput({ debitAccountId: cashAccountId, creditAccountId: suspenseAccountId }),
    );

    const detail = await withTransaction(ownerId, (tx) => getTransactionDetail(tx, orgId, id));

    const debitLine = detail.lines.find((line) => line.direction === 'debit');
    const creditLine = detail.lines.find((line) => line.direction === 'credit');

    expect(debitLine?.accountCode).toBe('cash');
    expect(debitLine?.accountNameEn).toBeTruthy();
    expect(creditLine?.accountCode).toBe('suspense');
    expect(creditLine?.accountNameEn).toBeTruthy();
  });
});

describe('createJournal - permissions and locking', () => {
  it('blocks a viewer from creating journal entries', async () => {
    currentUserId = viewerId;
    await expect(createJournal(orgSlug, journalInput())).rejects.toThrow(/forbidden|cannot/i);
  });

  it('blocks an unauthenticated caller', async () => {
    currentUserId = null;
    await expect(createJournal(orgSlug, journalInput())).rejects.toThrow();
  });

  it('refuses a date inside a locked period but allows one after it', async () => {
    await admin`update organizations set locked_until = '2026-08-31' where id = ${orgId}`;

    currentUserId = ownerId;
    await expect(
      createJournal(orgSlug, journalInput({ occurredOn: '2026-08-15' })),
    ).rejects.toThrow(/locked/i);

    await expect(
      createJournal(orgSlug, journalInput({ occurredOn: '2026-09-06' })),
    ).resolves.toBeTruthy();

    await admin`update organizations set locked_until = null where id = ${orgId}`;
  });
});
