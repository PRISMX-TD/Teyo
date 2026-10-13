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
    <table className="transaction-table tx-list">
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
          // row-link 让手机上的整张卡片都点得进详情页。原来只有备注那几个字是
          // 链接，备注为空时只剩一个「—」，几乎点不中。链接本身仍然只有一个，
          // 读屏与键盘走的还是它；为什么只在卡片布局上做，见 globals.css 的 .row-link。
          <tr key={row.id} className={row.voidedAt ? 'row-link row-voided' : 'row-link'}>
            <td>{row.occurredOn}</td>
            {/* 备注一行放不下就截成省略号（规则见 globals.css 的 .tx-description），
                悬停看全文，详情页里是完整的。 */}
            <td className="tx-description">
              <div className="tx-description-line">
                <Link
                  href={`/${orgSlug}/transactions/${row.id}`}
                  title={row.description || undefined}
                >
                  {row.description || '\u2014'}
                </Link>
                {row.voidedAt ? <span className="badge">{t.transaction.voided}</span> : null}
              </div>
            </td>
            <td>
              {row.categoryId
                ? localizedName({ name_en: row.categoryNameEn, name_zh: row.categoryNameZh }, locale)
                : row.kind === 'journal'
                  ? t.transaction.journal
                  : row.kind === 'closing'
                    ? t.yearEnd.closingEntry
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
