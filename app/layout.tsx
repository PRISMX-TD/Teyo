import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { OfflineBanner } from '@/components/shell/offline-banner';
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

export const viewport: Viewport = {
  themeColor: '#0f7a5f',
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
async function resolveLocale(): Promise<Locale> {
  try {
    const userId = await getCurrentUserId();
    if (!userId) return 'en';
    return (await getUserLocale(userId)) as Locale;
  } catch {
    return 'en';
  }
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await resolveLocale();

  return (
    <html lang={locale} className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body>
        <OfflineBanner locale={locale} />
        {children}
      </body>
    </html>
  );
}
