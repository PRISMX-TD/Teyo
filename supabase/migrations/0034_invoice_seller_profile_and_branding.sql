-- ============================================================
-- 0034  发票上的卖方资料与公司 logo
-- ============================================================
-- 可打印发票（app/(app)/[orgSlug]/invoices/[id]/print）此前只印得出开票方的
-- 公司名与地址。一张寄给马来西亚客户的发票，对方通常还要看到：
--
--   registration_number  公司注册号（SSM）
--   tax_number           税务登记号（SST 注册号或 TIN）
--   phone / email        联系方式
--   payment_details      收款信息（银行、户名、账号），客户照着付款
--   logo_path            logo 在 branding bucket 里的对象路径
--
-- 全部可空，理由与 0026 的 address 相同：已有的公司不该因为这几列而变成
-- 「资料不完整」，填不填由用户在「公司资料」里决定。长度上限由
-- lib/schemas.ts 的 updateOrgSchema 管，与 address 一致。

alter table organizations add column if not exists registration_number text;
alter table organizations add column if not exists tax_number text;
alter table organizations add column if not exists phone text;
alter table organizations add column if not exists email text;
alter table organizations add column if not exists payment_details text;
alter table organizations add column if not exists logo_path text;

comment on column organizations.registration_number is
  '公司注册号（SSM），印在发票上。可空。';
comment on column organizations.tax_number is
  '税务登记号（SST 注册号或 TIN），印在发票上。可空。';
comment on column organizations.payment_details is
  '收款信息（银行、户名、账号），印在发票底部。可空。';
comment on column organizations.logo_path is
  'branding bucket 里的对象路径，形如 <organization_id>/logo-<uuid>.<ext>。可空。';

-- ── logo 的存储 ──
--
-- 不和收据共用 receipts bucket：收据要收 10MB 的 PDF 与 HEIC，logo 只该是
-- 一张小图。分开之后 Storage 自己就会拒掉超限的文件，不只靠应用层那一道。
--
-- 不收 SVG。SVG 是可以夹带 <script> 的 XML，签名 URL 在浏览器里直接打开时
-- 它会在 Supabase 的域名下执行——一张「logo」就成了一段别人能点开的脚本。
--
-- 私有 bucket，打印页按需取短时效签名 URL。logo 本身谈不上机密，但公开
-- bucket 的地址一旦给出去就永久可读，而路径首段是公司 id——没有理由让它
-- 成为一个可以从外面枚举公司的入口。
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'branding',
  'branding',
  false,
  1048576,
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 与 0006 的 receipts 策略同一个形状：路径首段是 organization_id。
-- 应用实际经 service role 写入（lib/supabase/storage.ts），授权在
-- server/actions/organizations.ts 里做；这三条是 teyo_app 直连时的兜底。
-- 写入的角色与 account:manage 一致（owner / admin），也就是能改公司资料的人。

create policy branding_read on storage.objects
  for select to teyo_app
  using (
    bucket_id = 'branding'
    and app_is_member(((storage.foldername(name))[1])::uuid)
  );

create policy branding_insert on storage.objects
  for insert to teyo_app
  with check (
    bucket_id = 'branding'
    and app_has_role(
      ((storage.foldername(name))[1])::uuid,
      array['owner', 'admin']::membership_role[]
    )
  );

create policy branding_delete on storage.objects
  for delete to teyo_app
  using (
    bucket_id = 'branding'
    and app_has_role(
      ((storage.foldername(name))[1])::uuid,
      array['owner', 'admin']::membership_role[]
    )
  );
