import type { ReactNode } from 'react';
import { getMessages } from '@/lib/i18n';

export default function AuthLayout({ children }: { children: ReactNode }) {
  const t = getMessages('en');

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
