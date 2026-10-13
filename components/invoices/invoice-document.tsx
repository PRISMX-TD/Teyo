import type { ReactNode } from 'react';
import { formatAmount, formatDocumentDate, formatMoney, formatQuantity } from '@/lib/format';
import { getMessages, interpolate, type Locale, type Messages } from '@/lib/i18n';
import type { InvoiceLocale } from '@/lib/invoice-options';
import type { InvoicePdfData } from '@/server/repositories/invoice-pdf';

type Props = {
  data: InvoicePdfData;
  logoUrl: string | null;
  /**
   * 这张发票用什么语言印。由打印页决定（公司设置的默认值，或者页面上临时
   * 切换的那一个），与看这一页的人的界面语言无关——发票是给客户看的。
   */
  lang: InvoiceLocale;
};

/** 基点 → 不带多余零的百分数：800 → '8'，625 → '6.25'。整数运算，理由同 invoice-form.tsx。 */
function percentOf(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const fraction = String(Math.abs(bps % 100)).padStart(2, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

/**
 * 发票单据本身：只管排版，不取数、不查权限。打印页把数据和语言交给它。
 *
 * 拆出来是为了让单据能脱离 Next 的请求上下文单独渲染（测试里直接
 * renderToStaticMarkup），版式改动不必每次都登录一遍去看。
 */
export function InvoiceDocument({ data, logoUrl, lang }: Props) {
  const { organization, invoice, contact, items } = data;

  const en = getMessages('en');
  const zh = getMessages('zh');
  const primary = lang === 'zh' ? zh : en;
  // 双语发票的日期、数字按英文印：一行里只能有一种日期写法。
  const docLocale: Locale = lang === 'zh' ? 'zh' : 'en';

  /**
   * 一个标签。双语时英文在前、中文跟在后面并弱化——客户里不读中文的人
   * 照样一眼看懂，读中文的人也不必猜。
   */
  const label = (pick: (m: Messages) => string): ReactNode =>
    lang === 'bilingual' ? (
      <>
        {pick(en)}
        <span className="printable-invoice-alt" lang="zh">
          {' '}
          {pick(zh)}
        </span>
      </>
    ) : (
      pick(primary)
    );

  const money = (minor: bigint) => formatMoney(minor, invoice.currency, docLocale);
  const amount = (minor: bigint) => formatAmount(minor, invoice.currency);
  const date = (iso: string) => formatDocumentDate(iso, docLocale);

  // 草稿与作废打水印，其余状态一律不印：「已发送」「部分收款」是我们自己
  // 的流程，不是客户要读的东西。双语时水印只用英文，两种文字叠在一起
  // 斜着铺满半页没法读。
  const watermark =
    invoice.status === 'voided'
      ? primary.invoicePdf.watermarkVoid
      : invoice.status === 'draft'
        ? primary.invoicePdf.watermarkDraft
        : null;

  // 已冲掉的超过总额只可能来自数据不一致；印一个负的「应付」只会让客户
  // 以为我们欠他钱，宁可印 0。
  const dueMinor =
    invoice.totalMinor > invoice.deductedMinor ? invoice.totalMinor - invoice.deductedMinor : 0n;

  const taxLabel: ReactNode = organization.invoiceTaxLabel ?? label((m) => m.invoices.tax);

  return (
    <article className="printable-invoice" lang={lang === 'zh' ? 'zh' : 'en'}>
      {watermark ? (
        <div className="printable-invoice-watermark" aria-hidden="true">
          {watermark}
        </div>
      ) : null}

      <header className="printable-invoice-head">
        <div className="printable-invoice-brand">
          {logoUrl ? (
            // 签名 URL 一小时后失效，next/image 的优化缓存在这里没有意义，
            // 还得在 next.config.ts 里登记 Supabase 的域名。
            // eslint-disable-next-line @next/next/no-img-element
            <img
              className="printable-invoice-logo"
              src={logoUrl}
              alt={interpolate(primary.settings.logoAlt, { name: organization.name })}
            />
          ) : null}
          <h1 className="printable-invoice-title">{label((m) => m.invoicePdf.documentTitle)}</h1>
        </div>
        <div className="printable-invoice-org">
          <strong>{organization.name}</strong>
          {organization.registrationNumber ? (
            <p>
              {label((m) => m.invoicePdf.registrationNumber)}{' '}
              <span className="mono">{organization.registrationNumber}</span>
            </p>
          ) : null}
          {organization.address ? (
            <p className="printable-invoice-multiline">{organization.address}</p>
          ) : null}
          {organization.phone ? <p>{organization.phone}</p> : null}
          {organization.email ? <p>{organization.email}</p> : null}
          {organization.taxNumber ? (
            <p>
              {label((m) => m.invoicePdf.taxNumber)}{' '}
              <span className="mono">{organization.taxNumber}</span>
            </p>
          ) : null}
        </div>
      </header>

      <section className="printable-invoice-meta">
        <div className="printable-invoice-bill-to">
          <h2>{label((m) => m.invoicePdf.billTo)}</h2>
          <p>
            <strong>{contact.name}</strong>
          </p>
          {contact.address ? <p className="printable-invoice-multiline">{contact.address}</p> : null}
          {contact.phone ? <p>{contact.phone}</p> : null}
          {contact.email ? <p>{contact.email}</p> : null}
          {contact.taxId ? (
            <p>
              {label((m) => m.invoicePdf.taxNumber)} <span className="mono">{contact.taxId}</span>
            </p>
          ) : null}
        </div>

        <dl className="printable-invoice-facts">
          <dt>{label((m) => m.invoicePdf.invoiceNumber)}</dt>
          <dd className="mono">{invoice.invoiceNumber}</dd>
          <dt>{label((m) => m.invoicePdf.issueDate)}</dt>
          <dd>{date(invoice.issueDate)}</dd>
          <dt>{label((m) => m.invoicePdf.dueDate)}</dt>
          <dd>{date(invoice.dueDate)}</dd>
          {contact.paymentTerms ? (
            <>
              <dt>{label((m) => m.invoicePdf.terms)}</dt>
              <dd>{contact.paymentTerms}</dd>
            </>
          ) : null}
          {invoice.reference ? (
            <>
              <dt>{label((m) => m.invoicePdf.reference)}</dt>
              <dd className="mono">{invoice.reference}</dd>
            </>
          ) : null}
          <dt>{label((m) => m.transaction.currency)}</dt>
          <dd className="mono">{invoice.currency}</dd>
        </dl>
      </section>

      <table className="report-table printable-invoice-items">
        <thead>
          <tr>
            <th>{label((m) => m.invoices.description)}</th>
            <th className="numeric">{label((m) => m.invoices.quantity)}</th>
            <th className="numeric">{label((m) => m.invoices.unitPrice)}</th>
            <th className="numeric">{label((m) => m.invoices.amount)}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
            <tr key={index}>
              <td className="printable-invoice-multiline">{item.description}</td>
              <td className="numeric mono">{formatQuantity(item.quantity)}</td>
              <td className="numeric mono">{amount(item.unitPriceMinor)}</td>
              <td className="numeric mono">{amount(item.amountMinor)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <dl className="printable-invoice-totals">
        {/* 没有税时小计就等于合计，两行一样的数只是噪音。 */}
        {invoice.taxRateBps > 0 ? (
          <>
            <div className="printable-invoice-total-row">
              <dt>{label((m) => m.invoices.subtotal)}</dt>
              <dd className="mono">{amount(invoice.subTotalMinor)}</dd>
            </div>
            <div className="printable-invoice-total-row">
              <dt>
                {taxLabel} ({percentOf(invoice.taxRateBps)}%)
              </dt>
              <dd className="mono">{amount(invoice.taxMinor)}</dd>
            </div>
          </>
        ) : null}
        <div className="printable-invoice-total-row is-total">
          <dt>{label((m) => m.invoices.total)}</dt>
          <dd className="mono">{money(invoice.totalMinor)}</dd>
        </div>
        {invoice.deductedMinor > 0n ? (
          <>
            <div className="printable-invoice-total-row">
              <dt>{label((m) => m.invoicePdf.paidToDate)}</dt>
              <dd className="mono">-{amount(invoice.deductedMinor)}</dd>
            </div>
            <div className="printable-invoice-total-row is-due">
              <dt>{label((m) => m.invoicePdf.amountDue)}</dt>
              <dd className="mono">{money(dueMinor)}</dd>
            </div>
          </>
        ) : null}
      </dl>

      {invoice.notes ? (
        <section className="printable-invoice-notes">
          <h2>{label((m) => m.invoices.notes)}</h2>
          <p className="printable-invoice-multiline">{invoice.notes}</p>
        </section>
      ) : null}

      {/* 收款信息放在金额之后：客户读完金额，下一眼要找的就是「钱打到哪里」。 */}
      {organization.paymentDetails ? (
        <section className="printable-invoice-notes">
          <h2>{label((m) => m.invoicePdf.paymentDetails)}</h2>
          <p className="printable-invoice-multiline">{organization.paymentDetails}</p>
        </section>
      ) : null}

      {organization.invoiceFooter ? (
        <p className="printable-invoice-footer printable-invoice-multiline">
          {organization.invoiceFooter}
        </p>
      ) : null}

      {organization.invoiceSignoff === 'signature' ? (
        <div className="printable-invoice-signature">
          <p>{organization.name}</p>
          <p className="printable-invoice-signature-line">{label((m) => m.invoicePdf.signature)}</p>
        </div>
      ) : organization.invoiceSignoff === 'computer_generated' ? (
        <p className="printable-invoice-signoff">{label((m) => m.invoicePdf.computerGenerated)}</p>
      ) : null}
    </article>
  );
}
