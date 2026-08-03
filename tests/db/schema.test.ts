import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { config } from 'dotenv';

config({ path: '.env.local' });

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for db integration tests.');

const sql = postgres(url, { max: 2, onnotice: () => {} });

// 每次运行用唯一后缀，避免云端库上重复运行时 slug / email 撞唯一约束
const RUN = Date.now().toString(36);

let userId: string;
let orgId: string;
let bankId: string;
let salesId: string;

beforeAll(async () => {
  const [authUser] = await sql`
    insert into auth.users (id, email)
    values (gen_random_uuid(), ${`schema-${RUN}@teyo.test`})
    returning id
  `;
  userId = authUser.id;

  await sql`
    insert into app_users (id, email, display_name)
    values (${userId}, ${`schema-${RUN}@teyo.test`}, 'Schema Test')
  `;

  const [org] = await sql`
    insert into organizations (name, slug, base_currency, created_by)
    values ('Schema Test Sdn Bhd', ${`schema-test-${RUN}`}, 'MYR', ${userId})
    returning id
  `;
  orgId = org.id;

  const [bank] = await sql`
    insert into accounts (organization_id, code, name_en, type, is_money_account)
    values (${orgId}, '1010', 'Bank', 'asset', true)
    returning id
  `;
  bankId = bank.id;

  const [sales] = await sql`
    insert into accounts (organization_id, code, name_en, type)
    values (${orgId}, '4010', 'Sales', 'revenue')
    returning id
  `;
  salesId = sales.id;
});

afterAll(async () => {
  // organizations 级联删除会带走 accounts/categories/transactions/journal_lines
  await sql`delete from organizations where id = ${orgId}`;
  await sql`delete from auth.users where id = ${userId}`;
  await sql.end();
});

async function insertTransaction(
  tx: postgres.TransactionSql,
  categoryId: string | null = null,
) {
  const [row] = await tx`
    insert into transactions (
      organization_id, kind, occurred_on, currency, amount_minor,
      base_amount_minor, exchange_rate, category_id, created_by, client_uuid
    )
    values (
      ${orgId}, 'transfer', '2026-01-15', 'MYR', 50000,
      50000, 1, ${categoryId}, ${userId}, gen_random_uuid()
    )
    returning id
  `;
  return row.id as string;
}

describe('journal balance trigger', () => {
  it('accepts a balanced transaction', async () => {
    await sql.begin(async (tx) => {
      const txId = await insertTransaction(tx);
      await tx`
        insert into journal_lines (transaction_id, organization_id, account_id, direction, amount_minor, base_amount_minor)
        values
          (${txId}, ${orgId}, ${bankId}, 'debit', 50000, 50000),
          (${txId}, ${orgId}, ${salesId}, 'credit', 50000, 50000)
      `;
    });

    const [{ count }] =
      await sql`select count(*)::int as count from transactions where organization_id = ${orgId}`;
    expect(count).toBeGreaterThan(0);
  });

  it('rejects an unbalanced transaction at commit time', async () => {
    await expect(
      sql.begin(async (tx) => {
        const txId = await insertTransaction(tx);
        await tx`
          insert into journal_lines (transaction_id, organization_id, account_id, direction, amount_minor, base_amount_minor)
          values
            (${txId}, ${orgId}, ${bankId}, 'debit', 50000, 50000),
            (${txId}, ${orgId}, ${salesId}, 'credit', 49999, 49999)
        `;
      }),
    ).rejects.toThrow(/unbalanced/i);
  });

  it('rejects a transaction with no journal lines', async () => {
    await expect(
      sql.begin(async (tx) => {
        const txId = await insertTransaction(tx);
        // 触发器只在 journal_lines 上，光插交易不会触发校验；
        // 因此插一条再删掉，让删除动作触发「没有分录」的检查。
        const [row] = await tx`
          insert into journal_lines (transaction_id, organization_id, account_id, direction, amount_minor, base_amount_minor)
          values (${txId}, ${orgId}, ${bankId}, 'debit', 1, 1)
          returning id
        `;
        await tx`delete from journal_lines where id = ${row.id}`;
      }),
    ).rejects.toThrow(/no journal lines/i);
  });

  it('rejects lines that balance in original currency but not in base currency', async () => {
    await expect(
      sql.begin(async (tx) => {
        const txId = await insertTransaction(tx);
        await tx`
          insert into journal_lines (transaction_id, organization_id, account_id, direction, amount_minor, base_amount_minor)
          values
            (${txId}, ${orgId}, ${bankId}, 'debit', 50000, 50000),
            (${txId}, ${orgId}, ${salesId}, 'credit', 50000, 49000)
        `;
      }),
    ).rejects.toThrow(/base currency/i);
  });
});

