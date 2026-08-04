'use client';

import { useState, type ReactNode } from 'react';

/** Next.js 用抛错实现 redirect()，摘要以 NEXT_REDIRECT 开头。 */
function isRedirectError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'digest' in error &&
    typeof (error as { digest: unknown }).digest === 'string' &&
    (error as { digest: string }).digest.startsWith('NEXT_REDIRECT')
  );
}

type Props = {
  title: string;
  submitLabel: string;
  /**
   * 成功时返回 undefined（通常已 redirect），失败时返回 { error }。
   * 生产构建会把 action 抛出的异常脱敏成 500，所以错误必须走返回值。
   */
  action: (formData: FormData) => Promise<{ error: string } | undefined | void>;
  children: ReactNode;
  footer?: ReactNode;
  successMessage?: string;
};

export function AuthForm({ title, submitLabel, action, children, footer, successMessage }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);

  async function handleSubmit(formData: FormData) {
    setPending(true);
    setError(null);
    try {
      const result = await action(formData);
      if (result && 'error' in result) {
        setError(result.error);
        return;
      }
      if (successMessage) setDone(true);
    } catch (e) {
      // redirect() 靠抛特殊错误实现，不能当成失败展示。
      if (isRedirectError(e)) throw e;
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="auth-shell">
      <h1>{title}</h1>

      <form action={handleSubmit} noValidate>
        {children}

        {error ? (
          <p role="alert" className="form-error">
            {error}
          </p>
        ) : null}

        {done && successMessage ? (
          <p role="status" className="form-success">
            {successMessage}
          </p>
        ) : null}

        <button type="submit" disabled={pending}>
          {submitLabel}
        </button>
      </form>

      {footer}
    </main>
  );
}
