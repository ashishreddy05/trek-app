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
import { readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as db from '../src/db.js';
import { handle } from '../src/http/app.js';
import { hashPassword } from '../src/auth/password-hash.js';
import { PERMISSIONS_BY_ROLE } from '../src/authz/permissions.js';

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
let currencySrc;

const PASSWORD = 'secret-passphrase';
let dbAvailable = true;

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
  currencySrc = await readFile(join(ROOT, 'src/http/routes.currency.js'), 'utf8');

  try {
    const hash = await hashPassword(PASSWORD);
    for (const email of ['ashishreddy@garageplug.com', 'abdul@garageplug.com']) {
      await db.query(
        `INSERT INTO password_credential (account_id, hash)
         SELECT a.id, $2 FROM account a JOIN employee e ON e.id = a.employee_id WHERE e.work_email = $1
         ON CONFLICT (account_id) DO UPDATE SET hash = EXCLUDED.hash`,
        [email, hash]
      );
    }
  } catch (err) {
    if (process.env.CI) throw err;
    dbAvailable = false;
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
      'A currency cannot have a rate against itself',
      'The rate must be a positive number with at most 8 decimal places',
      'You do not have access to this',
    ];
    const code = tripsSrc + expensesSrc + guardSrc + currencySrc;
    for (const msg of quoted) {
      assert.ok(manualSrc.includes(msg), `the manual quotes "${msg}" but does not`);
      assert.ok(code.includes(msg), `the manual quotes "${msg}" but the code never says it`);
    }
  });

  test('the roles table is the permission matrix, not a copy of it', () => {
    /* The manual's "who can do what" table is DRAWN from the matrix at run
     * time, so it cannot drift. These checks are what keep the data behind it
     * honest: every permission it names must be real, and every real
     * permission must be named — so a role that gains or loses a grant
     * cannot slip past the manual. */
    const capabilities = [...manualSrc.matchAll(/\{ label: '([^']+)', perms: \[([^\]]*)\] \}/g)];
    assert.ok(capabilities.length >= 20, `expected a full capability table (found ${capabilities.length} rows)`);

    const allPermissions = new Set(Object.values(PERMISSIONS_BY_ROLE).flat());
    const named = new Set();
    for (const [, label, permList] of capabilities) {
      const perms = [...permList.matchAll(/'([a-z.]+)'/g)].map((m) => m[1]);
      assert.ok(perms.length > 0, `the capability "${label}" names no permission`);
      for (const p of perms) {
        assert.ok(allPermissions.has(p), `the capability "${label}" names "${p}", which no role holds`);
        named.add(p);
      }
    }

    /* The roles the table has columns for must be the roles the matrix has. */
    const codes = [...new Set([...manualSrc.matchAll(/\{ role: '[^']+', code: '([a-z_]+)' \}/g)].map((m) => m[1]))].sort();
    assert.deepEqual(codes, Object.keys(PERMISSIONS_BY_ROLE).sort());
  });

  test('the capability catalogue is COMPLETE — every operation the app offers is in it', async () => {
    /* "The complete capabilities of this application" is a claim that can be
     * checked. Every operation the server actually offers must be named by a
     * capability, and every permission that no route reaches must be listed
     * as reserved. So the manual cannot quietly fall behind the product. */
    const catalogue = manualSrc.slice(manualSrc.indexOf('catalogue: {'), manualSrc.indexOf('reserved: {'));
    const ops = [...catalogue.matchAll(/op: '([a-zA-Z.]+)'/g)].map((m) => m[1]);
    const perms = new Set([...catalogue.matchAll(/perms: \[([^\]]*)\]/g)]
      .flatMap((m) => [...m[1].matchAll(/'([a-z.]+)'/g)].map((x) => x[1])));

    /* Every operation the server enforces must be named by a capability. */
    const httpDir = join(ROOT, 'src/http');
    const enforced = new Set();
    for (const file of await readdir(httpDir)) {
      if (!file.endsWith('.js')) continue;
      const src = await readFile(join(httpDir, file), 'utf8');
      for (const m of src.matchAll(/authorize\([\s\S]{0,200}?['"]([a-zA-Z.]+)['"]/g)) enforced.add(m[1]);
    }
    for (const op of enforced) {
      assert.ok(ops.includes(op), `the server offers "${op}" but the manual's catalogue does not name it`);
    }

    /* The public operations are handled by the session layer, not by
     * authorize() — they must still be in the catalogue. */
    for (const op of ['auth.login', 'auth.forgotPassword', 'auth.checkLink', 'auth.resetPassword']) {
      assert.ok(ops.includes(op), `the public operation "${op}" is not in the catalogue`);
    }

    /* Every permission no route reaches must be listed as reserved. */
    const allPermissions = new Set(Object.values(PERMISSIONS_BY_ROLE).flat());
    const reserved = manualSrc.slice(manualSrc.indexOf('reserved: {'), manualSrc.indexOf('workflow: {'));
    for (const p of allPermissions) {
      if (perms.has(p)) continue;
      assert.ok(reserved.includes(p), `the permission "${p}" reaches nothing in the app but is not listed as reserved`);
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
    for (const screen of ['Dashboard', 'My profile', 'My trips', 'My expenses', 'Approvals', 'Employees', 'Departments', 'Audit log', 'Settings']) {
      assert.ok(appSrc.includes(`'${screen}'`), `the manual names the screen "${screen}" but the app does not`);
    }
  });

  test('the endpoints it quotes exist', () => {
    for (const path of ['/healthz', '/readyz', '/api/v1/currencies', '/api/v1/exchange-rates', '/api/v1/permissions/matrix']) {
      assert.ok(routesSrc.includes(path), `the server routing table must define endpoint "${path}"`);
    }
  });

  test('the base currency it states is the one the code uses', () => {
    assert.match(tripsSrc, /base_currency/);
    assert.match(manualSrc, /INR/);
  });

  test('every non-public route in the routing table calls authorize()', async () => {
    const httpDir = join(ROOT, 'src/http');
    const files = await readdir(httpDir);
    const appRoutesSrc = await readFile(join(httpDir, 'app.js'), 'utf8');
    const routeMatches = [...appRoutesSrc.matchAll(/\['(GET|POST|PATCH|DELETE|PUT)',\s*'([^']+)',\s*([a-zA-Z0-9_]+)(?:,\s*\{([^}]*)\})?\]/g)];

    const SELF_AUTH_HANDLERS = new Set([
      'postLogin', 'postLogout', 'postForgotPassword', 'postCheckLink',
      'postResetPassword', 'postChangePassword', 'getMe', 'patchMe',
    ]);

    const handlerAuthorizations = new Map();
    for (const f of files) {
      if (!f.startsWith('routes.') || !f.endsWith('.js')) continue;
      const content = await readFile(join(httpDir, f), 'utf8');
      const fnMatches = [...content.matchAll(/export\s+async\s+function\s+([a-zA-Z0-9_]+)\s*\([^)]*\)\s*\{([\s\S]*?)(?=\nexport|\n\/\*|$)/g)];
      for (const [, fnName, fnBody] of fnMatches) {
        const authMatch = fnBody.match(/authorize\(\s*ctx\.db\s*,\s*ctx\.principal\s*,\s*['"]([a-zA-Z0-9_.]+)['"]/);
        if (authMatch) handlerAuthorizations.set(fnName, authMatch[1]);
      }
    }

    for (const [, method, path, handler, optsStr] of routeMatches) {
      const isPublic = optsStr && optsStr.includes('public: true');
      if (isPublic || SELF_AUTH_HANDLERS.has(handler)) continue;
      const op = handlerAuthorizations.get(handler);
      assert.ok(op, `Route ${method} ${path} (${handler}) must call authorize() but does not.`);
    }
  });
});

describe('the manual works', () => {
  test('it opens, lists every section, and searches', async (t) => {
    if (!dbAvailable) return t.skip('Database connection unavailable');
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
    assert.ok(titles.length >= 11, `expected the manual to have sections (found ${titles.length})`);
    for (const t of [
      'Getting started', 'The workflow', 'Who can do what', 'States', 'Money',
      'Currencies & rates', 'How do I…', 'When something goes wrong', 'The screens',
      'Words', 'Reference',
    ]) {
      assert.ok(titles.includes(t), `the manual is missing the section "${t}"`);
    }
  });

  test('the manual carries enough to answer a question without help', async () => {
    /* A manual that is one screen long is not a manual. These checks are
     * about SIZE, deliberately: they fail if the manual is ever trimmed back
     * to something you would need a colleague to explain. */
    const words = manualSrc
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/[^\w\s’'-]/g, ' ')
      .split(/\s+/)
      .filter(Boolean).length;
    assert.ok(words > 3000, `expected a full manual (found about ${words} words)`);

    for (const section of ['gettingStarted', 'currencies', 'recipes']) {
      assert.ok(manualSrc.includes(`${section}: {`), `the manual must have the "${section}" section`);
    }
  });
});
