-- 0019: recurring_transactions."interval" 必须至少为 1。
--
-- 0008 建表时写的是 `interval integer not null default 1`，从来没有任何
-- CHECK 约束。表单上那个 Math.max(1, Number(...)) 是客户端夹取，直接调用
-- Server Action 就绕过去了；createRecurring / editRecurring 在此之前也只校验
-- 金额，不看这一列。
--
-- interval = 0 时 computeNextDueDate 的五个分支全部退化成恒等函数，到期日
-- 永远不推进。补记循环因此会把同一个日期记满单次上限那么多笔，每笔各带一个
-- 新的 client_uuid，postJournal 的幂等查询拦不住；写回的 next_due_date 又没变，
-- 所以再点一次就再来一批。一笔 1200 的月租能在一个月里变成 72000，而且借贷
-- 完全配平——数据库层的配平触发器看不出任何问题。
--
-- 应用层已经在 server/actions/recurring.ts 里加了两道闸门（写入时的
-- assertValidInterval，以及补记循环里「日期必须严格前进」的断言）。这条约束
-- 是把同一条规则钉进库里，让任何绕过应用层的写入路径也不可能造出这种行。
--
-- 先把已有的违规行归一到 1 再加约束，否则 ADD CONSTRAINT 会因为存量数据失败。
-- 归一到 1 而不是删除：这些规则是用户建的，间隔填坏了不该让规则连同它的
-- 借贷科目、金额、起止日期一起消失；改成「每 1 期一次」是最接近用户意图、
-- 且立刻恢复正常推进的取值。

update recurring_transactions
set "interval" = 1
where "interval" < 1;

alter table recurring_transactions
  add constraint recurring_transactions_interval_positive
  check ("interval" >= 1);
