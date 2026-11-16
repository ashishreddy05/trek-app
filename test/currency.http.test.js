/* The currency registry, the remembered rates, and reading a report in
 * another currency — over the wire, through the real routing table and the
 * real guard.
 *
 * The property under test is the one that matters: A REMEMBERED RATE IS A
 * DEFAULT TO OFFER, NEVER A REWRITE. Recording a rate today must not move a
 * rupee that was spent last month, and the stored amount must survive a
 * report being shown in another currency.
 */

import { test, after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as db from '../src/db.js';
import { handle } from '../src/http/app.js';
import { hashPassword } from '../src/auth/password-hash.js';

let server;
let baseUrl;
const PASSWORD = 'secret-passphrase';

/* One trip with one approved expense of 1000.00 INR, owned by traveller one.
 * Inserted directly: the money path is not what is under test here. */
const TRIP_ID = 'trp_display_test';

before(async () => {
  server = http.createServer(handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const hash = await hashPassword(PASSWORD);
  for (const email of [
    'test.traveller.five@garageplug.test',
    'test.finance@garageplug.test',
  ]) {
    await db.query(
      `INSERT INTO password_credential (account_id, hash)
       SELECT a.id, $2 FROM account a JOIN employee e ON e.id = a.employee_id WHERE e.work_email = $1
       ON CONFLICT (account_id) DO UPDATE SET hash = EXCLUDED.hash`,
      [email, hash]
    );
  }

  await db.query('DELETE FROM expense WHERE trip_id = $1', [TRIP_ID]);
  await db.query('DELETE FROM trip WHERE id = $1', [TRIP_ID]);
  await db.query("DELETE FROM exchange_rate WHERE from_code IN ('USD', 'UGX') AND to_code = 'INR'");
  await db.query(
    `INSERT INTO trip (id, employee_id, destination, purpose, start_date, end_date,
                       currency, base_currency, status)
     VALUES ($1, 'emp_t08', 'Test City', 'Display currency test', CURRENT_DATE,
             CURRENT_DATE + 2, 'INR', 'INR', 'active')`,
    [TRIP_ID]
  );
  await db.query(
    `INSERT INTO expense (trip_id, employee_id, expense_date, description, category,
                          amount, currency, status, base_amount, rate_to_base)
     VALUES ($1, 'emp_t08', CURRENT_DATE, 'Test expense', 'food',
             1000.00, 'INR', 'approved', 1000.00, 1.00000000)`,
    [TRIP_ID]
  );
});

after(async () => {
  await db.query('DELETE FROM expense WHERE trip_id = $1', [TRIP_ID]);
  await db.query('DELETE FROM trip WHERE id = $1', [TRIP_ID]);
  await new Promise((resolve) => server.close(resolve));
  await db.close();
});

async function loginAs(email) {
  const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  assert.equal(res.status, 200);
  const match = res.headers.get('set-cookie').match(/trek_session=([^;]+)/);
  assert.ok(match);
  return `trek_session=${match[1]}`;
}

const get = (cookie, path) =>
  fetch(`${baseUrl}/api/v1${path}`, { headers: { cookie } });

const post = (cookie, path, body) =>
  fetch(`${baseUrl}/api/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });

describe('the currency registry', () => {
  test('anybody signed in may read the list of currencies', async () => {
    const cookie = await loginAs('test.traveller.five@garageplug.test');
    const res = await get(cookie, '/currencies');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.currencies.length >= 5, 'the registry has the common currencies');
    assert.ok(body.currencies.some((c) => c.code === 'INR'));
    assert.ok(body.currencies.some((c) => c.code === 'USD'));
    assert.equal(body.baseCurrency, 'INR', 'the company says which currency it budgets in');
  });

  test('a currency nobody has signed in for is refused', async () => {
    const res = await fetch(`${baseUrl}/api/v1/currencies`);
    assert.equal(res.status, 401);
  });
});

describe('remembering a rate', () => {
  test('an employee may not remember a rate', async () => {
    const cookie = await loginAs('test.traveller.five@garageplug.test');
    const res = await post(cookie, '/exchange-rates', { fromCode: 'USD', toCode: 'INR', rate: '83.25000000' });
    assert.equal(res.status, 403);
  });

  test('finance may remember a rate', async () => {
    const cookie = await loginAs('test.finance@garageplug.test');
    const res = await post(cookie, '/exchange-rates', {
      fromCode: 'USD', toCode: 'INR', rate: '83.25000000', effectiveOn: '2026-11-01',
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.rate.from_code, 'USD');
    assert.equal(body.rate.to_code, 'INR');
    assert.equal(body.rate.rate, '83.25000000');
  });

  test('a rate against the same currency is refused', async () => {
    const cookie = await loginAs('test.finance@garageplug.test');
    const res = await post(cookie, '/exchange-rates', { fromCode: 'INR', toCode: 'INR', rate: '1' });
    assert.equal(res.status, 422);
  });

  test('a rate that is not a number is refused', async () => {
    const cookie = await loginAs('test.finance@garageplug.test');
    const res = await post(cookie, '/exchange-rates', { fromCode: 'USD', toCode: 'INR', rate: 'about eighty' });
    assert.equal(res.status, 422);
  });

  test('a currency Trek does not know about is refused', async () => {
    const cookie = await loginAs('test.finance@garageplug.test');
    const res = await post(cookie, '/exchange-rates', { fromCode: 'XXX', toCode: 'INR', rate: '1' });
    assert.equal(res.status, 422);
  });

  test('the remembered rate is offered back in both directions', async () => {
    const cookie = await loginAs('test.traveller.five@garageplug.test');
    const res = await get(cookie, '/exchange-rates/USD');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.currency, 'USD');
    assert.equal(body.baseCurrency, 'INR');
    /* One USD buys 83.25 INR — so one INR buys 1/83.25 USD. */
    assert.equal(body.rateToBase, '83.25000000', 'what a trip stores');
    assert.equal(body.rateFromBase, '0.01201201', 'what a reader converting INR to USD needs');
    assert.equal(body.rateToBaseEffectiveOn, '2026-11-01');
  });
});

describe('reading a report in another currency', () => {
  test('the dashboard reports the currency, the rate and the day it took effect', async () => {
    const cookie = await loginAs('test.traveller.five@garageplug.test');
    const res = await get(cookie, '/dashboard?display=USD');
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.display.currency, 'USD');
    assert.equal(body.display.baseCurrency, 'INR');
    assert.equal(body.display.rate, '0.01201201');
    assert.equal(body.display.effectiveOn, '2026-11-01');
    assert.equal(body.display.known, true);
  });

  test('the money is converted for showing and the stored amount is untouched', async () => {
    const cookie = await loginAs('test.traveller.five@garageplug.test');
    const res = await get(cookie, '/dashboard?display=USD');
    const body = await res.json();

    /* 1000.00 INR at 0.01201201 USD per INR is 12.01 USD — truncated, never
     * rounded up, so a shown figure never exceeds the money behind it. */
    assert.equal(body.totals.spent_display, '12.01');
    assert.equal(body.totals.spent_base, '1000.00');

    const stored = await db.one('SELECT base_amount FROM expense WHERE trip_id = $1', [TRIP_ID]);
    assert.equal(stored.base_amount, '1000.00', 'the stored amount did not move');
  });

  test('a currency with no remembered rate produces no number, and says why', async () => {
    const cookie = await loginAs('test.traveller.five@garageplug.test');
    const res = await get(cookie, '/dashboard?display=UGX');
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.display.known, false);
    assert.equal(body.display.rate, null);
    assert.equal(body.totals.spent_display, null, 'no number nobody can account for');
    assert.equal(body.totals.spent_base, '1000.00', 'the real amount is still there');
  });

  test('a currency Trek does not know about is refused', async () => {
    const cookie = await loginAs('test.traveller.five@garageplug.test');
    const res = await get(cookie, '/dashboard?display=XXX');
    assert.equal(res.status, 422);
  });

  test('with no display asked for, the report is in the base currency', async () => {
    const cookie = await loginAs('test.traveller.five@garageplug.test');
    const res = await get(cookie, '/dashboard');
    const body = await res.json();
    assert.equal(body.display.currency, 'INR');
    assert.equal(body.display.rate, '1.00000000');
    assert.equal(body.totals.spent_display, '1000.00');
  });

  test('the CSV export carries the converted columns as well as the base ones', async () => {
    const cookie = await loginAs('test.traveller.five@garageplug.test');
    const res = await get(cookie, '/reports/export.csv?kind=trips&display=USD');
    assert.equal(res.status, 200);
    const csv = await res.text();
    assert.match(csv, /Budget \(base\)/);
    assert.match(csv, /Budget \(USD\)/);
    assert.match(csv, /12\.01/);
  });
});
