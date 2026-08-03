'use client';

import { useState } from 'react';
import type { Locale } from '@/lib/i18n';
import { getMessages } from '@/lib/i18n';
import { exportReport } from '@/server/actions/export';

type Props = { orgSlug: string; locale: Locale };

export function ExportForm({ orgSlug, locale }: Props) {
  const t = getMessages(locale);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(formData: FormData) {
    setPending(true);
    setError(null);
    try {
      const result = await exportReport(orgSlug, {
        kind: String(formData.get('kind')) as 'transaction-detail' | 'account-summary',
        format: String(formData.get('format')) as 'csv' | 'xlsx',
        from: String(formData.get('from')),
        to: String(formData.get('to')),
        includeVoided: formData.get('includeVoided') === 'true',
        locale,
      });

      const bytes = Uint8Array.from(atob(result.body), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: result.contentType }));
      const link = document.createElement('a');
      link.href = url;
      link.download = result.fileName;
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 7)}-01`;

  return (
    <form action={handleSubmit} className="export-form">
      <fieldset>
        <legend>{t.exportPage.title}</legend>
        <label>
          <input type="radio" name="kind" value="transaction-detail" defaultChecked />
          {t.exportPage.transactionDetail}
          <span className="field-hint">{t.exportPage.transactionDetailHint}</span>
        </label>
        <label>
          <input type="radio" name="kind" value="account-summary" />
          {t.exportPage.accountSummary}
          <span className="field-hint">{t.exportPage.accountSummaryHint}</span>
        </label>
      </fieldset>

      <label htmlFor="from">{t.filters.from}</label>
      <input id="from" name="from" type="date" defaultValue={monthStart} required />

      <label htmlFor="to">{t.filters.to}</label>
      <input id="to" name="to" type="date" defaultValue={today} required />

      <label htmlFor="format">{t.exportPage.format}</label>
      <select id="format" name="format" defaultValue="xlsx">
        <option value="xlsx">{t.exportPage.xlsx}</option>
        <option value="csv">{t.exportPage.csv}</option>
      </select>

      <label>
        <input type="checkbox" name="includeVoided" value="true" />
        {t.filters.includeVoided}
      </label>

      {error ? <p role="alert" className="form-error">{error}</p> : null}

      <button type="submit" disabled={pending}>
        {pending ? t.common.loading : t.exportPage.download}
      </button>
    </form>
  );
}
