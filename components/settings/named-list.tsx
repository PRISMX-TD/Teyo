'use client';

import { useState } from 'react';
import type { Locale } from '@/lib/i18n';
import { localizedName, getMessages } from '@/lib/i18n';

type Item = {
  id: string;
  nameEn: string | null;
  nameZh: string | null;
  isActive: boolean;
  extra?: string;
  kind?: string;
};

type Props = {
  orgSlug: string;
  items: Item[];
  locale: Locale;
  onCreate: (orgSlug: string, payload: Record<string, unknown>) => Promise<unknown>;
  onRename: (orgSlug: string, id: string, names: Record<string, string>) => Promise<unknown>;
  onToggle: (orgSlug: string, id: string, active: boolean) => Promise<unknown>;
};

export function NamedList({ orgSlug, items, locale, onCreate, onRename, onToggle }: Props) {
  const t = getMessages(locale);
  const [nameEn, setNameEn] = useState('');
  const [nameZh, setNameZh] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editEn, setEditEn] = useState('');
  const [editZh, setEditZh] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleCreate() {
    setPending(true);
    setError(null);
    try {
      await onCreate(orgSlug, { nameEn: nameEn.trim(), nameZh: nameZh.trim() });
      setNameEn('');
      setNameZh('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  async function handleRename(id: string) {
    setPending(true);
    setError(null);
    try {
      await onRename(orgSlug, id, { nameEn: editEn.trim(), nameZh: editZh.trim() });
      setEditing(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="named-list">
      {items.map((item) => (
        <div key={item.id} className={`list-item ${!item.isActive ? 'inactive' : ''}`}>
          {editing === item.id ? (
            <div className="inline-edit">
              <input
                value={editEn}
                onChange={(e) => setEditEn(e.target.value)}
                placeholder={t.settings.nameEn}
              />
              <input
                value={editZh}
                onChange={(e) => setEditZh(e.target.value)}
                placeholder={t.settings.nameZh}
              />
              <button onClick={() => handleRename(item.id)} disabled={pending}>
                {t.settings.save}
              </button>
              <button onClick={() => setEditing(null)}>{t.common.cancel}</button>
            </div>
          ) : (
            <div className="list-item-line">
              <span>{localizedName({ name_en: item.nameEn, name_zh: item.nameZh }, locale)}{item.kind ? ` (${item.kind})` : ''}{item.extra ? ` (${item.extra})` : ''}</span>
              {!item.isActive ? <span className="badge">{t.settings.inactive}</span> : null}
              <button onClick={() => { setEditing(item.id); setEditEn(item.nameEn ?? ''); setEditZh(item.nameZh ?? ''); }}>
                {t.settings.save}
              </button>
              <button onClick={() => onToggle(orgSlug, item.id, !item.isActive)}>
                {item.isActive ? t.settings.deactivate : t.settings.reactivate}
              </button>
            </div>
          )}
        </div>
      ))}

      {error ? <p role="alert" className="form-error">{error}</p> : null}

      <div className="add-form">
        <input placeholder={t.settings.nameEn} value={nameEn} onChange={(e) => setNameEn(e.target.value)} />
        <input placeholder={t.settings.nameZh} value={nameZh} onChange={(e) => setNameZh(e.target.value)} />
        <button onClick={handleCreate} disabled={pending}>{t.settings.addCategory}</button>
      </div>
    </div>
  );
}
