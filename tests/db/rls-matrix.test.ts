import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin } from '@/tests/helpers/db';
import { withTransaction, type Tx } from '@/server/db/transaction';
import {
  ROLES,
  ROW_LEVEL_TABLES,
  TABLE_ACCESS,
  rolesFor,
  type Command,
  type Role,
} from '@/server/domain/permissions';

/**
 * RLS 一致性矩阵：22 张表 × 4 角色 × 增删改查。
 *
 * 总纲设计文档 §10 把这条列为合并门槛，但此前没有落地——tests/db/rls.test.ts
 * 只有 13 个用例，且一条都没碰 0008/0009 建的那 22 张表。
 *
 * ============================================================
 * 这个文件为什么这么写
 * ============================================================
 * 1. 角色切换必须在事务内显式做。
 *    postgres.js 的 `connection: { role: 'teyo_app' }` 在 Supabase pooler 上会被
 *    静默忽略（见 server/db/client.ts 与 tests/db/rls.test.ts 顶部的注释）：
 *    连上去仍然是 postgres，rolbypassrls = true，策略等于不存在，整个文件会
 *    全绿而什么都没测。所以这里所有探针都走 withTransaction——那是应用自己
 *    用的同一条路径，它每次都 `set local role teyo_app`。
 *    下面第一个 describe 就是重复 rls.test.ts:194 的那条元测试，
 *    它必须最先跑：它红了，后面 352 条断言的绿色一文不值。
 *
 * 2. 表清单从 pg_class 动态取，不手写。
 *    手写清单会在下一次加表时悄悄漏掉。这里的做法是：库里每一张启用了 RLS
 *    的表，必须出现在 TABLE_ACCESS 或 ROW_LEVEL_TABLES 之一，否则当场变红。
 *
 * 3. 写探针全部在回滚的事务里跑。
 *    .env.local 的 DATABASE_URL 指向真实生产库。探针只碰本文件自己建的那家
 *    测试公司，而且 update/insert/delete 一律 savepoint + rollback，
 *    连自己建的种子数据都不改。
 *
 * ============================================================
 * 0022 执行之前，本文件会红
 * ============================================================
 * 这是它存在的理由，不是配置问题：
 *   - 0010 的 `for all` 策略让 viewer 也能 delete 这 22 张表
 *     → 全部 22 张表的 viewer/bookkeeper delete 断言失败
 *   - 0010 的 with check 只认 owner/admin
 *     → 单据表的 bookkeeper insert/update 断言失败
 * 跑完 0022 之后全绿。
 */

// ============================================================
// 判定规则
// ============================================================

type Outcome = { allowed: boolean; detail: string };

/**
 * 42501 = insufficient_privilege。PostgreSQL 的 RLS WITH CHECK 失败只报这一个码
 * （"new row violates row-level security policy"）。
 *
 * 另外两个码说明策略**已经放行**，是后面的约束拦下的：
 *   23505 唯一键——克隆种子行时业务单号撞车
 *   23503 外键——删一个还被引用的父行
 * 对「RLS 允不允许」这个问题而言，它们都算允许。后者尤其重要：删除探针在
 * 0022 之前会撞上立即检查的外键（contacts / invoices / bills / tax_rates /
 * projects / inventory_items 这六张表有子行引用），如果把 23503 也算成拒绝，
 * P0 那个洞就会被掩盖成「看起来挡住了」。
 *
 * 白名单而不是「不是 42501 就算允许」：第一版写成后者，结果 insert 探针因为
 * 一个与权限无关的 22023（参数绑定错误）对每一个角色都报「允许」——包括
 * 外人和停权成员——整组 insert 断言变成了噪音。任何不在名单上的错误一律
 * 原样抛出，让它以自己的面目失败。
 */
const RLS_DENIED = '42501';
const BLOCKED_AFTER_RLS = new Set(['23505', '23503']);

function classify(error: unknown): Outcome {
  const code = (error as { code?: string }).code ?? '';
  if (code === RLS_DENIED) return { allowed: false, detail: 'RLS 拒绝 42501' };
  if (BLOCKED_AFTER_RLS.has(code)) return { allowed: true, detail: `SQLSTATE ${code}` };
  throw error;
}

