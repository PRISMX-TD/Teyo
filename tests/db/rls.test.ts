import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { config } from 'dotenv';

config({ path: '.env.local' });

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for db integration tests.');

// admin 连接用于造数据（postgres 拥有 BYPASSRLS，不受策略约束）。
//
// 注意：计划里写的 `connection: { role: 'teyo_app' }` 在 Supabase pooler 上会被
// 静默忽略——实测连上去仍是 postgres 且 rolbypassrls=true，等于完全不受策略约束，
// 测试会全部假通过。唯一可靠的方式是在每个事务里显式 `set local role teyo_app`。
const admin = postgres(url, { max: 1, onnotice: () => {} });
const app = postgres(url, { max: 1, onnotice: () => {} });

const RUN = Date.now().toString(36);

let orgA: string;
let orgB: string;
let aliceId: string;
let bobId: string;
const extraUsers: string[] = [];

async function createUser(email: string, name: string): Promise<string> {
  const [row] = await admin`
    insert into auth.users (id, email)
    values (gen_random_uuid(), ${email})
    returning id
  `;
  await admin`
    insert into app_users (id, email, display_name)
    values (${row.id}, ${email}, ${name})
  `;
  return row.id as string;
}

/**
 * 以指定用户身份在受 RLS 约束的事务里执行。
 * 先切成 teyo_app（无 BYPASSRLS），再设置 app.user_id 供策略函数读取。
 */
// postgres.js 的 begin() 返回 UnwrapPromiseArray<T>，与裸 T 不兼容，
// 因此这里用 unknown 承接再由调用方断言，避免泛型不匹配。
async function asUser<T>(
  userId: string,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  const result = await app.begin(async (tx) => {
    await tx`set local role teyo_app`;
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return (await fn(tx)) as unknown as never;
  });
  return result as unknown as T;
}

/** 不带用户上下文、但同样受 RLS 约束的事务 */
async function asAnonymous<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  const result = await app.begin(async (tx) => {
    await tx`set local role teyo_app`;
    return (await fn(tx)) as unknown as never;
  });
  return result as unknown as T;
}

beforeAll(async () => {
  aliceId = await createUser(`alice-${RUN}@example.com`, 'Alice');
  bobId = await createUser(`bob-${RUN}@example.com`, 'Bob');

  const [a] = await admin`
    insert into organizations (name, slug, base_currency, created_by)
    values ('Org A', ${'org-a-' + RUN}, 'MYR', ${aliceId})
    returning id
  `;
  const [b] = await admin`
    insert into organizations (name, slug, base_currency, created_by)
    values ('Org B', ${'org-b-' + RUN}, 'SGD', ${bobId})
    returning id
  `;
  orgA = a.id;
  orgB = b.id;

  await admin`
    insert into memberships (user_id, organization_id, role)
    values (${aliceId}, ${orgA}, 'owner'), (${bobId}, ${orgB}, 'owner')
  `;

  // 两家公司各有一个资金账户与一笔交易
  for (const [org, owner] of [
    [orgA, aliceId],
    [orgB, bobId],
  ] as const) {
    const [cash] = await admin`
      insert into accounts (organization_id, code, name_en, type, is_money_account, is_system)
      values (${org}, '1000', 'Cash', 'asset', true, true)
      returning id
    `;
    const [sales] = await admin`
      insert into accounts (organization_id, code, name_en, type, is_system)
      values (${org}, '4000', 'Sales', 'revenue', true)
      returning id
    `;
    const [category] = await admin`
      insert into categories (organization_id, name_en, kind, account_id)
      values (${org}, 'Sales', 'income', ${sales.id})
      returning id
    `;
    await admin.begin(async (tx) => {
      const [txn] = await tx`
        insert into transactions
          (organization_id, kind, occurred_on, currency, amount_minor,
           base_amount_minor, exchange_rate, category_id, created_by, client_uuid)
        values (${org}, 'income', '2026-03-01', 'MYR', 10000, 10000, 1,
                ${category.id}, ${owner}, gen_random_uuid())
        returning id
      `;
      await tx`
        insert into journal_lines
          (transaction_id, organization_id, account_id, direction, amount_minor, base_amount_minor)
        values
          (${txn.id}, ${org}, ${cash.id}, 'debit', 10000, 10000),
          (${txn.id}, ${org}, ${sales.id}, 'credit', 10000, 10000)
      `;
    });
  }
});

afterAll(async () => {
  // 先删组织（级联清掉交易/分录/科目/审计），再删用户
  await admin`delete from organizations where id in (${orgA}, ${orgB})`;
  for (const id of [aliceId, bobId, ...extraUsers]) {
    await admin`delete from auth.users where id = ${id}`;
  }
  await admin.end();
  await app.end();
});

