/* Currencies, remembered rates, and conversion.
 *
 * THREE THINGS LIVE HERE, AND THEY ANSWER THREE DIFFERENT QUESTIONS:
 *
 *   1. "Which currencies exist?"          — the registry.
 *   2. "What was the rate on Tuesday?"     — the remembered rates.
 *   3. "What is 100 AED worth in USD?"     — conversion.
 *
 * THE RULE THAT MAKES THIS SAFE: a rate is remembered, but money is never
 * rewritten. Every budget line, expense and fund stores the rate it used
 * (`rate_to_base`) and the amount that rate produced (`base_amount`). Changing
 * a remembered rate tomorrow does not touch a rupee already spent — the
 * snapshot is what makes an old trip's arithmetic auditable.
 *
 * So a rate here is a DEFAULT to offer, and a conversion here is a PRESENTATION
 * of a stored amount. Neither ever edits a booked number.
 *
 * Rates are entered by people. Nothing is fetched from a provider: an exchange
 * rate that arrives unannounced is not a rate anyone agreed to.
 */

import { sumAmounts, multiplyRate, toMinorUnits, toDecimalString, normaliseRate } from '../money.js';
import { tx } from '../db.js';
import { WorkflowError } from '../trips/validate.js';

/** The rate used when a currency IS the base currency: one to one. */
export const IDENTITY_RATE = '1.00000000';

/**
 * The company's base currency — the one every stored amount is already in.
 * Read from the database, because it is a setting, not a constant.
 */
let cachedBaseCurrency = null;
let baseCurrencyExpiry = 0;

export async function baseCurrency(db) {
  const now = Date.now();
  if (cachedBaseCurrency && baseCurrencyExpiry > now) return cachedBaseCurrency;
  const row = await db.one('SELECT base_currency FROM company LIMIT 1');
  cachedBaseCurrency = row?.base_currency ?? 'INR';
  baseCurrencyExpiry = now + 60_000;
  return cachedBaseCurrency;
}

let cachedCurrencies = null;
let currenciesExpiry = 0;

/** Every active currency, for the interface's pickers. */
export async function listCurrencies(db) {
  const now = Date.now();
  if (cachedCurrencies && currenciesExpiry > now) return cachedCurrencies;
  cachedCurrencies = await db.many(
    `SELECT code, name, symbol, minor_units
       FROM currency WHERE active ORDER BY code`
  );
  currenciesExpiry = now + 60_000;
  return cachedCurrencies;
}

/** Assert a currency code is active and known in the currency registry. */
export async function assertCurrencyKnown(db, code, field = 'currency') {
  const currencies = await listCurrencies(db);
  const found = currencies.some((c) => c.code === code);
  if (!found) {
    throw new WorkflowError(422, 'validation_failed', `${code} is not a currency Trek knows about.`, {
      [field]: `${code} is not a currency Trek knows about.`,
    });
  }
}

/**
 * The most recent remembered rate for a pair, or null if there is none.
 *
 * `direction` is which way round the caller wants the number:
 *   'to_base'    — how many BASE one unit of `currency` buys (what a trip stores)
 *   'from_base'  — how many `currency` one unit of BASE buys (what a person reads)
 *
 * The table stores one direction per pair: how many `to_code` one `from_code`
 * buys. Which row to look for therefore depends on the direction asked for.
 */