// ============================================================
// 事务外壳
// ============================================================

/** 用它把探针的结果带出一个必然回滚的事务。 */
class Rollback extends Error {
  constructor(readonly payload: unknown) {
    super('rollback');
    this.name = 'Rollback';
  }
}

async function asUserRollingBack<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    await withTransaction(userId, async (tx) => {
      throw new Rollback(await fn(tx));
    });
  } catch (error) {
    if (error instanceof Rollback) return error.payload as T;
    throw error;
  }
  throw new Error('unreachable: withTransaction 应当把 Rollback 原样抛出');
}

/**
 * 每条探针各占一个 savepoint 并无条件回滚。
 *
 * 不用一条探针一个事务：本机到 ap-southeast-1 一次往返约 20ms，
 * 88 组 × 4 条探针各开一个事务就是四千多次往返。savepoint 把它压回
 * 一组一个事务。无条件回滚（finally 里）而不是只在出错时回滚，
 * 是因为「探针成功了」恰恰是最需要撤销的情况。
 */
async function inSavepoint<T>(tx: Tx, name: string, fn: () => Promise<T>): Promise<T> {
  await tx.unsafe(`savepoint ${name}`);
  try {
    return await fn();
  } finally {
    await tx.unsafe(`rollback to savepoint ${name}`);
  }
}

// ============================================================
// 测试数据
// ============================================================

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];

let orgId = '';
let outsiderOrgId = '';
let outsiderId = '';
let suspendedId = '';
const userByRole: Record<Role, string> = {
  owner: '',
  admin: '',
  bookkeeper: '',
  viewer: '',
};

/** 每张表一行种子数据的主键。 */
const seedId: Record<string, string> = {};
/** 种子行的完整快照，insert 探针靠它克隆出一行合法数据。 */
const seedRow: Record<string, Record<string, unknown>> = {};

/**
 * 克隆时必须改掉的唯一键。不改的话合法角色的 insert 会以 23505 收场——
 * 那仍然会被判成「允许」，但就再也观察不到一次真正成功的插入了。
 */
let cloneCounter = 0;
function uniqueOverrides(table: string): Record<string, unknown> {
  cloneCounter += 1;
  const n = cloneCounter;
  switch (table) {
    case 'invoices':
      return { invoice_number: `RLSM-INV-${RUN}-${n}` };
    case 'bills':
      return { bill_number: `RLSM-BILL-${RUN}-${n}` };
    case 'credit_notes':
      return { cn_number: `RLSM-CN-${RUN}-${n}` };
    case 'purchase_orders':
      return { po_number: `RLSM-PO-${RUN}-${n}` };
    case 'inventory_items':
      return { sku: `RLSM-SKU-${RUN}-${n}` };
    case 'budgets':
      return { year: 2100 + (n % 50) };
    case 'depreciation_schedules':
      return { period: `2100-${String((n % 12) + 1).padStart(2, '0')}-01` };
    default:
      return {};
  }
}

async function createUser(label: string): Promise<string> {
  const id = randomUUID();
  const email = `rls-matrix-${label}-${RUN}@example.com`;
  createdUserIds.push(id);
  await admin`
    insert into auth.users (id, email, encrypted_password, email_confirmed_at, aud, role)
    values (${id}, ${email}, 'test-not-a-real-hash', now(), 'authenticated', 'authenticated')
  `;
  await admin`insert into app_users (id, email, display_name) values (${id}, ${email}, ${label})`;
  return id;
}

