import Link from 'next/link';
import { getMessages } from '@/lib/i18n';
import { resolveOrgContext } from '@/server/auth/guard';
import { can, type Action } from '@/server/domain/permissions';
import { getUserLocale } from '@/server/repositories/organizations';
import { ThemeToggleButton } from '@/components/shell/theme-toggle-button';

// action 留空表示不做权限过滤——settings/page.tsx（分流页本身）和
// /account 对任何已登录成员都可见，只是各自内部按角色再筛一遍要展示什么。
type MoreLink = { href: string; label: string; action?: Action };
type MoreGroup = { label: string; items: MoreLink[] };

/**
 * 移动端 dock 只放得下 5 格（Overview/Transactions/Reports/More/+），
 * 侧栏其余分组、以及从 dock 挪出来的 Settings/主题切换/My account 都在这里——
 * 分组方式与 components/shell/sidebar.tsx 一致，只去掉 dock 上已有入口的三项
 * （Overview/Transactions/Reports）。「切换公司」不在这里：OrgSwitcher 直接
 * 渲染在 app-main 顶部，各屏宽都看得到，侧栏底部那个链接本来就是它的冗余副本。
 *
 * dock 最初塞了 8 格（含 Settings/主题切换/My account），用 Playwright 在
 * 375px 量过之后才发现问题不是某个格子里的文字被裁——是一整行本身在 320-390px
 * 都放不下（约需 400px），My account 被推出视口，完全点不到。收紧格子内边距
 * 挪的是 0px 的整行宽度（几乎每格早顶到了 min-width:44px 的地板），治不了这个。
 * 真正的修法是砍格子数，把 Settings/主题切换/My account 搬到这一页：
 * 主题切换单独拆成 ThemeToggleButton（客户端组件，这页其余部分仍是纯服务端
 * 渲染），因为它需要 localStorage/matchMedia，不能是个静态链接。
 */
export default async function MorePage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const context = await resolveOrgContext(orgSlug);
  const locale = (await getUserLocale(context.userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  const groups: MoreGroup[] = [
    {
      label: t.settings.general,
      items: [{ href: `/${orgSlug}/uncertain`, label: t.uncertain.title, action: 'transaction:read' }],
    },
    {
      label: t.nav.invoices,
      items: [
        { href: `/${orgSlug}/invoices`, label: t.nav.invoices, action: 'transaction:read' },
        { href: `/${orgSlug}/payments`, label: t.nav.payments, action: 'transaction:read' },
        { href: `/${orgSlug}/credit-notes`, label: t.nav.creditNotes, action: 'transaction:read' },
        { href: `/${orgSlug}/purchase-orders`, label: t.nav.purchaseOrders, action: 'transaction:read' },
        { href: `/${orgSlug}/bills`, label: t.nav.bills, action: 'transaction:read' },
      ],
    },
    {
      label: t.nav.reports,
      items: [
        { href: `/${orgSlug}/general-ledger`, label: t.nav.generalLedger, action: 'transaction:read' },
        { href: `/${orgSlug}/reconciliation`, label: t.nav.reconciliation, action: 'transaction:edit:any' },
        { href: `/${orgSlug}/budgets`, label: t.nav.budgets, action: 'account:manage' },
      ],
    },
    {
      label: t.nav.projects,
      items: [
        { href: `/${orgSlug}/projects`, label: t.nav.projects, action: 'transaction:read' },
        { href: `/${orgSlug}/bank-import`, label: t.nav.bankImport, action: 'transaction:create' },
        { href: `/${orgSlug}/fixed-assets`, label: t.nav.fixedAssets, action: 'account:manage' },
        { href: `/${orgSlug}/export`, label: t.nav.export, action: 'report:export' },
      ],
    },
    {
      label: t.nav.settings,
      items: [
        // 分流页本身不设权限门槛——它只是分流，settings/page.tsx 再按角色筛一遍
        // 具体子页（同样的道理见该文件顶部的注释）。
        { href: `/${orgSlug}/settings`, label: t.nav.settings },
        { href: `/${orgSlug}/settings/tax`, label: t.nav.tax, action: 'account:manage' },
      ],
    },
  ];

  const visibleGroups = groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => !item.action || can(context.role, item.action)),
    }))
    .filter((group) => group.items.length > 0);

  return (
    <>
      <h1>{t.nav.more}</h1>

      <nav aria-label={t.nav.more}>
        {visibleGroups.map((group) => (
          <section key={group.label} style={{ marginBottom: 'var(--space-6)' }}>
            <h2 className="coa-section-title">{group.label}</h2>
            <div className="settings-index">
              {group.items.map((item) => (
                <Link key={item.href} href={item.href}>
                  {item.label}
                </Link>
              ))}
            </div>
          </section>
        ))}

        {/* 从 dock 搬过来的两项：任何已登录成员都能看，不走 can() 过滤。 */}
        <section style={{ marginBottom: 'var(--space-6)' }}>
          <h2 className="coa-section-title">{t.nav.account}</h2>
          <div className="settings-index">
            <Link href="/account">{t.nav.account}</Link>
            <ThemeToggleButton label={t.nav.toggleTheme} />
          </div>
        </section>
      </nav>
    </>
  );
}
