-- ============================================================
-- 0035  账单也能挂附件
-- ============================================================
-- attachments 原来只能挂在交易上（transaction_id not null）。而最常见的一类
-- 凭证——供应商寄来的账单 PDF——恰恰属于账单本身：草稿账单还没有分录，
-- 已入账的账单改一次就重过一次账，挂在它生成的那笔分录上都不稳。
--
-- 做法：加一列可空的 bill_id，用 check 保证一份附件只属于一处。
--
-- 没有选 (entity_type, entity_id) 那种多态写法：那样 entity_id 上建不了外键，
-- 单据删除不会级联、跨公司引用也挡不住——而 0032 刚把这两件事在数据库层钉死。
-- 以后要给别的单据挂附件，照这里再加一列即可。

alter table attachments alter column transaction_id drop not null;
alter table attachments add column if not exists bill_id uuid;

alter table attachments add constraint attachments_single_owner
  check (num_nonnulls(transaction_id, bill_id) = 1);

-- ── 跨公司引用 ──
--
-- 与 0032 同一个做法：被引用表上加 (id, organization_id) 唯一约束，再用复合
-- 外键把 organization_id 一起钉住。transactions 那一侧的唯一约束 0032 已经
-- 建过。attachments.transaction_id 原来只校验「交易存在」，于是一行
-- organization_id 是 A 公司、transaction_id 指向 B 公司交易的附件在库里是
-- 合法的（tests/actions/attachments.test.ts 里那条跨公司用例的注释说的就是
-- 这件事）。
--
-- 应用前已在远端库只读核对过：attachments 现存 0 行、bills 现存 0 行，
-- 所以这里不需要 not valid / validate 两步走。
--
-- 两条都是 on delete cascade：附件随所属交易或账单一起删，与原来
-- attachments.transaction_id 的单列外键语义一致；也满足 0033 那条
-- 「删公司级联闭包里的外键要么级联、要么延迟」的规则。

alter table bills add constraint bills_id_org_key unique (id, organization_id);

alter table attachments add constraint attachments_txn_same_org
  foreign key (transaction_id, organization_id)
  references transactions (id, organization_id) on delete cascade;

alter table attachments add constraint attachments_bill_same_org
  foreign key (bill_id, organization_id)
  references bills (id, organization_id) on delete cascade;

create index if not exists attachments_by_bill
  on attachments (bill_id) where bill_id is not null;
