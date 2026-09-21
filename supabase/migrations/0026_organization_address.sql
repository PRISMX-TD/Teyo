-- ============================================================
-- 0026  公司地址
-- ============================================================
-- server/repositories/invoice_pdf.ts 的 getInvoicePdfData 从一开始就在
-- `select name, address from organizations`——而 organizations 上从来没有
-- address 这一列。于是发票单据的取数每一次都撞
-- `column "address" does not exist`（42703）。
--
-- 也就是说「下载发票 PDF」这个功能从上线起一次都没有成功过：它根本走不到
-- 生成文件那一步。之所以一直没人发现，是因为整条链路上没有任何测试，而
-- 报错发生在 React 的 Suspense 边界内——HTTP 状态码仍然是 200，页面只是
-- 停在骨架屏上。
--
-- 补这一列而不是把查询里的 address 删掉：一张寄给客户的发票上必须有开票方
-- 的地址，这是发票之所以是发票的一部分。删掉它能让报错消失，但留下的是一张
-- 没有卖方地址的单据。
--
-- 可空：已有的公司不该因为这一列而变成「资料不完整」，填不填由用户在
-- 「公司资料」里决定。

alter table organizations add column if not exists address text;

comment on column organizations.address is
  '开票方地址，出现在发票单据上。可空——已有公司不强制回填。';
