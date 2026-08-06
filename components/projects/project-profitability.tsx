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
};

export function ProjectProfitability({ profitability, locale }: Props) {
  const t = getMessages(locale);
  const { totalIncome, totalExpense, netProfit } = profitability;

  return (
    <table className="transaction-table" style={{ maxWidth: '400px' }}>
      <caption className="visually-hidden">{t.projects.profitability}</caption>
      <tbody>
        <tr>
          <td>{t.projects.income}</td>
          <td className="numeric money-in">{formatMoney(totalIncome, 'USD')}</td>
        </tr>
        <tr>
          <td>{t.projects.expense}</td>
          <td className="numeric money-out">{formatMoney(totalExpense, 'USD')}</td>
        </tr>
      </tbody>
      <tfoot>
        <tr>
          <td>
            <strong>{t.projects.netProfit}</strong>
          </td>
          <td className={`numeric ${netProfit >= 0n ? 'money-in' : 'money-out'}`}>
            <strong>{formatMoney(netProfit >= 0n ? netProfit : -netProfit, 'USD')}</strong>
          </td>
        </tr>
      </tfoot>
    </table>
  );
}
