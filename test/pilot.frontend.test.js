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

  try {
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
  } catch {
    /* database offline or unreachable */
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

  test('the client carries no inline styles', async () => {
    /* Every value in the interface lives in a class — a utility named after
     * its CarbonCN token. An inline style is a value that bypasses the design
     * system, and the Content-Security-Policy now refuses them
     * (`style-src-attr 'none'`), so the browser would drop them and the page
     * would quietly lose its layout. This keeps the client and the header in
     * agreement. */
    for (const file of ['app.js', 'manual.js', 'index.html']) {
      const src = await readFile(join(ROOT, 'public', file), 'utf8');
      const found = src.match(/style\s*=\s*"/g) ?? [];
      assert.equal(found.length, 0, `public/${file} must not carry inline styles`);
    }
  });

  test('every class the client uses is defined in the stylesheet', async () => {
    /* A class that does not exist is not an error — the browser drops the
     * declaration and the element quietly looks wrong. `.font-mono` and
     * `.py-carbon-02` both shipped that way. This finds them at build time
     * instead of in a screenshot. */
    const css = await readFile(join(ROOT, 'public/styles.css'), 'utf8');
    const defined = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)\s*(?=[,{:])/g)].map((m) => m[1]));

    for (const file of ['app.js', 'manual.js']) {
      const src = await readFile(join(ROOT, 'public', file), 'utf8');
      const used = new Set();
      for (const m of src.matchAll(/class="([^"]*)"/g)) {
        for (const c of m[1].split()) {
          /* Skip template-literal fragments — they are not class names. */
          if (/^[a-zA-Z][\w-]*$/.test(c)) used.add(c);
        }
      }
      for (const c of used) {
        assert.ok(defined.has(c), `public/${file} uses "${c}", which the stylesheet does not define`);
      }
    }
  });

  test('the stylesheet follows the Carbon rules', async () => {
    const css = await readFile(join(ROOT, 'public/styles.css'), 'utf8');

    /* No rounded corners. Carbon has no radius. */
    for (const m of css.matchAll(/border-radius:\s*([^;]+);/g)) {
      assert.ok(
        ['0', '0px', 'var(--radius)', 'var(--radius-full)', '50%'].includes(m[1].trim()),
        `border-radius: ${m[1]} — Carbon has no rounded corners`
      );
    }

    /* Every colour is a Carbon token — no one-off hex or rgba in a rule. */
    const defined = new Set([...css.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]));
    for (const m of css.matchAll(/var\((--[a-z0-9-]+)\)/g)) {
      assert.ok(defined.has(m[1]), `${m[1]} is used but never defined`);
    }
    const bodyCss = css.replace(/:root\s*\{[^}]*\}/s, '');
    const rawHex = bodyCss.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    assert.equal(rawHex.length, 0, `One-off hex found outside :root: ${rawHex.join(', ')}`);

    /* Every spacing utility is on Carbon's 8px scale. */
    for (const m of css.matchAll(/\.(?:p|m|gap)[a-z0-9-]*carbon-(\d\d)\b/g)) {
      assert.ok(Number(m[1]) >= 1 && Number(m[1]) <= 10, `carbon-${m[1]} is not on the scale`);
    }
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