describe('cross-organization isolation', () => {
  it('lets a member read only their own organization', async () => {
    const rows = await asUser(aliceId, (tx) => tx`select id from organizations`);
    expect(rows.map((r) => r.id)).toEqual([orgA]);
  });

  it('hides another organization transactions', async () => {
    const rows = await asUser(aliceId, (tx) => tx`select id from transactions`);
    expect(rows).toHaveLength(1);

    const foreign = await asUser(
      aliceId,
      (tx) => tx`select id from transactions where organization_id = ${orgB}`,
    );
    expect(foreign).toHaveLength(0);
  });

  it('hides another organization journal lines and accounts', async () => {
    const lines = await asUser(
      aliceId,
      (tx) => tx`select id from journal_lines where organization_id = ${orgB}`,
    );
    expect(lines).toHaveLength(0);

    const accounts = await asUser(
      aliceId,
      (tx) => tx`select id from accounts where organization_id = ${orgB}`,
    );
    expect(accounts).toHaveLength(0);
  });

  it('blocks writing into another organization', async () => {
    await expect(
      asUser(
        aliceId,
        (tx) => tx`
          insert into accounts (organization_id, code, name_en, type)
          values (${orgB}, '9999', 'Injected', 'expense')
        `,
      ),
    ).rejects.toThrow();
  });

  it('blocks updating another organization records', async () => {
    const result = await asUser(
      aliceId,
      (tx) => tx`update transactions set description = 'hacked' where organization_id = ${orgB}`,
    );
    expect(result.count).toBe(0);
  });

  it('returns nothing when no user context is set', async () => {
    const rows = await asAnonymous((tx) => tx`select id from organizations`);
    expect(rows).toHaveLength(0);
  });

  it('actually runs as a role that cannot bypass RLS', async () => {
    // 这条是元测试：如果角色切换失效，上面所有隔离断言都会变成假通过。
    const [row] = await asUser(
      aliceId,
      (tx) => tx`
        select current_user as role,
               (select rolbypassrls from pg_roles where rolname = current_user) as bypass
      `,
    );
    expect(row.role).toBe('teyo_app');
    expect(row.bypass).toBe(false);
  });
});

describe('audit log immutability', () => {
  it('allows insert and select but rejects update and delete', async () => {
    await asUser(
      aliceId,
      (tx) => tx`
        insert into audit_logs (organization_id, actor_user_id, action, entity_type, entity_id)
        values (${orgA}, ${aliceId}, 'transaction.create', 'transaction', gen_random_uuid())
      `,
    );

    const rows = await asUser(aliceId, (tx) => tx`select id from audit_logs`);
    expect(rows.length).toBeGreaterThan(0);

    await expect(
      asUser(aliceId, (tx) => tx`update audit_logs set action = 'tampered'`),
    ).rejects.toThrow();

    await expect(asUser(aliceId, (tx) => tx`delete from audit_logs`)).rejects.toThrow();
  });

  it('hides the audit log from a bookkeeper', async () => {
    const carolId = await createUser(`carol-${RUN}@example.com`, 'Carol');
    extraUsers.push(carolId);
    await admin`
      insert into memberships (user_id, organization_id, role)
      values (${carolId}, ${orgA}, 'bookkeeper')
    `;

    const rows = await asUser(carolId, (tx) => tx`select id from audit_logs`);
    expect(rows).toHaveLength(0);
  });
});

describe('role enforcement at the database layer', () => {
  it('stops a bookkeeper from editing someone else record', async () => {
    const daveId = await createUser(`dave-${RUN}@example.com`, 'Dave');
    extraUsers.push(daveId);
    await admin`
      insert into memberships (user_id, organization_id, role)
      values (${daveId}, ${orgA}, 'bookkeeper')
    `;

    // Alice 创建的记录，Dave 改不动
    const result = await asUser(
      daveId,
      (tx) => tx`update transactions set description = 'edited' where created_by = ${aliceId}`,
    );
    expect(result.count).toBe(0);
  });

  it('stops a viewer from inserting transactions', async () => {
    const evaId = await createUser(`eva-${RUN}@example.com`, 'Eva');
    extraUsers.push(evaId);
    await admin`
      insert into memberships (user_id, organization_id, role)
      values (${evaId}, ${orgA}, 'viewer')
    `;

    const [cash] = await admin`
      select id from accounts where organization_id = ${orgA} and is_money_account limit 1
    `;
    expect(cash).toBeTruthy();

    await expect(
      asUser(
        evaId,
        (tx) => tx`
          insert into transactions
            (organization_id, kind, occurred_on, currency, amount_minor,
             base_amount_minor, exchange_rate, created_by, client_uuid)
          values (${orgA}, 'transfer', '2026-03-02', 'MYR', 100, 100, 1,
                  ${evaId}, gen_random_uuid())
        `,
      ),
    ).rejects.toThrow();
  });

  it('stops a suspended member from reading anything', async () => {
    const frankId = await createUser(`frank-${RUN}@example.com`, 'Frank');
    extraUsers.push(frankId);
    await admin`
      insert into memberships (user_id, organization_id, role, status)
      values (${frankId}, ${orgA}, 'admin', 'suspended')
    `;

    const rows = await asUser(frankId, (tx) => tx`select id from transactions`);
    expect(rows).toHaveLength(0);
  });

  // 回归：onboarding 曾在建公司后直接 seed 而没写 owner membership，
  // accounts_write 策略因此拒绝插入，线上表现为创建公司后 500。
  // 建公司的流程必须在同一事务里先写 membership，再 seed。
  it('rejects account inserts by a creator who has no membership yet', async () => {
    const graceId = await createUser(`grace-${RUN}@example.com`, 'Grace');
    extraUsers.push(graceId);

    await expect(
      asUser(graceId, async (tx) => {
        const [org] = await tx`
          insert into organizations (name, slug, base_currency, timezone, created_by)
          values ('No Membership Co', ${`no-membership-${RUN}`}, 'MYR',
                  'Asia/Kuala_Lumpur', ${graceId})
          returning id
        `;

        // 故意跳过 membership，直接 seed
        return tx`
          insert into accounts (organization_id, code, name_en, name_zh, type,
                                is_money_account, is_system, sort_order)
          values (${org.id}, 'cash', 'Cash', '现金', 'asset', true, true, 10)
        `;
      }),
    ).rejects.toThrow(/row-level security/i);
  });
});
