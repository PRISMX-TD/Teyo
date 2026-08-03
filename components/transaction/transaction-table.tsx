import Link from 'next/link';
import type { Locale } from '@/lib/i18n';
import { getMessages, localizedName } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';
import type { TransactionListRow } from '@/server/repositories/transactions';

type Props = {
  orgSlug: string;
  rows: TransactionListRow[];
  locale: Locale;
  baseCurrency: string;
  emptyLabel: string;
};

export function TransactionTable({ orgSlug, rows, locale, baseCurrency, emptyLabel }: Props) {
  const t = getMessages(locale);

  if (rows.length === 0) {
    return <p className="empty-state">{emptyLabel}</p>;
  }

  return (
    <table className="transaction-table">
      <caption className="visually-hidden">{t.transaction.listTitle}</caption>
      <thead>
        <tr>
          <th scope="col">{t.transaction.date}</th>
          <th scope="col">{t.transaction.description}</th>
          <th scope="col">{t.transaction.category}</th>
          <th scope="col">{t.transaction.moneyAccount}</th>
          <th scope="col">{t.transaction.createdBy}</th>
          <th scope="col" className="numeric">{t.transaction.amount}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id} className={row.voidedAt ? 'row-voided' : undefined}>
            <td>{row.occurredOn}</td>
            <td>
              <Link href={`/${orgSlug}/transactions/${row.id}`}>
                {row.description || '\u2014'}
              </Link>
              {row.voidedAt ? <span className="badge">{t.transaction.voided}</span> : null}
            </td>
            <td>
              {row.categoryId
                ? localizedName({ name_en: row.categoryNameEn, name_zh: row.categoryNameZh }, locale)
                : t.transaction.transfer}
            </td>
            <td>
              {localizedName(
                { name_en: row.moneyAccountNameEn, name_zh: row.moneyAccountNameZh },
                locale,
              )}
            </td>
            <td>{row.createdByName}</td>
            <td className={`numeric ${row.kind === 'income' ? 'money-in' : 'money-out'}`}>
              {formatMoney(row.baseAmountMinor, baseCurrency, locale)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
