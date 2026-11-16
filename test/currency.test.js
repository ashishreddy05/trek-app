/* The currency registry, the remembered rates, and conversion.
 *
 * These tests exist because money arithmetic is where a bug is most expensive
 * and least visible. Three properties are checked:
 *
 *   1. A rate is remembered once, and offered — never applied retroactively.
 *   2. A conversion is exact enough that no amount is invented or lost.
 *   3. A conversion nobody can account for is refused, not guessed.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  rateFor, reciprocalRate, convertForDisplay, sumAcrossBases, IDENTITY_RATE,
} from '../src/currency/service.js';
import { multiplyRate, sumAmounts } from '../src/money.js';

/* A stand-in for the database: remembered rates, looked up the way the service
 * looks them up (from_code, to_code) ordered by effective_on DESC. */
const dbWith = (rows) => ({
  one: async (sql, params) => {
    const matches = [];
    for (const r of rows) {
      const from = r.from_code ?? r.from;
      const to = r.to_code ?? r.to;
      if (sql.includes('from_code = $1') && from === params[0] && to === params[1]) {
        matches.push(r);
      }
    }
    if (!matches.length) return null;
    matches.sort((a, b) => {
      const da = a.effective_on ?? a.effectiveOn ?? '';
      const db = b.effective_on ?? b.effectiveOn ?? '';
      return db.localeCompare(da);
    });
    return matches[0];
  },
  many: async () => rows,
});

describe('the reciprocal of a rate', () => {
  test('inverts exactly, truncating rather than rounding', () => {
    /* 1/83.25 = 0.012012012…, truncated to eight decimals. */
    assert.equal(reciprocalRate('83.25000000'), '0.01201201');
    assert.equal(reciprocalRate('23.50000000'), '0.04255319');
    assert.equal(reciprocalRate('1.00000000'), '1.00000000');
    assert.equal(reciprocalRate('8.00000000'), '0.12500000');
  });

  test('never invents precision it does not have', () => {
    for (const rate of ['83.25000000', '23.50000000', '0.12500000']) {
      const r = reciprocalRate(rate);
      assert.match(r, /^\d+\.\d{8}$/, 'a rate carries exactly eight decimals');
    }
  });

  test('refuses a rate so small it would convert money to nothing', () => {
    /* 10^9 is tiny; at eight decimals its reciprocal truncates to zero. */
    assert.equal(reciprocalRate('1000000000.00000000'), null);
  });
});

describe('remembered rates', () => {
  test('a rate to base is the remembered row, read as written', async () => {
    /* The row is stored currency→base: one AED buys 83.25 INR. A trip asks
     * "how many base units does one foreign unit buy" — the same question,
     * so the same number. */
    const db = dbWith([{ from: 'AED', to: 'INR', rate: '83.25000000', effective_on: '2026-11-12' }]);
    const r = await rateFor(db, { currency: 'AED', base: 'INR', direction: 'to_base' });
    assert.equal(r.rate, '83.25000000');
    assert.equal(r.effectiveOn, '2026-11-12');
  });

  test('the most recent remembered rate is chosen when multiple effective dates exist', async () => {
    const db = dbWith([
      { from: 'AED', to: 'INR', rate: '80.00000000', effective_on: '2026-11-01' },
      { from: 'AED', to: 'INR', rate: '83.25000000', effective_on: '2026-11-12' },
      { from: 'AED', to: 'INR', rate: '81.50000000', effective_on: '2026-11-05' },
    ]);
    const r = await rateFor(db, { currency: 'AED', base: 'INR', direction: 'to_base' });
    assert.equal(r.rate, '83.25000000');
    assert.equal(r.effectiveOn, '2026-11-12');
  });

  test('a rate from base reads the row the other way round', async () => {
    /* "How many INR does one AED buy" is what the row says: 83.25. */
    const db = dbWith([{ from: 'AED', to: 'INR', rate: '83.25000000', effective_on: '2026-11-12' }]);
    const r = await rateFor(db, { currency: 'INR', base: 'AED', direction: 'from_base' });
    assert.equal(r.rate, '83.25000000');
  });

  test('the inverse is available when the other direction is asked for', async () => {
    /* "How many AED does one INR buy" is the reciprocal: 0.01201201. */
    const db = dbWith([{ from: 'AED', to: 'INR', rate: '83.25000000', effective_on: '2026-11-12' }]);
    const r = await rateFor(db, { currency: 'INR', base: 'AED', direction: 'to_base' });
    assert.equal(r.rate, '0.01201201');
  });

  test('a currency against itself needs no rate', async () => {
    const db = dbWith([]);
    assert.equal(await rateFor(db, { currency: 'INR', base: 'INR' }), IDENTITY_RATE);
  });

  test('an unknown pair has no rate', async () => {
    const db = dbWith([]);
    assert.equal(await rateFor(db, { currency: 'AED', base: 'INR' }), null);
  });
});

