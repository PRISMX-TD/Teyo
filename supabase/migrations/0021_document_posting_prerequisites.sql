-- 0021: 让单据（发票 / 账单 / 收付款 / 贷项通知单）能真正进总账。
--
-- 背景：0008/0009 建的这批表有完整的界面和数据模型，但没有一条产生
-- journal_lines。后果是应收账龄表上显示客户欠着钱，同一套数据算出来的
-- 资产负债表里应收账款却是 0——同一个产品里两个页面互相否认对方。
--
-- 这条迁移只补齐「过账需要而现在没有」的结构，不动任何既有数据的含义：
--   1. 三个新科目（进项税 / 汇兑收益 / 汇兑损失），回填给所有已存在的公司
--   2. bills 补净额与税额列——现在只有 total_minor，含税账单的税额无处可放
--   3. credit_notes 补 transaction_id——invoices/bills/payments 都有，只有它没有
--   4. 币种列收紧成 char(3) + 正则，与 transactions.currency 同一套约束
--   5. 明细表与 project_id 补索引
--   6. 把手工建出来的那个索引改回迁移文件里的名字
--
-- 刻意不做的一件事：payments/credit_notes/purchase_orders 的 exchange_rate
-- 是放大 10^8 的 bigint，而 transactions.exchange_rate 是 numeric(20,8)。
-- 两种写法承载的信息完全相同（都精确到 8 位小数，都不经浮点），差别只在
-- 观感。在一张有真实数据的表上改列类型，换来的是一致的观感，风险是换算
-- 写错就把已入账的汇率整体挪一个数量级。这里不动列，改为在代码侧统一用
-- parseRateToScaled / formatScaledRate 这一对函数，让「字符串 <-> 定标整数」
-- 只有一处实现。

-- ============================================================
-- 1. 新科目回填
-- ============================================================
-- 与 server/services/account-seed.ts 的 SEED_ACCOUNTS 逐字对应。新公司由
-- seedChartOfAccounts 写入，已存在的公司靠这一段补上——否则老公司一开发票
-- 就会在「找不到 tax-receivable」上失败，而新公司好好的。
insert into accounts (organization_id, code, name_en, name_zh, type, is_money_account, is_system, sort_order, cash_flow_category)
select o.id, v.code, v.name_en, v.name_zh, v.type::account_type, false, true, v.sort_order, v.cash_flow_category::cash_flow_category
from organizations o
cross join (values
  ('tax-receivable', 'Input Tax Receivable', '进项税',            'asset',   35,  'operating'),
  ('fx-gain',        'Foreign Exchange Gain', '汇兑收益',          'revenue', 330, 'operating'),
  ('fx-loss',        'Foreign Exchange Loss', '汇兑损失',          'expense', 495, 'operating'),
  -- cogs 与既有的 purchases 是两件事：purchases 记「买进来花了多少钱」，
  -- 发生在采购那一刻；cogs 记「卖出去的那批货当初值多少钱」，发生在销售
  -- 那一刻。缺了 cogs，存货出库只能挂回 purchases，于是进货多的月份看起来
  -- 在亏、清库存的月份看起来暴利，而两个月的账都完全配平。
  ('cogs',           'Cost of Goods Sold',    '销货成本',          'expense', 408, 'operating')
) as v(code, name_en, name_zh, type, sort_order, cash_flow_category)
on conflict (organization_id, code) do nothing;

-- 断言：每家公司都齐了。少一个就意味着某家公司的发票过账会在运行时失败，
-- 而失败发生在用户点「保存」的那一刻，不是现在。
do $$
declare missing int;
begin
  select count(*) into missing
  from organizations o
  cross join (values ('tax-receivable'), ('fx-gain'), ('fx-loss'), ('cogs')) as v(code)
  where not exists (
    select 1 from accounts a where a.organization_id = o.id and a.code = v.code
  );
  if missing > 0 then
    raise exception 'after backfill, % (organization, account) pairs are still missing', missing;
  end if;
end $$;

-- ============================================================
-- 2. bills 补净额 / 税率 / 税额
-- ============================================================
-- invoices 一开始就有 subtotal_minor / tax_rate_bps / tax_minor，bills 只有
-- total_minor。于是一张含 6% SST 的供应商账单，税额只能并进费用科目，
-- repositories/tax.ts 里那句 `0::bigint as tax_minor`（进项恒为 0）正是
-- 这个缺列的直接后果，不是查询写错了。
alter table bills add column if not exists subtotal_minor bigint not null default 0;
alter table bills add column if not exists tax_rate_bps integer not null default 0;
alter table bills add column if not exists tax_minor bigint not null default 0;

-- 既有行：整张账单都是净额，税额为 0。这与它们当初被录入时的含义一致
-- （那时界面上根本没有税这一栏），不是猜测。
update bills set subtotal_minor = total_minor where subtotal_minor = 0 and total_minor <> 0;

alter table bills drop constraint if exists bills_total_is_net_plus_tax;
alter table bills add constraint bills_total_is_net_plus_tax
  check (total_minor = subtotal_minor + tax_minor);

