'use client';

import type { Locale } from '@/lib/i18n';
import { getMessages } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';

type Props = {
  profitability: {
    totalIncome: bigint;
    totalExpense: bigint;
    netProfit: bigint;
  };
  locale: Locale;
  /** 三处金额原来都硬写 'USD'——项目的收支记在本位币上。 */
  baseCurrency: string;
};

export function ProjectProfitability({ profitability, locale, baseCurrency }: Props) {
  const t = getMessages(locale);
  const { totalIncome, totalExpense, netProfit } = profitability;

  return (
    <table className="transaction-table" style={{ maxWidth: '400px' }}>
      <caption className="visually-hidden">{t.projects.profitability}</caption>
      <tbody>
        <tr>
          <td>{t.projects.income}</td>
          <td className="numeric money-in">{formatMoney(totalIncome, baseCurrency, locale)}</td>
        </tr>
        <tr>
          <td>{t.projects.expense}</td>
          <td className="numeric money-out">{formatMoney(totalExpense, baseCurrency, locale)}</td>
        </tr>
      </tbody>
      <tfoot>
        <tr>
          <td>
            <strong>{t.projects.netProfit}</strong>
          </td>
          <td className={`numeric ${netProfit >= 0n ? 'money-in' : 'money-out'}`}>
            {/* 亏损要带负号。原来取了绝对值，只剩颜色区分盈亏——
                读屏器与打印出来的一页上，亏 500 和赚 500 是同一个数。 */}
            <strong>{formatMoney(netProfit, baseCurrency, locale)}</strong>
          </td>
        </tr>
      </tfoot>
    </table>
  );
}
