import type { Metadata, Viewport } from 'next';
import './globals.css';
import { OfflineBanner } from '@/components/shell/offline-banner';
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

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const userId = await getCurrentUserId();
  const locale = (userId ? await getUserLocale(userId) : 'en') as import('@/lib/i18n').Locale;

  return (
    <html lang={locale}>
      <body>
        <OfflineBanner locale={locale} />
        {children}
      </body>
    </html>
  );
}