-- invoices 上同一条不变量此前也没有。三个数不自洽时，过账出来的分录会
-- 配平（净额 + 税额自成一组），但表头金额与单据总额对不上。
alter table invoices drop constraint if exists invoices_total_is_net_plus_tax;
alter table invoices add constraint invoices_total_is_net_plus_tax
  check (total_minor = subtotal_minor + tax_minor);

alter table bills add column if not exists tax_rate_id uuid references tax_rates (id);

-- ============================================================
-- 3. credit_notes 补 transaction_id
-- ============================================================
-- invoices / bills / payments / depreciation_schedules 都有这一列，用来从
-- 单据找到它的分录（作废单据时要连带作废分录）。credit_notes 没有，所以
-- 它即使过账了也找不回自己的那笔交易。
alter table credit_notes add column if not exists transaction_id uuid references transactions (id) on delete set null;

-- 0020 给指向 transactions 的六条外键补了 on delete set null/cascade，
-- 新加的这一条照同一套规矩来（上面 references 子句里已写）。

-- ============================================================
-- 4. 币种列收紧
-- ============================================================
-- transactions.currency 是 char(3) + check (currency ~ '^[A-Z]{3}$')。
-- 0008/0009 建的这批表写的是 text default 'USD'——既没有长度约束也没有
-- 大小写约束，而默认值 'USD' 与 organizations.timezone 默认
-- 'Asia/Kuala_Lumpur' 所指的市场对不上。默认值改由应用侧传本位币，
-- 这里只负责让非法值进不来。
do $$
declare t text;
begin
  foreach t in array array['invoices', 'bills', 'payments', 'credit_notes', 'purchase_orders'] loop
    -- 先把既有数据归一化，否则加约束会失败。已知全部是 'USD'/'MYR' 这类
    -- 三字母大写值，upper(btrim()) 对它们是恒等变换。
    execute format('update %I set currency = upper(btrim(currency)) where currency <> upper(btrim(currency))', t);
    execute format('alter table %I alter column currency type char(3)', t);
    execute format('alter table %I alter column currency drop default', t);
    execute format('alter table %I drop constraint if exists %I', t, t || '_currency_format');
    execute format('alter table %I add constraint %I check (currency ~ ''^[A-Z]{3}$'')', t, t || '_currency_format');
  end loop;
end $$;

-- ============================================================
-- 5. 缺失的索引
-- ============================================================
-- 五张明细表的父键全部没有索引，而它们的 RLS 策略本身就是
-- `parent_id in (select ...)` 形式的子查询——每次读明细都要顺序扫描。
create index if not exists invoice_items_by_invoice on invoice_items (invoice_id);
create index if not exists bill_items_by_bill on bill_items (bill_id);
create index if not exists po_items_by_po on po_items (po_id);
create index if not exists payment_items_by_payment on payment_items (payment_id);
create index if not exists credit_note_items_by_credit_note on credit_note_items (credit_note_id);

-- 收付款要按单据反查已核销金额，这两个方向都得走索引。
create index if not exists payment_items_by_invoice on payment_items (invoice_id) where invoice_id is not null;
create index if not exists payment_items_by_bill on payment_items (bill_id) where bill_id is not null;

-- 0009 给 transactions 加了 project_id 却没有索引：按项目筛交易是全表扫描。
create index if not exists transactions_by_project on transactions (organization_id, project_id)
  where project_id is not null;

-- 单据过账后要从 transaction 反查单据，以及反过来。
create index if not exists invoices_by_transaction on invoices (transaction_id) where transaction_id is not null;
create index if not exists bills_by_transaction on bills (transaction_id) where transaction_id is not null;
create index if not exists payments_by_transaction on payments (transaction_id) where transaction_id is not null;
create index if not exists credit_notes_by_transaction on credit_notes (transaction_id) where transaction_id is not null;

-- ============================================================
-- 6. 索引名归一
-- ============================================================
-- 0018 的文件里索引叫 transactions_by_category_recent 并标注「未应用」，
-- 而库里实际存在的是 transactions_recent_by_category——同样的定义，不同的
-- 名字，说明它是某次手工执行 SQL 时建的。`create index if not exists` 按
-- 名字判断，所以照 0018 原样跑一遍只会再建一个一模一样的重复索引。
-- 改名而不是「先删再建」：改名是元数据操作，删了重建要在一张最大的表上
-- 重新扫一遍。
do $$
begin
  if exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'transactions_recent_by_category')
     and not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'transactions_by_category_recent')
  then
    alter index transactions_recent_by_category rename to transactions_by_category_recent;
  end if;
end $$;

create index if not exists transactions_by_category_recent on transactions (category_id, occurred_on)
  where voided_at is null;

-- 断言：这条索引最终只存在一份。
do $$
declare n int;
begin
  select count(*) into n from pg_indexes
  where schemaname = 'public'
    and indexname in ('transactions_recent_by_category', 'transactions_by_category_recent');
  if n <> 1 then
    raise exception 'expected exactly one recent-category index, found %', n;
  end if;
end $$;
