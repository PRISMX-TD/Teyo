'use client';

import type { Locale } from '@/lib/i18n';
import { getMessages, localizedName } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';

type ValuationItem = {
  itemId: string;
  sku: string;
  nameEn: string;
  nameZh: string;
  unit: string;
  quantity: number;
  avgCostMinor: bigint;
  totalValueMinor: bigint;
};

type Props = {
  valuation: ValuationItem[];
  locale: Locale;
};

export function InventoryValuation({ valuation, locale }: Props) {
  const t = getMessages(locale);

  const totalValue = valuation.reduce(
    (sum, v) => sum + v.totalValueMinor,
    0n,
  );

  return (
    <table className="transaction-table">
      <caption className="visually-hidden">{t.inventory.valuation}</caption>
      <thead>
        <tr>
          <th scope="col">{t.inventory.sku}</th>
          <th scope="col">{t.inventory.name}</th>
          <th scope="col">{t.inventory.unit}</th>
          <th scope="col" className="numeric">{t.inventory.quantity}</th>
          <th scope="col" className="numeric">{t.inventory.avgCost}</th>
          <th scope="col" className="numeric">{t.inventory.totalValue}</th>
        </tr>
      </thead>
      <tbody>
        {valuation.map((v) => (
          <tr key={v.itemId}>
            <td>{v.sku}</td>
            <td>{localizedName({ name_en: v.nameEn, name_zh: v.nameZh }, locale)}</td>
            <td>{v.unit}</td>
            <td className="numeric">{v.quantity}</td>
            <td className="numeric">{formatMoney(v.avgCostMinor, 'USD')}</td>
            <td className="numeric">{formatMoney(v.totalValueMinor, 'USD')}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td colSpan={5} className="numeric">
            <strong>{t.reports.total}</strong>
          </td>
          <td className="numeric">
            <strong>{formatMoney(totalValue, 'USD')}</strong>
          </td>
        </tr>
      </tfoot>
    </table>
  );
}
