-- 0018: server/repositories/categories.ts 的 listRecentCategories（Task 15）
-- 在交易录入页每次加载时都跑一次，是全应用写入最频繁的一个页面。查询按
-- t.category_id 连接 categories 与 transactions，并过滤 t.voided_at is null
-- 和 t.occurred_on >= current_date - interval '90 days'，但查询本身不带
-- t.organization_id 过滤条件（组织范围完全靠 categories 一侧的
-- c.organization_id 过滤，再通过外键连接传导到 transactions）。
--
-- transactions 表现有的索引都帮不上这个连接：
--   - transactions_by_category (organization_id, category_id) 以
--     organization_id 打头，而这条查询在 transactions 一侧根本不带这个
--     过滤条件，Postgres 无法把它当成 category_id 的等值索引来用。
--   - transactions_by_org_date (organization_id, occurred_on desc, ...)
--     同样以 organization_id 打头，且不含 category_id。
--
-- 结果是这个连接退化成对 transactions 全表（跨所有公司）的顺序扫描，
-- 每次有人打开录入页就要扫一遍——这张表恰恰是全库增长最快的一张。
--
-- category_id 本身已经能把范围收窄到单个公司（categories.id 是全局唯一
-- 的 uuid，一个分类只属于一家公司），所以以 category_id 打头、覆盖
-- occurred_on 用于范围过滤、只包含未作废行的局部索引，正好对上这条查询：
-- 对 categories 一侧筛出的少数几个分类（通常不到三十个）逐个做索引查找，
-- 而不是扫全表。
--
-- 未应用：迁移按批次由人工执行，这里只是把索引定义留档。

create index if not exists transactions_by_category_recent on transactions (category_id, occurred_on)
  where voided_at is null;
