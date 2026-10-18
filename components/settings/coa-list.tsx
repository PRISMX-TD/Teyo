'use client';

import { useId, useState } from 'react';
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
  const uid = useId();
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

  // 停用/恢复原来直接调 toggleAction，没有 await 也没有 catch：停用最后
  // 一个资金账户时 Action 抛的那句「先加一个再停用」变成一个未处理的
  // Promise 拒绝，界面上什么都不发生。
  async function handleToggle(id: string, nextActive: boolean) {
    setPending(true);
    setError(null);
    try {
      await toggleAction(orgSlug, id, nextActive);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  const active = items.filter((a) => a.isActive);
  const inactive = items.filter((a) => !a.isActive);

  return (
    <>
      <div className="named-list">
        {ACCOUNT_TYPES.map((type) => {
          const subset = active.filter((a) => a.type === type);
          if (subset.length === 0) return null;
          return (
            <div key={type} className="coa-section">
              <h2 className="coa-section-title">{t.settings[TYPE_LABEL_KEYS[type]]}</h2>
              <div className="coa-group">
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
                        <button onClick={() => handleToggle(item.id, !item.isActive)} disabled={pending}>
                          {item.isActive ? t.settings.deactivate : t.settings.reactivate}
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}

        {inactive.length > 0 ? (
          <div className="coa-section">
            <h2 className="coa-section-title">{t.settings.inactive}</h2>
            <div className="coa-group">
              {inactive.map((item) => (
                <div key={item.id} className="list-item inactive">
                  <div className="list-item-line">
                    <span className="coa-code">{item.code}</span>
                    <span>{localizedName({ name_en: item.nameEn, name_zh: item.nameZh }, locale)}</span>
                    <span className="badge">{t.settings.inactive}</span>
                    <button onClick={() => handleToggle(item.id, true)} disabled={pending}>
                      {t.settings.reactivate}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {error ? <p role="alert" className="form-error">{error}</p> : null}

      {/* 新增表单放在分组列表外面（原来是 .named-list 的最后一项，最后一组的
          下边距和表单的上边距叠成五十多像素）。每一栏都有看得见的标签：原来
          两个输入框只有 placeholder，类型下拉只显示一个「资产」。 */}
      <form
        id="add-account"
        className="add-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void handleCreate();
        }}
      >
        <h3>{t.settings.addAccount}</h3>
        <div className="form-field">
          <label htmlFor={`${uid}-type`}>{t.settings.accountType}</label>
          <select
            id={`${uid}-type`}
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
        </div>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={newIsMoney}
            onChange={(e) => setNewIsMoney(e.target.checked)}
            disabled={newType !== 'asset'}
          />
          {t.settings.moneyAccount}
        </label>
        <div className="form-field">
          <label htmlFor={`${uid}-en`}>{t.settings.nameEn}</label>
          <input id={`${uid}-en`} value={nameEn} onChange={(e) => setNameEn(e.target.value)} />
        </div>
        <div className="form-field">
          <label htmlFor={`${uid}-zh`}>{t.settings.nameZh}</label>
          <input id={`${uid}-zh`} value={nameZh} onChange={(e) => setNameZh(e.target.value)} />
        </div>
        <div className="add-form-actions">
          <button type="submit" disabled={pending}>
            {t.settings.addAccount}
          </button>
        </div>
      </form>
    </>
  );
}
