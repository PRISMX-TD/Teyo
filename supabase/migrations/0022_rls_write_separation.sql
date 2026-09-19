-- 0022: 把 0010 那 22 条 `for all` 策略拆成按动作分开的策略，
--        并补齐阻塞 organization:delete 的外键删除行为。
--
-- 与 0021 没有依赖关系：本文件只碰 RLS 策略与外键约束，不碰 0021 新增的
-- 任何列（bills.subtotal_minor / credit_notes.transaction_id / 三个新科目）。
-- 两条迁移谁先跑都一样。
--
-- ============================================================
-- P0：`for all` 让任何成员——包括 viewer——都能 DELETE 这 22 张表
-- ============================================================
-- 0010 把 22 张表统一改成了这个形状：
--
--   create policy "X: org isolation" on X for all
--     using (app_is_member(organization_id))
--     with check (app_has_role(organization_id, array['owner','admin']));
--
-- 读起来像是「成员可读，owner/admin 可写」。但 DELETE **只检查 USING，
-- 不检查 WITH CHECK**——WITH CHECK 约束的是「写进去的新行长什么样」，而
-- DELETE 不产生新行。于是这条策略对 DELETE 的实际含义是
-- 「任何 status='active' 的成员都可以删」。
--
--   以 teyo_app 身份、带着一个 viewer 的 app.user_id：
--     delete from contacts where organization_id = <自己公司>;   -- 成功
--     delete from invoices  where organization_id = <自己公司>;   -- 成功
--
-- 线上普查（select ... from pg_policies）确认 22 条全是这个形状，
-- 且全部是 `to public` 而不是 0002 用的 `to teyo_app`。
--
-- 拆开写之后，每个动作各有一条策略，DELETE 那一条的 USING 才真正是删除
-- 的闸门。哪些表根本不建 delete 策略、为什么，见下面「删除权限的分配」。
--
-- ============================================================
-- P1：应用层权限矩阵与数据库策略此前是两套互不知情的规则
-- ============================================================
-- 0010 的 with check 一律写 owner/admin，而应用层 server/actions/ 那边：
--
--   payments.ts / credit_notes.ts / recurring.ts / bank_import.ts
--       要 transaction:create —— 记账员有 —— 数据库却只认 owner/admin。
--       结果：记账员点「记录收款」，应用层放行、RLS 拒绝，用户看到的是
--       一句裸的 Postgres 报错。记账员记收付款正是这个角色的工作内容。
--
--   invoices.ts / bills.ts
--       要 transaction:read —— **viewer 也有** —— 唯一挡住 viewer 开发票的
--       只有 RLS 的 with check。应用层这一侧是别的任务的文件，本迁移不动，
--       但数据库这一侧放宽到包含 bookkeeper 之后，viewer 仍然被挡住。
--
-- 本迁移把角色数组与 server/domain/permissions.ts 的 Action 逐一对应：
--
--   permissions.ts 的 Action        角色集合                      本文件用在
--   ------------------------------  ----------------------------  --------------------------
--   document:read                   owner, admin, bookkeeper,     所有 select
--                                   viewer  （= app_is_member）
--   document:create                 owner, admin, bookkeeper      单据与明细的 insert
--   document:edit                   owner, admin, bookkeeper      单据与明细的 update / 明细的 delete
--   document:delete                 （空集）                       不建 delete 策略
--   masterdata:manage               owner, admin                  主数据的 insert / update
--
-- select 用 app_is_member(organization_id) 而不是列出四个角色：
-- 成员必然持有四个角色之一，两种写法等价，而 app_is_member 与 0002 同形，
-- 也少一次数组比较。tests/db/rls-matrix.test.ts 会断言
-- rolesFor('document:read') 确实等于全部四个角色，等价关系不会悄悄失效。
--
-- ============================================================
-- 删除权限的分配：为什么绝大多数表干脆没有 delete 策略
-- ============================================================
-- 参照 0002 对 transactions 的处理（「不提供 delete 策略：软删除通过 update
-- 完成，硬删除在数据库层就不可能」），并按 `grep -rn "delete from" server/`
-- 的实际结果分配，而不是按直觉：
--
--   全仓对这 22 张表的硬删除只有五处，全部是「删了重写」或「清理暂存」：
--     invoices.ts:246 / bills.ts:215 / purchase_orders.ts:180 /
--     credit_notes.ts:248        —— 改单据时整批重写明细
--     bank_import.ts:157         —— 清理未匹配的导入暂存行
--
--   其余全部软删除：单据有 voided_at，主数据有 is_active。
--   repositories/tax.ts 的 deleteTaxRate 名字叫 delete，实现却是先查引用
--   再 `update tax_rates set is_active = false`——应用层自己就没打算真删。
--
-- 于是：
--   a) 单据（invoices/bills/payments/credit_notes/purchase_orders）
--      与 bank_reconciliations / inventory_transactions / recurring_transactions
--      → **不建 delete 策略**。作废是 update voided_at，停用是 update is_active。
--   b) 主数据（contacts/tax_rates/projects/inventory_items/budgets/fixed_assets/
--      depreciation_schedules）
--      → **同样不建 delete 策略**。这一条比「给 owner/admin」更严：
--        给一个没有任何调用方的能力，换来的只是攻击面。真要硬删主数据，
--        那个功能自己带一条迁移来，顺便把「引用还在时怎么办」一起想清楚。
--        今天的引用保护来自外键（见下半部分），不来自 RLS。
--   c) 六张明细表 + imported_transactions
--      → delete 给 owner/admin/bookkeeper，与它们的 update 同一组角色。
--        明细表统一给（哪怕 payment_items 今天没有调用方）：删了重写是明细表
--        的通用模式，留一处例外只会让下一个人在加「编辑收款」时撞上一句裸的
--        RLS 报错，而那正是本次要根除的那类故障。
--
-- 不用 `revoke delete on ... from teyo_app`（0002 对 audit_logs 的手法）：
-- audit_logs 的不可篡改是绝对的、与组织和角色无关，表权限是对的层；
-- 单据的删除权限是按公司、按角色的，那是 RLS 的层。混用会让「为什么删不掉」
-- 出现两个都对但不在一处的答案。
--
-- ============================================================
-- 这条迁移没有解决什么
-- ============================================================
-- 1. 应用层的错配仍然存在，因为那些文件属于别的任务：
--      server/actions/invoices.ts / bills.ts 仍然用 transaction:read 守卫
--      「创建」与「作废」——viewer 在应用层仍然能走到 RLS 才被挡下。
--      应改成 document:create / document:edit。
--      server/actions/purchase_orders.ts / fixed_assets.ts / inventory.ts /
--      projects.ts / contacts.ts / budgets.ts / tax.ts 用的 account:manage
--      角色集合恰好等于 masterdata:manage，行为不变，改名是可选的。
--      server/actions/recurring.ts 的编辑用 transaction:edit:any（owner/admin），
--      比数据库严；这是安全方向的不对称，不会产生裸报错。
-- 2. 不做行级细分。0002 给 transactions 的 bookkeeper 加了
--    `created_by = app_current_user_id()`，这批表没有对应的「只能改自己开的
--    发票」规则，本迁移也不发明一条——那是产品决定，不是修 bug。
-- 3. organization:delete 仍然没有实现。本迁移只是把数据库这一侧的障碍清掉。
--
-- ============================================================

