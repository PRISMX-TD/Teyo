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
