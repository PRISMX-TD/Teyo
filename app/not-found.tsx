import Link from 'next/link';
import { getMessages } from '@/lib/i18n';
import { SealQuestion } from '@/components/ui/icons';

/**
 * 全站的 404。没有它时 Next 给的是一页英文的「404 | This page could not
 * be found.」，黑底白字、没有出口，和这个产品的其它页面毫无关系。
 *
 * 这一页不查库：任何地址打错都会落到这里，包括没登录的人。两种语言都渲染，
 * 由 root layout 写好的 <html lang> 挑一份显示（与 app/error.tsx 同一做法）。
 * '/' 会按登录状态与公司数量分流，是唯一一个对谁都成立的出口。
 */
const en = getMessages('en');
const zh = getMessages('zh');

export default function NotFound() {
  return (
    <div className="auth-page">
      <header className="auth-brand">
        <span className="brand-mark brand-mark--lg" aria-hidden="true">T</span>
        <strong>{en.brand.name}</strong>
      </header>
      <main className="auth-shell status-shell">
        <span className="status-shell-icon" aria-hidden="true">
          <SealQuestion size={28} weight="bold" />
        </span>
        <h1>
          <span className="lang-only-en">{en.errors.notFoundTitle}</span>
          <span className="lang-only-zh">{zh.errors.notFoundTitle}</span>
        </h1>
        <p>
          <span className="lang-only-en">{en.errors.notFoundBody}</span>
          <span className="lang-only-zh">{zh.errors.notFoundBody}</span>
        </p>
        <Link href="/" className="primary-button">
          <span className="lang-only-en">{en.errors.backHome}</span>
          <span className="lang-only-zh">{zh.errors.backHome}</span>
        </Link>
      </main>
    </div>
  );
}
