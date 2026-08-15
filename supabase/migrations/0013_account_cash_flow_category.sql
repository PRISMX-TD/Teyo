-- 现金流量表此前按字面量科目编码分类（netFlow('equipment') 等），
-- 因此用户自建的科目在报表中恒为零且无提示。改为按科目上的显式分类。
--
-- 分类的是现金的对方科目，不是资金账户本身：
-- is_money_account = true 的行保持 null。

create type cash_flow_category as enum ('operating', 'investing', 'financing');

alter table accounts
  add column cash_flow_category cash_flow_category;

comment on column accounts.cash_flow_category is
  '现金流量表分类。资金账户为 null（它们是现金本身，不是现金的去向）。';

-- 按既有种子科目的语义回填。无生产数据，此处只影响开发与测试库。
update accounts set cash_flow_category = 'investing'
  where is_money_account = false
    and code in ('equipment', 'furniture', 'vehicles', 'software-intangible');

update accounts set cash_flow_category = 'financing'
  where is_money_account = false
    and code in ('capital', 'loans', 'owners-draw');

update accounts set cash_flow_category = 'operating'
  where is_money_account = false
    and cash_flow_category is null
    and type in ('revenue', 'expense', 'liability');