beforeAll(async () => {
  for (const role of ROLES) userByRole[role] = await createUser(role);
  outsiderId = await createUser('outsider');
  suspendedId = await createUser('suspended');

  const [org] = await admin`
    insert into organizations (name, slug, base_currency, created_by)
    values ('RLS Matrix Co', ${`rls-matrix-${RUN}`}, 'MYR', ${userByRole.owner})
    returning id
  `;
  orgId = org.id as string;
  createdOrgIds.push(orgId);

  const [other] = await admin`
    insert into organizations (name, slug, base_currency, created_by)
    values ('RLS Outsider Co', ${`rls-outsider-${RUN}`}, 'MYR', ${outsiderId})
    returning id
  `;
  outsiderOrgId = other.id as string;
  createdOrgIds.push(outsiderOrgId);

  for (const role of ROLES) {
    await admin`
      insert into memberships (user_id, organization_id, role, status)
      values (${userByRole[role]}, ${orgId}, ${role}, 'active')
    `;
  }
  await admin`
    insert into memberships (user_id, organization_id, role, status)
    values (${outsiderId}, ${outsiderOrgId}, 'owner', 'active')
  `;
  // suspended 是成员**状态**不是角色：给他最高的 admin，唯一的区别是 status。
  // app_is_member / app_has_role 都带 `and m.status = 'active'`，所以他应当
  // 在每一张表的每一个动作上都被拒绝。
  await admin`
    insert into memberships (user_id, organization_id, role, status)
    values (${suspendedId}, ${orgId}, 'admin', 'suspended')
  `;

  const account = async (code: string, name: string, type: string, money = false) => {
    const [row] = await admin`
      insert into accounts (organization_id, code, name_en, type, is_money_account, is_system)
      values (${orgId}, ${code}, ${name}, ${type}::account_type, ${money}, false)
      returning id
    `;
    return row.id as string;
  };
  const cash = await account('rlsm-cash', 'Cash', 'asset', true);
  const sales = await account('rlsm-sales', 'Sales', 'revenue');
  const expense = await account('rlsm-exp', 'Expense', 'expense');
  const equipment = await account('rlsm-equip', 'Equipment', 'asset');
  const accumDepn = await account('rlsm-accum', 'Accumulated Depreciation', 'asset');
  const inventory = await account('rlsm-inv', 'Inventory', 'asset');
  const cogs = await account('rlsm-cogs', 'COGS', 'expense');

  const [category] = await admin`
    insert into categories (organization_id, name_en, kind, account_id)
    values (${orgId}, 'Sales', 'income', ${sales})
    returning id
  `;

  // 一笔配平的交易：reconciliation_items / depreciation_schedules /
  // imported_transactions 都要指向它。journal_lines_balanced 是延迟到提交才
  // 校验的约束触发器，所以两条分录必须在同一个事务里写完。
  const [txn] = await admin.begin(async (tx) => {
    const [created] = await tx`
      insert into transactions
        (organization_id, kind, occurred_on, currency, amount_minor, base_amount_minor,
         exchange_rate, category_id, created_by, client_uuid)
      values (${orgId}, 'income', '2026-03-01', 'MYR', 10000, 10000, 1,
              ${category.id}, ${userByRole.owner}, gen_random_uuid())
      returning id
    `;
    await tx`
      insert into journal_lines
        (transaction_id, organization_id, account_id, direction, amount_minor, base_amount_minor)
      values
        (${created.id}, ${orgId}, ${cash}, 'debit', 10000, 10000),
        (${created.id}, ${orgId}, ${sales}, 'credit', 10000, 10000)
    `;
    return [created];
  });
  const transactionId = txn.id as string;

  const seed = async (table: string, id: string) => {
    seedId[table] = id;
  };

  const one = async (sqlText: string, params: unknown[]): Promise<string> => {
    const rows = await admin.unsafe(sqlText, params as never[]);
    return rows[0].id as string;
  };

  // ---- 主数据 ----
  await seed(
    'contacts',
    await one(
      `insert into contacts (organization_id, type, name) values ($1, 'customer', $2) returning id`,
      [orgId, `RLSM Customer ${RUN}`],
    ),
  );
  await seed(
    'tax_rates',
    await one(
      `insert into tax_rates (organization_id, name_en, name_zh, rate_bps) values ($1, 'SST', '销售税', 600) returning id`,
      [orgId],
    ),
  );
  await seed(
    'projects',
    await one(
      `insert into projects (organization_id, name, contact_id) values ($1, $2, $3) returning id`,
      [orgId, `RLSM Project ${RUN}`, seedId.contacts],
    ),
  );
  await seed(
    'inventory_items',
    await one(
      `insert into inventory_items (organization_id, sku, name_en, name_zh, inventory_account_id, cogs_account_id)
       values ($1, $2, 'Widget', '小部件', $3, $4) returning id`,
      [orgId, `RLSM-SKU-${RUN}`, inventory, cogs],
    ),
  );
  await seed(
    'budgets',
    await one(
      `insert into budgets (organization_id, account_id, year, month, budget_minor)
       values ($1, $2, 2099, 3, 0) returning id`,
      [orgId, expense],
    ),
  );
  await seed(
    'fixed_assets',
    await one(
      `insert into fixed_assets (organization_id, name, purchase_date, cost_minor, useful_life_months,
                                 asset_account_id, depn_expense_account_id, depn_accum_account_id)
       values ($1, 'RLSM Laptop', '2026-01-01', 100000, 36, $2, $3, $4) returning id`,
      [orgId, equipment, expense, accumDepn],
    ),
  );
  await seed(
    'depreciation_schedules',
    await one(
      `insert into depreciation_schedules (fixed_asset_id, period, depreciation_minor,
                                           accumulated_minor, book_value_minor, transaction_id)
       values ($1, '2026-02-01', 1000, 1000, 99000, $2) returning id`,
      [seedId.fixed_assets, transactionId],
    ),
  );

  // ---- 单据 ----
  // 金额一律给 0：0021 会给 invoices / bills 加上
  // `total_minor = subtotal_minor + tax_minor` 的检查约束，而它新加的
  // subtotal/tax 两列默认是 0。用 0 让这份 fixture 在 0021 前后都成立。
  await seed(
    'invoices',
    await one(
      `insert into invoices (organization_id, contact_id, invoice_number, issue_date, due_date,
                             currency, subtotal_minor, tax_minor, total_minor)
       values ($1, $2, $3, '2026-03-01', '2026-03-31', 'MYR', 0, 0, 0) returning id`,
      [orgId, seedId.contacts, `RLSM-INV-${RUN}`],
    ),
  );
  await seed(
    'invoice_items',
    await one(
      `insert into invoice_items (invoice_id, description, unit_price_minor, amount_minor)
       values ($1, 'line', 0, 0) returning id`,
      [seedId.invoices],
    ),
  );
  await seed(
    'bills',
    await one(
      `insert into bills (organization_id, contact_id, bill_number, issue_date, due_date, currency, total_minor)
       values ($1, $2, $3, '2026-03-01', '2026-03-31', 'MYR', 0) returning id`,
      [orgId, seedId.contacts, `RLSM-BILL-${RUN}`],
    ),
  );
  await seed(
    'bill_items',
    await one(
      `insert into bill_items (bill_id, description, amount_minor) values ($1, 'line', 0) returning id`,
      [seedId.bills],
    ),
  );
  await seed(
    'payments',
    await one(
      `insert into payments (organization_id, contact_id, type, amount_minor, base_amount_minor,
                             payment_date, currency, created_by)
       values ($1, $2, 'received', 0, 0, '2026-03-05', 'MYR', $3) returning id`,
      [orgId, seedId.contacts, userByRole.owner],
    ),
  );
  // payment_items 有 `invoice_id XOR bill_id` 的检查约束，只能挂一边。
  await seed(
    'payment_items',
    await one(
      `insert into payment_items (payment_id, invoice_id, amount_minor) values ($1, $2, 0) returning id`,
      [seedId.payments, seedId.invoices],
    ),
  );
  await seed(
    'credit_notes',
    await one(
      `insert into credit_notes (organization_id, contact_id, cn_number, issue_date,
                                 base_amount_minor, currency, invoice_id, created_by)
       values ($1, $2, $3, '2026-03-06', 0, 'MYR', $4, $5) returning id`,
      [orgId, seedId.contacts, `RLSM-CN-${RUN}`, seedId.invoices, userByRole.owner],
    ),
  );
  await seed(
    'credit_note_items',
    await one(
      `insert into credit_note_items (credit_note_id, description, unit_price_minor, amount_minor, tax_rate_id)
       values ($1, 'line', 0, 0, $2) returning id`,
      [seedId.credit_notes, seedId.tax_rates],
    ),
  );
  await seed(
    'purchase_orders',
    await one(
      `insert into purchase_orders (organization_id, contact_id, po_number, issue_date, currency, created_by)
       values ($1, $2, $3, '2026-03-01', 'MYR', $4) returning id`,
      [orgId, seedId.contacts, `RLSM-PO-${RUN}`, userByRole.owner],
    ),
  );
  await seed(
    'po_items',
    await one(
      `insert into po_items (po_id, description, unit_price_minor, amount_minor, tax_rate_id)
       values ($1, 'line', 0, 0, $2) returning id`,
      [seedId.purchase_orders, seedId.tax_rates],
    ),
  );
  await seed(
    'bank_reconciliations',
    await one(
      `insert into bank_reconciliations (organization_id, money_account_id, statement_date,
                                         statement_balance_minor, created_by)
       values ($1, $2, '2026-03-31', 0, $3) returning id`,
      [orgId, cash, userByRole.owner],
    ),
  );
  await seed(
    'reconciliation_items',
    await one(
      `insert into reconciliation_items (reconciliation_id, transaction_id) values ($1, $2) returning id`,
      [seedId.bank_reconciliations, transactionId],
    ),
  );
  await seed(
    'recurring_transactions',
    await one(
      `insert into recurring_transactions (organization_id, kind, amount, debit_account_id,
                                           credit_account_id, category_id)
       values ($1, 'expense', '100', $2, $3, $4) returning id`,
      [orgId, expense, cash, category.id],
    ),
  );
  await seed(
    'inventory_transactions',
    await one(
      `insert into inventory_transactions (organization_id, inventory_item_id, type, quantity,
                                           unit_cost_minor, total_cost_minor, created_by)
       values ($1, $2, 'purchase', 1, 100, 100, $3) returning id`,
      [orgId, seedId.inventory_items, userByRole.owner],
    ),
  );
  await seed(
    'imported_transactions',
    await one(
      `insert into imported_transactions (organization_id, money_account_id, source, transaction_date,
                                          amount_minor, created_by, matched_transaction_id, status)
       values ($1, $2, 'csv', '2026-03-01', 10000, $3, $4, 'matched') returning id`,
      [orgId, cash, userByRole.owner, transactionId],
    ),
  );
  // 年结记录（0024）。这张表与上面所有表不同的是它**没有 update 策略**——
  // 一次年结的内容在发生那一刻就定死了，要改只能撤销重做。TABLE_ACCESS 里
  // 它的 update 取的是空角色集合的哨兵值，所以下面的矩阵会断言四个角色
  // 的 UPDATE 全部被拒。
  await seed(
    'fiscal_year_closings',
    await one(
      `insert into fiscal_year_closings (organization_id, period_start, period_end,
                                          transaction_id, net_income_minor, closed_by)
       values ($1, '2025-01-01', '2025-12-31', $2, 123456, $3) returning id`,
      [orgId, transactionId, userByRole.owner],
    ),
  );

  // 种子行快照，insert 探针靠它克隆。用 to_jsonb 取整行而不是逐列列举：
  // 列加了、默认值改了都不用动这个文件。
  for (const table of Object.keys(TABLE_ACCESS)) {
    const rows = await admin.unsafe(`select to_jsonb(t) as row from ${table} t where t.id = $1`, [
      seedId[table],
    ] as never[]);
    if (rows.length !== 1) {
      throw new Error(`种子数据缺失：${table}（矩阵断言会给出误导性的失败原因，这里直接判死）`);
    }
    seedRow[table] = rows[0].row as Record<string, unknown>;
  }
}, 120_000);

