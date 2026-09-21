'use client';

import { useState } from 'react';
import type { Locale } from '@/lib/i18n';
import { getMessages, localizedName } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';
import { ModalDialog } from '@/components/shell/modal-dialog';
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
  /** 公司本位币。库存金额原来一律按 'USD' 显示，见下面 totalValue 的注释。 */
  baseCurrency: string;
};

const TYPES = ['purchase', 'sale', 'adjustment', 'return'] as const;

/**
 * 库存总值 = 平均成本 × 数量，**不经过浮点**。
 *
 * 原来写的是 `item.currentAvgCostMinor * BigInt(Math.round(item.currentQuantity))`：
 * 数量被四舍五入成整数，0.5 kg 的存货按 1 kg 估值，2.4 米的线材按 2 米估值。
 * 数量那一栏明明显示着 0.5，旁边的总值却是按 1 算的，对不上也看不出为什么。
 *
 * 这里把数量当定点小数处理：拆成整数位和小数位两段字符串，各自转 BigInt，
 * 乘完再按小数位数除回去。除法那一步是唯一的精度损失点，且只发生在最后，
 * 按最小货币单位四舍五入——和会计上「金额只保留到分」是同一件事。
 */
function inventoryValueMinor(avgCostMinor: bigint, quantity: number): bigint {
  if (!Number.isFinite(quantity) || quantity === 0) return 0n;

  const negative = quantity < 0;
  // toFixed 的输入是 number，本身已经是浮点了；但这里只用它把数量固定到
  // 4 位小数（数据库里 quantity 的精度），不用它算钱。
  const [whole, fraction = ''] = Math.abs(quantity).toFixed(4).split('.');
  const scale = 10n ** BigInt(fraction.length);
  const scaledQuantity = BigInt(`${whole}${fraction}`);

  const product = avgCostMinor * scaledQuantity;
  // 四舍五入到最小货币单位，而不是直接截断（截断会让每一行都少几分）。
  const rounded = (product + scale / 2n) / scale;
  return negative ? -rounded : rounded;
}

