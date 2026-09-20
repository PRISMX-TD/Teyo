-- 0024: 财年、年结、预收/预付款。
--
-- 三件一直没有的东西，凑在一条迁移里是因为它们互相牵连：年结要知道财年
-- 从哪个月开始，而预收款的科目与年结一样都落在同一批种子科目上。
--
--   1. organizations.fiscal_year_start_month —— 报表此前硬编码日历年
--   2. fiscal_year_closings —— 年结的记录，让「这一年结过没有」可查、可撤
--   3. transactions_category_matches_kind 并入 'closing'
--   4. payment_items_one_target 放宽，允许一笔不核销任何单据的预收/预付
--   5. 两个新种子科目：预收账款（负债）、预付账款（资产）

-- ============================================================
-- 1. 财年起始月
-- ============================================================
-- 报表页此前写的是 `${new Date().getFullYear()}-01-01`，也就是把日历年
-- 当成财年。马来西亚的中小企业财年常常不是 1 月起（跟着母公司、跟着
-- 行业惯例、或者当初注册时随手选的），而损益表、现金流量表、年结的
-- 边界全都由它决定——差一个月，整张损益表就是错的期间。
--
-- 存「起始月」而不是「起始日期」：财年只会在某个月的 1 号开始，存一个
-- 完整日期就要额外回答「那个日期的年份是什么意思」，而它每年都在变。
alter table organizations
  add column if not exists fiscal_year_start_month smallint not null default 1;

alter table organizations drop constraint if exists organizations_fiscal_year_start_month_valid;
alter table organizations add constraint organizations_fiscal_year_start_month_valid
  check (fiscal_year_start_month between 1 and 12);

-- ============================================================
-- 2. 'closing' 并入「不带分类」那一支
-- ============================================================
-- 0014 把 'journal' 并进 transfer 那一支时解释过：调用方直接指定借贷两个
-- 科目，分类在这里没有意义。年结同理——它结转的是一整批科目的余额，
-- 「这笔属于哪个分类」这个问题本身不成立。
--
-- 不合并这一条的后果与 0007 当年一模一样：kind = 'closing' 的行每一次
-- 插入都会撞约束而失败，而失败发生在用户点「结转本年度」的那一刻。
alter table transactions drop constraint transactions_category_matches_kind;

alter table transactions add constraint transactions_category_matches_kind check (
  (kind in ('transfer', 'journal', 'closing') and category_id is null)
  or (kind not in ('transfer', 'journal', 'closing') and category_id is not null)
);

-- ============================================================
-- 3. 年结记录
-- ============================================================
-- 为什么要一张表，而不是「查有没有 kind = 'closing' 的交易」：
--
--   - 幂等：同一个财年只能结一次。唯一约束把这件事钉在数据库层，而不是
--     靠应用每次先查一遍（两个人同时点会各自查到「还没结过」）。
--   - 可撤销：结错了要能反悔。删这一行 + 作废那笔交易，是一个有明确边界
--     的操作；而从一堆交易里认出「哪几笔是去年那次年结」要靠猜日期。
--   - 可查：界面上要显示「2026 财年已于 X 日结转，净利润 Y」。这些信息
--     散落在分录里，凑不回来。
create table if not exists fiscal_year_closings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  /* 财年的第一天与最后一天，闭区间。存两个日期而不是「年份」：财年跨自然
     年时（比如 7 月起），「2026 财年」指的是哪一段本身就有歧义。 */
  period_start date not null,
  period_end date not null,
  /* 结转产生的那笔分录。on delete set null：交易被作废时用软删除，真被
     硬删只可能是删公司（那时这一行也一起走），留 null 好过挡住删除。 */
  transaction_id uuid references transactions (id) on delete set null,
  /* 结转的净利润（本位币最小单位）。正数为盈利。冗余存一份是为了界面
     不必为了显示一个数字去重算一遍损益表。 */
  net_income_minor bigint not null,
  closed_at timestamptz not null default now(),
  closed_by uuid not null references app_users (id),
  constraint fiscal_year_closings_period_order check (period_end > period_start),
  constraint fiscal_year_closings_unique_period unique (organization_id, period_start)
);

create index if not exists fiscal_year_closings_by_org
  on fiscal_year_closings (organization_id, period_start desc);

