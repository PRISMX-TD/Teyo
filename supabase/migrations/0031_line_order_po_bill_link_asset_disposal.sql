-- 三处只加列、向后兼容的补充，给下面三个功能用：
--
-- 1. 单据明细行序。invoice_items / credit_note_items / bill_items / po_items
--    原来没有序号列，读取时只能 order by id（uuid），编辑和打印时行序是乱的。
--    加 position，并按现有的 id 顺序回填——这正是这些行此前一直被读出来的
--    顺序，所以回填不会让任何一张已有单据「看起来变了」。
--
-- 2. 采购单转账单。bills.purchase_order_id 记录这张账单是从哪张采购单转来的；
--    采购单被删（目前只会随公司一起删）时置空，账单本身保留。
--
-- 3. 固定资产处置过账。原来「处置」只是把资产标为停用，不出分录：资产原值与
--    累计折旧永远挂在账上，也不记处置损益。disposal_transaction_id 指向处置
--    分录，disposal_proceeds_minor 记处置收入（本位币最小单位，0 = 报废）。

alter table invoice_items     add column if not exists position integer;
alter table credit_note_items add column if not exists position integer;
alter table bill_items        add column if not exists position integer;
alter table po_items          add column if not exists position integer;

update invoice_items t set position = s.rn
from (select id, row_number() over (partition by invoice_id order by id) - 1 as rn from invoice_items) s
where s.id = t.id and t.position is null;

update credit_note_items t set position = s.rn
from (select id, row_number() over (partition by credit_note_id order by id) - 1 as rn from credit_note_items) s
where s.id = t.id and t.position is null;

update bill_items t set position = s.rn
from (select id, row_number() over (partition by bill_id order by id) - 1 as rn from bill_items) s
where s.id = t.id and t.position is null;

update po_items t set position = s.rn
from (select id, row_number() over (partition by po_id order by id) - 1 as rn from po_items) s
where s.id = t.id and t.position is null;

alter table bills add column if not exists purchase_order_id uuid
  references purchase_orders (id) on delete set null;
create index if not exists bills_by_purchase_order
  on bills (purchase_order_id) where purchase_order_id is not null;

alter table fixed_assets add column if not exists disposal_transaction_id uuid
  references transactions (id) on delete set null;
alter table fixed_assets add column if not exists disposal_proceeds_minor bigint;
create index if not exists fixed_assets_by_disposal_transaction
  on fixed_assets (disposal_transaction_id) where disposal_transaction_id is not null;
