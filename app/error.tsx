'use client';

/**
 * 路由级 error boundary。
 *
 * 没有它，任何 Server Component 抛出的异常都会变成 500 白屏，用户既看不到
 * 原因也没有重试入口——生产构建还会把 message 脱敏掉，只剩一个 digest。
 * digest 展示出来，方便对着 Vercel Runtime Logs 定位具体那一次请求。
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="error-page">
      <h1>Something went wrong</h1>
      <p>We could not load this page. Try again, or head back to the start.</p>

      {error.digest ? <p className="hint">Reference: {error.digest}</p> : null}

      <button type="button" onClick={reset}>
        Try again
      </button>
    </main>
  );
}
