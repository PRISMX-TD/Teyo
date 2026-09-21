'use client';

import { useState } from 'react';
import type { Locale } from '@/lib/i18n';
import { localizedName, getMessages } from '@/lib/i18n';

type AccountItem = {
  id: string;
  code: string;
  nameEn: string | null;
  nameZh: string | null;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  isMoneyAccount: boolean;
  isActive: boolean;
};

const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;
type AccountType = (typeof ACCOUNT_TYPES)[number];

type Props = {
  orgSlug: string;
  items: AccountItem[];
  locale: Locale;
  createAction: (
    orgSlug: string,
    payload: { nameEn?: string; nameZh?: string; type: AccountType; isMoneyAccount: boolean },
  ) => Promise<{ id: string }>;
  renameAction: (orgSlug: string, id: string, names: { nameEn?: string; nameZh?: string }) => Promise<void>;
  toggleAction: (orgSlug: string, id: string, active: boolean) => Promise<void>;
};

const TYPE_LABEL_KEYS: Record<AccountType, keyof ReturnType<typeof getMessages>['settings']> = {
  asset: 'typeAsset',
  liability: 'typeLiability',
  equity: 'typeEquity',
  revenue: 'typeRevenue',
  expense: 'typeExpense',
};

export function CoAList({ orgSlug, items, locale, createAction, renameAction, toggleAction }: Props) {
  const t = getMessages(locale);
  const [nameEn, setNameEn] = useState('');
  const [nameZh, setNameZh] = useState('');
  const [newType, setNewType] = useState<AccountType>('asset');
  const [newIsMoney, setNewIsMoney] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editEn, setEditEn] = useState('');
  const [editZh, setEditZh] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleCreate() {
    setPending(true);
    setError(null);
    try {
      await createAction(orgSlug, {
        nameEn: nameEn.trim(),
        nameZh: nameZh.trim(),
        type: newType,
        isMoneyAccount: newIsMoney,
      });
      setNameEn('');
      setNameZh('');
      setNewIsMoney(false);
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
      await renameAction(orgSlug, id, { nameEn: editEn.trim(), nameZh: editZh.trim() });
      setEditing(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  const active = items.filter((a) => a.isActive);
  const inactive = items.filter((a) => !a.isActive);

  return (
    <div className="named-list">
      {ACCOUNT_TYPES.map((type) => {
        const subset = active.filter((a) => a.type === type);
        if (subset.length === 0) return null;
        return (
          <div key={type} className="coa-section">
            <h2 className="coa-section-title">{t.settings[TYPE_LABEL_KEYS[type]]}</h2>
            {subset.map((item) => (
              <div key={item.id} className={`list-item ${!item.isActive ? 'inactive' : ''}`}>
                {editing === item.id ? (
                  <div className="inline-edit">
                    <input
                      value={editEn}
                      onChange={(e) => setEditEn(e.target.value)}
                      placeholder={t.settings.nameEn} aria-label={t.settings.nameEn}
                    />
                    <input
                      value={editZh}
                      onChange={(e) => setEditZh(e.target.value)}
                      placeholder={t.settings.nameZh} aria-label={t.settings.nameZh}
                    />
                    <button onClick={() => handleRename(item.id)} disabled={pending}>
                      {t.settings.save}
                    </button>
                    <button onClick={() => setEditing(null)}>{t.common.cancel}</button>
                  </div>
                ) : (
                  <div className="list-item-line">
                    <span className="coa-code">{item.code}</span>
                    <span>{localizedName({ name_en: item.nameEn, name_zh: item.nameZh }, locale)}</span>
                    {item.isMoneyAccount ? <span className="badge badge-info">{t.settings.moneyAccount}</span> : null}
                    <button
                      onClick={() => {
                        setEditing(item.id);
                        setEditEn(item.nameEn ?? '');
                        setEditZh(item.nameZh ?? '');
                      }}
                    >
                      {t.settings.rename}
                    </button>
                    <button onClick={() => toggleAction(orgSlug, item.id, !item.isActive)}>
                      {item.isActive ? t.settings.deactivate : t.settings.reactivate}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        );
      })}

      {inactive.length > 0 ? (
        <div className="coa-section">
          <h2 className="coa-section-title">{t.settings.inactive}</h2>
          {inactive.map((item) => (
            <div key={item.id} className="list-item inactive">
              <div className="list-item-line">
                <span className="coa-code">{item.code}</span>
                <span>{localizedName({ name_en: item.nameEn, name_zh: item.nameZh }, locale)}</span>
                <span className="badge">{t.settings.inactive}</span>
                <button onClick={() => toggleAction(orgSlug, item.id, true)}>
                  {t.settings.reactivate}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {error ? <p role="alert" className="form-error">{error}</p> : null}

      <div className="add-form">
        <h3>{t.settings.addAccount}</h3>
        {/* aria-label：同一张表单里两个输入框都成对写了 placeholder + aria-label，
            唯独这个下拉既没有 <label> 也没有名字，读屏器只能念出当前选中的
            那个值（「资产」），说不出这一栏问的是什么。 */}
        <select
          aria-label={t.settings.accountType}
          value={newType}
          onChange={(e) => {
            const next = e.target.value as AccountType;
            setNewType(next);
            // 类型改成非资产时必须把「资金账户」清掉。此前复选框只是被
            // disabled，值还留在 state 里：先选资产、勾上、再改成负债，提交
            // 的是 { type:'liability', isMoneyAccount:true }。accountSchema
            // 不管这个组合，于是它一路走到数据库，撞在 accounts_money_is_asset
            // 上——用户得到的是一句裸的 Postgres 约束名。
            if (next !== 'asset') setNewIsMoney(false);
          }}
        >
          {ACCOUNT_TYPES.map((type) => (
            <option key={type} value={type}>
              {t.settings[TYPE_LABEL_KEYS[type]]}
            </option>
          ))}
        </select>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={newIsMoney}
            onChange={(e) => setNewIsMoney(e.target.checked)}
            disabled={newType !== 'asset'}
          />
          {t.settings.moneyAccount}
        </label>
        <input
          placeholder={t.settings.nameEn} aria-label={t.settings.nameEn}
          value={nameEn}
          onChange={(e) => setNameEn(e.target.value)}
        />
        <input
          placeholder={t.settings.nameZh} aria-label={t.settings.nameZh}
          value={nameZh}
          onChange={(e) => setNameZh(e.target.value)}
        />
        <button onClick={handleCreate} disabled={pending}>
          {t.settings.addAccount}
        </button>
      </div>
    </div>
  );
}
