import { MoneyError, currencyExponent } from '@/server/domain/money';

export const RATE_SCALE = 10n ** 8n;
const RATE_DECIMALS = 8;

export type RateSource = 'auto' | 'manual';

export function parseRateToScaled(input: string): bigint {
  const trimmed = input.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new MoneyError(`Invalid exchange rate: ${input}`);
  }

  const [whole, fraction = ''] = trimmed.split('.');
  if (fraction.length > RATE_DECIMALS) {
    throw new MoneyError(`Exchange rate supports at most ${RATE_DECIMALS} decimal places: ${input}`);
  }

  const scaled = BigInt(whole + fraction.padEnd(RATE_DECIMALS, '0'));
  if (scaled <= 0n) {
    throw new MoneyError('Exchange rate must be greater than zero');
  }
  return scaled;
}

export function formatScaledRate(scaled: bigint): string {
  if (scaled <= 0n) {
    throw new MoneyError('Exchange rate must be greater than zero');
  }
  const digits = scaled.toString().padStart(RATE_DECIMALS + 1, '0');
  const whole = digits.slice(0, digits.length - RATE_DECIMALS);
  const fraction = digits.slice(digits.length - RATE_DECIMALS).replace(/0+$/, '');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}

export function convertToBaseMinor(args: {
  amountMinor: bigint;
  currency: string;
  baseCurrency: string;
  scaledRate: bigint;
}): bigint {
  const { amountMinor, currency, baseCurrency, scaledRate } = args;

  if (scaledRate <= 0n) {
    throw new MoneyError('Exchange rate must be greater than zero');
  }

  if (currency === baseCurrency) {
    if (scaledRate !== RATE_SCALE) {
      throw new MoneyError('Exchange rate must be exactly 1 when currency equals base currency');
    }
    return amountMinor;
  }

  const fromExponent = currencyExponent(currency);
  const toExponent = currencyExponent(baseCurrency);

  // numerator / denominator, then round half up on the target minor unit.
  let numerator = amountMinor * scaledRate;
  let denominator = RATE_SCALE;

  if (toExponent >= fromExponent) {
    numerator *= 10n ** BigInt(toExponent - fromExponent);
  } else {
    denominator *= 10n ** BigInt(fromExponent - toExponent);
  }

  return (numerator * 2n + denominator) / (denominator * 2n);
}
