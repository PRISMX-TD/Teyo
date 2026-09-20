import { getMessages } from '@/lib/i18n';

/**
 * Suspense 兜底骨架屏。
 *
 * 它必须是同步渲染的——这一页存在的全部意义就是「在数据回来之前先给点
 * 东西看」，为了取用户的语言再去查一次库，等于把它要遮的那段等待原样加回来。
 * 所以和 app/error.tsx 走同一条路：两种语言都渲染，由 <html lang> 用 CSS
 * 挑一份（.lang-only-en / .lang-only-zh，见 app/globals.css）。
 *
 * 原来同时写了 aria-label="Loading" 和一段可见文字 "Loading…"，两者都写死
 * 英文；而且 aria-label 会**覆盖**元素内的文字内容，读屏只会念 label，
 * 里面那句等于白写。现在只留 role="status" + 一段视觉隐藏的文字。
 */
const en = getMessages('en');
const zh = getMessages('zh');

export default function Loading() {
  return (
    <div className="loading-skeleton" role="status">
      <span className="visually-hidden">
        <span className="lang-only-en">{en.common.loading}</span>
        <span className="lang-only-zh">{zh.common.loading}</span>
      </span>
    </div>
  );
}
