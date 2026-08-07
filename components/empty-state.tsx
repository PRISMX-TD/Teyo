import Link from 'next/link';
import type { Locale } from '@/lib/i18n';

type Props = {
  title: string;
  description: string;
  /** Optional CTA */
  href?: string;
  ctaLabel?: string;
  locale: Locale;
};

export function EmptyState({ title, description, href, ctaLabel, locale }: Props) {
  return (
    <div className="empty-state" style={{ padding: 'var(--space-12) var(--space-4)', textAlign: 'center' }}>
      <div style={{
        width: 48, height: 48, margin: '0 auto var(--space-5)',
        borderRadius: '50%', background: 'var(--bg-tertiary)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: '1.25rem', color: 'var(--text-tertiary)',
      }}>
        {locale === 'zh' ? '空' : '~'}
      </div>
      <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginBottom: 'var(--space-2)', fontWeight: 500 }}>
        {title}
      </p>
      <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: href ? 'var(--space-5)' : 0, maxWidth: 320, marginLeft: 'auto', marginRight: 'auto' }}>
        {description}
      </p>
      {href && ctaLabel ? (
        <Link href={href} className="primary-button" style={{ display: 'inline-flex' }}>
          {ctaLabel}
        </Link>
      ) : null}
    </div>
  );
}
