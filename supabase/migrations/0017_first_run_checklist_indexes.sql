-- 0017: 首次引导清单在仪表盘每次加载时都会对 contacts 与 invitations
-- 做一次按 organization_id 的存在性查询（server/repositories/dashboard.ts
-- 的 getFirstRunChecklistState）。这两张表目前都没有能用上的索引：
--
--   - contacts 完全没有索引，任何按 organization_id 的查询都是顺序扫描。
--   - invitations 唯一的索引是 invitations_pending_unique，一个
--     partial unique index（只覆盖 accepted_at is null and revoked_at
--     is null 的行）。我们的查询不带这两个过滤条件，Postgres 无法把它当
--     索引条件的子集来用，同样会退化成顺序扫描。
--
-- getFirstRunChecklistState 已经按角色跳过没有权限看到对应清单项的查询
-- （只有 account:manage / member:manage 持有者，也就是 owner/admin，
-- 才会真的发出这两条查询），缩小了受影响的请求范围，但没有消除扫描本身——
-- owner 通常是每家公司打开仪表盘最频繁的角色。补上这两个索引让查询回到
-- 索引扫描。

create index contacts_by_org on contacts (organization_id);
create index invitations_by_org on invitations (organization_id);
