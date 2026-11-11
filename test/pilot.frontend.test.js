/* The pilot workflow, from the outside.
 *
 * These are the checks that a unit test cannot make: the browser's cache
 * headers, the routes the frontend actually calls, and the permissions the
 * UI offers. Each one here was a real defect found by clicking through the
 * app rather than by reading it.
 */

import { test, after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as db from '../src/db.js';
import { handle, SECURITY_HEADERS } from '../src/http/app.js';
import { hashPassword } from '../src/auth/password-hash.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let server;
let baseUrl;
const PASSWORD = 'secret-passphrase';

before(async () => {
  server = http.createServer(handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const hash = await hashPassword(PASSWORD);
  for (const email of [
    'test.traveller.one@garageplug.test',
    'test.manager@garageplug.test',
    'test.traveller.two@garageplug.test',
    'test.finance@garageplug.test',
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
  const match = res.headers.get('set-cookie').match(/trek_session=([^;]+)/);
  assert.ok(match);
  return match[0];
}

describe('static assets', () => {
  test('the app script is not cached — a stale script outlives its deploy', async () => {
    /* app.js and styles.css are not fingerprinted. If they were cached, a
     * browser would run yesterday's JavaScript against today's API, which is
     * exactly the "it works on my machine" failure this whole app is meant
     * to avoid. */
    for (const path of ['/app.js', '/styles.css']) {
      const res = await fetch(`${baseUrl}${path}`);
      assert.equal(res.status, 200, `${path} must be served`);
      const cache = res.headers.get('cache-control') ?? '';
      assert.match(cache, /no-cache/, `${path} must not be cached (got "${cache}")`);
    }
  });

  test('the HTML shell is served with the security headers', async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });

  test('the HTML does not pin a cache-busting query that is never bumped', async () => {
    /* A manual "?v=2" is forgotten at the next deploy; the header above is
     * what actually keeps the browser honest. */
    const html = await readFile(join(ROOT, 'public/index.html'), 'utf8');
    assert.doesNotMatch(html, /app\.js\?v=\d/, 'app.js must not carry a manual version query');
    assert.doesNotMatch(html, /styles\.css\?v=\d/, 'styles.css must not carry a manual version query');
  });

  test('the frontend references only routes that exist', async () => {
    const app = await readFile(join(ROOT, 'public/app.js'), 'utf8');
    const routes = await readFile(join(ROOT, 'src/http/app.js'), 'utf8');

    /* Every API path the client calls must be registered in the server's
     * routing table, or the button silently does nothing. The client calls
     * paths relative to /api/v1, quoted with ' " or a backtick — hence the hex
     * escapes rather than a literal backtick in the pattern. */
    const called = new Set();
    const CALL = /api\.(?:get|post|patch|put|del|delete)\(\s*['"\x60](\/[^'"\x60?]*)/g;
    for (const m of app.matchAll(CALL)) called.add(m[1]);

    assert.ok(called.size > 10, `expected the client to call the API (found ${called.size})`);

    /* The server's routing table, with each parameter collapsed to a single
     * placeholder so the two sides can be compared by SHAPE. The client's
     * "${trip.id}" and the server's ":id" are the same segment. */
    const shape = (p) => `/${p}`
      .replace(/\$\{q\}$/, '')            /* a query string, not a segment */
      .replace(/\$\{[^}]+\}/g, ':x')
      .replace(/\/:[A-Za-z_]+/g, '/:x')
      .replace(/\?.*$/, '');

    const serverRoutes = new Set(
      [...routes.matchAll(/'((?:\/:[A-Za-z_]+|\/)[^']*)'/g)]
        .map((m) => shape(m[1]))
    );

    for (const path of called) {
      const literal = shape(`/api/v1${path}`);
      assert.ok(
        serverRoutes.has(literal),
        `the client calls ${path} but the server has no such route`
      );
    }
  });
});

describe('the permissions the UI offers', () => {
  let travellerOneCookie;
  let financeCookie;

  before(async () => {
    travellerOneCookie = await loginAs('test.traveller.one@garageplug.test');
    financeCookie = await loginAs('test.finance@garageplug.test');
  });

  test('Finance can read every trip — approving a budget needs to see it', async () => {
    const res = await fetch(`${baseUrl}/api/v1/trips?scope=all`, { headers: { cookie: financeCookie } });
    assert.equal(res.status, 200, 'Finance must be able to read company trips');
    const body = await res.json();
    assert.ok(Array.isArray(body.data));
  });

  test('an employee still cannot read every trip', async () => {
    const res = await fetch(`${baseUrl}/api/v1/trips?scope=all`, { headers: { cookie: travellerOneCookie } });
    assert.equal(res.status, 403, 'an employee must not get company-wide trips');
  });

  test('a collection read needs no explicit scope', async () => {
    for (const path of ['/api/v1/trips', '/api/v1/expenses', '/api/v1/departments', '/api/v1/cost-centers']) {
      const res = await fetch(`${baseUrl}${path}`, { headers: { cookie: travellerOneCookie } });
      assert.equal(res.status, 200, `${path} must not require an explicit ?scope=`);
    }
  });
});
