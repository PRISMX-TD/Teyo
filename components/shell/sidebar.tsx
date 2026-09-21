'use client';

import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import { getMessages } from '@/lib/i18n';
import { useTheme } from './use-theme';

type Org = { id: string; slug: string; name: string };

type Props = {
  orgSlug: string;
  i18n: ReturnType<typeof getMessages>;
  /** 当前公司与用户属于的全部公司。前者用于报头，后者决定是否渲染切换下拉。 */
  orgs: Org[];
};

type NavGroup = {
  label: string;
  items: { href: string; label: string }[];
};

export function Sidebar({ orgSlug, i18n, orgs }: Props) {
  const pathname = usePathname();
  const router = useRouter();
  const { theme, toggle } = useTheme();
  const currentOrg = orgs.find((o) => o.slug === orgSlug);

  const groups: NavGroup[] = [
    {
      label: i18n.settings.general ?? 'General',
      items: [
        { href: `/${orgSlug}`, label: i18n.nav.overview },
        { href: `/${orgSlug}/transactions`, label: i18n.nav.transactions },
        // Task 16：待确认队列——「不确定」场景卡片记下的条目最终要有地方去处理，
        // 挂在「流水」组下而不是单开一个顶级分组，因为它本质上是交易列表的一个过滤视图。
        { href: `/${orgSlug}/uncertain`, label: i18n.uncertain.title },
      ],
    },
    {
      label: i18n.nav.invoices,
      items: [
        { href: `/${orgSlug}/invoices`, label: i18n.nav.invoices },
        { href: `/${orgSlug}/payments`, label: i18n.nav.payments },
        { href: `/${orgSlug}/credit-notes`, label: i18n.nav.creditNotes },
        { href: `/${orgSlug}/purchase-orders`, label: i18n.nav.purchaseOrders },
        { href: `/${orgSlug}/bills`, label: i18n.nav.bills },
      ],
    },
    {
      label: i18n.nav.reports,
      items: [
        { href: `/${orgSlug}/reports`, label: i18n.nav.reports },
        { href: `/${orgSlug}/general-ledger`, label: i18n.nav.generalLedger },
        { href: `/${orgSlug}/reconciliation`, label: i18n.nav.reconciliation },
        { href: `/${orgSlug}/budgets`, label: i18n.nav.budgets },
      ],
    },
    {
      label: i18n.nav.projects,
      items: [
        { href: `/${orgSlug}/projects`, label: i18n.nav.projects },
        { href: `/${orgSlug}/bank-import`, label: i18n.nav.bankImport },
        { href: `/${orgSlug}/fixed-assets`, label: i18n.nav.fixedAssets },
        { href: `/${orgSlug}/export`, label: i18n.nav.export },
      ],
    },
    {
      label: i18n.nav.settings,
      items: [
        { href: `/${orgSlug}/settings`, label: i18n.nav.settings },
        { href: `/${orgSlug}/settings/tax`, label: i18n.nav.tax },
      ],
    },
  ];

  return (
    <aside className="sidebar">
      {/* 报头。公司名以前只在「有两家以上公司」时才由 <select> 露出来
          （OrgSwitcher 在 orgs.length <= 1 时 return null），于是单公司的
          用户从头到尾不知道自己在哪家公司的账里——而这个应用的卖点恰恰是
          「一个人可以管几套账」。现在公司名常驻，切换下拉只在真的有得切
          的时候才追加在它下面。 */}
      <div className="sidebar-masthead">
        <span className="sidebar-brand">{i18n.brand.name}</span>
        {currentOrg ? (
          <span className="sidebar-org" title={currentOrg.name}>
            {currentOrg.name}
          </span>
        ) : null}
        {orgs.length > 1 ? (
          <>
            <label className="visually-hidden" htmlFor="sidebar-org-select">
              {i18n.nav.switchCompany}
            </label>
            <select
              id="sidebar-org-select"
              className="sidebar-org-select"
              value={orgSlug}
              onChange={(e) => {
                if (e.target.value !== orgSlug) router.push(`/${e.target.value}`);
              }}
            >
              {orgs.map((org) => (
                <option key={org.id} value={org.slug}>
                  {org.name}
                </option>
              ))}
            </select>
          </>
        ) : null}
      </div>

      <Link href={`/${orgSlug}/transactions/new`} className="sidebar-action">
        {i18n.transaction.newTitle}
      </Link>

      <nav className="sidebar-nav">
        {groups.map((group, gi) => (
          <div key={gi} className="sidebar-group">
            <div className="sidebar-group-label">{group.label}</div>
            {group.items.map((link) => {
              const isActive =
                pathname === link.href ||
                (link.href !== `/${orgSlug}` && pathname.startsWith(link.href));
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  // className 只喂给 CSS，读屏完全看不见它。aria-current
                  // 才是「你正在这一页」这件事唯一能被辅助技术感知的形式；
                  // 没有它，18 个链接里哪个是当前页，读屏用户无从判断。
                  aria-current={isActive ? 'page' : undefined}
                  className={isActive ? 'active' : ''}
                >
                  {link.label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="sidebar-footer">
        {/* 原来是 `theme === 'dark' ? 'Light' : 'Dark'`：同一个功能在 /more
            页面走的是 t.nav.toggleTheme，这里却是两段写死的英文。文案统一
            到 catalog，当前状态交给 aria-pressed 表达（「深色模式开着吗」
            正是一个双态开关，不是两个不同的按钮）。 */}
        <button
          type="button"
          className="theme-toggle"
          aria-pressed={theme === 'dark'}
          onClick={toggle}
        >
          <span>{i18n.nav.toggleTheme}</span>
          <span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span>
        </button>
        <Link href="/account">{i18n.nav.account}</Link>
        <Link href="/">{i18n.nav.switchCompany}</Link>
      </div>
    </aside>
  );
}
