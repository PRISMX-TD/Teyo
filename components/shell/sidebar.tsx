'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { getMessages } from '@/lib/i18n';

type Props = {
  orgSlug: string;
  i18n: ReturnType<typeof getMessages>;
};

export function Sidebar({ orgSlug, i18n }: Props) {
  const pathname = usePathname();

  const links = [
    { href: `/${orgSlug}`, label: i18n.nav.overview },
    { href: `/${orgSlug}/transactions`, label: i18n.nav.transactions },
    { href: `/${orgSlug}/invoices`, label: i18n.nav.invoices },
    { href: `/${orgSlug}/payments`, label: i18n.nav.payments },
    { href: `/${orgSlug}/credit-notes`, label: i18n.nav.creditNotes },
    { href: `/${orgSlug}/purchase-orders`, label: i18n.nav.purchaseOrders },
    { href: `/${orgSlug}/bills`, label: i18n.nav.bills },
    { href: `/${orgSlug}/reports`, label: i18n.nav.reports },
    { href: `/${orgSlug}/general-ledger`, label: i18n.nav.generalLedger },
    { href: `/${orgSlug}/reconciliation`, label: i18n.nav.reconciliation },
    { href: `/${orgSlug}/budgets`, label: i18n.nav.budgets },
    { href: `/${orgSlug}/projects`, label: i18n.nav.projects },
    { href: `/${orgSlug}/bank-import`, label: i18n.nav.bankImport },
    { href: `/${orgSlug}/fixed-assets`, label: i18n.nav.fixedAssets },
    { href: `/${orgSlug}/export`, label: i18n.nav.export },
    { href: `/${orgSlug}/settings`, label: i18n.nav.settings },
    { href: `/${orgSlug}/settings/tax`, label: i18n.nav.tax },
  ];

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">{i18n.brand.name}</div>

      {/* 录一笔是这个产品的主动作，不能埋在二级页里 */}
      <Link href={`/${orgSlug}/transactions/new`} className="sidebar-action">
        {i18n.transaction.newTitle}
      </Link>

      <nav className="sidebar-nav">
        {links.map((link) => {
          const isActive =
            pathname === link.href ||
            (link.href !== `/${orgSlug}` && pathname.startsWith(link.href));
          return (
            <Link
              key={link.href}
              href={link.href}
              className={isActive ? 'active' : ''}
            >
              {link.label}
            </Link>
          );
        })}
      </nav>

      <div className="sidebar-footer">
        <Link href="/account">{i18n.nav.account}</Link>
        <Link href="/">{i18n.nav.switchCompany}</Link>
      </div>
    </aside>
  );
}
