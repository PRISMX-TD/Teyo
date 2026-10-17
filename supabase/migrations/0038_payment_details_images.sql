-- ============================================================
-- 0038  收款信息里可以放图片
-- ============================================================
-- 收款信息（0034 的 payment_details）原来只能写字。可很多公司给客户的就是
-- 一张图：DuitNow / 银行的收款二维码、加密钱包地址的二维码。客户拿手机一扫
-- 就付，比照着一串 TRC20 地址一个字一个字抄要可靠得多。
--
-- 存成一个路径数组而不是另开一张表：图片只属于这家公司的收款信息，没有自己
-- 的生命周期，也不会被别处引用；最多三张，按添加的先后印在发票上。
--
-- 对象放在 0034 的 branding bucket 里，路径形如
-- <organization_id>/payment-<uuid>.<ext>——首段是公司 id，那个 bucket 的三条
-- Storage 策略照样适用，大小（1MB）与类型（PNG / JPG / WebP，不收 SVG）也由
-- 它在 Storage 那一层再挡一次。
--
-- not null default '{}'：旧代码不读这一列，加上它不影响迁移与新代码上线之间
-- 那段时间。

alter table organizations
  add column if not exists payment_image_paths text[] not null default '{}';

-- 上限与 lib/upload-rules.ts 的 MAX_PAYMENT_IMAGES 一致。应用层在加锁之后
-- 先判，这一条是两个人同时贴图时的最后一道。
alter table organizations add constraint organizations_payment_images_max
  check (cardinality(payment_image_paths) <= 3);

comment on column organizations.payment_image_paths is
  '收款信息里的图片（收款二维码等），branding bucket 里的对象路径，按添加顺序，最多 3 张。印在发票的收款信息下面。';
