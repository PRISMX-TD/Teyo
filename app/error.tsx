'use client';

import { getMessages, interpolate } from '@/lib/i18n';

/**
 * 路由级 error boundary。
 *
 * 没有它，任何 Server Component 抛出的异常都会变成 500 白屏，用户既看不到
 * 原因也没有重试入口——生产构建还会把 message 脱敏掉，只剩一个 digest。
 * digest 展示出来，方便对着 Vercel Runtime Logs 定位具体那一次请求。
 *
 * ── 关于语言 ──
 * 这一页拿不到用户的 locale。locale 存在数据库里，要查库；而这个组件之所以
 * 会被渲染出来，前提就是「别的东西已经坏了」——很可能坏的正是那次查询。
 * 在错误页里再发一次同样可能失败的请求，只会把一次报错变成两次。
 *
 * 取舍：两种语言都渲染，交给 CSS 按 <html lang> 挑一份显示（.lang-only-en /
 * .lang-only-zh，见 app/globals.css）。lang 是 root layout 在服务端就写好的，
 * 所以这条路不查库、不跑 JS、不闪烁、也不会有 hydration 不一致——代价是
 * HTML 里多了一份看不见的文案，对一个错误页来说完全可以接受。
 * 文案本身仍然只有 catalog 一个来源，没有硬编码的英文。
 */
const en = getMessages('en');
const zh = getMessages('zh');

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="error-page">
      <h1>
        <span className="lang-only-en">{en.errors.pageTitle}</span>
        <span className="lang-only-zh">{zh.errors.pageTitle}</span>
      </h1>
      <p>
        <span className="lang-only-en">{en.errors.pageBody}</span>
        <span className="lang-only-zh">{zh.errors.pageBody}</span>
      </p>

      {error.digest ? (
        <p className="hint">
          <span className="lang-only-en">
            {interpolate(en.errors.reference, { digest: error.digest })}
          </span>
          <span className="lang-only-zh">
            {interpolate(zh.errors.reference, { digest: error.digest })}
          </span>
        </p>
      ) : null}

      <button type="button" onClick={reset}>
        <span className="lang-only-en">{en.errors.tryAgain}</span>
        <span className="lang-only-zh">{zh.errors.tryAgain}</span>
      </button>
    </main>
  );
}
