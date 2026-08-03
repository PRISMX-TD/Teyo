import { randomUUID } from 'node:crypto';
import { admin } from '@/tests/helpers/db';
import { withTransaction } from '@/server/db/transaction';
import { SEED_ACCOUNTS, SEED_CATEGORIES, seedChartOfAccounts } from '@/server/services/account-seed';

// 本模块创建的对象 id，resetTestData 只清理这些。
const createdUserIds = new Set<string>();
const createdOrgIds = new Set<string>();
const seededRateKeys: Array<{ base: string; quote: string; date: string }> = [];

/**
 * 清理本文件创建的测试数据。
 *
 * 不能按 email 通配删除（比如 `like 'test-%@example.com'`）：vitest 并行跑
 * 多个测试文件，tests/helpers/db.ts 生成的 email 也是同样的形状，通配删除会
 * 把别的测试文件正在用的用户删掉，导致 app_users_id_fkey 违反这种莫名其妙的
 * 跨文件失败。只删自己登记过的 id 才是并行安全的。
 *
 * 也不用 `truncate ... cascade`：app_users.id 外键指向 auth.users，
 * truncate app_users 不会连带清掉 auth.users，会堆积孤儿账号。
 *
 * 顺序不能反：organizations.created_by 指向 app_users 且不是 on delete cascade，
 * 先删用户会撞 organizations_created_by_fkey。必须先删公司（级联清掉交易、
 * 分录、审计），再删用户。
 */
export async function resetTestData(): Promise<void> {
  for (const rate of seededRateKeys) {
    await admin`
      delete from exchange_rates
      where base_currency = ${rate.base} and quote_currency = ${rate.quote}
        and rate_date = ${rate.date} and source = 'test'
    `;
  }
  seededRateKeys.length = 0;

  if (createdOrgIds.size > 0) {
    await admin`delete from organizations where id = any(${[...createdOrgIds]})`;
    createdOrgIds.clear();
  }
  if (createdUserIds.size > 0) {
    await admin`delete from auth.users where id = any(${[...createdUserIds]})`;
    createdUserIds.clear();
  }
}

/**
 * 建测试用户。auth.users 由 Supabase Auth 管理，测试里插一条最小可用记录，
 * 再插 app_users（其 id 外键指向 auth.users）。
 */
export async function createTestUser(email: string, displayName: string): Promise<string> {
  const id = randomUUID();
  createdUserIds.add(id);
  await admin`
    insert into auth.users (id, email, encrypted_password, email_confirmed_at,
                            aud, role, raw_app_meta_data, raw_user_meta_data,
                            created_at, updated_at)
    values (${id}, ${email}, 'test-not-a-real-hash', now(),
            'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, now(), now())
  `;
  await admin`
    insert into app_users (id, email, display_name)
    values (${id}, ${email}, ${displayName})
  `;
  return id;
}

/** 建公司但不生成预置科目。 */
export async function createTestOrg(
  ownerId: string,
  name: string,
  slug: string,
  baseCurrency = 'MYR',
): Promise<string> {
  const [org] = await admin`
    insert into organizations (name, slug, base_currency, created_by)
    values (${name}, ${slug}, ${baseCurrency}, ${ownerId})
    returning id
  `;
  createdOrgIds.add(org.id as string);
  await admin`
    insert into memberships (user_id, organization_id, role, status)
    values (${ownerId}, ${org.id}, 'owner', 'active')
  `;
  return org.id as string;
}

export type SeededOrg = {
  id: string;
  slug: string;
  accountsByCode: Record<string, string>;
  categoriesByAccountCode: Record<string, string>;
};

/** 建公司并生成完整预置科目与分类，返回便于测试引用的 id 映射。 */
export async function createTestOrgWithSeed(
  ownerId: string,
  name: string,
  slug: string,
  baseCurrency = 'MYR',
): Promise<SeededOrg> {
  const id = await createTestOrg(ownerId, name, slug, baseCurrency);

  await withTransaction(ownerId, (tx) => seedChartOfAccounts(tx, id));

  const accounts = await admin`select id, code from accounts where organization_id = ${id}`;
  const accountsByCode: Record<string, string> = {};
  for (const row of accounts) accountsByCode[row.code as string] = row.id as string;

  const categories = await admin`
    select c.id, a.code
    from categories c join accounts a on a.id = c.account_id
    where c.organization_id = ${id}
  `;
  const categoriesByAccountCode: Record<string, string> = {};
  for (const row of categories) categoriesByAccountCode[row.code as string] = row.id as string;

  // seed 缺失会让后续断言给出误导性的失败原因，这里直接判死。
  if (Object.keys(accountsByCode).length !== SEED_ACCOUNTS.length) {
    throw new Error('seedChartOfAccounts did not create the expected number of accounts');
  }
  if (Object.keys(categoriesByAccountCode).length === 0 && SEED_CATEGORIES.length > 0) {
    throw new Error('seedChartOfAccounts did not create categories');
  }

  return { id, slug, accountsByCode, categoriesByAccountCode };
}

export async function joinOrg(
  userId: string,
  organizationId: string,
  role: 'admin' | 'bookkeeper' | 'viewer',
): Promise<string> {
  const [row] = await admin`
    insert into memberships (user_id, organization_id, role, status)
    values (${userId}, ${organizationId}, ${role}, 'active')
    returning id
  `;
  return row.id as string;
}

/**
 * 写入一条测试汇率。source 固定为 'test'，避免清理时误删 Cron 同步的真实汇率。
 * 传入的是放大 10^8 的 bigint，转十进制字符串时不经 Number，避免浮点误差。
 */
export async function seedRate(
  base: string,
  quote: string,
  scaledRate: bigint,
  rateDate: string,
): Promise<void> {
  seededRateKeys.push({ base, quote, date: rateDate });
  const digits = scaledRate.toString().padStart(9, '0');
  const decimal = `${digits.slice(0, digits.length - 8)}.${digits.slice(digits.length - 8)}`;

  await admin`
    insert into exchange_rates (base_currency, quote_currency, rate, rate_date, source)
    values (${base}, ${quote}, ${decimal}, ${rateDate}, 'test')
    on conflict (base_currency, quote_currency, rate_date)
      do update set rate = excluded.rate, source = 'test'
  `;
}
