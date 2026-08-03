'use client';

import { useState, type ReactNode } from 'react';

type Props = {
  title: string;
  submitLabel: string;
  action: (formData: FormData) => Promise<void>;
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
      await action(formData);
      if (successMessage) setDone(true);
    } catch (e) {
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
