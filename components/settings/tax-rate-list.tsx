'use client';

import { useState } from 'react';
import type { Locale, Messages } from '@/lib/i18n';
import { localizedName, getMessages } from '@/lib/i18n';
import { createTaxRate, updateTaxRateAction, setDefaultTaxRateAction, deleteTaxRateAction } from '@/server/actions/tax';

type TaxRateItem = {
  id: string;
  nameEn: string;
  nameZh: string;
  rateBps: number;
  isDefault: boolean;
  isActive: boolean;
};

type Props = {
  orgSlug: string;
  locale: Locale;
  i18n: Messages;
  taxRates: TaxRateItem[];
};

export function TaxRateList({ orgSlug, locale, i18n: t, taxRates }: Props) {
  const [showAdd, setShowAdd] = useState(false);
  const [nameEn, setNameEn] = useState('');
  const [nameZh, setNameZh] = useState('');
  const [rateBps, setRateBps] = useState(600);
  const [isDefault, setIsDefault] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Edit state
  const [editing, setEditing] = useState<string | null>(null);
  const [editNameEn, setEditNameEn] = useState('');
  const [editNameZh, setEditNameZh] = useState('');
  const [editRateBps, setEditRateBps] = useState(0);
  const [editIsDefault, setEditIsDefault] = useState(false);

  async function handleCreate() {
    setPending(true);
    setError(null);
    try {
      setShowAdd(false);
      await createTaxRate(orgSlug, {
        nameEn: nameEn.trim(),
        nameZh: nameZh.trim(),
        rateBps,
        isDefault,
      });
      setNameEn('');
      setNameZh('');
      setRateBps(600);
      setIsDefault(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  async function handleUpdate(id: string) {
    setPending(true);
    setError(null);
    try {
      await updateTaxRateAction(orgSlug, id, {
        nameEn: editNameEn.trim(),
        nameZh: editNameZh.trim(),
        rateBps: editRateBps,
        isDefault: editIsDefault,
      });
      setEditing(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  async function handleSetDefault(id: string) {
    setPending(true);
    setError(null);
    try {
      await setDefaultTaxRateAction(orgSlug, id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  async function handleDelete(id: string) {
    setPending(true);
    setError(null);
    try {
      await deleteTaxRateAction(orgSlug, id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  function startEdit(item: TaxRateItem) {
    setEditing(item.id);
    setEditNameEn(item.nameEn);
    setEditNameZh(item.nameZh);
    setEditRateBps(item.rateBps);
    setEditIsDefault(item.isDefault);
  }

  function ratePercent(bps: number): string {
    return (bps / 100).toFixed(2) + '%';
  }

  const active = taxRates.filter((r) => r.isActive);
  const inactive = taxRates.filter((r) => !r.isActive);

  return (
    <div className="named-list">
      {active.map((item) => (
        <div key={item.id} className="list-item">
          {editing === item.id ? (
            <div className="inline-edit">
              <input
                value={editNameEn}
                onChange={(e) => setEditNameEn(e.target.value)}
                placeholder={t.settings.nameEn}
              />
              <input
                value={editNameZh}
                onChange={(e) => setEditNameZh(e.target.value)}
                placeholder={t.settings.nameZh}
              />
              <input
                type="number"
                value={editRateBps}
                onChange={(e) => setEditRateBps(Number(e.target.value))}
                placeholder={t.tax.rate}
              />
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={editIsDefault}
                  onChange={(e) => setEditIsDefault(e.target.checked)}
                />
                {t.tax.defaultRate}
              </label>
              <button onClick={() => handleUpdate(item.id)} disabled={pending}>
                {t.settings.save}
              </button>
              <button onClick={() => setEditing(null)}>{t.common.cancel}</button>
            </div>
          ) : (
            <div className="list-item-line">
              <span>{localizedName({ name_en: item.nameEn, name_zh: item.nameZh }, locale)}</span>
              <span className="badge">{ratePercent(item.rateBps)}</span>
              {item.isDefault ? <span className="badge badge-info">★ {t.tax.defaultRate}</span> : null}
              <span className="badge">{t.settings.active}</span>
              <button onClick={() => startEdit(item)}>
                {t.settings.rename ?? 'Edit'}
              </button>
              {!item.isDefault && (
                <button onClick={() => handleSetDefault(item.id)} disabled={pending}>
                  {t.tax.defaultRate}
                </button>
              )}
              <button onClick={() => handleDelete(item.id)} disabled={pending}>
                {t.common.delete}
              </button>
            </div>
          )}
        </div>
      ))}

      {inactive.length > 0 ? (
        <div className="coa-section">
          <h2 className="coa-section-title">{t.settings.inactive}</h2>
          {inactive.map((item) => (
            <div key={item.id} className="list-item inactive">
              <div className="list-item-line">
                <span>{localizedName({ name_en: item.nameEn, name_zh: item.nameZh }, locale)}</span>
                <span className="badge">{ratePercent(item.rateBps)}</span>
                <span className="badge">{t.settings.inactive}</span>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {error ? <p role="alert" className="form-error">{error}</p> : null}

      {!showAdd ? (
        <button onClick={() => setShowAdd(true)} className="add-button">
          {t.tax.addRate}
        </button>
      ) : (
        <div className="add-form">
          <h3>{t.tax.addRate}</h3>
          <input
            placeholder={t.settings.nameEn}
            value={nameEn}
            onChange={(e) => setNameEn(e.target.value)}
          />
          <input
            placeholder={t.settings.nameZh}
            value={nameZh}
            onChange={(e) => setNameZh(e.target.value)}
          />
          <input
            type="number"
            placeholder={t.tax.rate}
            value={rateBps}
            onChange={(e) => setRateBps(Number(e.target.value))}
          />
          <span className="hint">{ratePercent(rateBps)}</span>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
            />
            {t.tax.defaultRate}
          </label>
          <button onClick={handleCreate} disabled={pending || !nameEn.trim() || !nameZh.trim()}>
            {t.tax.addRate}
          </button>
          <button onClick={() => setShowAdd(false)}>{t.common.cancel}</button>
        </div>
      )}
    </div>
  );
}
