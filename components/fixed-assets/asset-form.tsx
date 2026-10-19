'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Locale, Messages } from '@/lib/i18n';
import { interpolate, localizedName } from '@/lib/i18n';
import { currencyExponent, formatMinorToDecimal } from '@/server/domain/money';
import { createFixedAsset, updateFixedAssetAction } from '@/server/actions/fixed-assets';
import type { FixedAssetRow } from '@/server/repositories/fixed-assets';
import { useLocalToday } from '@/components/ui/use-local-today';

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
   * 折旧表、冻结已过账期间」的逻辑（server/repositories/fixed-assets.ts 的
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
  const uid = useId();
  const isEdit = asset !== null;

  // 编辑时的初值按本位币的小数位还原。cost_minor / salvage_value_minor
  // 这两列存的就是本位币（原币三列只作购入留痕，见 0011 迁移），所以这里
  // 用 baseCurrency 的 exponent 而不是 asset.originalCurrency 的——后者会
  // 让一条按日元录入的资产在本位币为马币的公司里被还原成 1/100。
  const baseDecimals = currencyExponent(baseCurrency);

  const [name, setName] = useState(asset?.name ?? '');
  const [description, setDescription] = useState(asset?.description ?? '');
  // 默认日期等水合完成后才取设备上的今天，见 components/ui/use-local-today.ts。
  const today = useLocalToday();
  const [purchaseDateInput, setPurchaseDate] = useState<string | null>(asset?.purchaseDate ?? null);
  const purchaseDate = purchaseDateInput ?? today;
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
  // （见 server/actions/fixed-assets.ts 的 parseAmountMinor）。表单必须先把
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

  const canSubmit =
    !pending &&
    !!name.trim() &&
    !!cost &&
    !costDecimalsError &&
    !salvageDecimalsError &&
    !!assetAccountId &&
    !!depnExpenseAccountId &&
    !!depnAccumAccountId;

  // 每个标签都用 htmlFor 指向自己的输入框：原来 <label> 是孤立的，读屏器
  // 念不出这一栏问的是什么，点标签也不会聚焦输入框。
  const fid = (key: string) => `${uid}-${key}`;

  return (
    // 真正的 <form>：提交按钮原来是个不在表单里、没写 type 的 <button>，
    // 拿不到主按钮的绿色与上边距，回车也提交不了。
    <form
      className="transaction-form fa-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) void handleSubmit();
      }}
    >
      <div className="form-field">
        {/* 原来是 `t.fixedAssets.title ?? 'Asset Name'`：title 在 Messages
            里是必填的 string，`??` 那一支永远到不了——真正生效的是
            t.fixedAssets.title，也就是「固定资产」这个**页面标题**被当成
            了「资产名称」这个**字段标签**。改用 t.settings.name（「名称」）。
            placeholder 和标签一模一样，去掉了。 */}
        <label htmlFor={fid('name')}>{t.settings.name}</label>
        <input id={fid('name')} value={name} onChange={(e) => setName(e.target.value)} />
      </div>

      <div className="form-field">
        <label htmlFor={fid('description')}>{t.transaction.description}</label>
        {/* 多行：备注常常是一整句，单行框在手机上只露出开头几个字。 */}
        <textarea
          id={fid('description')}
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <div className="form-field">
        <label htmlFor={fid('purchaseDate')}>{t.fixedAssets.purchaseDate}</label>
        <input
          id={fid('purchaseDate')}
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

      {/* .form-grid 而不是 .inline-edit-row：后者是列表行的样式（上边线、
          左右内边距、子项按内容宽），放在表单里就成了缩进、半宽、带一条
          细线的两个字段。 */}
      <div className="form-grid">
        {/* 购入币种只在新建时可选。编辑走的是 updateFixedAssetSchema，那张
            schema 收的 cost 是本位币账面原值，没有任何字段能改原币或汇率。 */}
        {!isEdit ? (
          <div className="form-field">
            <label htmlFor={fid('currency')}>{t.fixedAssets.purchaseCurrency}</label>
            <select
              id={fid('currency')}
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
          <label htmlFor={fid('cost')}>
            {t.fixedAssets.cost} ({originalCurrency})
          </label>
          <input
            id={fid('cost')}
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
          <label htmlFor={fid('rate')}>
            {locale === 'zh'
              ? `购入日汇率（1 ${originalCurrency} = ? ${baseCurrency}）`
              : `Rate on purchase date (1 ${originalCurrency} = ? ${baseCurrency})`}
          </label>
          <input
            id={fid('rate')}
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
        <label htmlFor={fid('salvage')}>
          {t.fixedAssets.salvageValue} ({baseCurrency})
        </label>
        <input
          id={fid('salvage')}
          value={salvageValue}
          onChange={(e) => setSalvageValue(e.target.value)}
          placeholder={amountPlaceholder(baseDecimals)}
          inputMode="decimal"
        />
        {salvageDecimalsError ? (
          <span className="hint" role="alert">{decimalsHint(baseCurrency, baseDecimals)}</span>
        ) : null}
      </div>

      <div className="form-grid">
        <div className="form-field">
          <label htmlFor={fid('life')}>{t.fixedAssets.usefulLife}</label>
          <input
            id={fid('life')}
            type="number"
            inputMode="numeric"
            // 0 显示为空框：原来清空后框里立刻变回「0」，再打 12 得到 012。
            value={usefulLifeMonths || ''}
            onChange={(e) => setUsefulLifeMonths(Number(e.target.value) || 0)}
            min={1}
          />
        </div>
        <div className="form-field">
          <label htmlFor={fid('method')}>{t.fixedAssets.method}</label>
          <select
            id={fid('method')}
            value={method}
            onChange={(e) => setMethod(e.target.value as 'straight_line' | 'declining_balance')}
          >
            <option value="straight_line">{t.fixedAssets.straightLine}</option>
            <option value="declining_balance">{t.fixedAssets.decliningBalance}</option>
          </select>
        </div>
      </div>

      {method === 'declining_balance' && (
        <div className="form-field">
          <label htmlFor={fid('declining')}>{t.fixedAssets.decliningRate}</label>
          {/* 标签写的是「（%）」，输入框原来收的却是基点：照着标签填 200
              （双倍余额递减）存下去的是 2%。框里显示与输入一律按百分数，
              换算成基点只在这里做一次。 */}
          <input
            id={fid('declining')}
            type="number"
            inputMode="decimal"
            value={decliningRateBps ? decliningRateBps / 100 : ''}
            onChange={(e) => setDecliningRateBps(Math.round((Number(e.target.value) || 0) * 100))}
            min={0}
            step="0.01"
          />
        </div>
      )}

      <div className="form-field">
        <label htmlFor={fid('assetAccount')}>{t.fixedAssets.assetAccount}</label>
        <select id={fid('assetAccount')} value={assetAccountId} onChange={(e) => setAssetAccountId(e.target.value)}>
          <option value="">{t.transaction.choosePlaceholder}</option>
          {assetAccounts.map((acc) => (
            <option key={acc.id} value={acc.id}>{accountName(acc)}</option>
          ))}
        </select>
      </div>

      <div className="form-field">
        <label htmlFor={fid('expenseAccount')}>{t.fixedAssets.depreciationExpense}</label>
        <select
          id={fid('expenseAccount')}
          value={depnExpenseAccountId}
          onChange={(e) => setDepnExpenseAccountId(e.target.value)}
        >
          <option value="">{t.transaction.choosePlaceholder}</option>
          {expenseAccounts.map((acc) => (
            <option key={acc.id} value={acc.id}>{accountName(acc)}</option>
          ))}
        </select>
      </div>

      <div className="form-field">
        <label htmlFor={fid('accumAccount')}>{t.fixedAssets.accumulatedDepreciation}</label>
        <select
          id={fid('accumAccount')}
          value={depnAccumAccountId}
          onChange={(e) => setDepnAccumAccountId(e.target.value)}
        >
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

      {/* 新建时原来写的是 t.invoices.save——「保存发票」。 */}
      <button type="submit" disabled={!canSubmit}>
        {pending
          ? t.common.loading
          : isEdit
            ? t.fixedAssets.saveChanges
            : t.fixedAssets.create}
      </button>
    </form>
  );
}
