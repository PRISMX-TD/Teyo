import { getMessages } from '@/lib/i18n';
import { OrgHomeLink } from '@/components/shell/org-home-link';

/**
 * 公司内的 404：详情页 notFound()（单据号不存在、被删、属于别家公司）时
 * 落到这里。放在公司外壳里，侧栏 / 标签栏都还在，用户知道自己仍在哪家
 * 公司的账里，不会被甩到一张孤零零的系统页上。
 *
 * not-found.tsx 拿不到 params，也就查不到用户语言；外壳的 <html lang>
 * 已经是用户语言，于是同 app/error.tsx 一样两份都渲染、由 CSS 挑一份。
 */
const en = getMessages('en');
const zh = getMessages('zh');

export default function OrgNotFound() {
  return (
    <>
      <h1>
        <span className="lang-only-en">{en.errors.notFoundTitle}</span>
        <span className="lang-only-zh">{zh.errors.notFoundTitle}</span>
      </h1>
      <div className="empty-state not-found-card">
        <p>
          <span className="lang-only-en">{en.errors.notFoundBody}</span>
          <span className="lang-only-zh">{zh.errors.notFoundBody}</span>
        </p>
        <OrgHomeLink className="primary-button">
          <span className="lang-only-en">{en.errors.backToOverview}</span>
          <span className="lang-only-zh">{zh.errors.backToOverview}</span>
        </OrgHomeLink>
      </div>
    </>
  );
}
