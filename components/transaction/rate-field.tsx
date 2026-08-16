'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import type { Locale } from '@/lib/i18n';
import { getMessages, interpolate } from '@/lib/i18n';
import { lookupRate } from '@/server/actions/rates';

type Props = {
  orgSlug: string;
  currency: string;
  baseCurrency: string;
  occurredOn: string;
  amount: string;
  locale: Locale;
  /**
   * 编辑一笔既有外币交易时传入：当时记的汇率与来源。有值时首次挂载不
   * 重新查询，直接采用它——不然打开一笔外币交易改个备注就会把汇率悄悄
   * 换成缓存里现在的值，改变本位币金额，而屏幕上什么都不会提示这一点。
   */
  initialRate?: string;
  initialSource?: 'auto' | 'manual';
};

export function RateField({
  orgSlug,
  currency,
  baseCurrency,
  occurredOn,
  amount,
  locale,
  initialRate,
  initialSource,
}: Props) {
  const t = getMessages(locale);
  const [rate, setRate] = useState(initialRate ?? '');
  const [source, setSource] = useState<'auto' | 'manual' | 'unavailable'>(initialSource ?? 'auto');
  const [, startTransition] = useTransition();

  // 首次挂载若带着已记录的汇率（编辑模式），跳过第一次查询；
  // 一旦币种或日期真的变了，就消耗掉这个豁免，跟创建时一样重新查询。
  const skipNextFetch = useRef(
    initialRate !== undefined && initialRate !== '' && !!currency && !!occurredOn,
  );
  const initialPair = useRef({ currency, occurredOn });

  // 币种或日期一变就重新拉汇率。这个 effect 只在 currency/occurredOn/orgSlug
  // 变化时触发，所以每次触发都意味着：无论之前是自动填入还是用户手动改过，
  // 那个值都是给旧的币种/日期配的，不能留在框里跟着新的一对一起提交。
  // 因此这里不再按 source 是否为 'manual' 跳过，而是先无条件重置成
  // 'auto' 并清空 rate，再为新的一对重新查询——不然「改成手动汇率后又切换
  // 币种」会让旧数值原地变成新币种的手工汇率，静默记错账。
  useEffect(() => {
    if (!currency || !occurredOn) return;

    if (
      skipNextFetch.current &&
      currency === initialPair.current.currency &&
      occurredOn === initialPair.current.occurredOn
    ) {
      skipNextFetch.current = false;
      return;
    }
    skipNextFetch.current = false;

    setSource('auto');
    setRate('');

    startTransition(async () => {
      const result = await lookupRate(orgSlug, currency, occurredOn);
      if (result.rate) {
        setRate(result.rate);
        setSource('auto');
      } else {
        setRate('');
        setSource('unavailable');
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currency, occurredOn, orgSlug]);

  const isForeign = currency !== baseCurrency;
  if (!isForeign) {
    // 不发 exchangeRate：让服务端走 currency === baseCurrency 分支，
    // 该分支返回 source 'auto'。发一个 "1" 会被判成手工汇率，
    // 使 rate_source 这一列对每一笔交易都恒为 'manual'。
    return null;
  }

  const converted = (() => {
    // Number('') is 0, not NaN -- without this guard, clearing the rate in the
    // 'unavailable' state would render "Equals 0.00 MYR" directly under the
    // message asking the user for a rate.
    if (rate === '') return null;
    const parsedAmount = Number(amount.replace(/,/g, ''));
    const parsedRate = Number(rate);
    if (!Number.isFinite(parsedAmount) || !Number.isFinite(parsedRate)) return null;
    return (parsedAmount * parsedRate).toFixed(2);
  })();

  return (
    <div className="rate-field">
      <label htmlFor="exchangeRate">{t.transaction.exchangeRate}</label>
      {source === 'auto' ? (
        <div className="rate-field__row">
          {/* Auto-fetched rate is shown but not submitted: no `name` attribute
              means the server takes the currency !== baseCurrency cache-lookup
              branch itself and stamps rate_source='auto'. Submitting this value
              as `exchangeRate` would make resolveRate treat it as a manual entry
              -- the same bug that made rate_source='manual' unconditional. */}
          <p id="exchangeRate" className="rate-field__value" aria-live="polite">
            {rate || '…'}
          </p>
          <button type="button" className="btn-small" onClick={() => setSource('manual')}>
            {t.transaction.useOtherRate}
          </button>
        </div>
      ) : (
        <input
          id="exchangeRate"
          name="exchangeRate"
          inputMode="decimal"
          value={rate}
          required
          onChange={(event) => {
            setRate(event.target.value);
            setSource('manual');
          }}
        />
      )}
      <p className="field-hint" role="status">
        {source === 'auto' ? t.transaction.rateAutoFilled : null}
        {source === 'manual' ? t.transaction.rateManual : null}
        {source === 'unavailable'
          ? interpolate(t.transaction.rateNeeded, { currency, base: baseCurrency })
          : null}
      </p>

      {converted ? (
        <p className="field-hint">
          {t.transaction.convertedAmount} {converted} {baseCurrency}
        </p>
      ) : null}
    </div>
  );
}
