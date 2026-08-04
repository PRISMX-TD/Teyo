import type { Metadata, Viewport } from 'next';
import './globals.css';
import { OfflineBanner } from '@/components/shell/offline-banner';
import type { Locale } from '@/lib/i18n';
import { getCurrentUserId } from '@/server/auth/session';
import { getUserLocale } from '@/server/repositories/organizations';

export const metadata: Metadata = {
  title: 'Teyo',
  description: 'The easy way to own your business.',
  manifest: '/manifest.webmanifest',
};

export const viewport: Viewport = {
  themeColor: '#0f7a5f',
  width: 'device-width',
  initialScale: 1,
};

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
    <html lang={locale}>
      <body>
        <OfflineBanner locale={locale} />
        {children}
      </body>
    </html>
  );
}
