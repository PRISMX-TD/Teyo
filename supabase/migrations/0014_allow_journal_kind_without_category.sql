-- 0014: 允许 kind = 'journal' 的交易不带 category_id。
--
-- 0007 给 transaction_kind 加了 'journal' 枚举值，但从未更新 0001 里的
-- transactions_category_matches_kind 约束——该约束至今仍然要求除 'transfer'
-- 外的所有 kind 必须有非空 category_id。Journal 分录（手工复式记账，见
-- server/actions/transactions.ts 的 createJournal；固定资产折旧过账，见
-- server/repositories/fixed_assets.ts 的 postDepreciation）从一开始写的就是
-- kind = 'journal' + category_id = null——调用方直接指定借贷两个科目，
-- 分类在这里没有意义，跟转账是同一道理。
--
-- 后果：这两条生产代码路径自 0007 上线以来，每一次插入都会撞上这条约束
-- 而失败（已用 information_schema/pg_constraint 核实：线上 transactions 表
-- 里 kind = 'journal' 的行数为 0，说明确实从未有一次成功过）。
--
-- 把 'journal' 并入 'transfer' 的分支：这两种 kind 都不带分类。

alter table transactions drop constraint transactions_category_matches_kind;

alter table transactions add constraint transactions_category_matches_kind check (
  (kind in ('transfer', 'journal') and category_id is null)
  or (kind not in ('transfer', 'journal') and category_id is not null)
);
