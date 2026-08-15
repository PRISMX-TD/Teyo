-- 0015: 小白改造所需的科目与分类标记。
--
-- suspense：用户不确定一笔钱属于什么时的合法去处。账依然配平，
--   该笔挂在「待确认」队列里直到有人处理。没有这个出口，用户只能猜，
--   而猜错会生成一笔看起来完全正常的错账。
--   cash_flow_category 留空：它不是现金的最终去向，只是暂存。
--
-- purchases：种子科目里没有任何进货/成本科目，做买卖的生意因此算不出毛利。
--
-- is_system_only：折旧、摊销这类只应由系统过账的分类，不能出现在
--   日常录入的下拉里——小白选了就会凭空冲减一次银行余额。

alter table categories
  add column is_system_only boolean not null default false;

comment on column categories.is_system_only is
  '只应由系统过账的分类（折旧、摊销等），不出现在录入表单的选择器中。';

-- 回填既有公司：补两个科目
insert into accounts (organization_id, code, name_en, name_zh, type, is_money_account, is_system, sort_order, cash_flow_category)
select o.id, 'suspense', 'Unsorted', '待确认', 'asset', false, true, 95, null
from organizations o
where not exists (
  select 1 from accounts a where a.organization_id = o.id and a.code = 'suspense'
);

insert into accounts (organization_id, code, name_en, name_zh, type, is_money_account, is_system, sort_order, cash_flow_category)
select o.id, 'purchases', 'Purchases', '进货', 'expense', false, false, 405, 'operating'
from organizations o
where not exists (
  select 1 from accounts a where a.organization_id = o.id and a.code = 'purchases'
);

-- 回填既有公司：标记非现金分类
update categories c
set is_system_only = true
from accounts a
where a.id = c.account_id
  and a.code in ('depreciation', 'amortization');

-- 回填既有公司：补进货分类
insert into categories (organization_id, name_en, name_zh, kind, account_id, sort_order)
select a.organization_id, 'Purchases', '进货', 'expense', a.id, 405
from accounts a
where a.code = 'purchases'
  and not exists (
    select 1 from categories c
    where c.organization_id = a.organization_id and c.account_id = a.id
  );
