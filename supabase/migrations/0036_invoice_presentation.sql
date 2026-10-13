-- ============================================================
-- 0036  发票的版式选项与客户参考号
-- ============================================================
-- 可打印发票原来的语言跟着「看这一页的人」的界面语言走：老板用中文界面，
-- 寄给马来西亚客户的发票就是中文的。发票是给客户看的单据，它的语言是公司
-- 的选择，不是操作员的偏好。
--
-- 这一组都是「怎么印」而不是「印什么数」，所以全部放在 organizations 上、
-- 由设置页统一管。每一项都有一个宽松的默认值，不强迫任何一家公司按某一种
-- 规矩来：有的公司要盖章签名、有的只要一句「电脑生成」、有的什么都不要；
-- 税那一行有人写 SST、有人写 Service Tax、有人就写 Tax。
--
--   invoice_locale    en | zh | bilingual（英文为主、中文并列）。默认 en。
--   invoice_signoff   computer_generated | signature | none。默认
--                     computer_generated（「本发票由电脑生成，无需签名」）。
--   invoice_tax_label 税那一行的名称。空即按发票语言印「Tax / 税」。
--   invoice_footer    印在每张发票底部的条款或一句话。可空。
--
-- invoices.reference：客户给的采购单号（PO）或参考号。很多公司付款前要
-- 拿它去对自己的采购单，发票上没有这个号，款就卡在对方的应付那一关。
--
-- 文字长度上限由 lib/schemas.ts 与 server/actions/invoices.ts 管，与 0034
-- 一致；这里只给两个枚举列加 CHECK——它们一旦写进一个不认识的值，打印页
-- 就会退回默认值而没人知道为什么。

alter table organizations
  add column if not exists invoice_locale text not null default 'en',
  add column if not exists invoice_signoff text not null default 'computer_generated',
  add column if not exists invoice_tax_label text,
  add column if not exists invoice_footer text;

alter table organizations drop constraint if exists organizations_invoice_locale_valid;
alter table organizations add constraint organizations_invoice_locale_valid
  check (invoice_locale in ('en', 'zh', 'bilingual'));

alter table organizations drop constraint if exists organizations_invoice_signoff_valid;
alter table organizations add constraint organizations_invoice_signoff_valid
  check (invoice_signoff in ('computer_generated', 'signature', 'none'));

comment on column organizations.invoice_locale is
  '发票打印语言：en、zh 或 bilingual。与操作员的界面语言无关。';
comment on column organizations.invoice_signoff is
  '发票底部：computer_generated（电脑生成无需签名）、signature（签名盖章栏）或 none。';
comment on column organizations.invoice_tax_label is
  '发票上税那一行的名称（如 SST、Service Tax）。空即按发票语言印默认的「Tax / 税」。';
comment on column organizations.invoice_footer is
  '印在每张发票底部的条款或说明。可空。';

alter table invoices add column if not exists reference text;

comment on column invoices.reference is
  '客户的采购单号或参考号，印在发票上。可空。';
