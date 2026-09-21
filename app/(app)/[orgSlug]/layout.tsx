import { requireUserId } from '@/server/auth/guard';
import { resolveOrgContext } from '@/server/auth/guard';
import { getMessages } from '@/lib/i18n';
import { listUserOrganizations, getUserLocale } from '@/server/repositories/organizations';
import { Sidebar } from '@/components/shell/sidebar';
import { FloatingDock } from '@/components/shell/floating-dock';
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
      <Sidebar
        orgSlug={orgSlug}
        i18n={t}
        orgs={allOrgs.map((o) => ({ id: o.id, slug: o.slug, name: o.name }))}
      />
      {/* tabIndex={-1}：跳转链接把焦点送到这里，<main> 本身不可聚焦的话，
          浏览器只会滚动过去而焦点仍留在链接上，下一次 Tab 又回到导航。 */}
      {/* 公司切换器已移进侧栏报头（见 components/shell/sidebar.tsx）。
          它原来浮在正文最上面，每一页的标题都被一个下拉框压在下面——
          切换公司是一个导航动作，属于导航区，不属于内容区。 */}
      <main id="app-main-content" className="app-main" tabIndex={-1}>
        {children}
      </main>
      <FloatingDock orgSlug={orgSlug} i18n={t} />
    </div>
  );
}
