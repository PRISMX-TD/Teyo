-- 0020: 给所有指向 transactions 的单列外键补上 on delete cascade。
--
-- ============================================================
-- 这是一类，不是一处
-- ============================================================
-- 只读普查线上库的 pg_constraint（confrelid = 'transactions'）：指向
-- transactions 的单列外键共 8 条。0001 建的两条本来就是对的
-- （journal_lines.transaction_id、attachments.transaction_id，都带 cascade）；
-- 0008 与 0009 后来加的 6 条全是 NO ACTION：
--
--   bills.transaction_id                          (0008)
--   invoices.transaction_id                       (0008)
--   reconciliation_items.transaction_id           (0008)
--   payments.transaction_id                       (0009)
--   depreciation_schedules.transaction_id         (0009)
--   imported_transactions.matched_transaction_id  (0009)
--
-- 与 0016 修的是同一次疏忽的另一半：0008/0009 里所有外键都没写 on delete
-- 行为，0016 只扫描了单列 organization_id 那一批，这 6 条不在它的范围内。
-- 因此这条迁移照 0016 的做法按 pg_constraint 枚举，而不是逐个点名——
-- 点名正是当初漏掉它们的原因，也挡不住以后新加的表再漏一次。
--
-- ============================================================
-- 症状
-- ============================================================
-- 删除一家公司时，transactions 与这些子表各自沿着自己的 organization_id
-- （或父表）级联被删除。NO ACTION 的引用完整性检查和 CASCADE 一样都是
-- AFTER ROW 触发器，同在一条 delete 语句的触发器队列里；检查若排在子表那条
-- 级联删除之前跑，它看到的行还在，于是整句 delete 被顶回来：
--
--   update or delete on table "transactions" violates foreign key constraint
--   "depreciation_schedules_transaction_id_fkey" on table "depreciation_schedules"
--
-- 队列顺序对一份给定的 schema 是固定的，只是从代码这边完全看不出来。实测：
--   - depreciation_schedules 这条**确实会**顶回来（任务 6 写折旧用例时撞上，
--     tests/actions/fixed-assets-depreciation.test.ts 的 afterAll 因此要先
--     手工把 transaction_id 置空；那段在本迁移落地后可以删掉）；
--   - 而指向 accounts 的那批 NO ACTION 目前**不会**——整套测试每轮都在删含
--     accounts 与 journal_lines 的公司，从没因此失败过。
-- 也就是说其余 5 条是同一个形状的潜在雷，不是已观测到的故障。
--
-- ============================================================
-- 为什么六条都用 cascade，而不是 set null
-- ============================================================
-- 六列都可空，set null 在语法上都成立，所以逐条核过：
--
-- 1. 应用层从不硬删交易。全仓 grep `delete from transactions`（*.ts/*.tsx/*.sql）
--    零命中——作废是写 voided_at / voided_by，不是 delete。所以这条 cascade
--    只会在删公司时触发。
-- 2. 删公司时这六张子表本来就要没：五张有自己的 organization_id（0016 已补
--    cascade），depreciation_schedules 经 fixed_assets、reconciliation_items
--    经 bank_reconciliations，两条父边本来就是 cascade。
-- 3. set null 会留下一行「声称自己已过账、却指不出那笔账」的记录，而且每张表
--    都还有一个外键动作管不到的状态列，会跟着一起说谎：
--      depreciation_schedules.is_posted 仍是 true
--      invoices.status / bills.status    仍停在已过账的值
--      payments.voided_at                仍是空
--      reconciliation_items.is_cleared   仍是 true
--      imported_transactions.status      仍是 'matched'
--    最后一条尤其清楚：server/repositories/bank_import.ts 里应用自己的「取消
--    匹配」是两列一起改（status = 'pending', matched_transaction_id = null），
--    一个外键动作复现不了它，只能造出一个应用自己从不会写出的半截状态。
--
-- 六条没有一条更适合 set null，因此统一 cascade，末尾的断言也才能是全称的。
--
-- ============================================================
-- 这条迁移**不能**解锁 organization:delete
-- ============================================================
-- 同一次普查还查出：删公司时父子两边都会被删掉、却仍是 NO ACTION 的单列外键
-- 一共 33 条。指向 transactions 的这 6 条只是其中一小部分，另外 27 条指向
-- accounts(12)、contacts(6)、categories(2)、invoices(2)、tax_rates(2)、
-- bills(1)、inventory_items(1)、projects(1)。
--
--   跑完这条迁移，organization:delete 与阶段 1 spec 的 PDPA 删除仍然是堵着的。
--
-- 别把它当成 0016 的收尾。它只关掉由 transactions 引起的那一段，其余 27 条要
-- 另开任务、按 0016 的方式整图扫一遍，并且需要人先逐条判断哪些该 cascade、
-- 哪些该 set null——那超出任务 6 的范围。

do $$
declare
  target record;
begin
  for target in
    select
      c.conname                   as constraint_name,
      c.conrelid::regclass::text  as table_name,
      a.attname                   as column_name
    from pg_constraint c
    join pg_attribute a
      on a.attrelid = c.conrelid
     and a.attnum = c.conkey[1]
    where c.contype = 'f'
      and c.confrelid = 'transactions'::regclass
      and c.confdeltype <> 'c'          -- 'c' = cascade，跳过已经正确的
      and array_length(c.conkey, 1) = 1
  loop
    -- 不按列名过滤：六条里有一条叫 matched_transaction_id，
    -- 照 0016 那样写死 'transaction_id' 就会正好漏掉它。
    execute format(
      'alter table %s drop constraint %I',
      target.table_name, target.constraint_name
    );
    execute format(
      'alter table %s add constraint %I foreign key (%I) references transactions (id) on delete cascade',
      target.table_name, target.constraint_name, target.column_name
    );
    raise notice 'cascaded % on %', target.constraint_name, target.table_name;
  end loop;
end $$;

-- 断言：不应再有任何指向 transactions 的单列外键缺少 cascade。
do $$
declare
  offending int;
begin
  select count(*) into offending
  from pg_constraint c
  where c.contype = 'f'
    and c.confrelid = 'transactions'::regclass
    and c.confdeltype <> 'c'
    and array_length(c.conkey, 1) = 1;

  if offending > 0 then
    raise exception '% foreign keys into transactions still lack on delete cascade', offending;
  end if;
end $$;
