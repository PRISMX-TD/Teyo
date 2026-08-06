'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Locale } from '@/lib/i18n';
import { getMessages } from '@/lib/i18n';
import { createProject } from '@/server/actions/projects';

type Contact = {
  id: string;
  name: string;
};

type Props = {
  orgSlug: string;
  locale: Locale;
  contacts: Contact[];
};

const STATUSES = ['active', 'completed', 'cancelled'] as const;

export function ProjectForm({ orgSlug, locale, contacts }: Props) {
  const t = getMessages(locale);
  const router = useRouter();

  const statusLabel: Record<string, string> = {
    active: t.projects.statusActive,
    completed: t.projects.statusCompleted,
    cancelled: t.projects.statusCancelled,
  };

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [contactId, setContactId] = useState('');
  const [budget, setBudget] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [status, setStatus] = useState<'active' | 'completed' | 'cancelled'>('active');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);

    try {
      await createProject(orgSlug, {
        name: name.trim(),
        description: description.trim() || undefined,
        contactId: contactId || undefined,
        budgetMinor: budget ? String(Math.round(parseFloat(budget) * 100)) : undefined,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
      });
      router.push(`/${orgSlug}/projects`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="transaction-form">
      <label htmlFor="pn">{t.projects.name}</label>
      <input
        id="pn"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
      />

      <label htmlFor="pd">{t.projects.description}</label>
      <textarea
        id="pd"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={2}
      />

      <label htmlFor="pc">{t.projects.client}</label>
      <select
        id="pc"
        value={contactId}
        onChange={(e) => setContactId(e.target.value)}
      >
        <option value="">{t.projects.noClient}</option>
        {contacts.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>

      <label htmlFor="pb">{t.projects.budget}</label>
      <input
        id="pb"
        type="number"
        min="0"
        step="0.01"
        value={budget}
        onChange={(e) => setBudget(e.target.value)}
      />

      <label htmlFor="psd">{t.projects.startDate}</label>
      <input
        id="psd"
        type="date"
        value={startDate}
        onChange={(e) => setStartDate(e.target.value)}
      />

      <label htmlFor="ped">{t.projects.endDate}</label>
      <input
        id="ped"
        type="date"
        value={endDate}
        onChange={(e) => setEndDate(e.target.value)}
      />

      <label htmlFor="pst">{t.projects.status}</label>
      <select
        id="pst"
        value={status}
        onChange={(e) => setStatus(e.target.value as 'active' | 'completed' | 'cancelled')}
      >
        {STATUSES.map((s) => (
          <option key={s} value={s}>
            {statusLabel[s]}
          </option>
        ))}
      </select>

      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}

      <div className="form-actions">
        <button type="submit" disabled={pending}>
          {pending ? t.common.loading : t.projects.save}
        </button>
      </div>
    </form>
  );
}
