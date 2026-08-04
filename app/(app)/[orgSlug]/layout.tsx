import { requireUserId } from '@/server/auth/guard';
import { resolveOrgContext } from '@/server/auth/guard';
import { getMessages } from '@/lib/i18n';
import { listUserOrganizations, getUserLocale } from '@/server/repositories/organizations';
import { Sidebar } from '@/components/shell/sidebar';
import { OrgSwitcher } from '@/components/shell/org-switcher';
import React from 'react';

export default async function AppLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const userId = await requireUserId();
  const allOrgs = await listUserOrganizations(userId);

  // 用户不属于这家公司 → 跳回首页（再根据权限决定去向）
  const isMember = allOrgs.some((o) => o.slug === orgSlug);
  if (!isMember) {
    const { redirect } = await import('next/navigation');
    redirect('/');
  }

  // 预热 org 上下文：layout 和 page 的 withTransaction 可以并行执行，
  // React.cache() 保证 page 里的 requirePermission 复用同一结果。
  resolveOrgContext(orgSlug);

  const locale = (await getUserLocale(userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  return (
    <div className="app-shell">
      <Sidebar orgSlug={orgSlug} i18n={t} />
      <main className="app-main">
        <OrgSwitcher
          current={orgSlug}
          orgs={allOrgs.map((o) => ({ id: o.id, slug: o.slug, name: o.name }))}
        />
        {children}
      </main>
    </div>
  );
}
