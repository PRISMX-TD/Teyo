'use client';

import { useId, useState } from 'react';
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

type AccountOption = { id: string; nameEn: string | null; nameZh: string | null };

type CreatePayload = {
  nameEn?: string;
  nameZh?: string;
  kind?: 'income' | 'expense';
  accountId?: string;
};

type Props = {
  orgSlug: string;
  items: Item[];
  locale: Locale;
  /** 仅分类页传入：需要额外采集 kind 与 accountId。 */
  categoryOptions?: {
    incomeAccounts: AccountOption[];
    expenseAccounts: AccountOption[];
  };
  onCreate: (orgSlug: string, payload: CreatePayload) => Promise<unknown>;
  onRename: (orgSlug: string, id: string, names: Record<string, string>) => Promise<unknown>;
  onToggle: (orgSlug: string, id: string, active: boolean) => Promise<unknown>;
  /** 新增表单的 id：页头的「新增」按钮跳到这里。 */
  addFormId?: string;
};

export function NamedList({
  orgSlug,
  items,
  locale,
  categoryOptions,
  onCreate,
  onRename,
  onToggle,
  addFormId,
}: Props) {
  const t = getMessages(locale);
  const uid = useId();
  const [nameEn, setNameEn] = useState('');
  const [nameZh, setNameZh] = useState('');
  const [kind, setKind] = useState<'' | 'income' | 'expense'>('');
  const [accountId, setAccountId] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editEn, setEditEn] = useState('');
  const [editZh, setEditZh] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const accountsForKind: AccountOption[] =
    kind === 'income'
      ? categoryOptions?.incomeAccounts ?? []
      : kind === 'expense'
        ? categoryOptions?.expenseAccounts ?? []
        : [];

  async function handleCreate() {
    if (categoryOptions && (!kind || !accountId)) {
      setError(t.errors.validation);
      return;
    }

    setPending(true);
    setError(null);
    try {
      const payload: CreatePayload = { nameEn: nameEn.trim(), nameZh: nameZh.trim() };
      if (categoryOptions) {
        payload.kind = kind as 'income' | 'expense';
        payload.accountId = accountId;
      }
      await onCreate(orgSlug, payload);
      setNameEn('');
      setNameZh('');
      setKind('');
      setAccountId('');
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

  // 与 handleRename 同一个理由：停用/恢复失败时要把错误显示出来，而不是
  // 留一个未处理的 Promise 拒绝。
  async function handleToggle(id: string, nextActive: boolean) {
    setPending(true);
    setError(null);
    try {
      await onToggle(orgSlug, id, nextActive);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  // kind 原来原样拼进括号里，中文界面上显示的是「(expense)」。
  const kindLabel = (kind: string) =>
    kind === 'income' ? t.settings.kindIncome : kind === 'expense' ? t.settings.kindExpense : kind;

  return (
    <>
      <div className="named-list">
        {items.map((item) => (
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
                <button type="button" onClick={() => handleRename(item.id)} disabled={pending}>
                  {t.settings.save}
                </button>
                <button type="button" onClick={() => setEditing(null)}>{t.common.cancel}</button>
              </div>
            ) : (
              <div className="list-item-line">
                {/* 收支类型另起一行小字。原来括在名字后面一起折行，英文窄屏上
                    「Other Income (Money coming in)」折成三行，最后一行只剩「in)」。 */}
                <span>
                  {localizedName({ name_en: item.nameEn, name_zh: item.nameZh }, locale)}
                  {item.extra ? ` (${item.extra})` : ''}
                  {item.kind ? <span className="list-item-sub">{kindLabel(item.kind)}</span> : null}
                </span>
                {!item.isActive ? <span className="badge">{t.settings.inactive}</span> : null}
                {/* 两个按钮包成一组：各自是 flex 项时，名字稍长就只把「隐藏」
                    一个甩到下一行，每行高矮不一、按钮时左时右。 */}
                <span className="row-actions">
                  <button type="button" onClick={() => { setEditing(item.id); setEditEn(item.nameEn ?? ''); setEditZh(item.nameZh ?? ''); }}>
                    {t.settings.rename}
                  </button>
                  <button type="button" onClick={() => handleToggle(item.id, !item.isActive)} disabled={pending}>
                    {item.isActive ? t.settings.deactivate : t.settings.reactivate}
                  </button>
                </span>
              </div>
            )}
          </div>
        ))}
      </div>

      {error ? <p role="alert" className="form-error">{error}</p> : null}

      {/* 新增表单放在列表卡片外面：原来它是列表里的最后一项，卡片里再套
          一张卡片。每个字段都有看得见的标签——两个下拉原来都只显示
          「请选择…」，分不清哪个是收支、哪个是科目。 */}
      <form
        id={addFormId}
        className="add-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void handleCreate();
        }}
      >
        <h3>{t.settings.addCategory}</h3>
        <div className="form-field">
          <label htmlFor={`${uid}-en`}>{t.settings.nameEn}</label>
          <input id={`${uid}-en`} value={nameEn} onChange={(e) => setNameEn(e.target.value)} />
        </div>
        <div className="form-field">
          <label htmlFor={`${uid}-zh`}>{t.settings.nameZh}</label>
          <input id={`${uid}-zh`} value={nameZh} onChange={(e) => setNameZh(e.target.value)} />
        </div>
        {categoryOptions ? (
          <>
            <div className="form-field">
              <label htmlFor={`${uid}-kind`}>{t.settings.categoryKind}</label>
              <select
                id={`${uid}-kind`}
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value as '' | 'income' | 'expense');
                  setAccountId('');
                }}
              >
                <option value="">{t.transaction.choosePlaceholder}</option>
                <option value="income">{t.settings.kindIncome}</option>
                <option value="expense">{t.settings.kindExpense}</option>
              </select>
            </div>
            <div className="form-field">
              <label htmlFor={`${uid}-account`}>{t.settings.categoryAccount}</label>
              <select
                id={`${uid}-account`}
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                disabled={!kind}
              >
                <option value="">{kind ? t.transaction.choosePlaceholder : t.settings.chooseKindFirst}</option>
                {accountsForKind.map((account) => (
                  <option key={account.id} value={account.id}>
                    {localizedName({ name_en: account.nameEn, name_zh: account.nameZh }, locale)}
                  </option>
                ))}
              </select>
            </div>
          </>
        ) : null}
        <div className="add-form-actions">
          <button type="submit" disabled={pending}>{t.settings.addCategory}</button>
        </div>
      </form>
    </>
  );
}
