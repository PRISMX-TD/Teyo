import { getMessages } from '@/lib/i18n';
import { WifiSlash } from '@/components/ui/icons';

/**
 * Service Worker 的离线兜底页（见 app/sw.ts）。它是在构建时静态生成、
 * 由 SW 从缓存里直接吐出来的——那一刻既没有会话也没有数据库，所以和
 * app/error.tsx 一样拿不到用户 locale。
 *
 * 原来的写法是把中英两句直接写死并排显示，两种语言的用户都得先跳过一句
 * 看不懂的话。这里改成：文案回到 catalog，两份都渲染，由 <html lang> 用
 * CSS 挑一份显示（.lang-only-en / .lang-only-zh，见 app/globals.css）。
 * lang 由 root layout 在服务端写入；离线时那份 HTML 也是缓存里的同一份。
 *
 * 版面借登录页的外壳（.auth-page + .auth-brand）：这一页在 (auth) 路由组
 * 之外，原来是一张贴着屏幕顶边、没有左右留白的卡片。
 */
const en = getMessages('en');
const zh = getMessages('zh');

export default function OfflinePage() {
  return (
    <div className="auth-page">
      <header className="auth-brand">
        <span className="brand-mark brand-mark--lg" aria-hidden="true">T</span>
        <strong>{en.brand.name}</strong>
      </header>
      <main className="auth-shell status-shell">
        <span className="status-shell-icon" aria-hidden="true">
          <WifiSlash size={28} weight="bold" />
        </span>
        <h1>
          <span className="lang-only-en">{en.offlinePage.title}</span>
          <span className="lang-only-zh">{zh.offlinePage.title}</span>
        </h1>
        <p>
          <span className="lang-only-en">{en.offlinePage.body}</span>
          <span className="lang-only-zh">{zh.offlinePage.body}</span>
        </p>
        {/* 空 href 就是「再请求一次当前地址」：SW 兜底时地址栏没变，还是用户
            原本要去的那一页。用普通 <a> 而不是按钮 + reload()：离线时这页的
            JS 未必在缓存里，链接不靠 JS 也能点。 */}
        <a href="" className="primary-button">
          <span className="lang-only-en">{en.errors.tryAgain}</span>
          <span className="lang-only-zh">{zh.errors.tryAgain}</span>
        </a>
      </main>
    </div>
  );
}
