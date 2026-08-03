-- 私有收据 bucket，只能通过签名 URL 访问
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'receipts',
  'receipts',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 路径首段是 organization_id，Storage 策略靠它做租户隔离。
-- storage.foldername(name) 返回路径各段的数组，[1] 是第一段（Postgres 数组从 1 开始）。

create policy receipts_read on storage.objects
  for select to teyo_app
  using (
    bucket_id = 'receipts'
    and app_is_member(((storage.foldername(name))[1])::uuid)
  );

create policy receipts_insert on storage.objects
  for insert to teyo_app
  with check (
    bucket_id = 'receipts'
    and app_has_role(
      ((storage.foldername(name))[1])::uuid,
      array['owner', 'admin', 'bookkeeper']::membership_role[]
    )
  );

create policy receipts_delete on storage.objects
  for delete to teyo_app
  using (
    bucket_id = 'receipts'
    and app_has_role(
      ((storage.foldername(name))[1])::uuid,
      array['owner', 'admin', 'bookkeeper']::membership_role[]
    )
  );