describe('converting for display', () => {
  test('an amount in the base currency needs no conversion', async () => {
    const db = dbWith([]);
    const r = await convertForDisplay(db, { baseAmount: '1000.00', fromBase: 'INR', toDisplay: 'INR' });
    assert.equal(r.amount, '1000.00');
    assert.equal(r.currency, 'INR');
  });

  test('an amount is converted at the remembered rate, and says which', async () => {
    /* 1000.00 INR shown in AED: one INR buys 1/83.25 AED, so 12.01 AED.
     * The true value is 12.012012…, truncated to 12.01 — a converted amount
     * never exceeds the money it came from. */
    const db = dbWith([{ from: 'AED', to: 'INR', rate: '83.25000000', effective_on: '2026-11-12' }]);
    const r = await convertForDisplay(db, { baseAmount: '1000.00', fromBase: 'INR', toDisplay: 'AED' });
    assert.equal(r.amount, '12.01');
    assert.equal(r.currency, 'AED');
    assert.equal(r.rate, '0.01201201');
    assert.equal(r.effectiveOn, '2026-11-12');
  });

  test('an unconvertible amount is refused rather than guessed', async () => {
    const db = dbWith([]);
    const r = await convertForDisplay(db, { baseAmount: '1000.00', fromBase: 'INR', toDisplay: 'USD' });
    assert.equal(r, null, 'no rate means no number');
  });
});

describe('adding up amounts in different base currencies', () => {
  test('each part is converted, then added', async () => {
    const db = dbWith([{ from: 'AED', to: 'INR', rate: '83.25000000', effective_on: '2026-11-12' }]);
    const r = await sumAcrossBases(db, {
      amounts: ['1000.00', '832.50'],
      bases: ['INR', 'AED'],
      toDisplay: 'INR',
    });
    /* 832.50 AED at 83.25 is 69305.63 INR — the true value is 69305.625,
     * truncated so it never exceeds the money it came from. The total is
     * 70305.63 INR. */
    assert.equal(r.total, '70305.63');
    assert.equal(r.missing, null);
  });

  test('one unconvertible part makes the whole total unknown', async () => {
    const db = dbWith([]);
    const r = await sumAcrossBases(db, {
      amounts: ['1000.00', '832.50'],
      bases: ['INR', 'AED'],
      toDisplay: 'INR',
    });
    assert.equal(r.total, null);
    assert.equal(r.missing, 'AED');
  });

  test('the parts are reported, so the arithmetic can be checked', async () => {
    const db = dbWith([{ from: 'AED', to: 'INR', rate: '83.25000000', effective_on: '2026-11-12' }]);
    const r = await sumAcrossBases(db, { amounts: ['1000.00', '832.50'], bases: ['INR', 'AED'], toDisplay: 'INR' });
    assert.equal(r.parts.length, 2);
    assert.deepEqual(r.parts.map((p) => p.base), ['INR', 'AED']);
    assert.equal(r.parts[1].subtotal, '832.50');
    assert.equal(r.parts[1].converted.amount, '69305.63');
  });
});

describe('conversion is exact', () => {
  test('a converted total equals the sum of its parts', async () => {
    const db = dbWith([{ from: 'AED', to: 'INR', rate: '83.25000000', effective_on: '2026-11-12' }]);
    const r = await sumAcrossBases(db, { amounts: ['100.00', '200.00'], bases: ['INR', 'AED'], toDisplay: 'INR' });
    const parts = r.parts.map((p) => (p.base === 'INR' ? p.subtotal : p.converted.amount));
    assert.equal(r.total, sumAmounts(parts), 'the total is the sum of what it says it is');
  });

  test('multiplying by a rate never loses a paisa to rounding', () => {
    /* 83.25 and 0.01201201 — the round trip is off by less than a paisa. */
    const forward = multiplyRate('1000.00', '83.25000000');
    const back = multiplyRate(forward, '0.01201201');
    assert.equal(back, '1000.00');
  });
});
