-- 数据库层的租户一致性、单一默认税率与缺失索引。
--
-- 应用前已在远端库只读核对过：下面每条约束现存数据都满足（跨公司引用 0 行，
-- 有两个以上启用中默认税率的公司 0 家），所以 validate 不会失败。

-- ── 1. 跨公司引用 ──
--
-- journal_lines.account_id / transaction_id 与 transactions.category_id 原来
-- 只校验「id 存在」，不校验「是同一家公司的」。RLS 只看分录行自己的
-- organization_id，所以一条带着别家科目 id 的分录行在库里是合法的——
-- 应用层每条写入路径都得记得自己查，漏一处就是串账。
--
-- 做法：在被引用表上加 (id, organization_id) 唯一约束，再用复合外键把
-- organization_id 一起钉住。删除语义与原单列外键保持一致：分录行随交易
-- 级联删除；科目与分类沿用原来的 deferrable initially deferred。
-- 先 not valid 再 validate，避免长时间持有强锁。

alter table accounts     add constraint accounts_id_org_key     unique (id, organization_id);
alter table transactions add constraint transactions_id_org_key unique (id, organization_id);
alter table categories   add constraint categories_id_org_key   unique (id, organization_id);

alter table journal_lines add constraint journal_lines_txn_same_org
  foreign key (transaction_id, organization_id)
  references transactions (id, organization_id) on delete cascade not valid;

alter table journal_lines add constraint journal_lines_account_same_org
  foreign key (account_id, organization_id)
  references accounts (id, organization_id) deferrable initially deferred not valid;

-- category_id 可空：复合外键默认 MATCH SIMPLE，category_id 为空的行不受约束。
alter table transactions add constraint transactions_category_same_org
  foreign key (category_id, organization_id)
  references categories (id, organization_id) deferrable initially deferred not valid;

alter table journal_lines validate constraint journal_lines_txn_same_org;
alter table journal_lines validate constraint journal_lines_account_same_org;
alter table transactions  validate constraint transactions_category_same_org;

-- ── 2. 每家公司只能有一个启用中的默认税率 ──
--
-- 只有 setDefault 会先清掉旧默认值，insertTaxRate / updateTaxRate 都能再写进
-- 第二个，之后「默认税率」取哪一个取决于扫描顺序。
create unique index if not exists tax_rates_single_default
  on tax_rates (organization_id) where is_default and is_active;

-- ── 3. 缺失的索引 ──

-- 0021 给各单据表补了索引，漏了对账明细；它的 RLS 子查询按 reconciliation_id
-- 过滤，没有索引时每次都是顺序扫描。
create index if not exists reconciliation_items_by_reconciliation
  on reconciliation_items (reconciliation_id);
create index if not exists recurring_transactions_by_org_due
  on recurring_transactions (organization_id, next_due_date);
create index if not exists tax_rates_by_org
  on tax_rates (organization_id);
create index if not exists bank_reconciliations_by_account
  on bank_reconciliations (organization_id, money_account_id, statement_date desc);
create index if not exists inventory_transactions_by_org
  on inventory_transactions (organization_id, created_at desc);
create index if not exists invoices_by_contact on invoices (contact_id);
create index if not exists bills_by_contact    on bills (contact_id);
create index if not exists categories_by_account on categories (account_id);

-- 指向 transactions 的外键，子表一侧没有索引：删公司（或级联删交易）时
-- 每删一笔交易都要把这些子表扫一遍。
create index if not exists reconciliation_items_by_transaction
  on reconciliation_items (transaction_id) where transaction_id is not null;
create index if not exists depreciation_schedules_by_transaction
  on depreciation_schedules (transaction_id) where transaction_id is not null;
create index if not exists imported_transactions_by_match
  on imported_transactions (matched_transaction_id) where matched_transaction_id is not null;
create index if not exists fiscal_year_closings_by_transaction
  on fiscal_year_closings (transaction_id) where transaction_id is not null;

-- ── 4. 新建函数的默认执行权 ──
--
-- 0030 撤掉了 anon / authenticated 的默认 EXECUTE，但 PUBLIC 那一份还在：
-- 以后新建的函数（包括 security definer 的）照样能经 PUBLIC 被 anon 调用。
-- 这里把 PUBLIC 的默认执行权也撤掉，同时默认授予 teyo_app——应用与 RLS
-- 策略里调用的函数仍然开箱可用，不需要每条迁移记得手动 grant。
-- 只影响此后由迁移角色新建的函数；已有函数的权限 0030 已经逐个处理过。
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public grant execute on functions to teyo_app;
