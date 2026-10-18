'use client';

import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import { getMessages } from '@/lib/i18n';
import { can, type Action, type Role } from '@/server/domain/permissions';
import { Plus } from '@/components/ui/icons';
import { NavIcon, type NavIconName } from './nav-icons';
import { useTheme } from './use-theme';

type Org = { id: string; slug: string; name: string };

type Props = {
  orgSlug: string;
  i18n: ReturnType<typeof getMessages>;
  /** 当前公司与用户属于的全部公司。前者用于报头，后者决定是否渲染切换下拉。 */
  orgs: Org[];
  /** 当前用户在这家公司的角色，用来隐藏点进去就 403 的入口（与 more 页同一套过滤）。 */
  role: Role;
};

type NavGroup = {
  label: string;
  // action 与对应页面 requirePermission 的那一个保持一致；留空表示任何成员可见。
  items: { href: string; label: string; icon: NavIconName; action?: Action }[];
};

export function Sidebar({ orgSlug, i18n, orgs, role }: Props) {
  const pathname = usePathname();
  const router = useRouter();
  const { theme, toggle } = useTheme();
  const currentOrg = orgs.find((o) => o.slug === orgSlug);

  const allGroups: NavGroup[] = [
    {
      label: i18n.nav.groupDaily,
      items: [
        { href: `/${orgSlug}`, label: i18n.nav.overview, icon: 'overview', action: 'transaction:read' },
        { href: `/${orgSlug}/transactions`, label: i18n.nav.transactions, icon: 'transactions', action: 'transaction:read' },
        // Task 16：待确认队列——「不确定」场景卡片记下的条目最终要有地方去处理，
        // 挂在「流水」组下而不是单开一个顶级分组，因为它本质上是交易列表的一个过滤视图。
        { href: `/${orgSlug}/uncertain`, label: i18n.uncertain.title, icon: 'uncertain', action: 'transaction:read' },
      ],
    },
    {
      label: i18n.nav.groupDocuments,
      items: [
        { href: `/${orgSlug}/invoices`, label: i18n.nav.invoices, icon: 'invoices', action: 'transaction:read' },
        { href: `/${orgSlug}/payments`, label: i18n.nav.payments, icon: 'payments', action: 'transaction:read' },
        { href: `/${orgSlug}/credit-notes`, label: i18n.nav.creditNotes, icon: 'creditNotes', action: 'transaction:read' },
        { href: `/${orgSlug}/purchase-orders`, label: i18n.nav.purchaseOrders, icon: 'purchaseOrders', action: 'transaction:read' },
        { href: `/${orgSlug}/bills`, label: i18n.nav.bills, icon: 'bills', action: 'transaction:read' },
      ],
    },
    {
      label: i18n.nav.groupBooks,
      items: [
        { href: `/${orgSlug}/reports`, label: i18n.nav.reports, icon: 'reports', action: 'transaction:read' },
        { href: `/${orgSlug}/general-ledger`, label: i18n.nav.generalLedger, icon: 'generalLedger', action: 'transaction:read' },
        { href: `/${orgSlug}/reconciliation`, label: i18n.nav.reconciliation, icon: 'reconciliation', action: 'transaction:edit:any' },
        { href: `/${orgSlug}/budgets`, label: i18n.nav.budgets, icon: 'budgets', action: 'account:manage' },
      ],
    },
    {
      label: i18n.nav.groupTools,
      items: [
        { href: `/${orgSlug}/projects`, label: i18n.nav.projects, icon: 'projects', action: 'transaction:read' },
        { href: `/${orgSlug}/bank-import`, label: i18n.nav.bankImport, icon: 'bankImport', action: 'transaction:create' },
        { href: `/${orgSlug}/fixed-assets`, label: i18n.nav.fixedAssets, icon: 'fixedAssets', action: 'account:manage' },
        { href: `/${orgSlug}/export`, label: i18n.nav.export, icon: 'export', action: 'report:export' },
      ],
    },
    {
      label: i18n.nav.groupSettings,
      items: [
        { href: `/${orgSlug}/settings`, label: i18n.nav.settings, icon: 'settings' },
        { href: `/${orgSlug}/settings/tax`, label: i18n.nav.tax, icon: 'tax', action: 'account:manage' },
      ],
    },
  ];

  // 原来侧栏不分角色全部列出，viewer 能看到预算/对账/固定资产/导出/税务/
  // 银行导入，点进去全是 403；more 页早就按 can() 筛过，两处入口不一致。
  const groups = allGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => !item.action || can(role, item.action)),
    }))
    .filter((group) => group.items.length > 0);

  // 当前页只认一个链接：取「完全相等或以 href + '/' 开头」里最长的那条。
  // 原来是裸 startsWith，在 /settings/tax 上「设置」和「税务」会同时高亮
  // （两条 aria-current="page"），而且没有路径边界——/x/bills 也会匹配
  // /x/bills-archive 这类将来的同级路由。总览 /${orgSlug} 只认完全相等。
  const activeHref = groups
    .flatMap((group) => group.items.map((item) => item.href))
    .filter(
      (href) =>
        pathname === href || (href !== `/${orgSlug}` && pathname.startsWith(`${href}/`)),
    )
    .reduce<string | null>((best, href) => (!best || href.length > best.length ? href : best), null);

  return (
    <aside className="sidebar">
      {/* 报头。公司名以前只在「有两家以上公司」时才由 <select> 露出来
          （OrgSwitcher 在 orgs.length <= 1 时 return null），于是单公司的
          用户从头到尾不知道自己在哪家公司的账里——而这个应用的卖点恰恰是
          「一个人可以管几套账」。现在公司名常驻，切换下拉只在真的有得切
          的时候才追加在它下面。 */}
      <div className="sidebar-masthead">
        <span className="brand-mark" aria-hidden="true">T</span>
        <div className="sidebar-identity">
          <span className="sidebar-brand">{i18n.brand.name}</span>
          {currentOrg ? (
            <span className="sidebar-org" title={currentOrg.name}>
              {currentOrg.name}
            </span>
          ) : null}
        </div>
      </div>
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

      {can(role, 'transaction:create') ? (
        <Link href={`/${orgSlug}/transactions/new`} className="sidebar-action">
          <Plus size={16} weight="bold" aria-hidden="true" />
          {i18n.transaction.newTitle}
        </Link>
      ) : null}

      <nav className="sidebar-nav" aria-label={i18n.nav.primaryNavigation}>
        {groups.map((group) => (
          <div key={group.label} className="sidebar-group">
            <div className="sidebar-group-label">{group.label}</div>
            {group.items.map((link) => {
              const isActive = link.href === activeHref;
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
                  <NavIcon name={link.icon} active={isActive} size={19} />
                  <span>{link.label}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="sidebar-footer">
        {/* 一个 iOS 式的开关。文案统一走 catalog（「深色模式」），开没开交给
            aria-pressed：读屏器念「深色模式，切换按钮，已按下」，与看到的
            开关是同一个状态。 */}
        <button
          type="button"
          className="theme-toggle"
          aria-pressed={theme === 'dark'}
          onClick={toggle}
        >
          <NavIcon name="theme" size={18} />
          <span>{i18n.nav.toggleTheme}</span>
          <span className="theme-switch" aria-hidden="true" />
        </button>
        {/* from：/account 的「返回」回到这里，而不是 '/'（见 account-link.tsx）。 */}
        <Link href={`/account?from=${encodeURIComponent(pathname)}`}>
          <NavIcon name="account" size={18} />
          <span>{i18n.nav.account}</span>
        </Link>
        <Link href="/">
          <NavIcon name="switchCompany" size={18} />
          <span>{i18n.nav.switchCompany}</span>
        </Link>
        {/* 只有一家公司时 '/' 会直接跳回这家（见 app/page.tsx），这里是唯一
            能建第二家的入口；new=1 让 /onboarding 不把已有公司的人送走。 */}
        <Link href="/onboarding?new=1">
          <NavIcon name="newCompany" size={18} />
          <span>{i18n.nav.newCompany}</span>
        </Link>
      </div>
    </aside>
  );
}