describe('schema constraints', () => {
  it('allows only one owner per organization', async () => {
    const email = `second-owner-${RUN}@teyo.test`;
    const [second] = await sql`
      insert into auth.users (id, email) values (gen_random_uuid(), ${email}) returning id
    `;
    await sql`insert into app_users (id, email, display_name) values (${second.id}, ${email}, 'Second')`;

    await sql`insert into memberships (user_id, organization_id, role) values (${userId}, ${orgId}, 'owner')`;

    await expect(
      sql`insert into memberships (user_id, organization_id, role) values (${second.id}, ${orgId}, 'owner')`,
    ).rejects.toThrow();

    await sql`delete from memberships where organization_id = ${orgId}`;
    await sql`delete from auth.users where id = ${second.id}`;
  });

  it('requires a category for income and expense but forbids it for transfer', async () => {
    const [category] = await sql`
      insert into categories (organization_id, name_en, kind, account_id)
      values (${orgId}, 'Sales', 'income', ${salesId})
      returning id
    `;

    await expect(
      sql`
        insert into transactions (organization_id, kind, occurred_on, currency, amount_minor,
          base_amount_minor, exchange_rate, category_id, created_by, client_uuid)
        values (${orgId}, 'income', '2026-01-15', 'MYR', 100, 100, 1, null, ${userId}, gen_random_uuid())
      `,
    ).rejects.toThrow();

    await expect(
      sql`
        insert into transactions (organization_id, kind, occurred_on, currency, amount_minor,
          base_amount_minor, exchange_rate, category_id, created_by, client_uuid)
        values (${orgId}, 'transfer', '2026-01-15', 'MYR', 100, 100, 1, ${category.id}, ${userId}, gen_random_uuid())
      `,
    ).rejects.toThrow();
  });

  it('rejects a money account that is not an asset', async () => {
    await expect(
      sql`
        insert into accounts (organization_id, code, name_en, type, is_money_account)
        values (${orgId}, '9999', 'Bad Money Account', 'expense', true)
      `,
    ).rejects.toThrow();
  });

  it('enforces client_uuid idempotency per organization', async () => {
    const shared = '11111111-1111-1111-1111-111111111111';
    await sql.begin(async (tx) => {
      const [row] = await tx`
        insert into transactions (organization_id, kind, occurred_on, currency, amount_minor,
          base_amount_minor, exchange_rate, created_by, client_uuid)
        values (${orgId}, 'transfer', '2026-02-01', 'MYR', 700, 700, 1, ${userId}, ${shared})
        returning id
      `;
      await tx`
        insert into journal_lines (transaction_id, organization_id, account_id, direction, amount_minor, base_amount_minor)
        values (${row.id}, ${orgId}, ${bankId}, 'debit', 700, 700),
               (${row.id}, ${orgId}, ${salesId}, 'credit', 700, 700)
      `;
    });

    await expect(
      sql`
        insert into transactions (organization_id, kind, occurred_on, currency, amount_minor,
          base_amount_minor, exchange_rate, created_by, client_uuid)
        values (${orgId}, 'transfer', '2026-02-02', 'MYR', 800, 800, 1, ${userId}, ${shared})
      `,
    ).rejects.toThrow();
  });

  it('requires void reason when voiding', async () => {
    await expect(
      sql`
        update transactions
        set voided_at = now(), voided_by = ${userId}, void_reason = ''
        where organization_id = ${orgId}
      `,
    ).rejects.toThrow();
  });
});