afterAll(async () => {
  // 只删自己登记过的 id。不能按 email 通配删（vitest 并行跑多个文件，
  // tests/helpers/db.ts 生成的 email 是同样的形状），也不能 truncate cascade
  // （app_users.id 外键指向 auth.users，truncate 不会连带清掉它）。
  //
  // 下面这段逐表删除在 0022 之后可以整段删掉，只留最后那句删公司。
  // 原因：删公司时父子两边各自沿 organization_id 级联删除，而「二级子表」
  // （经父表级联删除的那些，如 depreciation_schedules）引用「一级子表」
  // （如 transactions）时，NO ACTION 的检查会排在二级子表的级联之前跑，
  // 看到行还在就把整句 delete 顶回来——0020 的注释里记的正是这一条。
  // 0022 把这批外键改成延迟检查之后，检查在提交时才跑，那时行已经没了。
  const orgs = createdOrgIds;
  if (orgs.length > 0) {
    await admin`delete from depreciation_schedules where fixed_asset_id in (
      select id from fixed_assets where organization_id = any(${orgs}))`;
    await admin`delete from reconciliation_items where reconciliation_id in (
      select id from bank_reconciliations where organization_id = any(${orgs}))`;
    await admin`delete from payment_items where payment_id in (
      select id from payments where organization_id = any(${orgs}))`;
    await admin`delete from credit_note_items where credit_note_id in (
      select id from credit_notes where organization_id = any(${orgs}))`;
    await admin`delete from po_items where po_id in (
      select id from purchase_orders where organization_id = any(${orgs}))`;
    await admin`delete from invoice_items where invoice_id in (
      select id from invoices where organization_id = any(${orgs}))`;
    await admin`delete from bill_items where bill_id in (
      select id from bills where organization_id = any(${orgs}))`;
    await admin`delete from imported_transactions where organization_id = any(${orgs})`;
    await admin`delete from organizations where id = any(${orgs})`;
  }
  // 顺序不能反：organizations.created_by 指向 app_users 且不是 cascade，
  // 先删用户会撞 organizations_created_by_fkey。
  if (createdUserIds.length > 0) {
    await admin`delete from auth.users where id = any(${createdUserIds})`;
  }
}, 120_000);

