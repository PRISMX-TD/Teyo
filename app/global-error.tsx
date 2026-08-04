'use client';

/**
 * root layout 自身抛错时 app/error.tsx 兜不住（它渲染在 layout 内部），
 * 只有 global-error 能接住。它替换整棵树，所以必须自带 html/body。
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body>
        <main style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
          <h1>Something went wrong</h1>
          <p>Teyo could not start. Try again in a moment.</p>
          {error.digest ? <p>Reference: {error.digest}</p> : null}
          <button type="button" onClick={reset}>
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
