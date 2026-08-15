'use client';

import { useEffect, useState, useTransition } from 'react';
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
};

export function RateField({ orgSlug, currency, baseCurrency, occurredOn, amount, locale }: Props) {
  const t = getMessages(locale);
  const [rate, setRate] = useState('');
  const [source, setSource] = useState<'auto' | 'manual' | 'unavailable'>('auto');
  const [, startTransition] = useTransition();

  // 币种或日期一变就重新拉汇率，除非用户已手动改过
  useEffect(() => {
    if (source === 'manual') return;
    if (!currency || !occurredOn) return;

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