-- ------------------------------------------------------------
-- 一、策略：按动作拆开重建
-- ------------------------------------------------------------
-- 不按猜的名字 drop：0010 正是因为写了三个从未存在过的策略名，留下三张表的
-- 旧策略没删掉，任何读写都直接失败，最后要 0012 来补。这里对每张表枚举
-- pg_policies 按实际名字全部删掉，再重建——顺带让这条迁移可以重复执行。
do $$
declare
  t          record;
  c          record;
  stale      text;
  read_pred  text;
  write_pred text;
begin
  for t in
    select * from (values
      -- 表名,                   父表,                   父外键,               insert 角色,                   update 角色,                   delete 角色（null = 不建策略）
      ('contacts',               null,                   null,                 '{owner,admin}',               '{owner,admin}',               null),
      ('tax_rates',              null,                   null,                 '{owner,admin}',               '{owner,admin}',               null),
      ('projects',               null,                   null,                 '{owner,admin}',               '{owner,admin}',               null),
      ('inventory_items',        null,                   null,                 '{owner,admin}',               '{owner,admin}',               null),
      ('budgets',                null,                   null,                 '{owner,admin}',               '{owner,admin}',               null),
      ('fixed_assets',           null,                   null,                 '{owner,admin}',               '{owner,admin}',               null),
      ('depreciation_schedules', 'fixed_assets',         'fixed_asset_id',     '{owner,admin}',               '{owner,admin}',               null),
      ('invoices',               null,                   null,                 '{owner,admin,bookkeeper}',    '{owner,admin,bookkeeper}',    null),
      ('bills',                  null,                   null,                 '{owner,admin,bookkeeper}',    '{owner,admin,bookkeeper}',    null),
      ('payments',               null,                   null,                 '{owner,admin,bookkeeper}',    '{owner,admin,bookkeeper}',    null),
      ('credit_notes',           null,                   null,                 '{owner,admin,bookkeeper}',    '{owner,admin,bookkeeper}',    null),
      ('purchase_orders',        null,                   null,                 '{owner,admin,bookkeeper}',    '{owner,admin,bookkeeper}',    null),
      ('bank_reconciliations',   null,                   null,                 '{owner,admin,bookkeeper}',    '{owner,admin,bookkeeper}',    null),
      ('recurring_transactions', null,                   null,                 '{owner,admin,bookkeeper}',    '{owner,admin,bookkeeper}',    null),
      ('inventory_transactions', null,                   null,                 '{owner,admin,bookkeeper}',    '{owner,admin,bookkeeper}',    null),
      ('imported_transactions',  null,                   null,                 '{owner,admin,bookkeeper}',    '{owner,admin,bookkeeper}',    '{owner,admin,bookkeeper}'),
      ('invoice_items',          'invoices',             'invoice_id',         '{owner,admin,bookkeeper}',    '{owner,admin,bookkeeper}',    '{owner,admin,bookkeeper}'),
      ('bill_items',             'bills',                'bill_id',            '{owner,admin,bookkeeper}',    '{owner,admin,bookkeeper}',    '{owner,admin,bookkeeper}'),
      ('po_items',               'purchase_orders',      'po_id',              '{owner,admin,bookkeeper}',    '{owner,admin,bookkeeper}',    '{owner,admin,bookkeeper}'),
      ('payment_items',          'payments',             'payment_id',         '{owner,admin,bookkeeper}',    '{owner,admin,bookkeeper}',    '{owner,admin,bookkeeper}'),
      ('credit_note_items',      'credit_notes',         'credit_note_id',     '{owner,admin,bookkeeper}',    '{owner,admin,bookkeeper}',    '{owner,admin,bookkeeper}'),
      ('reconciliation_items',   'bank_reconciliations', 'reconciliation_id',  '{owner,admin,bookkeeper}',    '{owner,admin,bookkeeper}',    '{owner,admin,bookkeeper}')
    ) as v(tbl, parent_tbl, parent_fk, ins_roles, upd_roles, del_roles)
  loop
    for stale in
      select policyname from pg_policies
      where schemaname = 'public' and tablename = t.tbl
    loop
      execute format('drop policy %I on %I', stale, t.tbl);
      raise notice 'dropped policy % on %', stale, t.tbl;
    end loop;

    -- 读：成员皆可。明细表没有自己的 organization_id，经父表子查询约束。
    if t.parent_tbl is null then
      read_pred := 'app_is_member(organization_id)';
    else
      read_pred := format(
        '%I in (select id from %I where app_is_member(organization_id))',
        t.parent_fk, t.parent_tbl
      );
    end if;

    -- 显式写 `to teyo_app` 而不是沿用 0010 的 `to public`：
    -- 与 0002 同一约定，且让「哪个角色适用哪条策略」在 pg_policies 里一眼可见。
    execute format(
      'create policy %I on %I for select to teyo_app using (%s)',
      t.tbl || '_select', t.tbl, read_pred
    );

    for c in
      select * from (values
        ('insert', t.ins_roles),
        ('update', t.upd_roles),
        ('delete', t.del_roles)
      ) as x(cmd, roles)
    loop
      continue when c.roles is null;

      if t.parent_tbl is null then
        write_pred := format(
          'app_has_role(organization_id, %L::membership_role[])', c.roles
        );
      else
        write_pred := format(
          '%I in (select id from %I where app_has_role(organization_id, %L::membership_role[]))',
          t.parent_fk, t.parent_tbl, c.roles
        );
      end if;

      if c.cmd = 'insert' then
        -- insert 只有 with check：没有既有行可供 using 过滤。
        execute format(
          'create policy %I on %I for insert to teyo_app with check (%s)',
          t.tbl || '_insert', t.tbl, write_pred
        );
      elsif c.cmd = 'update' then
        -- using 与 with check 写同一个谓词：前者管「能改哪些行」，
        -- 后者管「改完之后还能不能留在这里」。两者不同就会出现
        -- 「能把自家单据改到别人公司名下」或反之。
        execute format(
          'create policy %I on %I for update to teyo_app using (%s) with check (%s)',
          t.tbl || '_update', t.tbl, write_pred, write_pred
        );
      else
        -- delete 只有 using——这正是 0010 的 `for all` 漏掉的那一半。
        execute format(
          'create policy %I on %I for delete to teyo_app using (%s)',
          t.tbl || '_delete', t.tbl, write_pred
        );
      end if;
    end loop;
  end loop;
