'use client';

import type { Locale, Messages } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';

type TaxReportRow = {
  taxRateName: string | null;
  taxRate: number;
  netAmount: bigint;
  taxAmount: bigint;
};

type Props = {
  outputTax: TaxReportRow[];
  inputTax: TaxReportRow[];
  from: string;
  to: string;
  locale: Locale;
  baseCurrency: string;
  i18n: Messages;
};

export function TaxReportView({ outputTax, inputTax, from, to, locale, baseCurrency, i18n: t }: Props) {
  const outputTotalNet = outputTax.reduce((s, r) => s + r.netAmount, 0n);
  const outputTotalTax = outputTax.reduce((s, r) => s + r.taxAmount, 0n);
  const inputTotalNet = inputTax.reduce((s, r) => s + r.netAmount, 0n);
  const inputTotalTax = inputTax.reduce((s, r) => s + r.taxAmount, 0n);
  const netTaxPayable = outputTotalTax - inputTotalTax;

  function ratePct(bps: number): string {
    return (bps / 100).toFixed(2) + '%';
  }

  return (
    <div className="tax-report">
      <p className="report-period">
        {from} {t.reports.to} {to}
      </p>

      {/* Output Tax Section */}
      <h2 className="section-title">{t.tax.outputTax}</h2>
      {outputTax.length === 0 ? (
        <p className="empty-state">{t.reports.empty}</p>
      ) : (
        <table className="report-table">
          <thead>
            <tr>
              <th>{t.tax.rateName}</th>
              <th className="numeric">{t.invoices.subtotal ?? 'Net Amount'}</th>
              <th className="numeric">{t.invoices.tax}</th>
              <th className="numeric">{t.reports.total}</th>
            </tr>
          </thead>
          <tbody>
            {outputTax.map((row, i) => {
              const total = row.netAmount + row.taxAmount;
              return (
                <tr key={i}>
                  <td>{row.taxRateName} ({ratePct(row.taxRate)})</td>
                  <td className="numeric mono">{formatMoney(row.netAmount, baseCurrency, locale)}</td>
                  <td className="numeric mono">{formatMoney(row.taxAmount, baseCurrency, locale)}</td>
                  <td className="numeric mono">{formatMoney(total, baseCurrency, locale)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <th>{t.reports.total}</th>
              <th className="numeric mono">{formatMoney(outputTotalNet, baseCurrency, locale)}</th>
              <th className="numeric mono">{formatMoney(outputTotalTax, baseCurrency, locale)}</th>
              <th className="numeric mono">{formatMoney(outputTotalNet + outputTotalTax, baseCurrency, locale)}</th>
            </tr>
          </tfoot>
        </table>
      )}

      {/* Input Tax Section */}
      <h2 className="section-title">{t.tax.inputTax}</h2>
      {inputTax.length === 0 ? (
        <p className="empty-state">{t.reports.empty}</p>
      ) : (
        <table className="report-table">
          <thead>
            <tr>
              <th>{t.tax.rateName}</th>
              <th className="numeric">{t.invoices.subtotal ?? 'Net Amount'}</th>
              <th className="numeric">{t.invoices.tax}</th>
              <th className="numeric">{t.reports.total}</th>
            </tr>
          </thead>
          <tbody>
            {inputTax.map((row, i) => {
              const total = row.netAmount + row.taxAmount;
              return (
                <tr key={i}>
                  <td>{row.taxRateName} ({ratePct(row.taxRate)})</td>
                  <td className="numeric mono">{formatMoney(row.netAmount, baseCurrency, locale)}</td>
                  <td className="numeric mono">{formatMoney(row.taxAmount, baseCurrency, locale)}</td>
                  <td className="numeric mono">{formatMoney(total, baseCurrency, locale)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <th>{t.reports.total}</th>
              <th className="numeric mono">{formatMoney(inputTotalNet, baseCurrency, locale)}</th>
              <th className="numeric mono">{formatMoney(inputTotalTax, baseCurrency, locale)}</th>
              <th className="numeric mono">{formatMoney(inputTotalNet + inputTotalTax, baseCurrency, locale)}</th>
            </tr>
          </tfoot>
        </table>
      )}

      {/* Summary */}
      <div className="tax-summary">
        <h2>{t.reports.total}</h2>
        <table className="report-table">
          <tbody>
            <tr>
              <td>{t.tax.outputTax}</td>
              <td className="numeric mono">{formatMoney(outputTotalTax, baseCurrency, locale)}</td>
            </tr>
            <tr>
              <td>{t.tax.inputTax}</td>
              <td className="numeric mono">({formatMoney(inputTotalTax, baseCurrency, locale)})</td>
            </tr>
            <tr className="total-row">
              <th>{t.tax.netTaxPayable}</th>
              <th className="numeric mono">
                {netTaxPayable >= 0
                  ? formatMoney(netTaxPayable, baseCurrency, locale)
                  : `(${formatMoney(-netTaxPayable, baseCurrency, locale)})`}
              </th>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
