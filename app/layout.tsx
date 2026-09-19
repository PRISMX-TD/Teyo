import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { OfflineBanner } from '@/components/shell/offline-banner';
import { ThemeScript } from '@/components/shell/theme-script';
import type { Locale } from '@/lib/i18n';
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
 * 用户连重试的入口都没有。语言只影响文案，读不到就退回 en。
 */
async function resolveShell(): Promise<{ locale: Locale; signedIn: boolean }> {
  try {
    const userId = await getCurrentUserId();
    if (!userId) return { locale: 'en', signedIn: false };
    return { locale: (await getUserLocale(userId)) as Locale, signedIn: true };
  } catch {
    // 读不出来就当未登录：OfflineBanner 拿到 signedIn=false 只是不去补发
    // 队列（见那个组件的注释），代价是多等一次页面加载；反过来把未登录
    // 当成已登录，代价是一整轮注定失败的提交。
    return { locale: 'en', signedIn: false };
  }
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { locale, signedIn } = await resolveShell();

  return (
    // 不再需要 suppressHydrationWarning：主题现在由 ThemeScript 里的同步
    // <script> 在 hydration 之前就写好 data-theme，服务端与客户端的首帧一致。
    // 它原来存在的理由，正是当初把"亮色用户首屏闪一下暗色"这个症状盖住的
    // 那个东西——留着只会让下一处不一致同样悄悄过去。
    <html lang={locale} className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body>
        <ThemeScript />
        <OfflineBanner locale={locale} signedIn={signedIn} />
        {children}
      </body>
    </html>
  );
}