export function InventoryList({ orgSlug, locale, items: initialItems, accounts, baseCurrency }: Props) {
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
              {/* 每件存货挂哪两个科目，原来只有点开「编辑」才看得到。
                  getAccountName 这个函数早就写好了，却没有任何地方调用它——
                  科目挂错时，每一次出库都会把成本记到错的地方，而列表上
                  看不出任何异样。摆出来，错的那一行一眼就能认出来。 */}
              <th scope="col">{t.inventory.cogsAccount}</th>
              <th scope="col">{t.inventory.inventoryAccount}</th>
              {/* 这一列原来的表头是 t.common.cancel（「取消」）——它其实是
                  操作列，里面放的是编辑/记录出入库/隐藏三个按钮。 */}
              <th scope="col">{t.common.actions}</th>
            </tr>
          </thead>
          <tbody>
            {activeItems.map((item) => {
              const lowStock = item.currentQuantity <= item.reorderLevel;
              const totalValueMinor = inventoryValueMinor(
                item.currentAvgCostMinor,
                item.currentQuantity,
              );

              if (editing === item.id) {
                return (
                  <tr key={item.id}>
                    <td colSpan={10}>
                      <div className="inline-edit">
                        <input
                          value={editSku}
                          onChange={(e) => setEditSku(e.target.value)}
                          placeholder={t.inventory.sku} aria-label={t.inventory.sku}
                        />
                        <input
                          value={editNameEn}
                          onChange={(e) => setEditNameEn(e.target.value)}
                          placeholder={t.settings.nameEn} aria-label={t.settings.nameEn}
                        />
                        <input
                          value={editNameZh}
                          onChange={(e) => setEditNameZh(e.target.value)}
                          placeholder={t.settings.nameZh} aria-label={t.settings.nameZh}
                        />
                        <input
                          value={editUnit}
                          onChange={(e) => setEditUnit(e.target.value)}
                          placeholder={t.inventory.unit} aria-label={t.inventory.unit}
                        />
                        <div className="inline-edit-row">
                          <select
                            value={editCostMethod}
                            onChange={(e) => setEditCostMethod(e.target.value as 'fifo' | 'average')}
                          >
                            {/* 第二个选项原来渲染的是 t.inventory.costMethod
                                （「成本法」——那是这个下拉本身的标题），
                                选项名和字段名撞在一起，用户根本看不出选的是
                                加权平均。 */}
                            <option value="fifo">{t.inventory.fifo}</option>
                            <option value="average">{t.inventory.average}</option>
                          </select>
                          <input
                            type="number"
                            min="0"
                            value={editReorderLevel}
                            onChange={(e) => setEditReorderLevel(e.target.value)}
                            placeholder={t.inventory.reorderLevel} aria-label={t.inventory.reorderLevel}
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
                  {/* 原来这两处硬写 'USD'。库存成本记的是本位币，一家
                      马来西亚公司的货值会被标成 US$——数字对、币种错，
                      而且零小数币种（JPY/KRW/VND）连数字都会差 100 倍。 */}
                  <td className="numeric">
                    {formatMoney(item.currentAvgCostMinor, baseCurrency, locale)}
                  </td>
                  <td className="numeric">{formatMoney(totalValueMinor, baseCurrency, locale)}</td>
                  <td>
                    {lowStock ? (
                      <span className="badge badge-danger">{t.inventory.lowStock}</span>
                    ) : (
                      <span className="badge badge-success">{t.settings.active}</span>
                    )}
                  </td>
                  <td>{getAccountName(item.cogsAccountId)}</td>
                  <td>{getAccountName(item.inventoryAccountId)}</td>
                  <td>
                    <button onClick={() => startEdit(item)}>{t.common.edit}</button>
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
            placeholder={`${t.inventory.sku}*`} aria-label={`${t.inventory.sku}*`}
            value={sku}
            onChange={(e) => setSku(e.target.value)}
          />
          <input
            placeholder={`${t.settings.nameEn}*`} aria-label={`${t.settings.nameEn}*`}
            value={nameEn}
            onChange={(e) => setNameEn(e.target.value)}
          />
          <input
            placeholder={`${t.settings.nameZh}*`} aria-label={`${t.settings.nameZh}*`}
            value={nameZh}
            onChange={(e) => setNameZh(e.target.value)}
          />
          <input
            placeholder={`${t.inventory.unit}*`} aria-label={`${t.inventory.unit}*`}
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
          />
          <select
            value={costMethod}
            onChange={(e) => setCostMethod(e.target.value as 'fifo' | 'average')}
          >
            <option value="fifo">{t.inventory.fifo}</option>
            <option value="average">{t.inventory.average}</option>
          </select>
          <input
            type="number"
            min="0"
            placeholder={t.inventory.reorderLevel} aria-label={t.inventory.reorderLevel}
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

      {/* 库存出入库对话框。原来是 <div role="dialog">：有对话框的语义，
          却没有对话框的任何行为——Tab 会跑到背后的库存表格里、Esc 不关、
          背景不 inert。换成共用的 ModalDialog（内部走 showModal()）。 */}
      <ModalDialog
        // 这个框里有类型、数量、单价、账户四组字段，.app-dialog 默认的
        // 400px 会把每一行挤成两截。
        className="app-dialog--wide"
        open={txnItem !== null}
        onClose={() => {
          setTxnItem(null);
          setError(null);
        }}
        title={
          txnItem
            ? `${t.inventory.recordTransaction}: ${localizedName(
                { name_en: txnItem.nameEn, name_zh: txnItem.nameZh },
                locale,
              )}`
            : t.inventory.recordTransaction
        }
      >
        {txnItem ? (
          <>
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

            <div className="app-dialog-actions">
              <button onClick={() => { setTxnItem(null); setError(null); }}>
                {t.common.cancel}
              </button>
              <button className="primary-button" onClick={handleRecordTxn} disabled={pending}>
                {pending ? t.common.loading : t.settings.save}
              </button>
            </div>
          </>
        ) : null}
      </ModalDialog>
    </div>
  );
}
