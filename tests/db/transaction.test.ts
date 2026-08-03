import { afterAll, describe, expect, it } from 'vitest';
import { sql } from '@/server/db/client';
import { withTransaction, withoutUserContext } from '@/server/db/transaction';

const TEST_UUID = '00000000-0000-4000-8000-000000000abc';

afterAll(async () => {
  await sql.end();
});

describe('withTransaction', () => {
  it('sets the app.user_id context for the duration of the transaction', async () => {
    const [row] = await withTransaction(
      TEST_UUID,
      (tx) => tx`select app_current_user_id() as id`,
    );
    expect(row.id).toBe(TEST_UUID);
  });

  it('runs as teyo_app so that RLS cannot be bypassed', async () => {
    // 元测试：连接默认是 postgres（BYPASSRLS），若没切角色，所有策略都形同虚设。
    const [row] = await withTransaction(
      TEST_UUID,
      (tx) => tx`
        select current_user as role,
               (select rolbypassrls from pg_roles where rolname = current_user) as bypass
      `,
    );
    expect(row.role).toBe('teyo_app');
    expect(row.bypass).toBe(false);
  });

  it('clears the context outside the transaction', async () => {
    await withTransaction(TEST_UUID, (tx) => tx`select 1`);
    const [row] = await sql`select app_current_user_id() as id`;
    expect(row.id).toBeNull();
  });

  it('restores the original role outside the transaction', async () => {
    await withTransaction(TEST_UUID, (tx) => tx`select 1`);
    const [row] = await sql`select current_user as role`;
    expect(row.role).not.toBe('teyo_app');
  });

  it('returns the callback result', async () => {
    const result = await withTransaction(TEST_UUID, async () => 'done');
    expect(result).toBe('done');
  });

  it('rolls back every write when the callback throws', async () => {
    const slug = `rollback-${Date.now()}`;
    const email = `${slug}@teyo.test`;

    // app_users.id 外键指向 auth.users，因此先用不受 RLS 约束的连接建好真实用户，
    // 保证事务里唯一的失败原因是 fn 抛出的 boom，而不是外键冲突。
    const [authUser] = await sql`
      insert into auth.users (id, email) values (gen_random_uuid(), ${email}) returning id
    `;
    await sql`
      insert into app_users (id, email, display_name)
      values (${authUser.id}, ${email}, 'Rollback')
    `;
    // organizations_insert 策略要求 created_by = app_current_user_id()
    const ownerId = authUser.id as string;

    await expect(
      withTransaction(ownerId, async (tx) => {
        await tx`
          insert into organizations (name, slug, base_currency, created_by)
          values ('Rollback Co', ${slug}, 'MYR', ${ownerId})
        `;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const rows = await sql`select id from organizations where slug = ${slug}`;
    expect(rows).toHaveLength(0);

    await sql`delete from auth.users where id = ${ownerId}`;
  });

  it('rejects a malformed user id instead of silently running unscoped', async () => {
    await expect(withTransaction('not-a-uuid', (tx) => tx`select 1`)).rejects.toThrow();
  });

  it('rejects a user id that tries to inject sql', async () => {
    await expect(
      withTransaction("' or true --", (tx) => tx`select 1`),
    ).rejects.toThrow();
  });
});

describe('withoutUserContext', () => {
  it('runs without any user context', async () => {
    const [row] = await withoutUserContext((tx) => tx`select app_current_user_id() as id`);
    expect(row.id).toBeNull();
  });

  it('can write global exchange rates that RLS grants no policy for', async () => {
    // exchange_rates 只有读策略，写入必须绕过 RLS；
    // 这条测试锁定「withoutUserContext 不切 teyo_app」这个刻意的设计。
    const day = '1999-01-04';
    await withoutUserContext(
      (tx) => tx`
        insert into exchange_rates (base_currency, quote_currency, rate, rate_date, source)
        values ('MYR', 'SGD', 0.3, ${day}, 'test')
        on conflict (base_currency, quote_currency, rate_date) do update set rate = excluded.rate
      `,
    );

    const rows = await sql`
      select rate from exchange_rates
      where base_currency = 'MYR' and quote_currency = 'SGD' and rate_date = ${day}
    `;
    expect(rows).toHaveLength(1);

    await sql`
      delete from exchange_rates
      where base_currency = 'MYR' and quote_currency = 'SGD' and rate_date = ${day}
    `;
  });
});
