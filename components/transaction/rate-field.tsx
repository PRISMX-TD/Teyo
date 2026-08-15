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
    const parsedAmount = Number(amount.replace(/,/g, ''));
    const parsedRate = Number(rate);
    if (!Number.isFinite(parsedAmount) || !Number.isFinite(parsedRate)) return null;
    return (parsedAmount * parsedRate).toFixed(2);
  })();

  return (
    <div className="rate-field">
      <label htmlFor="exchangeRate">{t.transaction.exchangeRate}</label>
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
