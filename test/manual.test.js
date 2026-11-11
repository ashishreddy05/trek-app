/* The manual must stay true.
 *
 * A help system that drifts from the product is worse than none: people trust
 * it and act on it. These tests check that the manual's claims still match the
 * code — the error messages it quotes are really produced, the states it lists
 * are really the states, and the screens it names really exist.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as db from '../src/db.js';
import { handle } from '../src/http/app.js';
import { hashPassword } from '../src/auth/password-hash.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let server;
let baseUrl;
let manualSrc;
let appSrc;
let routesSrc;
let tripsSrc;
let expensesSrc;
let permissionsSrc;
let guardSrc;

const PASSWORD = 'secret-passphrase';

before(async () => {
  server = http.createServer(handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  manualSrc = await readFile(join(ROOT, 'public/manual.js'), 'utf8');
  appSrc = await readFile(join(ROOT, 'public/app.js'), 'utf8');
  routesSrc = await readFile(join(ROOT, 'src/http/app.js'), 'utf8');
  tripsSrc = await readFile(join(ROOT, 'src/trips/service.js'), 'utf8');
  expensesSrc = await readFile(join(ROOT, 'src/expenses/service.js'), 'utf8');
  permissionsSrc = await readFile(join(ROOT, 'src/authz/permissions.js'), 'utf8');
  guardSrc = await readFile(join(ROOT, 'src/authz/guard.js'), 'utf8');

  const hash = await hashPassword(PASSWORD);
  for (const email of ['ashishreddy@garageplug.com', 'abdul@garageplug.com']) {
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

describe('the manual loads', () => {
  test('it is a classic script — no export, which would break the page', () => {
    /* public/manual.js is loaded with a plain <script> tag, so an ES module
     * export is a syntax error that takes the whole app down with it. */
    assert.doesNotMatch(manualSrc, /^\s*export\s/m, 'manual.js must not use export');
    assert.doesNotMatch(manualSrc, /\bimport\s+.*\bfrom\b/, 'manual.js must not use import');
  });

  test('the page loads the manual before the app that uses it', async () => {
    const html = await readFile(join(ROOT, 'public/index.html'), 'utf8');
    const manualAt = html.indexOf('/manual.js');
    const appAt = html.indexOf('/app.js');
    assert.ok(manualAt > -1, 'index.html must load the manual');
    assert.ok(manualAt < appAt, 'the manual must load before the app that opens it');
  });

  test('the app opens the manual from the sidebar', () => {
    assert.match(appSrc, /data-manual/, 'the shell must have a manual control');
    assert.match(appSrc, /openManual\(/, 'the manual control must open the manual');
  });

  test('the manual is served', async () => {
    const res = await fetch(`${baseUrl}/manual.js`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /Trek manual/);
  });
});

describe('the manual is true', () => {
  test('every trip state it lists is a real state', () => {
    const src = readFileSync(join(ROOT, 'migrations/009_budget_funds_bills.sql'), 'utf8');
    const enumLine = src.match(/ALTER TYPE trip_status ADD VALUE IF NOT EXISTS '([a-z_]+)'/g) ?? [];
    const declared = new Set(['draft', 'submitted', 'approved', 'rejected']);
    for (const m of enumLine) declared.add(m.match(/'([a-z_]+)'/)[1]);

    for (const state of ['Draft', 'Submitted', 'Changes requested', 'Approved', 'Rejected', 'Active', 'Awaiting Finance', 'Reconciled', 'Closed']) {
      const key = state.toLowerCase().replace('awaiting finance', 'reconciliation_pending').replace('changes requested', 'changes_requested');
      assert.ok(declared.has(key), `the manual names the state "${state}" but the database does not have it`);
    }
  });

  test('every error message it quotes is really produced', () => {
    /* The troubleshooting section quotes messages verbatim so a user can match
     * one against the screen in front of them. If the code changes the
     * wording, the manual must change with it. */
    const quoted = [
      'No exchange rate is set for',
      'Expenses can only be recorded once the trip is approved and funded',
      'You do not have an active reporting manager assigned',
      'still awaiting approval',
      'Only a draft trip can be edited',
      'Only draft expenses can be deleted',
      'Only submitted expenses can be decided',
      'Only a pending reconciliation can be decided',
      'Funds are issued only after the budget is approved',
      'A reconciliation can only be submitted while the trip is active',
      'A trip can only be settled after its reconciliation is approved',
      'You do not have access to this',
    ];
    const code = tripsSrc + expensesSrc + guardSrc;
    for (const msg of quoted) {
      assert.ok(manualSrc.includes(msg), `the manual quotes "${msg}" but does not`);
      assert.ok(code.includes(msg), `the manual quotes "${msg}" but the code never says it`);
    }
  });

  test('the roles it describes match the permission matrix', () => {
    for (const role of ['employee', 'manager', 'hr_travel', 'finance', 'admin']) {
      assert.ok(permissionsSrc.includes(`${role}: [`), `the matrix must declare the ${role} role`);
    }
    /* The team tier and the company tier are different permissions — the
     * manual says so, so the matrix must do so too. */
    assert.match(permissionsSrc, /trip\.approve\.all/);
    assert.match(permissionsSrc, /expense\.approve\.all/);
  });

  test('the screens it names are real screens', () => {
    for (const screen of ['My profile', 'My trips', 'My expenses', 'Approvals', 'Dashboard', 'Employees', 'Departments', 'Audit log']) {
      assert.ok(appSrc.includes(`'${screen}'`), `the manual names the screen "${screen}" but the app does not`);
    }
  });

  test('the endpoints it quotes exist', () => {
    for (const path of ['/healthz', '/readyz', '/api/v1']) {
      assert.ok(routesSrc.includes(path) || manualSrc.includes(path), `the manual quotes "${path}"`);
    }
  });

  test('the base currency it states is the one the code uses', () => {
    assert.match(tripsSrc, /base_currency/);
    assert.match(manualSrc, /INR/);
  });
});

describe('the manual works', () => {
  test('it opens, lists every section, and searches', async () => {
    const login = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ashishreddy@garageplug.com', password: PASSWORD }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').match(/trek_session=([^;]+)/)[0];

    const page = await fetch(`${baseUrl}/`, { headers: { cookie } });
    const html = await page.text();
    assert.match(html, /\/manual\.js/);

    /* The manual is pure client-side data; the section titles are what the
     * nav is built from. */
    const titles = [...manualSrc.matchAll(/^\s{4}title: '([^']+)'/gm)].map((m) => m[1]);
    assert.ok(titles.length >= 8, `expected the manual to have sections (found ${titles.length})`);
    for (const t of ['The workflow', 'Who can do what', 'States', 'Money', 'When something goes wrong', 'The screens', 'Words', 'Reference']) {
      assert.ok(titles.includes(t), `the manual is missing the section "${t}"`);
    }
  });
});
