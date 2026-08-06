'use client';

import { useState } from 'react';
import type { Locale, Messages } from '@/lib/i18n';
import { localizedName } from '@/lib/i18n';
import { createFixedAsset } from '@/server/actions/fixed_assets';

type AccountOption = {
  id: string;
  name_en: string;
  name_zh: string;
  type?: string;
};

type Props = {
  orgSlug: string;
  locale: Locale;
  i18n: Messages;
  accounts: AccountOption[];
  onSuccess?: (id: string) => void;
};

export function AssetForm({ orgSlug, locale, i18n: t, accounts, onSuccess }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [purchaseDate, setPurchaseDate] = useState(new Date().toISOString().slice(0, 10));
  const [cost, setCost] = useState('');
  const [salvageValue, setSalvageValue] = useState('0');
  const [usefulLifeMonths, setUsefulLifeMonths] = useState(60);
  const [method, setMethod] = useState<'straight_line' | 'declining_balance'>('straight_line');
  const [decliningRateBps, setDecliningRateBps] = useState(20000);
  const [assetAccountId, setAssetAccountId] = useState('');
  const [depnExpenseAccountId, setDepnExpenseAccountId] = useState('');
  const [depnAccumAccountId, setDepnAccumAccountId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit() {
    setPending(true);
    setError(null);
    try {
      const { id } = await createFixedAsset(orgSlug, {
        name: name.trim(),
        description: description.trim() || null,
        purchaseDate,
        cost,
        salvageValue,
        usefulLifeMonths,
        method,
        decliningRateBps: method === 'declining_balance' ? decliningRateBps : null,
        assetAccountId,
        depnExpenseAccountId,
        depnAccumAccountId,
      });
      onSuccess?.(id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  const assetAccounts = accounts.filter((a) => a.type === 'asset' || !a.type);
  const expenseAccounts = accounts.filter((a) => a.type === 'expense' || !a.type);

  function accountName(acc: AccountOption): string {
    return localizedName({ name_en: acc.name_en, name_zh: acc.name_zh }, locale);
  }

  return (
    <div className="add-form">
      <div className="form-field">
        <label>{t.fixedAssets.title ?? 'Asset Name'}</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t.settings.name}
        />
      </div>

      <div className="form-field">
        <label>{t.transaction.description}</label>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <div className="form-field">
        <label>{t.fixedAssets.purchaseDate}</label>
        <input
          type="date"
          value={purchaseDate}
          onChange={(e) => setPurchaseDate(e.target.value)}
        />
      </div>

      <div className="inline-edit-row">
        <div className="form-field">
          <label>{t.fixedAssets.cost}</label>
          <input
            value={cost}
            onChange={(e) => setCost(e.target.value)}
            placeholder="0.00"
          />
        </div>
        <div className="form-field">
          <label>{t.fixedAssets.salvageValue}</label>
          <input
            value={salvageValue}
            onChange={(e) => setSalvageValue(e.target.value)}
            placeholder="0.00"
          />
        </div>
      </div>

      <div className="inline-edit-row">
        <div className="form-field">
          <label>{t.fixedAssets.usefulLife}</label>
          <input
            type="number"
            value={usefulLifeMonths}
            onChange={(e) => setUsefulLifeMonths(Number(e.target.value))}
            min={1}
          />
        </div>
        <div className="form-field">
          <label>{t.fixedAssets.method}</label>
          <select value={method} onChange={(e) => setMethod(e.target.value as 'straight_line' | 'declining_balance')}>
            <option value="straight_line">Straight Line</option>
            <option value="declining_balance">Declining Balance</option>
          </select>
        </div>
      </div>

      {method === 'declining_balance' && (
        <div className="form-field">
          <label>{t.fixedAssets.decliningRate}</label>
          <input
            type="number"
            value={decliningRateBps}
            onChange={(e) => setDecliningRateBps(Number(e.target.value))}
            min={0}
          />
          <span className="hint">{(decliningRateBps / 100).toFixed(0)}%</span>
        </div>
      )}

      <div className="form-field">
        <label>{t.fixedAssets.assetAccount}</label>
        <select value={assetAccountId} onChange={(e) => setAssetAccountId(e.target.value)}>
          <option value="">--</option>
          {assetAccounts.map((acc) => (
            <option key={acc.id} value={acc.id}>{accountName(acc)}</option>
          ))}
        </select>
      </div>

      <div className="form-field">
        <label>{t.fixedAssets.depreciationExpense}</label>
        <select value={depnExpenseAccountId} onChange={(e) => setDepnExpenseAccountId(e.target.value)}>
          <option value="">--</option>
          {expenseAccounts.map((acc) => (
            <option key={acc.id} value={acc.id}>{accountName(acc)}</option>
          ))}
        </select>
      </div>

      <div className="form-field">
        <label>{t.fixedAssets.accumulatedDepreciation}</label>
        <select value={depnAccumAccountId} onChange={(e) => setDepnAccumAccountId(e.target.value)}>
          <option value="">--</option>
          {assetAccounts.map((acc) => (
            <option key={acc.id} value={acc.id}>{accountName(acc)}</option>
          ))}
        </select>
      </div>

      {error ? <p role="alert" className="form-error">{error}</p> : null}

      <button onClick={handleSubmit} disabled={pending || !name.trim() || !cost || !assetAccountId || !depnExpenseAccountId || !depnAccumAccountId}>
        {pending ? t.common.loading : t.invoices.save ?? 'Save'}
      </button>
    </div>
  );
}
