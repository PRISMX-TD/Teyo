'use client';

import { useState } from 'react';
import type { Locale } from '@/lib/i18n';
import { getMessages, localizedName } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';
import type { InventoryItemRow } from '@/server/repositories/inventory';
import {
  createInventoryItem,
  updateInventoryItemAction,
  toggleInventoryItemActive,
  recordInventoryTxnAction,
} from '@/server/actions/inventory';

type AccountOption = {
  id: string;
  code: string;
  nameEn: string;
  nameZh: string;
  type: string;
};

type Props = {
  orgSlug: string;
  locale: Locale;
  items: InventoryItemRow[];
  accounts: AccountOption[];
};

const TYPES = ['purchase', 'sale', 'adjustment', 'return'] as const;

export function InventoryList({ orgSlug, locale, items: initialItems, accounts }: Props) {
  const t = getMessages(locale);
  const [items, setItems] = useState(initialItems);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Add form state
  const [showAdd, setShowAdd] = useState(false);
  const [sku, setSku] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [nameZh, setNameZh] = useState('');
  const [unit, setUnit] = useState('');
  const [costMethod, setCostMethod] = useState<'fifo' | 'average'>('average');
  const [reorderLevel, setReorderLevel] = useState('0');
  const [cogsAccountId, setCogsAccountId] = useState('');
  const [inventoryAccountId, setInventoryAccountId] = useState('');

  // Edit state
  const [editing, setEditing] = useState<string | null>(null);
  const [editSku, setEditSku] = useState('');
  const [editNameEn, setEditNameEn] = useState('');
  const [editNameZh, setEditNameZh] = useState('');
  const [editUnit, setEditUnit] = useState('');
  const [editCostMethod, setEditCostMethod] = useState<'fifo' | 'average'>('average');
  const [editReorderLevel, setEditReorderLevel] = useState('');
  const [editCogsAccountId, setEditCogsAccountId] = useState('');
  const [editInventoryAccountId, setEditInventoryAccountId] = useState('');

  // Transaction dialog state
  const [txnItem, setTxnItem] = useState<InventoryItemRow | null>(null);
  const [txnType, setTxnType] = useState<string>('purchase');
  const [txnQuantity, setTxnQuantity] = useState('');
  const [txnUnitCost, setTxnUnitCost] = useState('');
  const [txnNotes, setTxnNotes] = useState('');

  function resetAddForm() {
    setSku('');
    setNameEn('');
    setNameZh('');
    setUnit('');
    setCostMethod('average');
    setReorderLevel('0');
    setCogsAccountId('');
    setInventoryAccountId('');
    setShowAdd(false);
  }

  async function handleCreate() {
    setPending(true);
    setError(null);
    try {
      const result = await createInventoryItem(orgSlug, {
        sku: sku.trim(),
        nameEn: nameEn.trim(),
        nameZh: nameZh.trim(),
        unit: unit.trim(),
        costMethod,
        reorderLevel: parseInt(reorderLevel, 10) || 0,
        cogsAccountId: cogsAccountId || undefined,
        inventoryAccountId: inventoryAccountId || undefined,
      });
      setItems((prev) => [
        ...prev,
        {
          id: result.id,
          organizationId: '',
          sku: sku.trim(),
          nameEn: nameEn.trim(),
          nameZh: nameZh.trim(),
          unit: unit.trim(),
          costMethod,
          currentQuantity: 0,
          currentAvgCostMinor: 0n,
          reorderLevel: parseInt(reorderLevel, 10) || 0,
          cogsAccountId: cogsAccountId || null,
          inventoryAccountId: inventoryAccountId || null,
          isActive: true,
          createdAt: new Date().toISOString(),
        },
      ]);
      resetAddForm();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  function startEdit(item: InventoryItemRow) {
    setEditing(item.id);
    setEditSku(item.sku);
    setEditNameEn(item.nameEn);
    setEditNameZh(item.nameZh);
    setEditUnit(item.unit);
    setEditCostMethod(item.costMethod);
    setEditReorderLevel(String(item.reorderLevel));
    setEditCogsAccountId(item.cogsAccountId ?? '');
    setEditInventoryAccountId(item.inventoryAccountId ?? '');
  }

  async function handleUpdate(id: string) {
    setPending(true);
    setError(null);
    try {
      await updateInventoryItemAction(orgSlug, id, {
        sku: editSku.trim(),
        nameEn: editNameEn.trim(),
        nameZh: editNameZh.trim(),
        unit: editUnit.trim(),
        costMethod: editCostMethod,
        reorderLevel: parseInt(editReorderLevel, 10) || 0,
        cogsAccountId: editCogsAccountId || undefined,
        inventoryAccountId: editInventoryAccountId || undefined,
      });
      setItems((prev) =>
        prev.map((item) =>
          item.id === id
            ? {
                ...item,
                sku: editSku.trim(),
                nameEn: editNameEn.trim(),
                nameZh: editNameZh.trim(),
                unit: editUnit.trim(),
                costMethod: editCostMethod,
                reorderLevel: parseInt(editReorderLevel, 10) || 0,
                cogsAccountId: editCogsAccountId || null,
                inventoryAccountId: editInventoryAccountId || null,
              }
            : item,
        ),
      );
      setEditing(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  async function handleToggle(id: string, active: boolean) {
    setPending(true);
    setError(null);
    try {
      await toggleInventoryItemActive(orgSlug, id, active);
      setItems((prev) =>
        prev.map((item) => (item.id === id ? { ...item, isActive: active } : item)),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  async function handleRecordTxn() {
    if (!txnItem) return;
    setPending(true);
    setError(null);
    try {
      const result = await recordInventoryTxnAction(orgSlug, {
        inventoryItemId: txnItem.id,
        type: txnType as 'purchase' | 'sale' | 'adjustment' | 'return',
        quantity: parseFloat(txnQuantity) || 0,
        unitCostMinor: String(Math.round((parseFloat(txnUnitCost) || 0) * 100)),
        notes: txnNotes.trim() || undefined,
      });
      setItems((prev) =>
        prev.map((item) =>
          item.id === txnItem.id
            ? {
                ...item,
                currentQuantity: result.newQuantity,
                currentAvgCostMinor: BigInt(result.newAvgCostMinor),
              }
            : item,
        ),
      );
      setTxnItem(null);
      setTxnQuantity('');
      setTxnUnitCost('');
      setTxnNotes('');
      setTxnType('purchase');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  function getAccountName(accountId: string | null): string {
    if (!accountId) return t.inventory.noAccount;
    const acct = accounts.find((a) => a.id === accountId);
    return acct ? localizedName({ name_en: acct.nameEn, name_zh: acct.nameZh }, locale) : t.inventory.noAccount;
  }

  const activeItems = items.filter((i) => i.isActive);
  const inactiveItems = items.filter((i) => !i.isActive);

  return (
    <div className="named-list">
      {activeItems.length > 0 ? (
        <table className="transaction-table">
          <caption className="visually-hidden">{t.inventory.title}</caption>
          <thead>
            <tr>
              <th scope="col">{t.inventory.sku}</th>
              <th scope="col">{t.inventory.name}</th>
              <th scope="col">{t.inventory.unit}</th>
              <th scope="col" className="numeric">{t.inventory.quantity}</th>
              <th scope="col" className="numeric">{t.inventory.avgCost}</th>
              <th scope="col" className="numeric">{t.inventory.totalValue}</th>
              <th scope="col">{t.inventory.status}</th>
              <th scope="col">{t.common.cancel}</th>
            </tr>
          </thead>
          <tbody>
            {activeItems.map((item) => {
              const lowStock = item.currentQuantity <= item.reorderLevel;
              const totalValueMinor = item.currentAvgCostMinor * BigInt(Math.round(item.currentQuantity));

              if (editing === item.id) {
                return (
                  <tr key={item.id}>
                    <td colSpan={8}>
                      <div className="inline-edit">
                        <input
                          value={editSku}
                          onChange={(e) => setEditSku(e.target.value)}
                          placeholder={t.inventory.sku}
                        />
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
                          value={editUnit}
                          onChange={(e) => setEditUnit(e.target.value)}
                          placeholder={t.inventory.unit}
                        />
                        <div className="inline-edit-row">
                          <select
                            value={editCostMethod}
                            onChange={(e) => setEditCostMethod(e.target.value as 'fifo' | 'average')}
                          >
                            <option value="fifo">FIFO</option>
                            <option value="average">{t.inventory.costMethod}</option>
                          </select>
                          <input
                            type="number"
                            min="0"
                            value={editReorderLevel}
                            onChange={(e) => setEditReorderLevel(e.target.value)}
                            placeholder={t.inventory.reorderLevel}
                          />
                        </div>
                        <div className="inline-edit-row">
                          <select
                            value={editCogsAccountId}
                            onChange={(e) => setEditCogsAccountId(e.target.value)}
                          >
                            <option value="">{t.inventory.cogsAccount}</option>
                            {accounts.map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.code} {localizedName({ name_en: a.nameEn, name_zh: a.nameZh }, locale)}
                              </option>
                            ))}
                          </select>
                          <select
                            value={editInventoryAccountId}
                            onChange={(e) => setEditInventoryAccountId(e.target.value)}
                          >
                            <option value="">{t.inventory.inventoryAccount}</option>
                            {accounts
                              .filter((a) => a.type === 'asset')
                              .map((a) => (
                                <option key={a.id} value={a.id}>
                                  {a.code} {localizedName({ name_en: a.nameEn, name_zh: a.nameZh }, locale)}
                                </option>
                              ))}
                          </select>
                        </div>
                        <div>
                          <button onClick={() => handleUpdate(item.id)} disabled={pending}>
                            {t.settings.save}
                          </button>
                          <button onClick={() => setEditing(null)}>{t.common.cancel}</button>
                        </div>
                      </div>
                    </td>
                  </tr>
                );
              }

              return (
                <tr key={item.id}>
                  <td>{item.sku}</td>
                  <td>{localizedName({ name_en: item.nameEn, name_zh: item.nameZh }, locale)}</td>
                  <td>{item.unit}</td>
                  <td className="numeric">{item.currentQuantity}</td>
                  <td className="numeric">
                    {formatMoney(item.currentAvgCostMinor, 'USD')}
                  </td>
                  <td className="numeric">{formatMoney(totalValueMinor, 'USD')}</td>
                  <td>
                    {lowStock ? (
                      <span className="badge badge-danger">{t.inventory.lowStock}</span>
                    ) : (
                      <span className="badge badge-success">{t.settings.active}</span>
                    )}
                  </td>
                  <td>
                    <button onClick={() => startEdit(item)}>Edit</button>
                    <button onClick={() => setTxnItem(item)}>
                      {t.inventory.recordTransaction}
                    </button>
                    <button onClick={() => handleToggle(item.id, false)}>
                      {t.settings.deactivate}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}

      {inactiveItems.length > 0 ? (
        <div className="coa-section">
          <h2 className="coa-section-title">{t.settings.inactive}</h2>
          {inactiveItems.map((item) => (
            <div key={item.id} className="list-item inactive">
              <div className="list-item-line">
                <span>{item.sku}</span>
                <span>{localizedName({ name_en: item.nameEn, name_zh: item.nameZh }, locale)}</span>
                <span className="badge">{t.settings.inactive}</span>
                <button onClick={() => handleToggle(item.id, true)}>
                  {t.settings.reactivate}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {activeItems.length === 0 && inactiveItems.length === 0 ? (
        <p className="empty-state">{t.inventory.noItems}</p>
      ) : null}

      {error ? <p role="alert" className="form-error">{error}</p> : null}

      {showAdd ? (
        <div className="add-form">
          <h3>{t.inventory.addItem}</h3>
          <input
            placeholder={`${t.inventory.sku}*`}
            value={sku}
            onChange={(e) => setSku(e.target.value)}
          />
          <input
            placeholder={`${t.settings.nameEn}*`}
            value={nameEn}
            onChange={(e) => setNameEn(e.target.value)}
          />
          <input
            placeholder={`${t.settings.nameZh}*`}
            value={nameZh}
            onChange={(e) => setNameZh(e.target.value)}
          />
          <input
            placeholder={`${t.inventory.unit}*`}
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
          />
          <select
            value={costMethod}
            onChange={(e) => setCostMethod(e.target.value as 'fifo' | 'average')}
          >
            <option value="fifo">FIFO</option>
            <option value="average">Average</option>
          </select>
          <input
            type="number"
            min="0"
            placeholder={t.inventory.reorderLevel}
            value={reorderLevel}
            onChange={(e) => setReorderLevel(e.target.value)}
          />
          <select value={cogsAccountId} onChange={(e) => setCogsAccountId(e.target.value)}>
            <option value="">{t.inventory.cogsAccount}</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} {localizedName({ name_en: a.nameEn, name_zh: a.nameZh }, locale)}
              </option>
            ))}
          </select>
          <select value={inventoryAccountId} onChange={(e) => setInventoryAccountId(e.target.value)}>
            <option value="">{t.inventory.inventoryAccount}</option>
            {accounts
              .filter((a) => a.type === 'asset')
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} {localizedName({ name_en: a.nameEn, name_zh: a.nameZh }, locale)}
                </option>
              ))}
          </select>
          <button onClick={handleCreate} disabled={pending || !sku.trim() || !nameEn.trim() || !unit.trim()}>
            {t.inventory.addItem}
          </button>
          <button onClick={resetAddForm}>{t.common.cancel}</button>
        </div>
      ) : (
        <button onClick={() => setShowAdd(true)} className="primary-button">
          {t.inventory.addItem}
        </button>
      )}

      {/* Transaction Dialog */}
      {txnItem ? (
        <div className="modal-overlay" role="dialog" aria-label={t.inventory.recordTransaction}>
          <div className="modal-content">
            <h3>
              {t.inventory.recordTransaction}:{' '}
              {localizedName({ name_en: txnItem.nameEn, name_zh: txnItem.nameZh }, locale)}
            </h3>
            <label htmlFor="txn-type">{t.inventory.type}</label>
            <select
              id="txn-type"
              value={txnType}
              onChange={(e) => setTxnType(e.target.value)}
            >
              {TYPES.map((tp) => (
                <option key={tp} value={tp}>
                  {t.inventory[tp as keyof typeof t.inventory]}
                </option>
              ))}
            </select>

            <label htmlFor="txn-qty">{t.inventory.quantity}</label>
            <input
              id="txn-qty"
              type="number"
              min="0"
              step="0.0001"
              value={txnQuantity}
              onChange={(e) => setTxnQuantity(e.target.value)}
              required
            />

            <label htmlFor="txn-cost">{t.inventory.unitCost}</label>
            <input
              id="txn-cost"
              type="number"
              min="0"
              step="0.01"
              value={txnUnitCost}
              onChange={(e) => setTxnUnitCost(e.target.value)}
              required
            />

            <label htmlFor="txn-notes">{t.settings.notes}</label>
            <input
              id="txn-notes"
              value={txnNotes}
              onChange={(e) => setTxnNotes(e.target.value)}
            />

            {error ? <p role="alert" className="form-error">{error}</p> : null}

            <div className="form-actions">
              <button onClick={handleRecordTxn} disabled={pending}>
                {pending ? t.common.loading : t.settings.save}
              </button>
              <button onClick={() => { setTxnItem(null); setError(null); }}>
                {t.common.cancel}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
