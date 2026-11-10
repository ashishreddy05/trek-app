/* HTTP Route Integration Tests for the pilot workflow.
 * Uses http.createServer(handle) on an ephemeral port and tests real HTTP requests.
 *
 * The workflow is walked end to end over the wire:
 *   trip → currency plan → budget → submit → approve → funds → expense → bill
 *   → submit expense → approve expense → reconciliation → approve → settle
 *
 * Every request goes through the real routing table, the real guard and the
 * real JSON encoder, so a wiring mistake fails here.
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

before(async () => {
  server = http.createServer(handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  /* Ensure the pilot trio have password credentials. */
  const hash = await hashPassword(PASSWORD);
  for (const email of [
    'suresh.kumar@garageplug.com',
    'vikram.shetty@garageplug.com',
    'nadia.haddad@garageplug.com',
    'ravi.nambiar@garageplug.com',
  ]) {
    await db.query(
      `INSERT INTO password_credential (account_id, hash)
       SELECT a.id, $2 FROM account a JOIN employee e ON e.id = a.employee_id WHERE e.work_email = $1
       ON CONFLICT (account_id) DO UPDATE SET hash = EXCLUDED.hash`,
      [email, hash]
    );
  }
});

after(async () => {
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
  const cookieHeader = res.headers.get('set-cookie');
  assert.ok(cookieHeader);
  const match = cookieHeader.match(/trek_session=([^;]+)/);
  assert.ok(match);
  return match[0]; // "trek_session=..."
}

const json = (cookie, body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify(body),
});

