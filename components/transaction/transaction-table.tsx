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
  /**
   * 公司只有一个成员时为 false：每张卡片上都重复同一个名字，还占掉第三行
   * 右半边，把账户名挤成省略号。只影响手机卡片布局（见 tx.css），桌面表格不变。
   */
  showCreator?: boolean;
};

export function TransactionTable({
  orgSlug,
  rows,
  locale,
  baseCurrency,
  emptyLabel,
  showCreator = true,
}: Props) {
  const t = getMessages(locale);

  if (rows.length === 0) {
    return <p className="empty-state">{emptyLabel}</p>;
  }

  return (
    <table className={showCreator ? 'transaction-table tx-list' : 'transaction-table tx-list tx-list--solo'}>
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
            {/* 只有收入和支出有方向。转账、凭证、年结原来一律记成红色的「出」，
                手机卡片上没有列名也没有正负号，颜色是唯一的线索，于是客户回款、
                股东注资看上去全像是钱流出去了。 */}
            <td
              className={
                row.kind === 'income'
                  ? 'numeric money-in'
                  : row.kind === 'expense'
                    ? 'numeric money-out'
                    : 'numeric'
              }
            >
              {formatMoney(row.baseAmountMinor, baseCurrency, locale)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