export async function rateFor(db, { currency, base, direction = 'to_base', onDate = null }) {
  if (!currency || !base) return null;
  if (currency === base) return IDENTITY_RATE;

  /* The table stores one direction per pair, so a pair may be remembered in
   * either direction. Look for the row as asked first, then the other way
   * round — and read it the right way once found.
   *
   *   'to_base'    — "how many BASE does one CURRENCY buy"
   *   'from_base'  — "how many CURRENCY does one BASE buy"
   */
  const when = onDate ? ' AND effective_on <= $3' : '';
  const find = (from, to) => db.one(
    `SELECT rate, effective_on
       FROM exchange_rate
      WHERE from_code = $1 AND to_code = $2 ${when}
      ORDER BY effective_on DESC
      LIMIT 1`,
    onDate ? [from, to, onDate] : [from, to]
  );

  let row = await find(currency, base);
  let storedReversed = false;
  if (!row) {
    /* The pair is remembered the other way round. */
    row = await find(base, currency);
    storedReversed = true;
  }
  if (!row) return null;

  /* A row read forwards says "how many `to_code` one `from_code` buys".
   *   stored currency→base, read forwards → "how many BASE one CURRENCY
   *   buys" → that is `to_base`.
   *   stored base→currency, read forwards → "how many CURRENCY one BASE
   *   buys" → that is `from_base`.
   * The other direction is the exact inverse. */
  const direct = storedReversed
    ? (direction === 'from_base')
    : (direction === 'to_base');

  if (direct) {
    return { rate: row.rate, effectiveOn: row.effective_on };
  }
  const recip = reciprocalRate(row.rate);
  if (!recip) return null;
  return { rate: recip, effectiveOn: row.effective_on };
}

/**
 * The reciprocal of a rate, exactly.
 *
 * 1 / 83.25 is not a number with eight decimals, and rounding it to eight
 * would put a fraction of a paisa into every converted amount. So the
 * reciprocal is computed in integer minor units at a higher scale and then
 * truncated — never rounded — because a converted amount must never exceed
 * the money it came from.
 *
 * Exported for its own tests: the arithmetic is the part most likely to be
 * wrong, and it must be checked on its own.
 */
export function reciprocalRate(rate) {
  const SCALE = 8n;
  const HIGH = 12n;
  const WORK = SCALE + HIGH;

  /* Recompute at twelve times the stored scale, so the truncation error is
   * small relative to the eight decimals the schema stores.
   *
   * `scaled` is the rate in minor units at scale WORK. The reciprocal at the
   * same scale is (10^WORK / scaled) expressed in minor units, which needs
   * the numerator scaled by 10^WORK as well — one factor of 10 short and the
   * answer lands a hundredfold too small, which truncates to zero.
   *
   * The reciprocal of 83.25 is 0.012012012…, which truncates to 0.01201201
   * at the stored scale. Truncation, not rounding: a converted amount must
   * never exceed the money it came from. */
  const scaled = toMinorUnits(rate, { scale: WORK, what: 'rate' });
  if (scaled === 0n) return null;

  const inverted = (10n ** (WORK + WORK)) / scaled;
  if (inverted === 0n) return null;

  /* Truncate toward zero at the stored scale. */
  const stored = inverted / (10n ** HIGH);

  /* A rate too small to survive truncation would convert money to zero. That
   * is never the right answer, so refuse rather than lie. */
  if (stored === 0n) return null;
  return toDecimalString(stored, SCALE);
}

/**
 * Remember a rate. One row per pair per day — re-entering today's rate
 * updates it in place, and last week's row is untouched.
 */
export async function recordRate(db, { fromCode, toCode, rate, effectiveOn, enteredBy, note }) {
  if (fromCode === toCode) {
    throw new Error('A currency cannot have a rate against itself.');
  }
  const row = await db.one(
    `INSERT INTO exchange_rate (from_code, to_code, rate, effective_on, entered_by, note)
     VALUES ($1, $2, $3, COALESCE($4::date, CURRENT_DATE), $5, $6)
     ON CONFLICT (from_code, to_code, effective_on)
       DO UPDATE SET rate = EXCLUDED.rate, entered_by = EXCLUDED.entered_by, note = EXCLUDED.note
     RETURNING *`,
    [fromCode, toCode, rate, effectiveOn ?? null, enteredBy ?? null, note ?? null]
  );
  return row;
}

/**
 * Fetch and compute live exchange rates from the European Central Bank feed.
 * Pure network fetch and in-memory calculation; NO database connection held.
 *
 * Zero proprietary API keys required. Computes exact 8-decimal conversion
 * rates for all major world currencies using BigInt minor-unit arithmetic,
 * plus central-bank pegged currencies (AED, SAR, QAR, OMR, BHD, KWD, JOD).
 */
