import { requireUserId } from '@/server/auth/guard';
import { resolveOrgContext } from '@/server/auth/guard';
import { getMessages } from '@/lib/i18n';
import { listUserOrganizations, getUserLocale } from '@/server/repositories/organizations';
import { Sidebar } from '@/components/shell/sidebar';
import { FloatingDock } from '@/components/shell/floating-dock';
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

  const isMember = allOrgs.some((o) => o.slug === orgSlug);
  if (!isMember) {
    const { redirect } = await import('next/navigation');
    redirect('/');
  }

  resolveOrgContext(orgSlug);

  const locale = (await getUserLocale(userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  return (
    <div className="app-shell">
      {/* 跳转链接。桌面侧栏有 18 个链接，没有它，只用键盘的用户每换一页
          都要先 Tab 穿过整张导航才能碰到正文。平时用 .skip-link 挪到视口
          外，只在获得焦点时才滑进来（见 app/globals.css）。 */}
      <a href="#app-main-content" className="skip-link">
        {t.nav.skipToContent}
      </a>
      <Sidebar orgSlug={orgSlug} i18n={t} />
      {/* tabIndex={-1}：跳转链接把焦点送到这里，<main> 本身不可聚焦的话，
          浏览器只会滚动过去而焦点仍留在链接上，下一次 Tab 又回到导航。 */}
      <main id="app-main-content" className="app-main" tabIndex={-1}>
        <OrgSwitcher
          current={orgSlug}
          orgs={allOrgs.map((o) => ({ id: o.id, slug: o.slug, name: o.name }))}
        />
        {children}
      </main>
      <FloatingDock orgSlug={orgSlug} i18n={t} />
    </div>
  );
}