end $$;

-- ------------------------------------------------------------
-- 二、外键：把「删公司」真正解锁
-- ------------------------------------------------------------
-- 0016 修了 organization_id 那一批，0020 修了指向 transactions 的 6 条，
-- 0020 自己在注释里点名还剩 27 条。
--
-- 线上普查（本迁移写作时）发现一件 0020 无法预见的事：
--   schema_migrations 里 0001..0020 全部是 baselined = true，也就是「效果已
--   经在库里，不是迁移器跑的」。但库里
--     - 指向 transactions 的 6 条外键仍然全是 NO ACTION（0020 未生效）
--     - recurring_transactions_interval_positive 约束不存在（0019 未生效）
--     - 索引名仍是手工建的 transactions_recent_by_category（0018 未生效）
--   也就是说 baseline 的范围划大了：0018/0019/0020 被记成已应用，实际没跑，
--   而 `migrate.mjs up` 只看记录，永远不会再跑它们。
--
-- 因此下面第 1 步把 0020 的动作原样重做一遍。它是幂等的（已经是 cascade 的
-- 会被 `confdeltype <> 'c'` 跳过），所以即使哪天有人把 0020 的 baseline 记录
-- 清掉重跑，两条迁移也不会互相打架。
--
-- 这里刻意**不重新裁决** 0020 已经做过的判断。0020 逐条论证了那 6 条为什么
-- 是 cascade 而不是 set null，理由（应用层从不硬删交易，删公司时这六张子表
-- 本来就要没）到今天仍然成立；在邻近迁移的任务里把它改成别的语义，只会让
-- 0020 的文件变成一段与事实不符的说明。

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
      and c.confdeltype <> 'c'
      and array_length(c.conkey, 1) = 1
  loop
    execute format(
      'alter table %s drop constraint %I',
      target.table_name, target.constraint_name
    );
    execute format(
      'alter table %s add constraint %I foreign key (%I) references transactions (id) on delete cascade',
      target.table_name, target.constraint_name, target.column_name
    );
    raise notice '0020 replay: cascaded % on %', target.constraint_name, target.table_name;
  end loop;
