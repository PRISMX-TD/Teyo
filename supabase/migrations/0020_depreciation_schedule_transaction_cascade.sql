-- 0020: 给 depreciation_schedules.transaction_id 补上 on delete cascade。
--
-- 0016 把 0008/0009 那批表指向 organizations 的外键统一补成了 cascade，
-- 但它只处理单列 organization_id 外键。depreciation_schedules.transaction_id
-- 指向 transactions(id)（0009 写的是裸 references，没有任何 on delete 行为），
-- 不在那次扫描范围内，至今仍是 NO ACTION。
--
-- 后果与 0016 描述的完全同一形状，只是晚一层：删除一家公司时，
-- transactions 与 fixed_assets -> depreciation_schedules 是两条各自独立的
-- 级联分支，Postgres 先走到哪一条不确定；一旦先删 transactions，那些
-- transaction_id 还指着它们的排程行就会把整句 delete 顶回来：
--
--   update or delete on table "transactions" violates foreign key constraint
--   "depreciation_schedules_transaction_id_fkey" on table "depreciation_schedules"
--
-- 也就是说：任何一家过过折旧的公司都删不掉。organization:delete 权限、
-- 阶段 1 spec 的 PDPA 删除、以及测试清理 resetTestData 都会撞上它。
-- tests/actions/fixed-assets-depreciation.test.ts 目前在 afterAll 里手工
-- 把 transaction_id 置空来绕过，这条迁移落地后那段就可以删掉。
--
-- 选 cascade 而不是 set null：排程行本来就会随 fixed_assets 一起被级联删除，
-- 这里只是让两条分支哪条先走都成立。set null 会留下 is_posted = true 却没有
-- 交易可指的行——一个自相矛盾的状态，比行本身消失更难解释。应用层从不硬删
-- 交易（作废是打标记，不是 delete），所以这条 cascade 在正常使用中永远不会
-- 单独触发。

alter table depreciation_schedules
  drop constraint depreciation_schedules_transaction_id_fkey;

alter table depreciation_schedules
  add constraint depreciation_schedules_transaction_id_fkey
  foreign key (transaction_id) references transactions (id) on delete cascade;

-- 断言：约束确实带上了 cascade（'c'）。
do $$
declare
  behaviour "char";
begin
  select c.confdeltype into behaviour
  from pg_constraint c
  where c.conname = 'depreciation_schedules_transaction_id_fkey'
    and c.conrelid = 'depreciation_schedules'::regclass;

  if behaviour is distinct from 'c' then
    raise exception 'depreciation_schedules.transaction_id still lacks on delete cascade (%)', behaviour;
  end if;
end $$;
