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

-- AR / inventory / prepaid-expenses 是资产类科目，不在下面按 type 回填的
-- revenue/expense/liability 分支里，但它们是标准间接法下的营运资金调整项——
-- server/repositories/reports.ts 已经把 -netFlow('accounts-receivable')、
-- -netFlow('inventory')、-netFlow('prepaid-expenses') 计入 operatingTotal，
-- 与 accounts-payable 是同一处理口径（资产端符号相反）。这里显式回填，
-- 不靠 type 判断，避免误伤 equipment 等同为资产类但属于 investing 的科目。
update accounts set cash_flow_category = 'operating'
  where is_money_account = false
    and code in ('accounts-receivable', 'inventory', 'prepaid-expenses');

update accounts set cash_flow_category = 'operating'
  where is_money_account = false
    and cash_flow_category is null
    and type in ('revenue', 'expense', 'liability');