end $$;

-- 2. 其余 27 条：改成延迟检查，而不是 cascade。
--
-- ------------------------------------------------------------
-- 为什么不是 cascade
-- ------------------------------------------------------------
-- 这 27 条的两端都在「删公司会被清空」的闭包里，形状是
--   journal_lines.account_id      -> accounts
--   invoices.contact_id           -> contacts
--   transactions.category_id      -> categories
--   transactions.project_id       -> projects        （0016 与 0020 都没覆盖这条）
--   ... 共 27 条，指向 accounts(12) / contacts(6) / categories(2) /
--       invoices(2) / tax_rates(2) / bills(1) / inventory_items(1) / projects(1)
--
-- 给它们加 cascade 的含义是：
--   删一个科目 → 引用它的分录行一起消失。
--   删一个客户 → 他名下的发票、账单、收付款、贷项通知单、采购单一起消失。
--
-- 第一条尤其致命。复式记账里分录行是账本本身；删掉一笔交易的一条腿，另一条
-- 腿还在，这笔交易就永久不配平了。0001 的 journal_lines_balanced 是
-- `deferrable initially deferred` 的约束触发器，提交时才校验，届时会抛
-- 「Transaction % is unbalanced」——也就是说 cascade 在这里连「安静地做错事」
-- 都做不到，它会换来一个指向完全无关位置的报错。而如果整笔交易恰好都被删净，
-- 那就是安静地毁账。
--
-- 应用层也从不硬删这些父表：contacts / tax_rates / projects / inventory_items
-- / accounts / categories 全部走 is_active 归档（repositories/tax.ts 的
-- deleteTaxRate 甚至是先查引用再置 is_active = false）。所以今天挡住这类误删的
-- 唯一东西就是这 27 条 NO ACTION 外键，把它们改成 cascade 等于把仅有的护栏拆了。
--
-- ------------------------------------------------------------
-- 那 NO ACTION 为什么会挡住删公司
-- ------------------------------------------------------------
-- 照 0020 的诊断：NO ACTION 的引用完整性检查和 CASCADE 一样都是 AFTER ROW
-- 触发器，同在一条 delete 语句的触发器队列里。删公司时父子两边各自沿
-- organization_id 级联删除，检查若排在子表那条级联之前跑，它看到的行还在，
-- 整句 delete 就被顶回来。队列顺序对一份给定的 schema 是固定的，但完全取决于
-- 约束的建立顺序——0008/0009 里哪一列先写，今天就决定了哪家公司删得掉。
--
-- ------------------------------------------------------------
-- deferrable initially deferred 同时满足两边
-- ------------------------------------------------------------
-- 把检查推迟到提交时：
--   删公司   —— 提交时父行与子行都已经没了，检查通过。与触发器队列顺序无关，
--               所以不是「碰巧能跑通」，是结构上不可能再被顺序影响。
--   删单个科目 / 单个客户 —— 提交时子行仍在，照样抛 23503 被拒绝。保护不变，
--               只是报错时机从语句结束挪到事务提交。
--
-- 这不是引进一个新概念：0001 的 journal_lines_balanced 用的就是同一个机制，
-- 理由也一样（「借贷平衡：延迟到事务提交时校验」）。
--
-- 唯一的行为差异是报错时机：违规现在在 COMMIT 时抛出，语句级的 try/catch
-- 接不到。核过全仓，没有任何地方依赖这一点——
-- `grep -rn "23503\|foreign_key_violation" server/ lib/ app/` 零命中，
-- repositories/tax.ts 的 deleteTaxRate 也是自己先查引用再动手，不靠外键报错。
-- withTransaction 的调用方仍然照常收到异常，只是它来自提交而不是那条语句。
--
-- 用 `alter constraint` 而不是 drop + add：前者只改系统表，后者要在表上重新
-- 全量校验一遍外键。语义上两者等价，代价差一个数量级。
--
-- 闭包用递归 CTE 现算，不写死表名：只要一张新表挂在任何一条 cascade 链下面，
-- 它就自动进入这条规则的管辖范围，末尾的断言也才能是全称的。