alter table fiscal_year_closings enable row level security;

-- 策略按 0022 的形状写：读/增/删分开，没有 update。
-- 没有 update 是有意的：一次年结的内容（期间、净利润、那笔分录）在它
-- 发生的那一刻就定死了。要改只能撤销重做，而撤销是 delete。
create policy "Fiscal year closings: read" on fiscal_year_closings
  for select to teyo_app using (app_is_member(organization_id));

-- 年结只有 owner 能做：它把一整年的损益推进留存收益，是这个产品里
-- 影响面最大的一次写入，与 period:lock / organization:transfer 同级。
create policy "Fiscal year closings: insert" on fiscal_year_closings
  for insert to teyo_app
  with check (app_has_role(organization_id, array['owner']::membership_role[]));

create policy "Fiscal year closings: delete" on fiscal_year_closings
  for delete to teyo_app using (app_has_role(organization_id, array['owner']::membership_role[]));

-- ============================================================
-- 4. 预收 / 预付款
-- ============================================================
-- payment_items_one_target 原本要求 invoice_id 与 bill_id 恰好一个非空，
-- 于是「收到钱时还没开发票」在这个产品里没有任何表达方式——而定金、预收
-- 货款正是小生意最常见的收款形式之一。表单目前挡在前面并说明原因，
-- 但那是承认做不到，不是做到了。
--
-- 放宽成「至多一个非空」：两个都为空 = 这笔钱还没有对应的单据，它挂在
-- 预收账款（负债）或预付账款（资产）上，等日后开了单再核销。
-- 仍然禁止两个都非空——一条核销明细不可能同时冲一张发票和一张账单。
alter table payment_items drop constraint if exists payment_items_one_target;

alter table payment_items add constraint payment_items_one_target check (
  invoice_id is null or bill_id is null
);

-- ============================================================
-- 5. 新种子科目
-- ============================================================
-- 与 server/services/account-seed.ts 的 SEED_ACCOUNTS 逐字对应。
-- 新公司由 seedChartOfAccounts 写入，已存在的公司靠这一段补上。
insert into accounts (organization_id, code, name_en, name_zh, type, is_money_account, is_system, sort_order, cash_flow_category)
select o.id, v.code, v.name_en, v.name_zh, v.type::account_type, false, true, v.sort_order, v.cash_flow_category::cash_flow_category
from organizations o
cross join (values
  -- 收了钱还没开票：钱是你的，货/服务还没交付，所以它是负债不是收入。
  ('customer-deposits', 'Customer Deposits', '预收账款', 'liability', 145, 'operating'),
  -- 付了钱还没收到账单：与 prepaid-expenses（预付费用，如预付租金）分开，
  -- 后者是「已知用途、按期摊销」，这个是「还没有单据」。
  ('supplier-deposits', 'Supplier Deposits',  '预付账款', 'asset',     92,  'operating')
) as v(code, name_en, name_zh, type, sort_order, cash_flow_category)
on conflict (organization_id, code) do nothing;

do $$
declare missing int;
begin
  select count(*) into missing
  from organizations o
  cross join (values ('customer-deposits'), ('supplier-deposits')) as v(code)
  where not exists (
    select 1 from accounts a where a.organization_id = o.id and a.code = v.code
  );
  if missing > 0 then
    raise exception 'after backfill, % (organization, account) pairs are still missing', missing;
  end if;
end $$;

-- ============================================================
-- 断言
-- ============================================================
do $$
begin
  -- 'closing' 真的能用（0023 之后、本条之前的窗口期里它还不能）。
  if not exists (
    select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
    where t.typname = 'transaction_kind' and e.enumlabel = 'closing'
  ) then
    raise exception 'transaction_kind is missing the closing value; run 0023 first';
  end if;

  -- 新表的策略齐了，且没有 update（见上面那段注释）。
  if (select count(*) from pg_policies where tablename = 'fiscal_year_closings') <> 3 then
    raise exception 'fiscal_year_closings should have exactly 3 policies (select/insert/delete)';
  end if;
  if exists (select 1 from pg_policies where tablename = 'fiscal_year_closings' and cmd in ('ALL', 'UPDATE')) then
    raise exception 'fiscal_year_closings must not have an UPDATE or FOR ALL policy';
  end if;
end $$;
