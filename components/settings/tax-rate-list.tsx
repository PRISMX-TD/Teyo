'use client';

import { useState } from 'react';
import type { Locale, Messages } from '@/lib/i18n';
import { localizedName } from '@/lib/i18n';
import { createTaxRate, updateTaxRateAction, setDefaultTaxRateAction, deleteTaxRateAction } from '@/server/actions/tax';
import { parseDecimalToMinor } from '@/server/domain/money';

/**
 * 税率的输入与存储。
 *
 * 库里存的是**基点**（rate_bps，6% = 600），而这两个输入框原来直接绑
 * rateBps，标签只写「Rate」。想设 6% 的人打「6」，得到的是 0.06%——
 * 此后每一张开出去的发票税额都几乎为零，而界面上从头到尾没有一句话说明
 * 这个框要的是基点。文案键 t.tax.ratePercent（「税率 (%)」）一直存在，
 * 却从没被用过：按百分比录入这件事本来就是打算做的。
 *
 * 转换不经浮点。parseDecimalToMinor(value, 2) 就是「把一个十进制串按两位
 * 小数放大成整数」，"6" -> 600、"6.5" -> 650、"8.25" -> 825，和这个仓库
 * 处理金额用的是同一个函数、同一套半进位规则。写成 parseFloat(v) * 100
 * 的话，"8.25" 会在二进制里变成 824.9999999999999，Math.round 今天救得
 * 回来，下一个小数位就未必。
 */
const RATE_DECIMALS = 2;

function percentToBps(value: string): number {
  const cleaned = value.trim();
  if (!cleaned) return 0;
  return Number(parseDecimalToMinor(cleaned, RATE_DECIMALS));
}

/**
 * 输入框里现在的内容能不能变成一个税率。
 *
 * parseDecimalToMinor 对非法输入是抛错的，而它抛的是 MoneyError——文案讲的
 * 是「金额」。把它直接冒到界面上，用户在税率这一格会读到一句谈金额的话。
 * 所以这里先判一次，非法时直接把保存按钮禁掉，用户根本走不到那个错误。
 */
function isValidPercent(value: string): boolean {
  const cleaned = value.trim();
  if (!cleaned) return false;
  try {
    parseDecimalToMinor(cleaned, RATE_DECIMALS);
    return true;
  } catch {
    return false;
  }
}

function bpsToPercent(bps: number): string {
  const sign = bps < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(bps)).toString().padStart(RATE_DECIMALS + 1, '0');
  const whole = abs.slice(0, -RATE_DECIMALS);
  const frac = abs.slice(-RATE_DECIMALS).replace(/0+$/, '');
  return frac ? `${sign}${whole}.${frac}` : `${sign}${whole}`;
}

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
  const [ratePct, setRatePct] = useState('6');
  const [isDefault, setIsDefault] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Edit state
  const [editing, setEditing] = useState<string | null>(null);
  const [editNameEn, setEditNameEn] = useState('');
  const [editNameZh, setEditNameZh] = useState('');
  const [editRatePct, setEditRatePct] = useState('0');
  const [editIsDefault, setEditIsDefault] = useState(false);

  async function handleCreate() {
    setPending(true);
    setError(null);
    try {
      setShowAdd(false);
      await createTaxRate(orgSlug, {
        nameEn: nameEn.trim(),
        nameZh: nameZh.trim(),
        rateBps: percentToBps(ratePct),
        isDefault,
      });
      setNameEn('');
      setNameZh('');
      setRatePct('6');
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
        rateBps: percentToBps(editRatePct),
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
    setEditRatePct(bpsToPercent(item.rateBps));
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
                placeholder={t.settings.nameEn} aria-label={t.settings.nameEn}
              />
              <input
                value={editNameZh}
                onChange={(e) => setEditNameZh(e.target.value)}
                placeholder={t.settings.nameZh} aria-label={t.settings.nameZh}
              />
              <input
                type="text"
                inputMode="decimal"
                value={editRatePct}
                onChange={(e) => setEditRatePct(e.target.value)}
                placeholder={t.tax.ratePercent} aria-label={t.tax.ratePercent}
              />
              <span className="hint">%</span>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={editIsDefault}
                  onChange={(e) => setEditIsDefault(e.target.checked)}
                />
                {t.tax.defaultRate}
              </label>
              <button
                onClick={() => handleUpdate(item.id)}
                disabled={pending || !isValidPercent(editRatePct)}
              >
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
            placeholder={t.settings.nameEn} aria-label={t.settings.nameEn}
            value={nameEn}
            onChange={(e) => setNameEn(e.target.value)}
          />
          <input
            placeholder={t.settings.nameZh} aria-label={t.settings.nameZh}
            value={nameZh}
            onChange={(e) => setNameZh(e.target.value)}
          />
          <input
            type="text"
            inputMode="decimal"
            placeholder={t.tax.ratePercent} aria-label={t.tax.ratePercent}
            value={ratePct}
            onChange={(e) => setRatePct(e.target.value)}
          />
          <span className="hint">%</span>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
            />
            {t.tax.defaultRate}
          </label>
          <button
            onClick={handleCreate}
            disabled={pending || !nameEn.trim() || !nameZh.trim() || !isValidPercent(ratePct)}
          >
            {t.tax.addRate}
          </button>
          <button onClick={() => setShowAdd(false)}>{t.common.cancel}</button>
        </div>
      )}
    </div>
  );
}
