import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InvoiceDocument } from '@/components/invoices/invoice-document';
import type { InvoiceLocale } from '@/lib/invoice-options';
import type { InvoicePdfData } from '@/server/repositories/invoice-pdf';

/**
 * 发票单据的版式。组件不取数，直接喂一份数据渲染成 HTML 看印出来的是什么。
 * 截图里那张发票的几处毛病（状态印给客户看、数量 1.0000、每格都是 US$、
 * 备注标题写成「描述」）各有一条用例守着。
 */

function sample(overrides: {
  organization?: Partial<InvoicePdfData['organization']>;
  invoice?: Partial<InvoicePdfData['invoice']>;
  contact?: Partial<InvoicePdfData['contact']>;
  items?: InvoicePdfData['items'];
} = {}): InvoicePdfData {
  return {
    organization: {
      name: 'Signal Lab',
      address: null,
      registrationNumber: null,
      taxNumber: null,
      phone: null,
      email: null,
      paymentDetails: null,
      logoPath: null,
      paymentImagePaths: [],
      invoiceLocale: 'en',
      invoiceSignoff: 'computer_generated',
      invoiceTaxLabel: null,
      invoiceFooter: null,
      ...overrides.organization,
    },
    invoice: {
      invoiceNumber: 'INV-00001',
      issueDate: '2026-10-13',
      dueDate: '2026-11-13',
      status: 'sent',
      currency: 'USD',
      subTotalMinor: 100000n,
      taxRateBps: 0,
      taxMinor: 0n,
      totalMinor: 100000n,
      notes: null,
      reference: null,
      deductedMinor: 0n,
      ...overrides.invoice,
    },
    contact: {
      name: 'Make Capital',
      email: null,
      phone: null,
      address: null,
      taxId: null,
      paymentTerms: null,
      ...overrides.contact,
    },
    items: overrides.items ?? [
      { description: '服务采购费', quantity: '1.0000', unitPriceMinor: 100000n, amountMinor: 100000n },
    ],
  };
}

function render(
  data: InvoicePdfData,
  lang: InvoiceLocale = 'en',
  paymentImageUrls: string[] = [],
): string {
  return renderToStaticMarkup(
    createElement(InvoiceDocument, { data, logoUrl: null, paymentImageUrls, lang }),
  );
}

