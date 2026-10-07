'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Locale, Messages } from '@/lib/i18n';
import { interpolate, localizedName } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';
import { currencyExponent } from '@/server/domain/money';
import {
  disposeFixedAssetAction,
  undoFixedAssetDisposalAction,
} from '@/server/actions/fixed-assets';
import type { DisposalSummary } from '@/server/repositories/fixed-assets';

type MoneyAccountOption = {
  id: string;
  name_en: string | null;
  name_zh: string | null;
};

type Props = {
  orgSlug: string;
  assetId: string;
  isActive: boolean;
  baseCurrency: string;
  /** 公司时区下的今天（todayInOrg），处置日的默认值。 */
  today: string;
  purchaseDate: string;
  moneyAccounts: MoneyAccountOption[];
  /** 已处置且有处置分录时才有值；0031 之前的旧处置为 null。 */
  disposal: DisposalSummary | null;
  locale: Locale;
  i18n: Messages;
};

/**
 * 详情页上的「处置」区块：在用时是一张处置表单，已处置时是处置摘要加
 * 「撤销处置」按钮。
 *
 * 原来处置只是列表页上的一个按钮，不问日期、不问卖了多少钱——因为它本来
 * 就不出分录。现在要出分录，这三样就必须由用户给出：处置日决定分录落在
 * 哪个期间、截到哪一期的累计折旧；收入决定损益；收款账户决定钱进哪里。
 */
export function DisposeAssetPanel({
  orgSlug,
  assetId,
  isActive,
  baseCurrency,
  today,
  purchaseDate,
  moneyAccounts,
  disposal,
  locale,
  i18n: t,
}: Props) {
  const router = useRouter();
  const decimals = currencyExponent(baseCurrency);

  // 默认今天，但不早于购入日——服务端会拒绝早于购入日的处置。
  const [disposalDate, setDisposalDate] = useState(today < purchaseDate ? purchaseDate : today);
  const [proceeds, setProceeds] = useState('0');
  const [moneyAccountId, setMoneyAccountId] = useState(moneyAccounts[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const cleaned = proceeds.trim().replace(/,/g, '');
  const isNumber = /^\d+(\.\d+)?$/.test(cleaned);
  const fraction = cleaned.split('.')[1] ?? '';
  const tooManyDecimals = isNumber && fraction.length > decimals;
  // 只用来决定要不要收款账户，金额本身由服务端按币种小数位解析。
  const hasProceeds = isNumber && /[1-9]/.test(cleaned);

  async function handleDispose() {
    if (!window.confirm(t.fixedAssets.disposeConfirm)) return;
    setPending(true);
    setError(null);
    try {
      await disposeFixedAssetAction(orgSlug, assetId, {
        disposalDate,
        proceeds: cleaned === '' ? '0' : cleaned,
        moneyAccountId: hasProceeds ? moneyAccountId : null,
      });
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  async function handleUndo() {
    if (!window.confirm(t.fixedAssets.undoDisposalConfirm)) return;
    setPending(true);
    setError(null);
    try {
      await undoFixedAssetDisposalAction(orgSlug, assetId);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  if (!isActive) {
    return (
      <section id="dispose" className="dispose-asset-panel">
        <h2>{t.fixedAssets.disposalTitle}</h2>
        {disposal ? (
          <>
            <p>{t.fixedAssets.disposalDate}: {disposal.disposalDate}</p>
            <p>
              {t.fixedAssets.disposalProceeds}:{' '}
              {disposal.proceedsMinor === 0n
                ? `${formatMoney(0n, baseCurrency, locale)} (${t.fixedAssets.scrapped})`
                : formatMoney(disposal.proceedsMinor, baseCurrency, locale)}
            </p>
            <p>
              {disposal.gainLossMinor >= 0n ? t.fixedAssets.disposalGain : t.fixedAssets.disposalLoss}:{' '}
              {formatMoney(
                disposal.gainLossMinor >= 0n ? disposal.gainLossMinor : -disposal.gainLossMinor,
                baseCurrency,
                locale,
              )}
            </p>
            <p>
              <Link href={`/${orgSlug}/transactions/${disposal.transactionId}`}>
                {t.fixedAssets.viewDisposalEntry}
              </Link>
              {disposal.voided ? ` (${t.fixedAssets.disposalEntryVoided})` : null}
            </p>
          </>
        ) : (
          <p className="field-hint">{t.fixedAssets.disposedWithoutEntry}</p>
        )}

        {error ? <p role="alert" className="form-error">{error}</p> : null}

        <button onClick={handleUndo} disabled={pending} className="secondary-button">
          {pending ? t.common.loading : t.fixedAssets.undoDisposal}
        </button>
      </section>
    );
  }

  return (
    <section id="dispose" className="dispose-asset-panel">
      <h2>{t.fixedAssets.disposalTitle}</h2>
      <p className="field-hint">{t.fixedAssets.disposalHint}</p>
      <div className="transaction-form">
        <div className="form-field">
          <label>{t.fixedAssets.disposalDate}</label>
          <input
            type="date"
            value={disposalDate}
            min={purchaseDate}
            onChange={(e) => setDisposalDate(e.target.value)}
          />
        </div>

        <div className="form-field">
          <label>
            {t.fixedAssets.disposalProceeds} ({baseCurrency})
          </label>
          <input
            value={proceeds}
            onChange={(e) => setProceeds(e.target.value)}
            placeholder={decimals === 0 ? '0' : '0.00'}
            inputMode="decimal"
          />
          <span className="hint">{t.fixedAssets.disposalProceedsHint}</span>
          {tooManyDecimals ? (
            <span className="hint" role="alert">
              {interpolate(t.fixedAssets.disposalDecimals, { currency: baseCurrency, decimals })}
            </span>
          ) : null}
        </div>

        {hasProceeds ? (
          <div className="form-field">
            <label>{t.fixedAssets.disposalMoneyAccount}</label>
            <select value={moneyAccountId} onChange={(e) => setMoneyAccountId(e.target.value)}>
              {moneyAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {localizedName(account, locale)}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {error ? <p role="alert" className="form-error">{error}</p> : null}

        <button
          onClick={handleDispose}
          disabled={
            pending ||
            !disposalDate ||
            tooManyDecimals ||
            (cleaned !== '' && !isNumber) ||
            (hasProceeds && !moneyAccountId)
          }
          className="btn-danger"
        >
          {pending ? t.common.loading : t.fixedAssets.dispose}
        </button>
      </div>
    </section>
  );
}
