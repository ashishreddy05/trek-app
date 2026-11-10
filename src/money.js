/* Money.
 *
 * ONE rule: no IEEE-754 float ever touches a monetary value. `parseFloat`,
 * `Math.round`, `Number('12.34')` and arithmetic on JS numbers are all banned
 * here — 0.1 + 0.2 !== 0.3 and a reimbursement off by one paisa is a real bug.
 *
 * Amounts are exact decimal strings with exactly 2 decimal places
 * ("1234.50"). Rates are exact decimal strings with up to 8 decimal places
 * ("83.25000000"), matching NUMERIC(20,8).
 *
 * The canonical representation is an integer count of minor units (paise, cents)
 * held in a BigInt. That is what every calculation runs on. Converting to a
 * decimal string happens only at the edges: on input and on output.
 *
 * Postgres does the same arithmetic in NUMERIC, which is exact by definition —
 * so the server and the client agree to the paisa without agreeing on a
 * floating-point rounding mode.
 */

/** Amounts carry exactly two decimal places. */
const AMOUNT_SCALE = 2n;

/** Rates carry up to eight decimal places (NUMERIC(20,8)). */
const RATE_SCALE = 8n;

const AMOUNT_RE = /^-?\d+(\.\d{1,2})?$/;
const RATE_RE = /^-?\d+(\.\d{1,8})?$/;

/** Currency codes: three letters, uppercase. */
const CURRENCY_RE = /^[A-Z]{3}$/;

export class MoneyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MoneyError';
  }
}

/**
 * Parse an exact decimal string into minor units (BigInt).
 * Rejects anything that is not an exact decimal — no exponent, no trailing
 * garbage, no more than the allowed scale.
 */
export function toMinorUnits(value, { scale = AMOUNT_SCALE, what = 'amount' } = {}) {
  const s = String(value ?? '').trim();
  if (s === '') throw new MoneyError(`${what} is required`);

  const negative = s.startsWith('-');
  const digits = negative ? s.slice(1) : s;
  const [whole, frac = ''] = digits.split('.');
  if (!/^\d+$/.test(whole)) throw new MoneyError(`${what} must be a decimal number`);

  const allowed = Number(scale);
  if (frac.length > allowed) {
    throw new MoneyError(`${what} must have at most ${allowed} decimal places`);
  }

  const padded = frac.padEnd(Number(scale), '0');
  const minor = BigInt(whole) * 10n ** scale + BigInt(padded || '0');
  return negative ? -minor : minor;
}

/** Render minor units back to an exact decimal string with 2 places. */
export function toDecimalString(minor, scale = AMOUNT_SCALE) {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const divisor = 10n ** scale;
  const whole = abs / divisor;
  const frac = abs % divisor;
  const s = `${whole}.${String(frac).padStart(Number(scale), '0')}`;
  return negative ? `-${s}` : s;
}

/** Normalise an amount for storage: exact 2-decimal string, or throw. */
export function normaliseAmount(value, { what = 'amount' } = {}) {
  const s = String(value ?? '').trim();
  if (!AMOUNT_RE.test(s)) {
    throw new MoneyError(`${what} must be a positive number with at most 2 decimal places`);
  }
  const minor = toMinorUnits(s, { what });
  if (minor <= 0n) throw new MoneyError(`${what} must be greater than zero`);
  return toDecimalString(minor);
}

/**
 * Normalise an amount that may be zero: a fee that does not apply, a cash
 * requirement of nothing, a forex card that was not loaded.
 *
 * "Absent" and "zero" are different things: an absent value means the caller
 * did not say; zero means the caller said nothing is needed. Only the latter
 * is written.
 */
export function normaliseNonNegativeAmount(value, { what = 'amount' } = {}) {
  const s = String(value ?? '').trim();
  if (s === '') return '0.00';
  if (!AMOUNT_RE.test(s)) {
    throw new MoneyError(`${what} must be a number with at most 2 decimal places`);
  }
  const minor = toMinorUnits(s, { what });
  if (minor < 0n) throw new MoneyError(`${what} cannot be negative`);
  return toDecimalString(minor);
}

/** Normalise a rate for storage: exact decimal string with at most 8 places. */
export function normaliseRate(value, { what = 'exchange rate' } = {}) {
  const s = String(value ?? '').trim();
  if (!RATE_RE.test(s)) {
    throw new MoneyError(`${what} must be a decimal number with at most 8 decimal places`);
  }
  const minor = toMinorUnits(s, { scale: RATE_SCALE, what });
  if (minor <= 0n) throw new MoneyError(`${what} must be greater than zero`);
  return toDecimalString(minor, RATE_SCALE);
}

/**
 * Multiply an amount by a rate, in exact arithmetic.
 *
 * amount is at scale 2, rate at scale 8, product lands at scale 10 — so the
 * intermediate is scaled by 10^10 and the result is rounded HALF UP to 2
 * decimal places, which is the rounding Postgres NUMERIC uses for `round()`.
 *
 * The rounding is done on BigInt integers, so it is exact and deterministic.
 */
export function multiplyRate(amount, rate) {
  const amountMinor = toMinorUnits(amount, { what: 'amount' });
  const rateMinor = toMinorUnits(rate, { scale: RATE_SCALE, what: 'exchange rate' });

  /* amount (scale 2) x rate (scale 8) lands at scale 10; bringing it back to
   * scale 2 divides by 10^8. */
  const product = amountMinor * rateMinor;
  const divisor = 10n ** RATE_SCALE;

  const negative = product < 0n;
  const abs = negative ? -product : product;

  const quotient = abs / divisor;
  const remainder = abs % divisor;
  /* Half up: anything at or above .5 of the last place rounds away from zero. */
  const rounded = remainder * 2n >= divisor ? quotient + 1n : quotient;

  return toDecimalString(negative ? -rounded : rounded);
}

/**
 * Add amounts given as exact decimal strings. Returns an exact decimal string.
 * Used to total a set of budget lines or expense rows.
 */
export function sumAmounts(amounts) {
  let total = 0n;
  for (const a of amounts) total += toMinorUnits(a);
  return toDecimalString(total);
}

/** Subtract two exact decimal strings. */
export function subtractAmounts(a, b) {
  return toDecimalString(toMinorUnits(a) - toMinorUnits(b));
}

/** Negate an exact decimal string. */
export function negateAmount(a) {
  return toDecimalString(-toMinorUnits(a));
}

/** Compare two exact decimal strings. Returns -1, 0 or 1. */
export function compareAmounts(a, b) {
  const x = toMinorUnits(a);
  const y = toMinorUnits(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** True when the value is a well-formed currency code. */
export function isCurrency(value) {
  return CURRENCY_RE.test(String(value ?? '').trim().toUpperCase());
}

/** Uppercase and validate a currency code. Throws if malformed. */
export function normaliseCurrency(value, { what = 'currency' } = {}) {
  const s = String(value ?? '').trim().toUpperCase();
  if (!isCurrency(s)) throw new MoneyError(`${what} must be a 3-letter code such as INR, USD, AED`);
  return s;
}

/** The currency a trip's money is converted into for comparison. */
export const BASE_CURRENCY = 'INR';
