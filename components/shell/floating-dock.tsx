'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import type { Messages } from '@/lib/i18n';
import { useTheme } from './use-theme';

type Props = {
  orgSlug: string;
  i18n: Messages;
};

const NAV_ITEMS: { label: keyof Messages['nav']; href: (slug: string) => string }[] = [
  { label: 'overview', href: (slug) => `/${slug}` },
  { label: 'transactions', href: (slug) => `/${slug}/transactions` },
  { label: 'reports', href: (slug) => `/${slug}/reports` },
  { label: 'settings', href: (slug) => `/${slug}/settings` },
  // 侧栏另外 14 个目的地（发票/账单/收付款/对账/预算/项目...）在移动端没有入口——
  // sidebar 在 767px 以下直接 display:none。这一格不是某个具体页面，是分流页
  // （见 app/(app)/[orgSlug]/more/page.tsx），按侧栏分组把其余目的地列出来，
  // 不在其中挑一个顶上去：Invoices/Bills/Payments 三个只挑一个会留下另外两个
  // 依然进不去，等于把「开发票」和「收发票的钱」拆成两条不对称的路。
  { label: 'more', href: (slug) => `/${slug}/more` },
];

export function FloatingDock({ orgSlug, i18n }: Props) {
  const pathname = usePathname();
  const { theme, toggle } = useTheme();

  return (
    <nav className="floating-dock" aria-label={i18n.nav.primaryNavigation}>
      {NAV_ITEMS.map((item) => {
        const href = item.href(orgSlug);
        const isActive =
          pathname === href ||
          (href !== `/${orgSlug}` && pathname.startsWith(href));
        return (
          <Link
            key={item.label}
            href={href}
            className={isActive ? 'active' : ''}
          >
            {i18n.nav[item.label]}
          </Link>
        );
      })}

      <Link
        href={`/${orgSlug}/transactions/new`}
        className="topbar-cta"
        aria-label={i18n.transaction.newTitle}
      >
        +
      </Link>

      <span className="floating-dock-separator" />

      <button
        type="button"
        className="dock-theme-btn"
        onClick={toggle}
        aria-label={i18n.nav.toggleTheme}
      >
        {theme === 'dark' ? '☀' : '☾'}
      </button>

      <Link href="/account">
        {i18n.nav.account}
      </Link>
    </nav>
  );
}