/** 去掉标签，只看印出来的字。 */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('InvoiceDocument', () => {
  it('prints the quantity without trailing zeros', () => {
    const html = render(
      sample({
        items: [
          { description: 'A', quantity: '1.0000', unitPriceMinor: 100n, amountMinor: 100n },
          { description: 'B', quantity: '2.5000', unitPriceMinor: 100n, amountMinor: 250n },
        ],
      }),
    );
    expect(html).not.toContain('1.0000');
    expect(html).toContain('>1<');
    expect(html).toContain('>2.5<');
  });

  it('puts the currency symbol on the total only, not on every line', () => {
    const out = text(render(sample()));
    expect(out.match(/US\$/g)).toHaveLength(1);
    expect(out).toContain('US$ 1,000.00');
  });

  it('does not print the internal status for an issued invoice', () => {
    const out = text(render(sample({ invoice: { status: 'partially_paid' } })));
    expect(out).not.toMatch(/Partly paid|Sent|Status/);
    expect(render(sample())).not.toContain('printable-invoice-watermark');
  });

  it('marks a draft and a voided invoice with a watermark', () => {
    expect(render(sample({ invoice: { status: 'draft' } }))).toMatch(
      /printable-invoice-watermark[^>]*>Draft</,
    );
    expect(render(sample({ invoice: { status: 'voided' } }), 'zh')).toMatch(
      /printable-invoice-watermark[^>]*>已作废</,
    );
  });

  it('titles the notes as notes, not as a description', () => {
    const out = text(render(sample({ invoice: { notes: 'Thanks' } }), 'zh'));
    expect(out).toContain('备注 Thanks');
  });

  it('prints dates the way a person writes them', () => {
    expect(text(render(sample()))).toContain('13 Oct 2026');
    expect(text(render(sample(), 'zh'))).toContain('2026年10月13日');
  });

  it('prints the customer reference, payment terms and phone when they are set', () => {
    const out = text(
      render(
        sample({
          invoice: { reference: 'PO-7781' },
          contact: { paymentTerms: '30 days', phone: '+60 12-345 6789', taxId: 'C2581234567' },
        }),
      ),
    );
    expect(out).toContain('Your ref. PO-7781');
    expect(out).toContain('Terms 30 days');
    expect(out).toContain('+60 12-345 6789');
    expect(out).toContain('Tax no. C2581234567');
  });

  it('leaves out the reference and terms rows when they are empty', () => {
    const out = text(render(sample()));
    expect(out).not.toContain('Your ref.');
    expect(out).not.toContain('Terms');
  });

  it('shows what has been paid and what is still owed', () => {
    const out = text(render(sample({ invoice: { deductedMinor: 40000n } })));
    expect(out).toContain('Paid / credited -400.00');
    expect(out).toContain('Amount due US$ 600.00');
  });

  it('never prints a negative amount due', () => {
    const out = text(render(sample({ invoice: { deductedMinor: 120000n } })));
    expect(out).toContain('Amount due US$ 0.00');
  });

  it('hides subtotal and tax when there is no tax', () => {
    const out = text(render(sample()));
    expect(out).not.toContain('Subtotal');
    expect(out).not.toContain('Tax (');
  });

  it('uses the company’s own name for the tax line', () => {
    const data = sample({
      organization: { invoiceTaxLabel: 'SST' },
      invoice: { subTotalMinor: 100000n, taxRateBps: 800, taxMinor: 8000n, totalMinor: 108000n },
    });
    const out = text(render(data));
    expect(out).toContain('Subtotal 1,000.00');
    expect(out).toContain('SST (8%) 80.00');
    expect(out).toContain('Total US$ 1,080.00');
  });

  it('prints English labels with Chinese alongside on a bilingual invoice', () => {
    const out = text(render(sample(), 'bilingual'));
    expect(out).toContain('Invoice 发票');
    expect(out).toContain('Bill to 客户');
    // 双语发票的日期按英文印：一行里只能有一种日期写法。
    expect(out).toContain('13 Oct 2026');
  });

  it('follows the chosen sign-off', () => {
    expect(text(render(sample()))).toContain('This is a computer-generated invoice');
    const signed = text(render(sample({ organization: { invoiceSignoff: 'signature' } })));
    expect(signed).toContain('Authorised signature & company stamp');
    expect(signed).not.toContain('computer-generated');
    const none = text(render(sample({ organization: { invoiceSignoff: 'none' } })));
    expect(none).not.toContain('computer-generated');
    expect(none).not.toContain('Authorised signature');
  });

  it('prints the payment QR codes under the payment details', () => {
    const html = render(
      sample({ organization: { paymentDetails: 'Bybit Wallet\nTCH7on3 (TRC20)' } }),
      'en',
      ['https://storage.test/a.png', 'https://storage.test/b.png'],
    );
    expect(html).toMatch(
      /Bybit Wallet[\s\S]*<div class="printable-invoice-payment-images"><img src="https:\/\/storage.test\/a.png" alt="Payment QR code 1"\/><img src="https:\/\/storage.test\/b.png" alt="Payment QR code 2"\/><\/div>/,
    );
  });

  it('prints the payment section for images alone, without empty text', () => {
    const html = render(sample(), 'zh', ['https://storage.test/a.png']);
    expect(html).toContain('付款信息');
    expect(html).toContain('alt="收款二维码 1"');
    expect(html).not.toContain('<p class="printable-invoice-multiline"></p>');
  });

  it('leaves the payment section out when there is neither text nor image', () => {
    expect(render(sample())).not.toContain('printable-invoice-payment-images');
    expect(text(render(sample()))).not.toContain('Payment details');
  });

  it('prints the company’s own footer text', () => {
    const out = text(
      render(sample({ organization: { invoiceFooter: 'Late payments incur 1.5% a month.' } })),
    );
    expect(out).toContain('Late payments incur 1.5% a month.');
  });
});