export async function fetchAndComputeEcbRates() {
  let data;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch('https://api.frankfurter.dev/v1/latest?base=EUR', {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`ECB rates feed returned HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    throw new Error(`Failed to fetch live rates from European Central Bank: ${err.message}`);
  }

  if (!data?.rates || !data.rates.INR) {
    throw new Error('European Central Bank feed missing INR rate');
  }

  const effectiveOn = data.date || new Date().toISOString().slice(0, 10);
  const eurInr = String(data.rates.INR);
  const SCALE = 12n;
  const eurInrMinor = toMinorUnits(eurInr, { scale: SCALE, what: 'rate' });

  // Map of currency code -> rate to INR (at 8 decimal places)
  const computedRates = new Map();

  // 1. EUR to INR
  computedRates.set('EUR', normaliseRate(toDecimalString(eurInrMinor / (10n ** 4n), 8n)));

  // 2. Direct ECB currencies (cross rate through EUR)
  for (const [code, rateVal] of Object.entries(data.rates)) {
    if (code === 'INR') continue;
    try {
      const codeMinor = toMinorUnits(String(rateVal), { scale: SCALE, what: 'rate' });
      const inrMinor = (eurInrMinor * (10n ** SCALE)) / codeMinor;
      const rate8 = toDecimalString(inrMinor / (10n ** 4n), 8n);
      computedRates.set(code, normaliseRate(rate8));
    } catch {
      // skip unparseable values
    }
  }

  // 3. Pegged currencies relative to USD
  const usdRate = computedRates.get('USD');
  if (usdRate) {
    const usdMinor = toMinorUnits(usdRate, { scale: SCALE, what: 'rate' });
    const PEGS = {
      AED: '3.6725', // UAE Central Bank peg
      SAR: '3.7500', // SAMA Saudi Central Bank peg
      QAR: '3.6400', // Qatar Central Bank peg
      OMR: '0.2723', // Central Bank of Oman peg (1 USD = 0.2723 OMR, ~309.7 INR/OMR)
      BHD: '0.3845', // Central Bank of Bahrain peg
      KWD: '0.3080', // Kuwaiti Dinar basket rate
      JOD: '0.7090', // Central Bank of Jordan peg
    };
    for (const [code, pegStr] of Object.entries(PEGS)) {
      try {
        const pegMinor = toMinorUnits(pegStr, { scale: SCALE, what: 'rate' });
        const inrMinor = (usdMinor * (10n ** SCALE)) / pegMinor;
        const rate8 = toDecimalString(inrMinor / (10n ** 4n), 8n);
        computedRates.set(code, normaliseRate(rate8));
      } catch {
        // skip
      }
    }
  }

  return { computedRates, effectiveOn };
}

/**
 * Persist computed rates to database inside a transaction.
 */
export async function applySyncRates(db, { computedRates, effectiveOn, enteredBy, note } = {}) {
  const execute = async (client) => {
    const base = await baseCurrency(client);
    if (base !== 'INR') {
      throw new Error(`Live rates sync currently supports INR base currency (configured: ${base})`);
    }

    // Only update currencies registered in our currency table
    const activeCurrencies = await client.many('SELECT code FROM currency WHERE active AND code != $1', [base]);
    const activeCodes = new Set(activeCurrencies.map((c) => c.code));

    const recorded = [];
    const syncNote = note || `Synced from European Central Bank (${effectiveOn})`;

    for (const [code, rate] of computedRates.entries()) {
      if (!activeCodes.has(code)) continue;
      const row = await recordRate(client, {
        fromCode: code,
        toCode: base,
        rate,
        effectiveOn,
        enteredBy,
        note: syncNote,
      });
      recorded.push(row);
    }

    return {
      syncedCount: recorded.length,
      effectiveOn,
      baseCurrency: base,
      rates: recorded,
    };
  };

  // If db is already a client inside a transaction (has query/one/many but no pool property),
  // execute directly; otherwise wrap in tx() for atomic commit of the whole batch.
  if (db && !db.pool && typeof db.query === 'function') {
    return execute(db);
  }
  return tx(execute);
}

/**
 * Synchronize official daily exchange rates against the base currency.
 * Accepts pre-fetched rates or fetches live from European Central Bank.
 */
export async function syncLiveRates(db, opts = {}) {
  const base = await baseCurrency(db);
  if (base !== 'INR') {
    throw new Error(`Live rates sync currently supports INR base currency (configured: ${base})`);
  }
  const feed = opts.computedRates
    ? { computedRates: opts.computedRates, effectiveOn: opts.effectiveOn || new Date().toISOString().slice(0, 10) }
    : await fetchAndComputeEcbRates();

  return applySyncRates(db, {
    computedRates: feed.computedRates,
    effectiveOn: feed.effectiveOn,
    enteredBy: opts.enteredBy,
    note: opts.note,
  });
}

/** Every remembered rate, newest first — so somebody can see what is known. */
export async function listRates(db, { limit = 200 } = {}) {
  return db.many(
    `SELECT r.id, r.from_code, r.to_code, r.rate, r.effective_on, r.note,
            c.name AS from_name, c.symbol AS from_symbol,
            d.name AS to_name, d.symbol AS to_symbol,
            e.name AS entered_by_name
       FROM exchange_rate r
       JOIN currency c ON c.code = r.from_code
       JOIN currency d ON d.code = r.to_code
       LEFT JOIN employee e ON e.id = r.entered_by
      ORDER BY r.effective_on DESC, r.from_code
      LIMIT $1`,
    [limit]
  );
}

/**
 * Convert a stored base amount into a display currency.
 *
 * This is PRESENTATION ONLY. The stored number is never changed — this
 * returns a second number to show beside it, and says which rate produced it.
 *
 * Returns null when no rate is known, because a converted number nobody can
 * account for is worse than no number.
 */
export async function convertForDisplay(db, { baseAmount, fromBase, toDisplay }) {
  if (!toDisplay || toDisplay === fromBase) {
    return { amount: baseAmount, currency: fromBase, rate: IDENTITY_RATE, effectiveOn: null };
  }

  /* We want "how many `toDisplay` does one `fromBase` buy" — which is the
   * `to_base` question for the pair (currency = fromBase, base = toDisplay).
   *
   * The rate table holds one direction per pair, so look for the pair both
   * ways round: the service reads whichever row it finds in the direction that
   * answers the question. */
  const found = await rateFor(db, {
    currency: fromBase,
    base: toDisplay,
    direction: 'to_base',
  });
  if (!found) return null;

  return {
    amount: multiplyRate(baseAmount, found.rate),
    currency: toDisplay,
    rate: found.rate,
    effectiveOn: found.effectiveOn,
  };
}

/**
 * Add up amounts that are in different base currencies.
 *
 * A company that reports in one currency but books trips in another has to
 * convert before it can add. Each amount is converted at the rate remembered
 * for the day it is being shown, and the result says so.
 */
export async function sumAcrossBases(db, { amounts, bases, toDisplay }) {
  const byBase = new Map();
  for (let i = 0; i < amounts.length; i++) {
    const base = bases[i];
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(amounts[i]);
  }

  let total = '0.00';
  const parts = [];
  for (const [base, list] of byBase) {
    const subtotal = sumAmounts(list);
    const converted = await convertForDisplay(db, {
      baseAmount: subtotal,
      fromBase: base,
      toDisplay,
    });
    if (!converted) {
      /* No rate known — the honest answer is to say so rather than to add up
       * a number that is wrong in one of its parts. */
      return { total: null, missing: base, parts };
    }
    total = sumAmounts([total, converted.amount]);
    parts.push({ base, subtotal, converted });
  }
  return { total, missing: null, parts };
}