// ============================================================
// 探针
// ============================================================

async function probeTable(userId: string, table: string): Promise<Record<Command, Outcome>> {
  const id = seedId[table];
  const clone = {
    ...seedRow[table],
    id: randomUUID(),
    ...uniqueOverrides(table),
  };

  return asUserRollingBack(userId, async (tx) => {
    const select = await inSavepoint(tx, 'sp_select', async () => {
      const rows = await tx.unsafe(`select id from ${table} where id = $1`, [id] as never[]);
      return { allowed: rows.length === 1, detail: `${rows.length} 行` };
    });

    const insert = await inSavepoint(tx, 'sp_insert', async () => {
      try {
        // 克隆整行而不是逐列构造：这样探针不需要知道任何一张表有哪些列，
        // 加列、改默认值都不用动这个文件。
        //
        // `$1::text::jsonb` 而不是 `$1::jsonb`：后者会让 postgres.js 把参数
        // 当成 jsonb 再 JSON 序列化一次，送到服务端的是一个 jsonb 标量字符串，
        // jsonb_populate_record 报 22023 "cannot call populate_composite on a
        // scalar"。先按 text 传再由服务端解析，绕开这一层类型推断。
        await tx.unsafe(
          `insert into ${table} select * from jsonb_populate_record(null::${table}, $1::text::jsonb)`,
          [JSON.stringify(clone)] as never[],
        );
        return { allowed: true, detail: '插入成功' };
      } catch (error) {
        return classify(error);
      }
    });

    const update = await inSavepoint(tx, 'sp_update', async () => {
      try {
        // `set id = id` 不改变任何业务语义，也不会触发外键重查
        // （主键值没变，PostgreSQL 会跳过 RI 检查）。
        // 被 USING 挡住的角色拿到的是 0 行而不是报错——这正是 RLS 对
        // UPDATE/DELETE 的表现方式。
        const result = await tx.unsafe(`update ${table} set id = id where id = $1`, [
          id,
        ] as never[]);
        return { allowed: result.count === 1, detail: `${result.count} 行` };
      } catch (error) {
        return classify(error);
      }
    });

    const remove = await inSavepoint(tx, 'sp_delete', async () => {
      try {
        const result = await tx.unsafe(`delete from ${table} where id = $1`, [id] as never[]);
        return { allowed: result.count === 1, detail: `${result.count} 行` };
      } catch (error) {
        // 这里 23503 会被 classify 判成「允许」，是对的：策略放行了这次删除，
        // 是引用完整性拦下的。0022 之前 contacts / invoices / bills /
        // tax_rates / projects / inventory_items 这六张表都会走到这里。
        return classify(error);
      }
    });

    return { select, insert, update, delete: remove };
  });
}

