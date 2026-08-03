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
    { href: `/${orgSlug}/export`, label: i18n.nav.export },
    { href: `/${orgSlug}/settings`, label: i18n.nav.settings },
  ];

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">{i18n.brand.name}</div>

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
        <Link href="/">{i18n.nav.switchCompany}</Link>
      </div>
    </aside>
  );
}
