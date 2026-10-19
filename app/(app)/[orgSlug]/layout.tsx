import { redirect } from 'next/navigation';
import { AuthError, requireUserId, resolveOrgContext } from '@/server/auth/guard';
import { getMessages } from '@/lib/i18n';
import { listUserOrganizations, getUserLocale } from '@/server/repositories/organizations';
import { Sidebar } from '@/components/shell/sidebar';
import { FloatingDock } from '@/components/shell/floating-dock';
import { MobileBar } from '@/components/shell/mobile-bar';
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

  // 三条查询互不依赖，拿到 userId 后一起发出。原来是串行的四次往返
  // （getUser → 公司列表 → 公司上下文 → 语言）。页面与 layout 是并行渲染的，
  // 页面里的 requirePermission / getUserLocale 经 React.cache 拿到的是这里
  // 同一个 Promise——语言查询提前发出，页面首段也跟着少等一轮。
  // resolveOrgContext 对非成员会抛 not_found；先接住，下面按成员资格重定向。
  const [allOrgs, context, localeRaw] = await Promise.all([
    listUserOrganizations(userId),
    resolveOrgContext(orgSlug).catch((error: unknown) => {
      // 只吞「不是成员」；数据库挂了之类照常抛给 error boundary，
      // 不能伪装成「你已无权访问」。
      if (error instanceof AuthError) return null;
      throw error;
    }),
    getUserLocale(userId),
  ]);

  const isMember = allOrgs.some((o) => o.slug === orgSlug);
  if (!isMember || !context) {
    // 带上原因：被暂停或移除的人不该被一声不响地丢到建公司页。
    // context 为空而列表里还有它：两次查询之间成员资格被撤销，同样处理。
    redirect('/?notice=no_access');
  }

  const locale = localeRaw as 'en' | 'zh';
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
        role={context.role}
      />
      {/* 手机上侧栏隐藏，公司名与「我的账号」由这一条顶上来（≥768px 不显示）。 */}
      <MobileBar
        orgSlug={orgSlug}
        orgName={allOrgs.find((o) => o.slug === orgSlug)?.name ?? ''}
        orgCount={allOrgs.length}
        i18n={t}
      />
      {/* tabIndex={-1}：跳转链接把焦点送到这里，<main> 本身不可聚焦的话，
          浏览器只会滚动过去而焦点仍留在链接上，下一次 Tab 又回到导航。 */}
      {/* 公司切换器已移进侧栏报头（见 components/shell/sidebar.tsx）。
          它原来浮在正文最上面，每一页的标题都被一个下拉框压在下面——
          切换公司是一个导航动作，属于导航区，不属于内容区。 */}
      <main id="app-main-content" className="app-main" tabIndex={-1}>
        {children}
      </main>
      <FloatingDock orgSlug={orgSlug} i18n={t} role={context.role} />
    </div>
  );
}