function expectedFor(table: string, command: Command, role: Role): boolean {
  return rolesFor(TABLE_ACCESS[table][command]).includes(role);
}

// ============================================================
// 用例
// ============================================================

describe('前提：探针真的受 RLS 约束', () => {
  // 这一条必须最先跑。角色切换一旦失效，下面全部断言会以「什么都允许」
  // 的方式变红——但更危险的是反过来：如果有人把期望值也一起改宽，
  // 整个文件会全绿而什么都没测。
  it('withTransaction 里的身份是 teyo_app，且它不能绕过 RLS', async () => {
    const [row] = await withTransaction(
      userByRole.owner,
      (tx) => tx`
        select current_user as role,
               (select rolbypassrls from pg_roles where rolname = current_user) as bypass
      `,
    );
    expect(row.role).toBe('teyo_app');
    expect(row.bypass).toBe(false);
  });

  it('库里每一张启用 RLS 的表都被某一份清单认领', async () => {
    const rows = await admin`
      select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
      order by c.relname
    `;
    const live = rows.map((r) => r.relname as string);
    const claimed = new Set([...Object.keys(TABLE_ACCESS), ...ROW_LEVEL_TABLES]);

    const unclaimed = live.filter((t) => !claimed.has(t));
    expect(
      unclaimed,
      '新表启用了 RLS 却没在 permissions.ts 里登记，它的策略无人断言',
    ).toEqual([]);

    const phantom = [...claimed].filter((t) => !live.includes(t));
    expect(phantom, 'permissions.ts 登记了库里不存在或未启用 RLS 的表').toEqual([]);
  });

  it('矩阵真的覆盖了 TABLE_ACCESS 里的每一张表 × 每一个角色', () => {
    // 这一条原来写的是 `toHaveLength(22)` —— 一个写死的数字。它守住的是
    // 「别把表从清单里删掉」，但代价是每加一张表都要有人回来改这个数字，
    // 而改的时候只看到 "expected 22 got 23"，看不出该做什么。加 0024 的
    // fiscal_year_closings 时它正是这样红的。
    //
    // 改成断言「上面那个 describe 循环真的为每一张登记的表都生成了用例」：
    // 这才是这条测试想守的东西——覆盖率，而不是某个特定的数目。表少了会
    // 被上面那条「库里每一张启用 RLS 的表都被认领」抓住，两条合起来双向
    // 封死。
    const registered = Object.keys(TABLE_ACCESS);
    expect(registered.length).toBeGreaterThan(0);
    expect(new Set(registered).size, '登记表里有重复').toBe(registered.length);
    expect(ROLES).toHaveLength(4);
    expect(COMMANDS).toHaveLength(4);
    // 每张表都必须有种子行，否则它的探针拿到 undefined，整个文件在
    // beforeAll 里就崩了（而不是报出「这张表没覆盖到」）。
    const unseeded = registered.filter((table) => !seedId[table]);
    expect(unseeded, '这些登记表没有种子行，矩阵探不到它们').toEqual([]);
  });
});

