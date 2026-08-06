'use client';

import { useState, useRef } from 'react';
import type { Locale, Messages } from '@/lib/i18n';
import { localizedName } from '@/lib/i18n';
import { uploadBankStatement } from '@/server/actions/bank_import';

type MoneyAccountOption = {
  id: string;
  name_en: string | null;
  name_zh: string | null;
};

type Props = {
  orgSlug: string;
  locale: Locale;
  i18n: Messages;
  moneyAccounts: MoneyAccountOption[];
};

export function ImportForm({ orgSlug, locale, i18n, moneyAccounts }: Props) {
  const [moneyAccountId, setMoneyAccountId] = useState('');
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);

    const file = fileRef.current?.files?.[0];
    if (!file) {
      setMessage({ type: 'error', text: 'Please select a file.' });
      return;
    }
    if (!moneyAccountId) {
      setMessage({ type: 'error', text: 'Please select a money account.' });
      return;
    }

    setUploading(true);
    try {
      const formData = new FormData();
      formData.set('file', file);
      formData.set('moneyAccountId', moneyAccountId);

      const result = await uploadBankStatement(orgSlug, formData);
      setMessage({
        type: 'success',
        text: `${result.count} transaction(s) imported successfully.`,
      });

      if (fileRef.current) fileRef.current.value = '';
      setMoneyAccountId('');
    } catch (err) {
      setMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Upload failed.',
      });
    } finally {
      setUploading(false);
    }
  };

  return (
    <form className="import-form" onSubmit={handleSubmit}>
      <h2>{i18n.bankImport.upload}</h2>

      <label>
        {i18n.bankImport.selectAccount}
        <select
          value={moneyAccountId}
          onChange={(e) => setMoneyAccountId(e.target.value)}
        >
          <option value="">--</option>
          {moneyAccounts.map((a) => (
            <option key={a.id} value={a.id}>
              {localizedName({ name_en: a.name_en, name_zh: a.name_zh }, locale)}
            </option>
          ))}
        </select>
      </label>

      <label>
        {i18n.bankImport.selectFile}
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.ofx,.qif,.qfx"
        />
      </label>

      <small>{i18n.bankImport.fileFormat}</small>

      <button type="submit" disabled={uploading}>
        {uploading ? i18n.common.loading : i18n.bankImport.upload}
      </button>

      {message && (
        <p className={`import-message ${message.type === 'success' ? 'message-success' : 'message-error'}`}>
          {message.text}
        </p>
      )}
    </form>
  );
}
