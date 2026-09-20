-- 0025: fiscal_year_closings -> transactions 改成延迟检查。
--
-- 0024 建这一列时写的是 `on delete set null`，理由是「交易被作废用软删除，
-- 真被硬删只可能是删公司，那时这一行也一起走」。前半句对，后半句想错了
-- 一步：删公司时这两张表**都在级联闭包里**，而 set null 不是 cascade，
-- 于是它落进了 0022 专门堵的那一类——
--
--   删除 organizations 时，PostgreSQL 会为闭包内的每一张表排一次级联动作。
--   fiscal_year_closings 与 transactions 都会被删，但两者谁先执行不由我们
--   决定。如果 transactions 先被删，指向它的这条 set null 会试图去 UPDATE
--   一批**马上也要被删掉**的行；触发器队列的顺序一变，整句 delete 就被
--   顶回来。症状是「删公司失败」，而报错指向一个与公司毫无关系的约束名。
--
-- 0022 对另外 27 条外键用的是同一个办法，理由在那条迁移里有完整论证：
-- 延迟到 COMMIT 才检查，那时子行已经没了，检查自然通过；而单独删一笔
-- 交易时，子行仍在，照样按 set null 正常处理。
--
-- tests/db/rls-matrix.test.ts 里那条「删公司闭包内没有既非 cascade 又非
-- 延迟检查的外键」的断言，就是为了让这一类疏漏在加表的当天被发现——
-- 它确实在 0024 落地的当天就红了。

do $$
declare fk_name text;
begin
  select c.conname into fk_name
  from pg_constraint c
  where c.contype = 'f'
    and c.conrelid = 'fiscal_year_closings'::regclass
    and c.confrelid = 'transactions'::regclass;

  if fk_name is null then
    raise exception 'fiscal_year_closings has no foreign key to transactions';
  end if;

  -- alter constraint 只改系统表，不会重新全量校验既有数据。
  execute format(
    'alter table fiscal_year_closings alter constraint %I deferrable initially deferred',
    fk_name
  );
end $$;

-- 断言：删公司闭包内不再有「既非 cascade 又非延迟」的外键。
-- 与 0022 末尾那条、以及 rls-matrix 里那条是同一个查询——三处写同一句，
-- 是因为它们各自守着不同的时刻：迁移守住这一次变更，测试守住往后每一次。
do $$
declare leftover text;
begin
  with recursive cascading(tbl) as (
    select 'organizations'::regclass as tbl
    union
    select c.conrelid::regclass
    from pg_constraint c
    join cascading p on p.tbl = c.confrelid::regclass
    where c.contype = 'f' and c.confdeltype = 'c'
  )
  select string_agg(c.conrelid::regclass::text || ' -> ' || c.confrelid::regclass::text, ', ')
    into leftover
  from pg_constraint c
  where c.contype = 'f'
    and c.conrelid in (select tbl from cascading)
    and c.confrelid in (select tbl from cascading)
    and c.confdeltype <> 'c'
    and not c.condeferrable;

  if leftover is not null then
    raise exception 'foreign keys inside the org-delete closure are neither cascade nor deferred: %', leftover;
  end if;
end $$;
