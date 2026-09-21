'use client';

import { getMessages, interpolate } from '@/lib/i18n';

/**
 * root layout 自身抛错时 app/error.tsx 兜不住（它渲染在 layout 内部），
 * 只有 global-error 能接住。它替换整棵树，所以必须自带 html/body。
 *
 * ── 关于语言和样式 ──
 * 和 app/error.tsx 一样查不到用户 locale（见那个文件的注释），但这里还多一层：
 * 它连 root layout 都没有，<html lang> 得自己写。能到这一步说明 layout 已经
 * 炸了，lang 未必写过——所以退回去读 document.documentElement.lang：React 是在
 * 提交新树之前调用这个函数的，那一刻 DOM 上还是上一版 <html>，读得到就用，
 * 读不到退回 en。服务端渲染这个组件时没有 document，同样退回 en。
 *
 * 样式全部内联，包括那两条挑语言的规则：走到 global-error 这一步，
 * 外部样式表本身没加载成功也是一种很现实的可能，此时再依赖 globals.css
 * 就会得到一张没有排版的纯文字页。这一页刻意不依赖仓库里任何其他文件。
 */
const en = getMessages('en');
const zh = getMessages('zh');

function documentLocale(): 'en' | 'zh' {
  if (typeof document === 'undefined') return 'en';
  return document.documentElement.lang.startsWith('zh') ? 'zh' : 'en';
}

const LANG_CSS = `
  :root:lang(zh) .lang-only-en { display: none; }
  :root:lang(en) .lang-only-zh { display: none; }
`;

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang={documentLocale()}>
      <body style={{ margin: 0, background: '#0b0a09', color: '#f0ede8' }}>
        <style dangerouslySetInnerHTML={{ __html: LANG_CSS }} />
        <main
          style={{
            maxWidth: '32rem',
            margin: '0 auto',
            padding: '2.5rem 1rem',
            fontFamily: 'system-ui, -apple-system, "Segoe UI", "PingFang SC", sans-serif',
            lineHeight: 1.55,
          }}
        >
          <h1 style={{ fontSize: '1.75rem', margin: '0 0 0.5rem' }}>
            <span className="lang-only-en">{en.errors.pageTitle}</span>
            <span className="lang-only-zh">{zh.errors.pageTitle}</span>
          </h1>
          <p style={{ margin: '0 0 2rem', color: '#b3aca3' }}>
            <span className="lang-only-en">{en.errors.globalBody}</span>
            <span className="lang-only-zh">{zh.errors.globalBody}</span>
          </p>

          {error.digest ? (
            <p style={{ fontFamily: 'ui-monospace, monospace', fontSize: '0.75rem', color: '#958e84' }}>
              <span className="lang-only-en">
                {interpolate(en.errors.reference, { digest: error.digest })}
              </span>
              <span className="lang-only-zh">
                {interpolate(zh.errors.reference, { digest: error.digest })}
              </span>
            </p>
          ) : null}

          <button
            type="button"
            onClick={reset}
            style={{
              minHeight: 44,
              padding: '0.5rem 1rem',
              marginTop: '1.5rem',
              font: 'inherit',
              fontWeight: 550,
              // 墨压纸，与 .primary-button 同一套（globals.css 的 --btn-*）。
              // 这一页拿不到 CSS 变量，值只能写死；改调色板时这里要跟着改。
              color: '#0b0a09',
              background: '#f0ede8',
              border: '1px solid #f0ede8',
              borderRadius: 6,
              cursor: 'pointer',
            }}
          >
            <span className="lang-only-en">{en.errors.tryAgain}</span>
            <span className="lang-only-zh">{zh.errors.tryAgain}</span>
          </button>
        </main>
      </body>
    </html>
  );
}