const COMMANDS: readonly Command[] = ['select', 'insert', 'update', 'delete'] as const;

for (const table of Object.keys(TABLE_ACCESS)) {
  describe(`${table} × 4 角色 × 增删改查`, () => {
    for (const role of ROLES) {
      it(`${role}`, async () => {
        const outcome = await probeTable(userByRole[role], table);
        const actual: Record<string, boolean> = {};
        const expectedMap: Record<string, boolean> = {};
        for (const command of COMMANDS) {
          actual[`${command}(${outcome[command].detail})`] = outcome[command].allowed;
          expectedMap[`${command}(${outcome[command].detail})`] = expectedFor(
            table,
            command,
            role,
          );
        }
        // 一次比四个动作而不是四条断言：失败时能一眼看出是哪一个动作错了，
        // 以及数据库实际返回了什么（几行 / 哪个 SQLSTATE）。
        expect(actual).toEqual(expectedMap);
      });
    }
  });
}

describe('不在本公司的人，四个动作全部拒绝', () => {
  for (const table of Object.keys(TABLE_ACCESS)) {
    it(table, async () => {
      const outcome = await probeTable(outsiderId, table);
      expect({
        select: outcome.select.allowed,
        insert: outcome.insert.allowed,
        update: outcome.update.allowed,
        delete: outcome.delete.allowed,
      }).toEqual({ select: false, insert: false, update: false, delete: false });
    });
  }
});

