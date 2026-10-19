import Link from 'next/link';
import { BackLink } from '@/components/ui/back-link';
import { notFound } from 'next/navigation';
import { isUuid } from '@/lib/uuid';
import { PrintButton } from '@/components/invoices/print-button';
import { InvoiceDocument } from '@/components/invoices/invoice-document';
import { getMessages, type Locale } from '@/lib/i18n';
import { INVOICE_LOCALES, INVOICE_LOCALE_NAMES, isInvoiceLocale } from '@/lib/invoice-options';
import { requirePagePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { getInvoicePdfData } from '@/server/repositories/invoice-pdf';
import { getLogoSignedUrl, getPaymentImageUrls } from '@/server/services/organization-logo';

/**
 * 一张可以直接打印、或用浏览器「另存为 PDF」的发票。
 *
 * 取代了原来那个手写的 PDF 生成器（app/api/invoice/[id]/pdf/route.ts）。
 * 那份代码不是「差一点」，是四个方向同时坏：
 *
 *   1. **对象图接错**。objects 数组是 [catalog, pages, page, content, font]，
 *      编号 1..5，而 catalog 写的是 `/Pages 3 0 R`（指向 Page 而不是 Pages
 *      树）、pages 写的是 `/Kids [4 0 R]`（指向内容流）、page 的 `/Parent`
 *      指向它自己。
 *   2. **xref 偏移全错**。offsets 用 `Buffer.byteLength(buf)`（默认按 UTF-8
 *      数），而文件最后是用 latin1 写出去的；开头那行二进制注释
 *      `%\xFF\xFE\xFD\xFC` 在 UTF-8 下是 8 字节、latin1 下是 4 字节，于是
 *      从第一个对象起每一个偏移都错位，第 5 条直接落在字体对象中间。
 *   3. **金额硬编码两位小数**。一张 1,000,000 日元的发票印出来是 10000.00。
 *   4. **非拉丁字符全部损坏**。字符串按 latin1 写入，一个汉字被截成一个字节；
 *      而且内建的 Helvetica 根本没有中日韩字形，就算编码对了也印不出来。
 *      实测一家中文公司名在 Chrome 里渲染成「ǭ a F」。
 *
 * 把它修到能正确排中文，等于要在仓库里塞一份中日韩字体并自己写 TrueType
 * 子集化 + CIDFontType2 + ToUnicode CMap——那是另一个项目。而浏览器的
 * 「打印 → 另存为 PDF」本来就带着真正的字体、选得中的文字和正确的元数据，
 * 任何语言都不用管。所以这里换成一张排好版的单据页，打印样式表
 * （app/globals.css 的 `@media print`）会把侧栏一类界面元素隐藏掉。
 */
export default async function InvoicePrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgSlug, id } = await params;
  // 不是 uuid 的 id 进 SQL 是类型错误、整页 500；与「查不到」一样给 404。
  if (!isUuid(id)) notFound();
  const raw = await searchParams;
  const context = await requirePagePermission(orgSlug, 'transaction:read');
  const locale = (await getUserLocale(context.userId)) as Locale;
  const t = getMessages(locale);

  const data = await withTransaction(context.userId, (tx) =>
    getInvoicePdfData(tx, context.organizationId, id),
  );

  // 与 invoices/[id] 同一条理由：查不到和不属于本公司在这里是同一件事，
  // 两者都只该得到 404。
  if (!data) notFound();

  // 两组签名 URL 各是一次对象存储往返，互不依赖，一起发。
  const [logoUrl, paymentImages] = await Promise.all([
    getLogoSignedUrl(data.organization.logoPath),
    getPaymentImageUrls(data.organization.paymentImagePaths),
  ]);
  const paymentImageUrls = paymentImages
    .map((image) => image.url)
    .filter((url): url is string => url !== null);

  // 发票语言：默认取公司设置，页面上可以临时换一种（?lang=）。临时换的
  // 不写回设置——给一个中文客户印一张，不该把全公司的默认值改掉。
  const lang = isInvoiceLocale(raw.lang) ? raw.lang : data.organization.invoiceLocale;

  return (
    <div className="invoice-document">
      {/*
        @page 的边距设成 0：Chrome 只有在页边没有空间时才不印它自己的页眉页脚
        （日期时间、网址、页面标题）。作者在页边框里放了内容也挡不住它——
        所以页边距只能是 0，留白改由下面 .print-frame 的表头表尾垫出来。
        放在这一页里而不是 globals.css：报表页打印时仍然要浏览器的默认页边距。
      */}
      <style>{'@page { margin: 0; }'}</style>

      <div className="page-header no-print">
        <BackLink href={`/${orgSlug}/invoices/${id}`}>{t.common.back}</BackLink>
        <div className="page-header-actions">
          <PrintButton label={t.invoicePdf.print} />
        </div>
      </div>

      {/* 三个选项装在一条分段轨道里：原来是三颗散开的 30px 胶囊，320 宽时
          「English + 中文」掉到第二行，也够不到 44px 的触控线。 */}
      <nav className="invoice-language-switch no-print" aria-label={t.invoicePdf.printLanguage}>
        <span>{t.invoicePdf.printLanguage}</span>
        <div className="invoice-language-switch__options">
          {INVOICE_LOCALES.map((option) => (
            <Link
              key={option}
              href={`/${orgSlug}/invoices/${id}/print?lang=${option}`}
              className={option === lang ? 'is-current' : undefined}
              aria-current={option === lang ? 'true' : undefined}
              replace
            >
              {INVOICE_LOCALE_NAMES[option]}
            </Link>
          ))}
        </div>
      </nav>

      <p className="hint no-print">{t.invoicePdf.printHint}</p>

      {/*
        打印时每一页上下的留白。表头、表尾在打印时会在每一页重复，于是两个
        空的格子就是每一页的上下页边距——@page 设成 0 之后，只有这个办法让
        第二页的内容不顶着纸边。屏幕上这层表格退成普通的块，垫片不显示。
      */}
      <table className="print-frame" role="presentation">
        <thead>
          <tr>
            <td>
              <div className="print-frame-gap" />
            </td>
          </tr>
        </thead>
        <tfoot>
          <tr>
            <td>
              <div className="print-frame-gap" />
            </td>
          </tr>
        </tfoot>
        <tbody>
          <tr>
            <td>
              <InvoiceDocument
                data={data}
                logoUrl={logoUrl}
                paymentImageUrls={paymentImageUrls}
                lang={lang}
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
