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
  /** 四位小数的十进制字符串，来自 getInventoryValuation。 */
  quantity: string;
  avgCostMinor: bigint;
  totalValueMinor: bigint;
};

type Props = {
  valuation: ValuationItem[];
  locale: Locale;
  /** 库存成本记在本位币上。原来三处金额都硬写 'USD'。 */
  baseCurrency: string;
};

export function InventoryValuation({ valuation, locale, baseCurrency }: Props) {
  const t = getMessages(locale);

  const totalValue = valuation.reduce(
    (sum, v) => sum + v.totalValueMinor,
    0n,
  );

  return (
    <table className="transaction-table doc-table">
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
            <td data-label={t.inventory.sku}>{v.sku}</td>
            <td className="doc-title">{localizedName({ name_en: v.nameEn, name_zh: v.nameZh }, locale)}</td>
            <td data-label={t.inventory.unit}>{v.unit}</td>
            <td className="numeric" data-label={t.inventory.quantity}>{v.quantity}</td>
            <td className="numeric" data-label={t.inventory.avgCost}>
              {formatMoney(v.avgCostMinor, baseCurrency, locale)}
            </td>
            <td className="numeric doc-amount">{formatMoney(v.totalValueMinor, baseCurrency, locale)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td colSpan={5} className="numeric doc-title">
            <strong>{t.reports.total}</strong>
          </td>
          <td className="numeric doc-amount">
            <strong>{formatMoney(totalValue, baseCurrency, locale)}</strong>
          </td>
        </tr>
      </tfoot>
    </table>
  );
}