describe('停权成员即使挂着 admin 角色也全部拒绝', () => {
  // suspended 是 memberships.status 而不是角色。这批用例保证
  // app_is_member / app_has_role 里那句 `and m.status = 'active'`
  // 在这 22 张表上同样生效——0010 的策略调的是同一对函数，
  // 但此前从来没有人对这些表验证过。
  for (const table of Object.keys(TABLE_ACCESS)) {
    it(table, async () => {
      const outcome = await probeTable(suspendedId, table);
      expect({
        select: outcome.select.allowed,
        insert: outcome.insert.allowed,
        update: outcome.update.allowed,
        delete: outcome.delete.allowed,
      }).toEqual({ select: false, insert: false, update: false, delete: false });
    });
  }
});

describe('策略形状（与 0022 末尾的断言同一条规则，在这里也钉一遍）', () => {
  it('不存在 USING 宽于 WITH CHECK 的 `for all` 策略', async () => {
    // 这是 P0 的判据本身：`for all` 时 DELETE 只看 USING，
    // 两个谓词一旦不同，宽的那个就漏给了删除。
    const rows = await admin`
      select tablename, policyname
      from pg_policies
      where schemaname = 'public'
        and cmd = 'ALL'
        and with_check is not null
        and with_check is distinct from qual
      order by tablename
    `;
    expect(rows.map((r) => `${r.tablename}.${r.policyname}`)).toEqual([]);
  });

  it('DELETE 策略只出现在允许硬删的表上', async () => {
    const rows = await admin`
      select tablename, policyname from pg_policies
      where schemaname = 'public' and cmd = 'DELETE'
      order by tablename, policyname
    `;
    const expectedTables = new Set([
      ...Object.entries(TABLE_ACCESS)
        .filter(([, access]) => rolesFor(access.delete).length > 0)
        .map(([table]) => table),
      // 0002 原有的两条：owner 可解散公司、可移除成员。
      'organizations',
      'memberships',
    ]);
    const unexpected = rows
      .map((r) => r.tablename as string)
      .filter((t) => !expectedTables.has(t));
    expect(unexpected).toEqual([]);
  });

  it('没有任何策略还授予 PUBLIC', async () => {
    const rows = await admin`
      select tablename, policyname from pg_policies
      where schemaname = 'public' and 'public' = any (roles)
      order by tablename
    `;
    expect(rows.map((r) => `${r.tablename}.${r.policyname}`)).toEqual([]);
  });

  it('删公司闭包内没有既非 cascade 又非延迟检查的外键', async () => {
    // organization:delete 与 PDPA 删除能否落地，就数据库这一侧而言，
    // 充要条件就是这一条。
    const rows = await admin`
      with recursive cascading(tbl) as (
        select 'organizations'::regclass as tbl
        union
        select c.conrelid::regclass
        from pg_constraint c
        join cascading p on p.tbl = c.confrelid::regclass
        where c.contype = 'f' and c.confdeltype = 'c'
      )
      select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent, c.conname
      from pg_constraint c
      where c.contype = 'f'
        and c.conrelid in (select tbl from cascading)
        and c.confrelid in (select tbl from cascading)
        and c.confdeltype <> 'c'
        and not c.condeferrable
      order by parent, child
    `;
    expect(rows.map((r) => `${r.child} -> ${r.parent}`)).toEqual([]);
  });
});