do $$
declare
  target record;
begin
  for target in
    with recursive cascading(tbl) as (
      select 'organizations'::regclass as tbl
      union
      select c.conrelid::regclass
      from pg_constraint c
      join cascading p on p.tbl = c.confrelid::regclass
      where c.contype = 'f'
        and c.confdeltype = 'c'
    )
    select
      c.conname                  as constraint_name,
      c.conrelid::regclass::text as table_name
    from pg_constraint c
    where c.contype = 'f'
      and c.conrelid in (select tbl from cascading)
      and c.confrelid in (select tbl from cascading)
      and c.confdeltype <> 'c'
      and not c.condeferrable
  loop
    execute format(
      'alter table %s alter constraint %I deferrable initially deferred',
      target.table_name, target.constraint_name
    );
    raise notice 'deferred % on %', target.constraint_name, target.table_name;
  end loop;
end $$;

-- ------------------------------------------------------------
-- 三、断言：这几类问题以后不能再犯
-- ------------------------------------------------------------

-- 断言 1（本迁移的核心）：不存在任何 `for all` 且 USING 宽于 WITH CHECK 的策略。
--
-- 判据是「cmd = ALL 且 with_check 与 qual 不同」。对 `for all` 策略，
-- SELECT 与 DELETE 只走 qual，INSERT 只走 with_check，UPDATE 两者都走；
-- 两个谓词一旦不同，宽的那个就会漏给 DELETE。0002 现存的 `for all` 策略
-- （accounts_write / categories_write / journal_lines_write /
--  attachments_write / invitations_manage / app_users_self）两侧逐字相同，
-- 因此本断言对它们成立，不需要为它们开例外。
do $$
declare
  offending text;
begin
  select string_agg(format('%s.%s', tablename, policyname), ', ')
  into offending
  from pg_policies
  where schemaname = 'public'
    and cmd = 'ALL'
    and with_check is not null
    and with_check is distinct from qual;

  if offending is not null then
    raise exception
      '"for all" policies whose USING is wider than their WITH CHECK (DELETE would escape): %',
      offending;
  end if;
end $$;

-- 断言 2：22 张表每张都齐了 select / insert / update 三条策略。
-- 少一条的后果不是「宽松」而是「完全不能用」——没有 select 策略的表读出来是空的。
do $$
declare
  missing text;
