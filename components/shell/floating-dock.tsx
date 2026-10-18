'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import type { Messages } from '@/lib/i18n';
import { can, type Role } from '@/server/domain/permissions';
import { Plus } from '@/components/ui/icons';
import { NavIcon, type NavIconName } from './nav-icons';

type Props = {
  orgSlug: string;
  i18n: Messages;
  role: Role;
};

// 5 个格子，不是 8 个：第一版把 Settings/主题切换/My account 全塞进 dock，
// 375px 上一行需要约 400px——375-container-fit 复测（container.scrollWidth
// vs clientWidth + 逐项 getBoundingClientRect().right）证实 320-390px 下
// My account 整个被推出视口、点不到。Settings、主题切换、My account 现在都
// 挂在 More 页面里（app/(app)/[orgSlug]/more/page.tsx），第一版复测确认
// 5 项在 320px 和 375px 都留有余量。
const NAV_ITEMS: { label: keyof Messages['nav'] & NavIconName; href: (slug: string) => string }[] = [
  { label: 'overview', href: (slug) => `/${slug}` },
  { label: 'transactions', href: (slug) => `/${slug}/transactions` },
  { label: 'reports', href: (slug) => `/${slug}/reports` },
  // 侧栏另外 15 个目的地（Settings、发票/账单/收付款/对账/预算/项目...、
  // 主题切换、My account）在移动端没有入口——sidebar 在 767px 以下直接
  // display:none。这一格不是某个具体页面，是分流页，按侧栏分组把其余目的地
  // 列出来，不在其中挑一个顶上去：Invoices/Bills/Payments 三个只挑一个会留下
  // 另外两个依然进不去，等于把「开发票」和「收发票的钱」拆成两条不对称的路。
  { label: 'more', href: (slug) => `/${slug}/more` },
];

export function FloatingDock({ orgSlug, i18n, role }: Props) {
  const pathname = usePathname();

  const matches = (href: string) =>
    pathname === href || (href !== `/${orgSlug}` && pathname.startsWith(`${href}/`));
  // 从 More 分流进去的页面（发票、账单、设置……）在 dock 上没有自己的格子，
  // 原来在那些页面上 dock 一格都不亮，用户看不出自己在哪个分支下。归到 More。
  const moreHref = `/${orgSlug}/more`;
  const underMore =
    pathname.startsWith(`/${orgSlug}/`) &&
    !NAV_ITEMS.some((item) => item.label !== 'more' && matches(item.href(orgSlug)));

  const tabs = NAV_ITEMS.map((item) => {
    const href = item.href(orgSlug);
    const isActive = matches(href);
    // 只有真的停在 /more 上才是 aria-current="page"；从 More 分流进去的
    // 子页只是「在这个分支里」，用 'true' 而不是冒充当前页。
    const isBranch = !isActive && href === moreHref && underMore;
    return (
      <Link
        key={item.label}
        href={href}
        aria-current={isActive ? 'page' : isBranch ? 'true' : undefined}
        className={isActive || isBranch ? 'active' : ''}
      >
        <NavIcon name={item.label} active={isActive || isBranch} size={24} />
        {/* 标签栏一格只有 57px：英文「Transactions」加粗后放不下，被截成
            「Transacti…」。这里单用一个短词，侧栏和页面标题仍用全称。英文用
            「Records」（全站文案管一笔流水就叫 record）；不用「Activity」，
            设置里的「Activity log」是另一个页面。 */}
        <span>{item.label === 'transactions' ? i18n.nav.dockRecords : i18n.nav[item.label]}</span>
      </Link>
    );
  });

  // 「记一笔」放在正中间：这是整个应用最常做的一件事，拇指在屏幕下沿
  // 最容易够到的就是正中。viewer 没有 transaction:create，这一格对它
  // 只会是一个 403，干脆不画，其余四格平分整行。
  const cta = can(role, 'transaction:create') ? (
    <Link
      key="cta"
      href={`/${orgSlug}/transactions/new`}
      className="topbar-cta"
      aria-label={i18n.transaction.newTitle}
    >
      <Plus className="nav-icon" size={26} weight="bold" aria-hidden="true" />
    </Link>
  ) : null;

  return (
    <nav className="floating-dock" aria-label={i18n.nav.primaryNavigation}>
      {tabs.slice(0, 2)}
      {cta}
      {tabs.slice(2)}
    </nav>
  );
}
