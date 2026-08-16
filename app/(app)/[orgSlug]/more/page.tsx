import Link from 'next/link';
import { getMessages } from '@/lib/i18n';
import { resolveOrgContext } from '@/server/auth/guard';
import { can, type Action } from '@/server/domain/permissions';
import { getUserLocale } from '@/server/repositories/organizations';

type MoreLink = { href: string; label: string; action: Action };
type MoreGroup = { label: string; items: MoreLink[] };

/**
 * 移动端 dock 只放得下 5 个目的地（Overview/Transactions/Reports/Settings/More），
 * 侧栏其余分组在这里原样列出——分组方式与 components/shell/sidebar.tsx 一致，
 * 只是去掉了 dock 上已经有入口的四项（Overview/Transactions/Reports/Settings）。
 * 「切换公司」不在这里：OrgSwitcher 直接渲染在 app-main 顶部，各屏宽都看得到，
 * 侧栏底部那个链接本来就是它的冗余副本。
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
      items: [{ href: `/${orgSlug}/settings/tax`, label: t.nav.tax, action: 'account:manage' }],
    },
  ];

  const visibleGroups = groups
    .map((group) => ({ ...group, items: group.items.filter((item) => can(context.role, item.action)) }))
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
      </nav>
    </>
  );
}
