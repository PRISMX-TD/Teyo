'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Locale, Messages } from '@/lib/i18n';
import { interpolate, localizedName } from '@/lib/i18n';
import { currencyExponent, formatMinorToDecimal } from '@/server/domain/money';
import { createFixedAsset, updateFixedAssetAction } from '@/server/actions/fixed_assets';
import type { FixedAssetRow } from '@/server/repositories/fixed_assets';
import { todayLocalISO } from '@/lib/date';

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
  baseCurrency: string;
  currencies: string[];
  /**
   * 有值即编辑模式。
   *
   * updateFixedAssetAction 此前在 app/ 与 components/ 下零引用——也就是说
   * 「改一条固定资产」在界面上根本没有入口，而它背后那套「改参数后重算整张
   * 折旧表、冻结已过账期间」的逻辑（server/repositories/fixed_assets.ts 的
   * generateDepreciationSchedule）从来没有被任何用户触发过。这里把它接上。
   * 与定期规则那一处（components/settings/recurring-list.tsx 的 startEdit）
   * 是同一件事的同一种修法：复用同一张表单，不另起一套字段与校验。
   */
  asset?: FixedAssetRow | null;
  onSuccess?: (id: string) => void;
};

export function AssetForm({
  orgSlug,
  locale,
  i18n: t,
  accounts,
  baseCurrency,
  currencies,
  asset = null,
  onSuccess,
}: Props) {
  const router = useRouter();
  const isEdit = asset !== null;

  // 编辑时的初值按本位币的小数位还原。cost_minor / salvage_value_minor
  // 这两列存的就是本位币（原币三列只作购入留痕，见 0011 迁移），所以这里
  // 用 baseCurrency 的 exponent 而不是 asset.originalCurrency 的——后者会
  // 让一条按日元录入的资产在本位币为马币的公司里被还原成 1/100。
  const baseDecimals = currencyExponent(baseCurrency);

  const [name, setName] = useState(asset?.name ?? '');
  const [description, setDescription] = useState(asset?.description ?? '');
  const [purchaseDate, setPurchaseDate] = useState(asset?.purchaseDate ?? todayLocalISO());
  const [cost, setCost] = useState(
    asset ? formatMinorToDecimal(asset.costMinor, baseDecimals) : '',
  );
  const [originalCurrency, setOriginalCurrency] = useState(baseCurrency);
  const [exchangeRate, setExchangeRate] = useState('1.00000000');
  const [salvageValue, setSalvageValue] = useState(
    asset ? formatMinorToDecimal(asset.salvageValueMinor, baseDecimals) : '0',
  );
  const [usefulLifeMonths, setUsefulLifeMonths] = useState(asset?.usefulLifeMonths ?? 60);
  const [method, setMethod] = useState<'straight_line' | 'declining_balance'>(
    asset?.method ?? 'straight_line',
  );
  const [decliningRateBps, setDecliningRateBps] = useState(asset?.decliningRateBps ?? 20000);
  const [assetAccountId, setAssetAccountId] = useState(asset?.assetAccountId ?? '');
  const [depnExpenseAccountId, setDepnExpenseAccountId] = useState(
    asset?.depnExpenseAccountId ?? '',
  );
  const [depnAccumAccountId, setDepnAccumAccountId] = useState(asset?.depnAccumAccountId ?? '');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /**
   * 上一次保存被冻结的那些期间。null = 还没保存过。
   *
   * 这是 updateFixedAssetAction 的返回值，必须显示出来：把年限从 6 个月改成
   * 4 个月之后，前两期金额没跟着变不是缺陷而是规则（已入账的历史不因为参数
   * 修正而改写），但用户只有在这里被告知一次，才知道自己刚才那一改到底影响
   * 了哪几期。空数组也要显示——「一期都没冻结」与「不知道冻结了几期」是
   * 两回事。
   */
  const [keptPostedPeriods, setKeptPostedPeriods] = useState<string[] | null>(null);

  // 编辑模式下不显示购入币种与购入日汇率：updateFixedAssetSchema 根本不收
  // 这三个字段，多画两个改不动的输入框只会让用户以为自己改得动。
  const isForeign = !isEdit && originalCurrency !== baseCurrency;

  // 一个币种能有几位小数由币种自己决定，不是一律两位：JPY / VND 没有分币。
  // 服务端按这个位数解析金额，多出来的小数会被拒绝而不是像以前那样截掉两位
  // （见 server/actions/fixed_assets.ts 的 parseAmountMinor）。表单必须先把
  // 这件事说清楚——提示位数、当场拦住——而不是让用户提交后撞一句报错。
  const costDecimals = currencyExponent(originalCurrency);
  const amountPlaceholder = (decimals: number) => (decimals === 0 ? '0' : '0.00');

  /** 这个数的小数位超出币种能表达的位数了吗。空串与非数字交给服务端报错。 */
  function tooManyDecimals(value: string, decimals: number): boolean {
    const cleaned = value.trim().replace(/,/g, '');
    if (!/^\d+(\.\d+)?$/.test(cleaned)) return false;
    const [, fraction = ''] = cleaned.split('.');
    return fraction.length > decimals;
  }

  function decimalsHint(currency: string, decimals: number): string {
    if (decimals === 0) {
      return locale === 'zh'
        ? `${currency} 没有小数位，请填整数金额。`
        : `${currency} amounts have no decimal places. Enter a whole number.`;
    }
    return locale === 'zh'
      ? `${currency} 最多 ${decimals} 位小数。`
      : `${currency} amounts take at most ${decimals} decimal place(s).`;
  }

  const costDecimalsError = tooManyDecimals(cost, costDecimals);
  const salvageDecimalsError = tooManyDecimals(salvageValue, baseDecimals);

  // 实时预览折算后的基准币种金额
  const convertedPreview = (() => {
    if (!isForeign || !cost) return null;
    const amount = Number(cost.replace(/,/g, ''));
    const rate = Number(exchangeRate);
    if (!Number.isFinite(amount) || !Number.isFinite(rate) || rate <= 0) return null;
    return (amount * rate).toFixed(baseDecimals);
  })();

  async function handleSubmit() {
    setPending(true);
    setError(null);
    try {
      if (isEdit && asset) {
        // 严格按 updateFixedAssetSchema 的形状传：那张 schema 里没有
        // originalCurrency / originalCostMinor / exchangeRate，cost 指的是
        // 本位币账面原值。把新建时那三个字段一并塞过来，zod 会静默剥掉，
        // 用户以为自己改了汇率，实际什么都没发生。
        const { keptPostedPeriods: kept } = await updateFixedAssetAction(orgSlug, asset.id, {
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
        setKeptPostedPeriods(kept);
        // 排程表就在这张表单上方，重算完必须让它跟着变——服务端已经
        // revalidatePath 过这个路径，这里只是把新的服务端渲染结果拉回来。
        router.refresh();
        return;
      }

      const { id } = await createFixedAsset(orgSlug, {
        name: name.trim(),
        description: description.trim() || null,
        purchaseDate,
        cost,
        originalCurrency: isForeign ? originalCurrency : undefined,
        originalCostMinor: isForeign ? cost : undefined,
        exchangeRate: isForeign ? exchangeRate : undefined,
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
    <div className="transaction-form">
      <div className="form-field">
        {/* 原来是 `t.fixedAssets.title ?? 'Asset Name'`：title 在 Messages
            里是必填的 string，`??` 那一支永远到不了——真正生效的是
            t.fixedAssets.title，也就是「固定资产」这个**页面标题**被当成
            了「资产名称」这个**字段标签**。改用 t.settings.name（「名称」），
            和下面 placeholder 用的是同一个键。 */}
        <label>{t.settings.name}</label>
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

      {isEdit ? (
        <p className="field-hint">
          {interpolate(t.fixedAssets.editBaseCurrencyHint, { currency: baseCurrency })}
        </p>
      ) : null}

      <div className="inline-edit-row">
        {/* 购入币种只在新建时可选。编辑走的是 updateFixedAssetSchema，那张
            schema 收的 cost 是本位币账面原值，没有任何字段能改原币或汇率。 */}
        {!isEdit ? (
          <div className="form-field">
            <label>{t.fixedAssets.purchaseCurrency}</label>
            <select
              value={originalCurrency}
              onChange={(e) => {
                const next = e.target.value;
                setOriginalCurrency(next);
                if (next === baseCurrency) setExchangeRate('1.00000000');
              }}
            >
              {currencies.map((c) => (
                <option key={c} value={c}>
                  {c}
                  {c === baseCurrency ? ` (${t.fixedAssets.baseCurrencyTag})` : ''}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="form-field">
          <label>
            {t.fixedAssets.cost} ({originalCurrency})
          </label>
          <input
            value={cost}
            onChange={(e) => setCost(e.target.value)}
            placeholder={amountPlaceholder(costDecimals)}
            inputMode="decimal"
          />
          {costDecimalsError ? (
            <span className="hint" role="alert">{decimalsHint(originalCurrency, costDecimals)}</span>
          ) : null}
        </div>
      </div>

      {isForeign && (
        <div className="form-field">
          <label>
            {locale === 'zh'
              ? `购入日汇率（1 ${originalCurrency} = ? ${baseCurrency}）`
              : `Rate on purchase date (1 ${originalCurrency} = ? ${baseCurrency})`}
          </label>
          <input
            value={exchangeRate}
            onChange={(e) => setExchangeRate(e.target.value)}
            placeholder="1.00000000"
            inputMode="decimal"
          />
          <span className="hint">
            {convertedPreview
              ? locale === 'zh'
                ? `账面原值：${convertedPreview} ${baseCurrency}（按购入日汇率折算一次，后续不重估）`
                : `Book cost: ${convertedPreview} ${baseCurrency} (translated once at purchase date, not revalued)`
              : locale === 'zh'
                ? '固定资产为非货币性项目，仅按购入日汇率折算一次。'
                : 'Fixed assets are non-monetary items, translated once at the purchase-date rate.'}
          </span>
        </div>
      )}

      <div className="form-field">
        <label>
          {t.fixedAssets.salvageValue} ({baseCurrency})
        </label>
        <input
          value={salvageValue}
          onChange={(e) => setSalvageValue(e.target.value)}
          placeholder={amountPlaceholder(baseDecimals)}
          inputMode="decimal"
        />
        {salvageDecimalsError ? (
          <span className="hint" role="alert">{decimalsHint(baseCurrency, baseDecimals)}</span>
        ) : null}
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
            <option value="straight_line">{t.fixedAssets.straightLine}</option>
            <option value="declining_balance">{t.fixedAssets.decliningBalance}</option>
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
          <option value="">{t.transaction.choosePlaceholder}</option>
          {assetAccounts.map((acc) => (
            <option key={acc.id} value={acc.id}>{accountName(acc)}</option>
          ))}
        </select>
      </div>

      <div className="form-field">
        <label>{t.fixedAssets.depreciationExpense}</label>
        <select value={depnExpenseAccountId} onChange={(e) => setDepnExpenseAccountId(e.target.value)}>
          <option value="">{t.transaction.choosePlaceholder}</option>
          {expenseAccounts.map((acc) => (
            <option key={acc.id} value={acc.id}>{accountName(acc)}</option>
          ))}
        </select>
      </div>

      <div className="form-field">
        <label>{t.fixedAssets.accumulatedDepreciation}</label>
        <select value={depnAccumAccountId} onChange={(e) => setDepnAccumAccountId(e.target.value)}>
          <option value="">{t.transaction.choosePlaceholder}</option>
          {assetAccounts.map((acc) => (
            <option key={acc.id} value={acc.id}>{accountName(acc)}</option>
          ))}
        </select>
      </div>

      {error ? <p role="alert" className="form-error">{error}</p> : null}

      {/*
        保存的结果。这段不是锦上添花：改 cost / salvage / life / method /
        purchaseDate 任一项都会重算整张折旧表，而已经过账的期间会被原样保留
        （generateDepreciationSchedule 拒绝改写它们，否则同一期折旧会被记
        第二笔）。用户看不到这句话，就只会看到「我把年限改短了，前两期金额
        却没变」，而界面上没有任何地方解释得了这件事。
      */}
      {keptPostedPeriods !== null ? (
        <div role="status" className="form-success">
          <p>{t.fixedAssets.scheduleRebuilt}</p>
          <p>
            {keptPostedPeriods.length === 0
              ? t.fixedAssets.scheduleKeptNone
              : interpolate(t.fixedAssets.scheduleKept, {
                  count: keptPostedPeriods.length,
                  // ISO 日期不需要翻译，所以这里不必再加一个文案键。
                  periods: keptPostedPeriods.join(', '),
                })}
          </p>
        </div>
      ) : null}

      <button
        onClick={handleSubmit}
        disabled={
          pending ||
          !name.trim() ||
          !cost ||
          costDecimalsError ||
          salvageDecimalsError ||
          !assetAccountId ||
          !depnExpenseAccountId ||
          !depnAccumAccountId
        }
      >
        {pending
          ? t.common.loading
          : isEdit
            ? t.fixedAssets.saveChanges
            : t.invoices.save}
      </button>
    </div>
  );
}
