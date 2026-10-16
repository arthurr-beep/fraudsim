/**
 * Money formatting.
 *
 * Every amount in `fraud-sim` is an integer in the currency's **minor unit** —
 * kobo for naira, cents for dollars. That is already currency-agnostic: only
 * the presentation is not. So a report can be rendered in any currency without
 * touching a single number, which is what this module does.
 *
 * The minor-unit exponent is read from `Intl` rather than assumed to be 2.
 * Dividing by 100 is right for NGN, USD, EUR and GBP and wrong for JPY and KRW,
 * which have no minor unit at all — a report that quietly showed a Japanese
 * figure as one hundredth of itself would be worse than one that refused.
 */

const DEFAULT_LOCALES = {
  NGN: 'en-NG',
  USD: 'en-US',
  EUR: 'en-IE',
  GBP: 'en-GB',
  KES: 'en-KE',
  GHS: 'en-GH',
  ZAR: 'en-ZA',
  INR: 'en-IN',
  JPY: 'ja-JP',
};

/** Cache formatters — constructing one per row is measurably slow. */
const cache = new Map();

function formatterFor(currency, locale) {
  const key = `${currency}|${locale}`;
  let formatter = cache.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
    });
    cache.set(key, formatter);
  }
  return formatter;
}

/**
 * How many minor units make one major unit of this currency.
 * 100 for most, 1 for JPY and KRW, 1000 for a few Gulf currencies.
 */
export function minorUnitsPerMajor(currency, locale) {
  const digits = formatterFor(currency, locale).resolvedOptions().maximumFractionDigits ?? 2;
  return 10 ** digits;
}

/**
 * Render an integer number of minor units as money.
 *
 * @param {number} minorUnits - e.g. 60000000 kobo, or 6060000 cents
 * @param {object} [options]
 * @param {string} [options.currency='NGN']
 * @param {string} [options.locale] - Defaults to a sensible locale for the currency.
 * @returns {string}
 */
export function formatMoney(minorUnits, options = {}) {
  if (!Number.isFinite(minorUnits)) return '—';

  const currency = options.currency ?? 'NGN';
  const locale = options.locale ?? DEFAULT_LOCALES[currency] ?? 'en-US';

  let formatter;
  try {
    formatter = formatterFor(currency, locale);
  } catch {
    // An unknown currency code should degrade to something readable rather than
    // throwing in the middle of rendering a report.
    return `${currency} ${Math.round(minorUnits / 100).toLocaleString('en-US')}`;
  }

  const major = minorUnits / minorUnitsPerMajor(currency, locale);

  // Whole amounts read better without trailing zeros in a report full of
  // figures; fractional ones keep their precision.
  const isWhole = Number.isInteger(major);
  if (isWhole) {
    return formatterFor(currency, locale)
      .formatToParts(major)
      .filter((part) => part.type !== 'decimal' && part.type !== 'fraction')
      .map((part) => part.value)
      .join('');
  }

  return formatter.format(major);
}

/** The currency's symbol on its own, for compact labels like a stat tile. */
export function currencySymbol(currency = 'NGN', locale) {
  const resolved = locale ?? DEFAULT_LOCALES[currency] ?? 'en-US';
  try {
    return (
      formatterFor(currency, resolved)
        .formatToParts(0)
        .find((part) => part.type === 'currency')?.value ?? currency
    );
  } catch {
    return currency;
  }
}
