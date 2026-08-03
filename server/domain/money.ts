export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

export type Money = {
  amountMinor: bigint;
  currency: string;
};

const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'PYG',
  'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

export function currencyExponent(currency: string): number {
  if (!CURRENCY_CODE_PATTERN.test(currency)) {
    throw new MoneyError(`Invalid currency code: ${currency}`);
  }
  return ZERO_DECIMAL_CURRENCIES.has(currency) ? 0 : 2;
}

export function parseDecimalToMinor(input: string, exponent: number): bigint {
  const normalized = input.trim().replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    throw new MoneyError(`Not a valid non-negative decimal amount: ${input}`);
  }

  const [whole, fraction = ''] = normalized.split('.');
  if (fraction.length > exponent) {
    throw new MoneyError(
      `Amount ${input} has more than ${exponent} decimal place(s)`,
    );
  }

  const paddedFraction = fraction.padEnd(exponent, '0');
  return BigInt(`${whole}${paddedFraction}`);
}

export function formatMinorToDecimal(amountMinor: bigint, exponent: number): string {
  const negative = amountMinor < 0n;
  const absolute = negative ? -amountMinor : amountMinor;

  if (exponent === 0) {
    return `${negative ? '-' : ''}${absolute.toString()}`;
  }

  const digits = absolute.toString().padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = digits.slice(digits.length - exponent);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

export function addMinor(a: bigint, b: bigint): bigint {
  return a + b;
}

export function sumMinor(values: bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}
