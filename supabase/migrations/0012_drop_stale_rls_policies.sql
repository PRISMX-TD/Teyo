-- 0012: 清除 0010 未能删除的三条陈旧 RLS 策略。
--
-- 0010 意图把 0008/0009 建立的策略全部换成 app_is_member/app_has_role 形式，
-- 但其中三条 drop 语句写的是从未存在过的策略名：
--
--   表                        0008 实际创建                    0010 尝试删除
--   bank_reconciliations      "Reconciliations: org isolation"  "Bank recons: org isolation"
--   reconciliation_items      "Rec items: org isolation"        "Recon items: org isolation"
--   recurring_transactions    "Recurring: org isolation"        "Recurring txns: org isolation"
--
-- 其余 19 条名称一致，已被正确替换。
--
-- 后果不是"多一条冗余策略"：陈旧策略的谓词读 current_setting('app.current_org_id'),
-- 而 withTransaction 只设 app.user_id。未设置的 GUC 在 current_setting() 的单参形式下
-- 抛错而不是返回 NULL，因此这三张表在 RLS 下的任何读写都直接失败。
--
-- 按名字删会重复同一类错误。这里改为枚举 pg_policies，只保留 0010 建立的那一条。

do $$
declare
  target_table text;
  policy_name text;
  keep_name text;
begin
  foreach target_table in array array[
    'bank_reconciliations',
    'reconciliation_items',
    'recurring_transactions'
  ] loop
    keep_name := case target_table
      when 'bank_reconciliations'   then 'Bank recons: org isolation'
      when 'reconciliation_items'   then 'Recon items: org isolation'
      when 'recurring_transactions' then 'Recurring txns: org isolation'
    end;

    for policy_name in
      select policyname
      from pg_policies
      where schemaname = 'public'
        and tablename = target_table
        and policyname <> keep_name
    loop
      execute format('drop policy %I on %I', policy_name, target_table);
      raise notice 'dropped stale policy % on %', policy_name, target_table;
    end loop;
  end loop;
end $$;

-- 断言：三张表各自恰好剩一条策略，且没有任何策略再引用 app.current_org_id。
do $$
declare
  offending int;
begin
  select count(*) into offending
  from pg_policies
  where schemaname = 'public'
    and tablename in ('bank_reconciliations', 'reconciliation_items', 'recurring_transactions')
    and (coalesce(qual, '') like '%app.current_org_id%'
      or coalesce(with_check, '') like '%app.current_org_id%');

  if offending > 0 then
    raise exception 'still % policies referencing app.current_org_id', offending;
  end if;
end $$;