begin
  select string_agg(format('%s:%s', t.tbl, c.cmd), ', ')
  into missing
  from (values
    ('contacts'), ('tax_rates'), ('projects'), ('inventory_items'), ('budgets'),
    ('fixed_assets'), ('depreciation_schedules'), ('invoices'), ('bills'),
    ('payments'), ('credit_notes'), ('purchase_orders'), ('bank_reconciliations'),
    ('recurring_transactions'), ('inventory_transactions'), ('imported_transactions'),
    ('invoice_items'), ('bill_items'), ('po_items'), ('payment_items'),
    ('credit_note_items'), ('reconciliation_items')
  ) as t(tbl)
  cross join (values ('SELECT'), ('INSERT'), ('UPDATE')) as c(cmd)
  where not exists (
    select 1 from pg_policies p
    where p.schemaname = 'public' and p.tablename = t.tbl and p.cmd = c.cmd
  );

  if missing is not null then
    raise exception 'tables missing per-command policies: %', missing;
  end if;
end $$;

-- 断言 3：DELETE 策略只出现在允许硬删的表上。
-- 这一条与断言 1 合起来才是全称的：断言 1 保证没有 `for all` 偷偷放行删除，
-- 断言 3 保证显式的 delete 策略没有多给。
do $$
declare
  unexpected text;
begin
  select string_agg(format('%s.%s', tablename, policyname), ', ')
  into unexpected
  from pg_policies
  where schemaname = 'public'
    and cmd = 'DELETE'
    and tablename not in (
      -- 本迁移有意给出的 7 张
      'imported_transactions', 'invoice_items', 'bill_items', 'po_items',
      'payment_items', 'credit_note_items', 'reconciliation_items',
      -- 0002 原有的 2 张（owner 可解散公司 / 移除成员）
      'organizations', 'memberships'
    );

  if unexpected is not null then
    raise exception 'unexpected DELETE policies: %', unexpected;
  end if;
end $$;

-- 断言 4：没有任何策略再授予 PUBLIC。
-- 0010 的 22 条全是 `to public`；那既不是 0002 的约定，也让人无法从
-- pg_policies 一眼看出策略到底管着谁。
do $$
declare
  public_policies text;
begin
  select string_agg(format('%s.%s', tablename, policyname), ', ')
  into public_policies
  from pg_policies
  where schemaname = 'public' and 'public' = any (roles);

  if public_policies is not null then
    raise exception 'policies still granted to PUBLIC instead of teyo_app: %', public_policies;
  end if;
end $$;

-- 断言 5：删公司闭包内不存在既非 cascade、又非延迟检查的外键。
-- 这是 organization:delete 与 PDPA 删除能否落地的充要条件（就数据库这一侧而言）。
do $$
declare
  offending int;
begin
  with recursive cascading(tbl) as (
    select 'organizations'::regclass as tbl
    union
    select c.conrelid::regclass
    from pg_constraint c
    join cascading p on p.tbl = c.confrelid::regclass
    where c.contype = 'f'
      and c.confdeltype = 'c'
  )
  select count(*)
  into offending
  from pg_constraint c
  where c.contype = 'f'
    and c.conrelid in (select tbl from cascading)
    and c.confrelid in (select tbl from cascading)
    and c.confdeltype <> 'c'
    and not c.condeferrable;

  if offending > 0 then
    raise exception
      '% foreign keys inside the organization-delete closure are neither cascading nor deferrable',
      offending;
  end if;
end $$;

-- 断言 6：0020 声称的不变量在库里成立。
-- 0020 被 baseline 成「已应用」却没有真的跑过；这条断言让它的文件从此与事实一致。
do $$
declare
  offending int;
begin
  select count(*)
  into offending
  from pg_constraint c
  where c.contype = 'f'
    and c.confrelid = 'transactions'::regclass
    and c.confdeltype <> 'c'
    and array_length(c.conkey, 1) = 1;

  if offending > 0 then
    raise exception '% foreign keys into transactions still lack on delete cascade', offending;
  end if;
end $$;

-- 断言 7：audit_logs 的不可篡改没有被本迁移碰坏。
-- 本迁移不动 audit_logs，但它是唯一一处靠表权限而非策略保证的不变量，
-- 顺手钉住比事后发现便宜。
do $$
declare
  leaked text;
begin
  select string_agg(privilege_type, ', ')
  into leaked
  from information_schema.role_table_grants
  where grantee = 'teyo_app'
    and table_schema = 'public'
    and table_name = 'audit_logs'
    and privilege_type in ('UPDATE', 'DELETE');

  if leaked is not null then
    raise exception 'teyo_app regained % on audit_logs', leaked;
  end if;
end $$;
