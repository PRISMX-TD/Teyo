import type { ReactNode } from 'react';
import { getMessages } from '@/lib/i18n';
import { resolveAnonymousLocale } from '@/lib/i18n/server';

export default async function AuthLayout({ children }: { children: ReactNode }) {
  // 这里还没有用户身份，语言取自浏览器的 Accept-Language。
  // 见 lib/i18n/server.ts —— 此前这四个文件一律写死 'en'。
  const t = getMessages(await resolveAnonymousLocale());

  return (
    <div className="auth-page">
      <header className="auth-brand">
        <strong>{t.brand.name}</strong>
        <p>{t.brand.tagline}</p>
      </header>
      {children}
    </div>
  );
}
