import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PrintButton } from '@/components/invoices/print-button';
import { formatMoney } from '@/lib/format';
import { getMessages, type Locale } from '@/lib/i18n';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { getUserLocale } from '@/server/repositories/organizations';
import { getInvoicePdfData } from '@/server/repositories/invoice_pdf';

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
}: {
  params: Promise<{ orgSlug: string; id: string }>;
}) {
  const { orgSlug, id } = await params;
  const context = await requirePermission(orgSlug, 'transaction:read');
  const locale = (await getUserLocale(context.userId)) as Locale;
  const t = getMessages(locale);

  const data = await withTransaction(context.userId, (tx) =>
    getInvoicePdfData(tx, context.organizationId, id),
  );

  // 与 invoices/[id] 同一条理由：查不到和不属于本公司在这里是同一件事，
  // 两者都只该得到 404。
  if (!data) notFound();

  const { organization, invoice, contact, items } = data;

  // 发票上的每一个数都是**发票自己的币种**（invoices.subtotal_minor 一类
  // 存的就是原币最小单位），不是本位币。用 baseCurrency 去格式化，一张
  // 美元发票会印上马币符号。
  const money = (minor: bigint) => formatMoney(minor, invoice.currency, locale);

  return (
    <div className="invoice-document">
      <div className="page-header no-print">
        <Link href={`/${orgSlug}/invoices/${id}`} className="text-button">
          &larr; {t.common.back}
        </Link>
        <div className="page-header-actions">
          <PrintButton label={t.invoicePdf.print} />
        </div>
      </div>

      <p className="hint no-print">{t.invoicePdf.printHint}</p>

      <article className="printable-invoice">
        <header className="printable-invoice-head">
          <div>
            <h1>{t.invoices.title}</h1>
            <p className="mono">{invoice.invoiceNumber}</p>
          </div>
          <div className="printable-invoice-org">
            <strong>{organization.name}</strong>
            {organization.address ? <p>{organization.address}</p> : null}
          </div>
        </header>

        <section className="printable-invoice-meta">
          <dl>
            <dt>{t.invoices.issueDate}</dt>
            <dd className="mono">{invoice.issueDate}</dd>
            <dt>{t.invoices.dueDate}</dt>
            <dd className="mono">{invoice.dueDate}</dd>
            <dt>{t.invoices.status}</dt>
            <dd>{invoice.status}</dd>
            <dt>{t.transaction.currency}</dt>
            <dd className="mono">{invoice.currency}</dd>
          </dl>

          <div className="printable-invoice-bill-to">
            <h2>{t.invoicePdf.billTo}</h2>
            <p>
              <strong>{contact.name}</strong>
            </p>
            {contact.email ? <p>{contact.email}</p> : null}
            {contact.address ? <p>{contact.address}</p> : null}
            {contact.taxId ? <p className="mono">{contact.taxId}</p> : null}
          </div>
        </section>

        <table className="report-table">
          <thead>
            <tr>
              <th>{t.invoices.description}</th>
              <th className="numeric">{t.invoices.quantity}</th>
              <th className="numeric">{t.invoices.unitPrice}</th>
              <th className="numeric">{t.invoices.amount}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, index) => (
              <tr key={index}>
                <td>{item.description}</td>
                <td className="numeric mono">{item.quantity}</td>
                <td className="numeric mono">{money(item.unitPriceMinor)}</td>
                <td className="numeric mono">{money(item.amountMinor)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th colSpan={3}>{t.invoices.subtotal}</th>
              <th className="numeric mono">{money(invoice.subTotalMinor)}</th>
            </tr>
            {invoice.taxRateBps > 0 ? (
              <tr>
                <th colSpan={3}>
                  {t.invoices.tax} ({(invoice.taxRateBps / 100).toFixed(2)}%)
                </th>
                <th className="numeric mono">{money(invoice.taxMinor)}</th>
              </tr>
            ) : null}
            <tr className="total-row">
              <th colSpan={3}>{t.invoices.total}</th>
              <th className="numeric mono">{money(invoice.totalMinor)}</th>
            </tr>
          </tfoot>
        </table>

        {invoice.notes ? (
          <section className="printable-invoice-notes">
            <h2>{t.transaction.description}</h2>
            <p>{invoice.notes}</p>
          </section>
        ) : null}
      </article>
    </div>
  );
}
