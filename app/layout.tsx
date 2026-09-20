import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { OfflineBanner } from '@/components/shell/offline-banner';
import { ThemeScript } from '@/components/shell/theme-script';
import type { Locale } from '@/lib/i18n';
import { resolveAnonymousLocale } from '@/lib/i18n/server';
import { getCurrentUserId } from '@/server/auth/session';
import { getUserLocale } from '@/server/repositories/organizations';

export const metadata: Metadata = {
  title: 'Teyo',
  description: 'The easy way to own your business.',
  manifest: '/manifest.webmanifest',
  // metadataBase 缺失时 Next.js 会对 OG/manifest 的相对路径发警告
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL ??
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000'),
  ),
};

/**
 * themeColor 与 --accent 对齐。
 *
 * 这四个值以前是四套互不相干的品牌色：这里是 #0f1117/#f8f9fb（页面底色），
 * app/manifest.ts 与 app/icon.tsx 是 #0f7a5f（绿），globals.css 的 --accent
 * 是蓝。用户装完 PWA 看到一个绿色图标，点开是蓝色界面，浏览器地址栏又是
 * 第三种深色——三处各自都"没错"，合起来不像同一个产品。
 *
 * 统一取强调色而不是底色：themeColor 染的是浏览器工具栏与任务切换器里的
 * 那一条，它在视觉上属于"这个应用的颜色"，不是"这一页的背景"。
 */
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#3b82f6' },
    { media: '(prefers-color-scheme: light)', color: '#2563eb' },
  ],
  width: 'device-width',
  initialScale: 1,
};

/**
 * 自托管字体：金额与日期必须用等宽 + tabular-nums 才能纵向对齐，
 * 这是记账界面的核心排版纪律，不能依赖用户机器上恰好装了什么。
 * display: 'swap' 保证字体没下载完时文字仍可读。
 */
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

/**
 * root layout 包裹每一个页面，所以这里抛错会让整站白屏——包括登录页，
 * 用户连重试的入口都没有。语言只影响文案，读不到就退回浏览器偏好。
 *
 * 未登录时取 Accept-Language 而不是硬回 'en'：<html lang> 决定读屏器用
 * 哪种语音念这一页。登录页的文案本来就已经按 Accept-Language 协商过了
 * （见 app/(auth)/layout.tsx），这里若仍然写死 'en'，屏幕上是中文而
 * lang 说是英文——读屏器会用英语的音去念中文，而视觉用户完全看不出问题。
 * 这是实际跑起来之后才发现的：页面是中文的，<html lang="en">。
 */
async function resolveShell(): Promise<{ locale: Locale; signedIn: boolean }> {
  try {
    const userId = await getCurrentUserId();
    if (!userId) return { locale: await resolveAnonymousLocale(), signedIn: false };
    return { locale: (await getUserLocale(userId)) as Locale, signedIn: true };
  } catch {
    // 读不出来就当未登录：OfflineBanner 拿到 signedIn=false 只是不去补发
    // 队列（见那个组件的注释），代价是多等一次页面加载；反过来把未登录
    // 当成已登录，代价是一整轮注定失败的提交。
    return { locale: await resolveAnonymousLocale(), signedIn: false };
  }
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { locale, signedIn } = await resolveShell();

  return (
    // suppressHydrationWarning 是必需的，不是遗留物。
    //
    // 我一度把它删掉了，理由是「主题现在由同步 <script> 在 hydration 之前
    // 就写好 data-theme，服务端与客户端应该一致」。把应用真的跑起来之后，
    // 控制台立刻报了 hydration mismatch —— 那个推理错在一个关键处：
    // **服务端根本渲染不出 data-theme**。主题存在 localStorage 与
    // prefers-color-scheme 里，两者服务端都读不到，所以 SSR 出来的 <html>
    // 上没有这个属性；同步脚本在浏览器里把它加上，React 随后 hydrate 时
    // 看到的就是「客户端多了一个属性」。
    //
    // 这正是 suppressHydrationWarning 存在的场景，也是 Next.js 文档里
    // 主题脚本的标准写法。它抑制的只有 <html> 这一个元素上的属性差异，
    // 不会掩盖子树里的任何不一致。
    //
    // 当初它确实顺带盖住了「亮色用户首屏闪暗色」的症状——但那个 bug 的
    // 根因是 ThemeScript 写成了 useEffect（已修成同步 script），不是这个
    // 属性。删掉它等于为了一个已经修好的 bug 去掉一个本来就需要的东西。
    <html
      lang={locale}
      className={`${inter.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <body>
        <ThemeScript />
        <OfflineBanner locale={locale} signedIn={signedIn} />
        {children}
      </body>
    </html>
  );
}
