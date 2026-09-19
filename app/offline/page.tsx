import { getMessages } from '@/lib/i18n';

/**
 * Service Worker 的离线兜底页（见 app/sw.ts）。它是在构建时静态生成、
 * 由 SW 从缓存里直接吐出来的——那一刻既没有会话也没有数据库，所以和
 * app/error.tsx 一样拿不到用户 locale。
 *
 * 原来的写法是把中英两句直接写死并排显示，两种语言的用户都得先跳过一句
 * 看不懂的话。这里改成：文案回到 catalog，两份都渲染，由 <html lang> 用
 * CSS 挑一份显示（.lang-only-en / .lang-only-zh，见 app/globals.css）。
 * lang 由 root layout 在服务端写入；离线时那份 HTML 也是缓存里的同一份。
 */
const en = getMessages('en');
const zh = getMessages('zh');

export default function OfflinePage() {
  return (
    <main className="auth-shell">
      <h1>{en.brand.name}</h1>
      <p>
        <span className="lang-only-en">{en.offlinePage.title}</span>
        <span className="lang-only-zh">{zh.offlinePage.title}</span>
      </p>
      <p>
        <span className="lang-only-en">{en.offlinePage.body}</span>
        <span className="lang-only-zh">{zh.offlinePage.body}</span>
      </p>
    </main>
  );
}
