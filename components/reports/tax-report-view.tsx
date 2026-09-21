'use client';

import type { Locale, Messages } from '@/lib/i18n';
import { interpolate } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';

/**
 * 税额汇总。
 *
 * 这个组件此前**与任何真实数据都对不上**，而且没有任何页面 import 它：
 * 它的 props 要的是「按税率分行」的数组（taxRateName / taxRate / netAmount /
 * taxAmount），而 server/repositories/tax.ts 的 getTaxReport 返回的是每一侧
 * 一个合计（netMinor / taxMinor / unmatchedTaxMinor）。journal_lines 上没有
 * tax_rate_id 这一列，按税率拆分今天的数据模型做不到——所以是组件跟着数据
 * 改，不是反过来。
 *
 * 另外补上了原来整个漏掉的 unmatchedTaxMinor。仓储专门把它单列出来，理由
 * 写在那边的注释里：向税局缴税（借待缴税款 / 贷银行）会让税科目变动，但它
 * 不是一笔销售退回。并进税额会让缴过税的月份销项凭空变小；丢掉又等于静默
 * 吞掉一笔真实发生的科目变动。既然仓储把它算出来了，报表上就必须看得到，
 * 否则读表的人对不上自己的总账。
 */

export type TaxSideView = {
  netMinor: string;
  taxMinor: string;
  unmatchedTaxMinor: string;
};

type Props = {
  outputTax: TaxSideView;
  inputTax: TaxSideView;
  netPayableMinor: string;
  from: string;
  to: string;
  locale: Locale;
  baseCurrency: string;
  i18n: Messages;
};

function big(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

export function TaxReportView({
  outputTax,
  inputTax,
  netPayableMinor,
  from,
  to,
  locale,
  baseCurrency,
  i18n: t,
}: Props) {
  const money = (value: bigint) => formatMoney(value, baseCurrency, locale);

  const outNet = big(outputTax.netMinor);
  const outTax = big(outputTax.taxMinor);
  const outUnmatched = big(outputTax.unmatchedTaxMinor);
  const inNet = big(inputTax.netMinor);
  const inTax = big(inputTax.taxMinor);
  const inUnmatched = big(inputTax.unmatchedTaxMinor);
  const netPayable = big(netPayableMinor);

  const hasUnmatched = outUnmatched !== 0n || inUnmatched !== 0n;
  const empty = outNet === 0n && outTax === 0n && inNet === 0n && inTax === 0n && !hasUnmatched;

  return (
    <div className="tax-report">
      <p className="report-period">
        {from} {t.reports.to} {to}
      </p>

      {empty ? (
        <p className="empty-state">{t.reports.empty}</p>
      ) : (
        <>
          <table className="report-table">
            <thead>
              <tr>
                <th>{t.tax.side}</th>
                <th className="numeric">{t.tax.netBase}</th>
                <th className="numeric">{t.tax.taxAmount}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{t.tax.outputTax}</td>
                <td className="numeric mono">{money(outNet)}</td>
                <td className="numeric mono">{money(outTax)}</td>
              </tr>
              <tr>
                <td>{t.tax.inputTax}</td>
                <td className="numeric mono">{money(inNet)}</td>
                <td className="numeric mono">{money(inTax)}</td>
              </tr>
            </tbody>
            <tfoot>
              <tr className="total-row">
                <th>{t.tax.netTaxPayable}</th>
                <th />
                <th className="numeric mono">
                  {netPayable >= 0n ? money(netPayable) : `(${money(-netPayable)})`}
                </th>
              </tr>
            </tfoot>
          </table>

          {hasUnmatched && (
            <div className="tax-unmatched">
              <h3>{t.tax.unmatched}</h3>
              <p className="hint">{t.tax.unmatchedHint}</p>
              <table className="report-table">
                <tbody>
                  <tr>
                    <td>{t.tax.outputTax}</td>
                    <td className="numeric mono">{money(outUnmatched)}</td>
                  </tr>
                  <tr>
                    <td>{t.tax.inputTax}</td>
                    <td className="numeric mono">{money(inUnmatched)}</td>
                  </tr>
                </tbody>
              </table>
              {/*
                这一句是让人能把报表和总账对上的钥匙：税科目本期的净发生额
                恒等于「税额 + 无对应基数的部分」。没有它，读表的人会以为
                报表算错了。
              */}
              <p className="hint">
                {interpolate(t.tax.unmatchedReconcile, {
                  output: money(outTax + outUnmatched),
                  input: money(inTax + inUnmatched),
                })}
              </p>
            </div>
          )}

          <p className="hint">{t.tax.zeroRatedCaveat}</p>
        </>
      )}
    </div>
  );
}
