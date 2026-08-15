-- 0016: 给 0008/0009 建立的表补上 organization_id 的 on delete cascade。
--
-- 0001 的 8 个业务表全部写的是 `references organizations (id) on delete cascade`。
-- 0008 与 0009 新增的 15 张表全部漏了 cascade，写成 `references organizations(id)`。
--
-- 后果不是"删公司会留下孤儿行"，而是**删不掉**：任何一家公司只要有过一个联系人、
-- 一张发票、一笔收款，删除操作就会撞上外键约束直接失败。
--   - server/domain/permissions.ts 定义了 organization:delete 权限并授予 owner，
--     但没有任何实现——真去实现会立刻撞上这个。
--   - 阶段 1 spec 的数据生命周期一节（PDPA 导出与删除）因此是堵死的。
--   - 测试清理 deleteTestOrganizations 也失败，留下越积越多的测试公司。
--
-- 统一到 0001 的约定：组织是租户边界，删除组织即删除其全部业务数据。
-- audit_logs 不在此列（0001 已有 cascade），其保留策略是独立议题。

do $$
declare
  target record;
begin
  for target in
    select
      c.conname   as constraint_name,
      c.conrelid::regclass::text as table_name,
      a.attname   as column_name
    from pg_constraint c
    join pg_attribute a
      on a.attrelid = c.conrelid
     and a.attnum = c.conkey[1]
    where c.contype = 'f'
      and c.confrelid = 'organizations'::regclass
      and c.confdeltype <> 'c'          -- 'c' = cascade，跳过已经正确的
      and array_length(c.conkey, 1) = 1
      and a.attname = 'organization_id'
  loop
    execute format(
      'alter table %s drop constraint %I',
      target.table_name, target.constraint_name
    );
    execute format(
      'alter table %s add constraint %I foreign key (%I) references organizations (id) on delete cascade',
      target.table_name, target.constraint_name, target.column_name
    );
    raise notice 'cascaded % on %', target.constraint_name, target.table_name;
  end loop;
end $$;

-- 断言：不应再有任何指向 organizations 的单列 organization_id 外键缺少 cascade。
do $$
declare
  offending int;
begin
  select count(*) into offending
  from pg_constraint c
  join pg_attribute a
    on a.attrelid = c.conrelid
   and a.attnum = c.conkey[1]
  where c.contype = 'f'
    and c.confrelid = 'organizations'::regclass
    and c.confdeltype <> 'c'
    and array_length(c.conkey, 1) = 1
    and a.attname = 'organization_id';

  if offending > 0 then
    raise exception '% organization_id foreign keys still lack on delete cascade', offending;
  end if;
end $$;
