/* HTTP Route Integration Tests for Trips and Expenses.
 * Uses http.createServer(handle) on ephemeral port and tests real HTTP fetch requests.
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

  // Ensure Suresh and Vikram have password credentials
  const hash = await hashPassword(PASSWORD);
  for (const email of ['suresh.kumar@garageplug.com', 'vikram.shetty@garageplug.com', 'nadia.haddad@garageplug.com']) {
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

describe('HTTP API End-to-End: Trips & Expenses', () => {
  let sureshCookie;
  let vikramCookie;
  let nadiaCookie;
  let tripId;
  let expenseId;

  test('sign in users and obtain session cookies', async () => {
    sureshCookie = await loginAs('suresh.kumar@garageplug.com');
    vikramCookie = await loginAs('vikram.shetty@garageplug.com');
    nadiaCookie = await loginAs('nadia.haddad@garageplug.com');
  });

  test('POST /api/v1/trips creates a draft trip', async () => {
    const res = await fetch(`${baseUrl}/api/v1/trips`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: sureshCookie,
      },
      body: JSON.stringify({
        destination: 'Doha, Qatar',
        purpose: 'GCC Partnership summit',
        startDate: '2026-12-10',
        endDate: '2026-12-14',
      }),
    });

    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.trip?.id);
    assert.equal(body.trip.destination, 'Doha, Qatar');
    assert.equal(body.trip.status, 'draft');
    tripId = body.trip.id;
  });

  test('GET /api/v1/trips returns user trips', async () => {
    const res = await fetch(`${baseUrl}/api/v1/trips?scope=own`, {
      headers: { cookie: sureshCookie },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.data));
    assert.ok(body.data.some((t) => t.id === tripId));
  });

  test('PATCH /api/v1/trips/:id updates draft trip', async () => {
    const res = await fetch(`${baseUrl}/api/v1/trips/${tripId}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        cookie: sureshCookie,
      },
      body: JSON.stringify({
        destination: 'Doha & Lusail, Qatar',
        purpose: 'GCC Partnership summit and keynote',
        startDate: '2026-12-10',
        endDate: '2026-12-15',
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.trip.destination, 'Doha & Lusail, Qatar');
  });

  test('POST /api/v1/expenses creates a draft expense', async () => {
    const res = await fetch(`${baseUrl}/api/v1/expenses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: sureshCookie,
      },
      body: JSON.stringify({
        tripId,
        date: '2026-12-11',
        description: 'Flight ticket return',
        category: 'airfare',
        amount: '1850.00',
        currency: 'SAR',
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.expense?.id);
    assert.equal(body.expense.amount, '1850.00');
    assert.equal(body.expense.category, 'airfare');
    expenseId = body.expense.id;
  });

  test('GET /api/v1/trips/:id includes expenses', async () => {
    const res = await fetch(`${baseUrl}/api/v1/trips/${tripId}`, {
      headers: { cookie: sureshCookie },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.trip.id, tripId);
    assert.ok(Array.isArray(body.trip.expenses));
    assert.equal(body.trip.expenses.length, 1);
    assert.equal(body.trip.expenses[0].id, expenseId);
  });

  test('unauthorized user cannot read trip (404 opaque on deny)', async () => {
    const res = await fetch(`${baseUrl}/api/v1/trips/${tripId}`, {
      headers: { cookie: nadiaCookie },
    });
    assert.equal(res.status, 404);
  });

  test('POST /api/v1/trips/:id/submit submits trip for approval', async () => {
    const res = await fetch(`${baseUrl}/api/v1/trips/${tripId}/submit`, {
      method: 'POST',
      headers: { cookie: sureshCookie },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.trip.status, 'submitted');
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

  test('manager cannot decide with invalid payload (missing reason on reject)', async () => {
    const res = await fetch(`${baseUrl}/api/v1/trips/${tripId}/decide`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: vikramCookie,
      },
      body: JSON.stringify({ decision: 'reject', reason: '' }),
    });
    assert.equal(res.status, 422);
  });

  test('manager approves trip and expense via HTTP', async () => {
    const tripRes = await fetch(`${baseUrl}/api/v1/trips/${tripId}/decide`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: vikramCookie,
      },
      body: JSON.stringify({ decision: 'approve' }),
    });
    assert.equal(tripRes.status, 200);
    const tripBody = await tripRes.json();
    assert.equal(tripBody.trip.status, 'approved');

    const expRes = await fetch(`${baseUrl}/api/v1/expenses/${expenseId}/decide`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: vikramCookie,
      },
      body: JSON.stringify({ decision: 'approve' }),
    });
    assert.equal(expRes.status, 200);
    const expBody = await expRes.json();
    assert.equal(expBody.expense.status, 'approved');
  });

  test('editing an approved trip via HTTP returns 409 conflict', async () => {
    const res = await fetch(`${baseUrl}/api/v1/trips/${tripId}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        cookie: sureshCookie,
      },
      body: JSON.stringify({
        destination: 'New Destination',
        purpose: 'New purpose',
        startDate: '2026-12-10',
        endDate: '2026-12-15',
      }),
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error.code, 'invalid_transition');
  });
});
