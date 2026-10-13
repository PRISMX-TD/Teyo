-- ============================================================
-- 0037  收付款记下钱进出的是哪个资金账户
-- ============================================================
-- payments 原来没有账户列，资金科目由 method 推：现金进 'cash'，其余一律进
-- 'bank'。一家公司在科目设置里另建了 Maybank、CIMB、PayPal 这样的户口，
-- 收付款也只会进系统自带的「银行」——真正收到钱的户口余额不动，按户口做的
-- 银行对账在那个户口里找不到这笔钱。把自带的「银行」停用了的公司更糟：钱
-- 照样记进那个已停用、任何下拉框里都看不到的科目。
--
-- 现在由用户在表单上选，存在这一列上（server/actions/payments.ts 的
-- createPayment，缺省值见 lib/payment-methods.ts）。
--
-- 可空，不是 not null：迁移先于新代码上线，中间那段时间旧代码写进来的行没有
-- 这一列的值；not null（哪怕是 not valid 的 check）会让那段时间的收付款全部
-- 失败。新代码每一行都写，读的一侧把 null 当「未记录」。

alter table payments add column if not exists money_account_id uuid;

-- ── 跨公司引用 ──
--
-- 与 0032 同一个做法：accounts 上的 (id, organization_id) 唯一约束 0032 已经
-- 建过，这里用复合外键把 organization_id 一起钉住——单列外键只保证「科目
-- 存在」，不保证是同一家公司的。
--
-- deferrable initially deferred：payments 在「删公司」的级联闭包里，闭包内的
-- 外键要么级联、要么延迟（0033，tests/db/rls-matrix.test.ts 钉住的规则）。
-- 不设 on delete：与 journal_lines_account_same_org 一致，科目被引用着就删不掉。
--
-- 「必须是资金账户」数据库层表达不了（外键指不到一个条件），由 createPayment
-- 的 getMoneyAccount 把关。

alter table payments add constraint payments_money_account_same_org
  foreign key (money_account_id, organization_id)
  references accounts (id, organization_id) deferrable initially deferred;

-- ── 回填 ──
--
-- 已有的收付款按它实际过账的那一笔分录补：主分录（payments.transaction_id）
-- 里挂在资金账户上的那一行。只认恰好一个资金账户的——一笔收付款只碰一个
-- 资金账户，碰到两个以上说明那不是它自己的分录，宁可留空也不猜。
--
-- 应用前已在远端库只读核对过：payments 现存 0 行。

update payments p
set money_account_id = m.account_id
from (
  select l.transaction_id, (array_agg(distinct l.account_id))[1] as account_id
  from journal_lines l
  join accounts a on a.id = l.account_id
  where a.is_money_account
  group by l.transaction_id
  having count(distinct l.account_id) = 1
) m
where m.transaction_id = p.transaction_id
  and p.money_account_id is null;

create index if not exists payments_by_money_account
  on payments (organization_id, money_account_id) where money_account_id is not null;