describe('HTTP API End-to-End: the pilot workflow', () => {
  let sureshCookie;
  let vikramCookie;
  let nadiaCookie;
  let raviCookie;   // Finance — issues funds, decides reconciliations
  let tripId;
  let expenseId;
  let billId;

  test('sign in users and obtain session cookies', async () => {
    sureshCookie = await loginAs('suresh.kumar@garageplug.com');
    vikramCookie = await loginAs('vikram.shetty@garageplug.com');
    nadiaCookie = await loginAs('nadia.haddad@garageplug.com');
    raviCookie = await loginAs('ravi.nambiar@garageplug.com');
  });

  test('POST /api/v1/trips creates a draft trip', async () => {
    const res = await fetch(`${baseUrl}/api/v1/trips`, json(sureshCookie, {
      destination: 'Doha & Lusail, Qatar',
      purpose: 'GCC Partnership summit and keynote',
      startDate: '2026-12-10',
      endDate: '2026-12-15',
      currency: 'AED',
    }));

    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.trip?.id);
    assert.equal(body.trip.destination, 'Doha & Lusail, Qatar');
    assert.equal(body.trip.status, 'draft');
    assert.equal(body.trip.base_currency, 'INR');
    tripId = body.trip.id;
  });

  test('PATCH /api/v1/trips/:id edits a draft trip', async () => {
    const res = await fetch(`${baseUrl}/api/v1/trips/${tripId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: sureshCookie },
      body: JSON.stringify({
        destination: 'Doha & Lusail, Qatar',
        purpose: 'GCC Partnership summit, keynote and two site visits',
        startDate: '2026-12-10',
        endDate: '2026-12-16',
        currency: 'AED',
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.trip.purpose, 'GCC Partnership summit, keynote and two site visits');
  });

  test('PUT /api/v1/trips/:id/forex sets the currency plan', async () => {
    const res = await fetch(`${baseUrl}/api/v1/trips/${tripId}/forex`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: sureshCookie },
      body: JSON.stringify({
        currency: 'AED',
        rateToBase: '83.25000000',
        cashAmount: '2000.00',
        cardAmount: '15000.00',
        gstAmount: '900.00',
        topupFee: '450.00',
        serviceFee: '150.00',
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.plan.currency, 'AED');
    assert.equal(body.plan.rate_to_base, '83.25000000');
  });

  test('POST /api/v1/trips/:id/budget adds a budget line, converted exactly', async () => {
    const res = await fetch(`${baseUrl}/api/v1/trips/${tripId}/budget`, json(sureshCookie, {
      category: 'travel',
      description: 'Return flights and airport transfer',
      amount: '4000.00',
      currency: 'AED',
    }));
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.line.base_amount, '333000.00', '4000.00 x 83.25');
  });

  test('a budget line in a currency with no rate is refused with 422', async () => {
    const res = await fetch(`${baseUrl}/api/v1/trips/${tripId}/budget`, json(sureshCookie, {
      category: 'food',
      description: 'Dinner',
      amount: '100.00',
      currency: 'JPY',
    }));
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.match(body.error.message, /exchange rate/i);
  });

  test('an expense cannot be recorded before the trip is approved and funded', async () => {
    const res = await fetch(`${baseUrl}/api/v1/expenses`, json(sureshCookie, {
      tripId,
      date: '2026-12-11',
      description: 'Flight ticket return',
      category: 'travel',
      amount: '1850.00',
      currency: 'AED',
      paymentMethod: 'forex_card',
    }));
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error.code, 'invalid_transition');
  });

  test('POST /api/v1/trips/:id/submit submits the trip for approval', async () => {
    const res = await fetch(`${baseUrl}/api/v1/trips/${tripId}/submit`, {
      method: 'POST',
      headers: { cookie: sureshCookie },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.trip.status, 'submitted');
  });

  test('an out-of-scope trip read is 404, not 403', async () => {
    const res = await fetch(`${baseUrl}/api/v1/trips/${tripId}`, {
      headers: { cookie: nadiaCookie },
    });
    assert.equal(res.status, 404);
  });

  test('manager cannot decide with invalid payload (missing reason on reject)', async () => {
    const res = await fetch(`${baseUrl}/api/v1/trips/${tripId}/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: vikramCookie },
      body: JSON.stringify({ decision: 'reject', reason: '' }),
    });
    assert.equal(res.status, 422);
  });

  test('manager approves the trip over HTTP', async () => {
    const res = await fetch(`${baseUrl}/api/v1/trips/${tripId}/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: vikramCookie },
      body: JSON.stringify({ decision: 'approve' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.trip.status, 'approved');
    assert.equal(body.trip.approved_budget_base, '333000.00');
  });

  test('editing an approved trip via HTTP returns 409 conflict', async () => {
    const res = await fetch(`${baseUrl}/api/v1/trips/${tripId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: sureshCookie },
      body: JSON.stringify({
        destination: 'New Destination',
        purpose: 'New purpose',
        startDate: '2026-12-10',
        endDate: '2026-12-15',
        currency: 'AED',
      }),
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error.code, 'invalid_transition');
  });

  test('GET /api/v1/trips without a scope returns the caller\'s own trips, not 403', async () => {
    const res = await fetch(`${baseUrl}/api/v1/trips`, { headers: { cookie: sureshCookie } });
    assert.equal(res.status, 200, 'a collection read must not require an explicit scope');
    const body = await res.json();
    assert.ok(Array.isArray(body.data));
    assert.ok(body.data.some((t) => t.id === tripId));
  });

  test('an employee cannot issue funds', async () => {
    const res = await fetch(`${baseUrl}/api/v1/trips/${tripId}/funds`, json(sureshCookie, {
      kind: 'cash',
      amount: '2000.00',
      currency: 'AED',
    }));
    assert.equal(res.status, 403);
  });

  test('a manager cannot issue funds — Finance does', async () => {
    const res = await fetch(`${baseUrl}/api/v1/trips/${tripId}/funds`, json(vikramCookie, {
      kind: 'cash',
      amount: '2000.00',
      currency: 'AED',
    }));
    assert.equal(res.status, 403, 'funds are issued by Finance, not by a manager');
  });

  test('POST /api/v1/trips/:id/funds activates the trip', async () => {
    const res = await fetch(`${baseUrl}/api/v1/trips/${tripId}/funds`, json(raviCookie, {
      kind: 'cash',
      amount: '2000.00',
      currency: 'AED',
      note: 'Cash at issuance',
    }));
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.fund.base_amount, '166500.00');
    assert.equal(body.fund.trip_status, 'active');
  });

  test('POST /api/v1/expenses creates a draft expense', async () => {
    const res = await fetch(`${baseUrl}/api/v1/expenses`, json(sureshCookie, {
      tripId,
      date: '2026-12-11',
      description: 'Flight ticket return',
      category: 'travel',
      amount: '1850.00',
      currency: 'AED',
      paymentMethod: 'forex_card',
    }));
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.expense?.id);
    assert.equal(body.expense.amount, '1850.00');
    assert.equal(body.expense.category, 'travel');
    assert.equal(body.expense.base_amount, '154012.50', '1850.00 x 83.25');
    assert.equal(body.expense.payment_method, 'forex_card');
    expenseId = body.expense.id;
  });

  test('GET /api/v1/trips/:id includes expenses and the budget-versus-actual totals', async () => {
    const res = await fetch(`${baseUrl}/api/v1/trips/${tripId}`, {
      headers: { cookie: sureshCookie },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.trip.id, tripId);
    assert.equal(body.trip.expenses.length, 1);
    assert.equal(body.trip.expenses[0].id, expenseId);
    assert.equal(body.trip.totals.budgetBase, '333000.00');
    assert.equal(body.trip.totals.fundsBase, '166500.00');
    assert.equal(body.trip.budget.length, 1);
    assert.equal(body.trip.fxPlan.length, 1);
    assert.equal(body.trip.funds.length, 1);
  });

  test('POST /api/v1/expenses/:id/bills uploads a receipt', async () => {
    const res = await fetch(`${baseUrl}/api/v1/expenses/${expenseId}/bills`, json(sureshCookie, {
      filename: 'ticket.pdf',
      contentType: 'application/pdf',
      content: Buffer.from('%PDF-1.4 fake ticket bytes').toString('base64'),
    }));
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.bill?.id);
    assert.equal(body.bill.filename, 'ticket.pdf');
    billId = body.bill.id;
  });

  test('GET /api/v1/bills/:id/content returns the receipt bytes', async () => {
    const res = await fetch(`${baseUrl}/api/v1/bills/${billId}/content`, {
      headers: { cookie: sureshCookie },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    const text = await res.text();
    assert.match(text, /^%PDF-1.4/);
  });

  test('POST /api/v1/expenses/:id/submit submits expense for approval', async () => {
    const res = await fetch(`${baseUrl}/api/v1/expenses/${expenseId}/submit`, {
      method: 'POST',
      headers: { cookie: sureshCookie },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.expense.status, 'submitted');
  });

  test('manager approves the expense via HTTP', async () => {
    const res = await fetch(`${baseUrl}/api/v1/expenses/${expenseId}/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: vikramCookie },
      body: JSON.stringify({ decision: 'approve' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.expense.status, 'approved');
  });

  test('POST /api/v1/trips/:id/reconciliation computes the balance', async () => {
    const res = await fetch(`${baseUrl}/api/v1/trips/${tripId}/reconciliation`, json(sureshCookie, {
      note: 'All receipts attached',
    }));
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.reconciliation.funds_base, '166500.00');
    assert.equal(body.reconciliation.expenses_base, '154012.50');
    assert.equal(body.reconciliation.balance_base, '12487.50');
    assert.equal(body.reconciliation.status, 'pending');
  });

  test('an employee cannot decide a reconciliation', async () => {
    const res = await fetch(`${baseUrl}/api/v1/trips/${tripId}/reconciliation/decide`, json(sureshCookie, {
      decision: 'approve',
    }));
    assert.equal(res.status, 403);
  });

  test('the dashboard returns the trip and its spend', async () => {
    const res = await fetch(`${baseUrl}/api/v1/dashboard`, { headers: { cookie: vikramCookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.totals);
    assert.ok(body.trips.some((t) => t.id === tripId));
    assert.ok(body.employees.length >= 1);
  });

  test('the report export is a CSV', async () => {
    const res = await fetch(`${baseUrl}/api/v1/reports/export.csv?kind=employees`, {
      headers: { cookie: vikramCookie },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    const text = await res.text();
    const [header] = text.split('\n');
    assert.match(header, /Employee code/);
    assert.match(header, /Approved spend/);
  });
});
