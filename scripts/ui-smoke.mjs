#!/usr/bin/env node
/* Render the real client against the real deployment, without a browser.
 *
 * public/app.js is plain DOM code, so it runs under a DOM implementation.
 * happy-dom is installed OUTSIDE this repository (it must not become a
 * dependency — the project is deliberately one-dependency), and is located via
 * TREK_UI_HARNESS.
 *
 * Every screen is rendered from live API responses and its HTML inspected, so
 * a screen that throws, or that renders an error, is caught.
 *
 *   node scripts/ui-smoke.mjs <base-url> [email] [password]
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/* happy-dom is deliberately NOT a dependency of this project — it is one
 * dependency (pg) by design, and a UI harness is not worth a permanent one.
 * Install it wherever you like and point TREK_UI_HARNESS at it:
 *
 *   mkdir -p /tmp/trek-ui-harness && cd /tmp/trek-ui-harness
 *   npm install happy-dom
 *   TREK_UI_HARNESS=/tmp/trek-ui-harness node scripts/ui-smoke.mjs <url> <email> <password>
 */
const HARNESS = process.env.TREK_UI_HARNESS ?? '/tmp/trek-ui-harness';
let Window;
try {
  ({ Window } = require(HARNESS + '/node_modules/happy-dom/lib/index.js'));
} catch {
  console.log('Skipped: happy-dom not found. Install it and set TREK_UI_HARNESS to run the UI harness.');
  process.exit(0);
}

const BASE = process.argv[2] ?? 'https://trek-app-beta.vercel.app';
const EMAIL = process.argv[3];
const PASSWORD = process.argv[4];

/* -------------------------------------------------------------- the DOM */

const win = new Window({ url: BASE + '/' });
const doc = win.document;

/* fetch is proxied so the harness can see what the client asked for, and so a
 * real session cookie can be attached after logging in. */
const calls = [];
let cookie = '';
const realFetch = globalThis.fetch;

async function appFetch(url, opts = {}) {
  const full = url.startsWith('http') ? url : BASE + url;
  calls.push({ method: opts.method || 'GET', url: full.replace(BASE, '') });
  const headers = { ...(opts.headers || {}) };
  if (cookie) headers.cookie = cookie;
  const res = await realFetch(full, { ...opts, headers });
  /* Capture the session cookie the way a browser would keep it. */
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return res;
}
globalThis.fetch = appFetch;
win.fetch = appFetch;

/* The client mounts into #root and toasts into #toasts — both come from the
 * real index.html, so load that rather than inventing a skeleton. */
const indexHtml = await (await realFetch(BASE + '/index.html')).text();
doc.write(indexHtml);
await new Promise((r) => setTimeout(r, 50));

/* ---------------------------------------------------------- app.js runner */

/* The manual is a separate classic script, loaded before app.js — the same
 * order index.html uses. Both run in ONE shared scope, exactly as the browser
 * does: they are classic <script> tags sharing the global scope, so manual.js
 * can call el() and esc() from app.js. Separating them here would break that
 * and hide real bugs.
 *
 * The client is fetched from the deployment by default, so what is checked is
 * what is actually being served. TREK_UI_LOCAL=1 checks the working copy
 * instead, for verifying a fix before it is deployed. */
const LOCAL = process.env.TREK_UI_LOCAL === '1';
const readClient = async (path) => {
  if (!LOCAL) return (await realFetch(BASE + path)).text();
  const { readFile } = await import('node:fs/promises');
  return readFile(new URL('../public/' + path.replace(/^\//, ''), import.meta.url), 'utf8');
};

const manualSrc = await readClient('/manual.js');
const appSrc = await readClient('/app.js');

/* The client is a classic script: top-level functions plus a boot() IIFE.
 * Run it in a scope of its own and hand back the pieces the harness needs. */
const H = new Function('document', 'window', 'location', 'fetch', 'setTimeout', `
  ${manualSrc}
  ${appSrc}
  return { renderLogin, renderApp, api, setRoute: (r) => { route = r; } };
`)(doc, win, win.location, appFetch, setTimeout);

/* ------------------------------------------------------------- helpers */

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? '✔' : '✖'} ${name}${detail ? '  — ' + detail : ''}`);
}
const settle = () => new Promise((r) => setTimeout(r, 700));
const bodyText = () => doc.body.textContent.replace(/\s+/g, ' ').trim();

/* ------------------------------------------------------------------ run */

console.log(`\nRendering the live client against ${BASE}\n`);

/* 1. The login screen. */
H.renderLogin();
await settle();
const loginText = bodyText();
check('login screen renders', /Sign in/i.test(loginText), loginText.slice(0, 70));

/* 1b. The forgot-password flow, from the login screen. */
const forgotBtn = doc.querySelector('[data-forgot]');
check('login screen offers "Forgot password?"', !!forgotBtn);
if (forgotBtn) {
  forgotBtn.click();
  await settle();
  const forgotText = bodyText();
  check('forgot-password screen renders', /Reset your password/i.test(forgotText), forgotText.slice(0, 70));
  const back = doc.querySelector('[data-back]');
  if (back) {
    back.click();
    await settle();
    check('back returns to sign in', /Sign in/i.test(bodyText()));
  }
}

/* 2. Sign in through the client's own form — the same path a person takes,
 * so the session cookie is set the way the browser would set it. */
if (EMAIL) {
  const emailEl = doc.querySelector('#email');
  const pwEl = doc.querySelector('#password');
  const form = doc.querySelector('form');
  emailEl.value = EMAIL;
  pwEl.value = PASSWORD;

  form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  for (let i = 0; i < 20 && doc.querySelector('#email'); i++) await settle();

  const signedIn = !doc.querySelector('#email');
  check('sign in through the form', signedIn, signedIn ? EMAIL : bodyText().slice(0, 90));

  if (signedIn) {
    /* 3. Every screen the client offers THIS role. The nav is
     * permission-driven, so a manager has no Employees screen and a traveller
     * has no Dashboard — those are correct absences, not failures. What must
     * hold is that every screen offered renders, and that the ones a role
     * should have are actually there. */
    const roleExpect = JSON.parse(process.env.TREK_UI_EXPECT ?? '{}');
    const navLabels = ['Employees', 'Departments', 'Dashboard', 'My trips', 'My expenses', 'Approvals', 'Audit log', 'My profile'];
    for (const label of navLabels) {
      const before = calls.length;
      const btn = [...doc.querySelectorAll('.nav-item')].find((b) => b.textContent.trim() === label);
      const expected = roleExpect[label];
      if (!btn) {
        /* Absent. Only a failure if this role was supposed to have it. */
        check(`nav "${label}" ${expected === false ? 'absent (correct)' : 'present'}`,
          expected === false, 'not offered');
        continue;
      }
      btn.click();
      await settle();
      await settle();
      const text = bodyText();
      const apiCalls = calls.slice(before).map((c) => c.method + ' ' + c.url);
      const errored = /Couldn't load|Something went wrong/i.test(text);
      check(
        `screen "${label}" renders`,
        text.length > 30 && !errored,
        `${apiCalls.length} call(s): ${apiCalls.slice(0, 2).join(', ')}`
      );
      const at = text.indexOf(label);
      console.log('      ' + text.slice(at, at + 240));
    }

    /* 4. The manual panel — the icon the user asked for. */
    const manualBtn = doc.querySelector('[data-manual]');
    check('manual button exists in the shell', !!manualBtn);
    if (manualBtn) {
      manualBtn.click();
      await settle();
      const manualText = bodyText();
      check('manual opens', /Trek manual/i.test(manualText), manualText.slice(0, 70));
      const navItems = doc.querySelectorAll('.man-nav-item').length;
      check('manual lists all sections', navItems === 8, `${navItems} nav items`);

      /* Every section must actually render its own content. */
      const sections = ['workflow', 'roles', 'states', 'money', 'troubleshooting', 'screens', 'glossary', 'reference'];
      for (const s of sections) {
        const before = bodyText().length;
        const item = [...doc.querySelectorAll('.man-nav-item')].find((b) => b.dataset.manGo === s);
        if (!item) { check(`manual section "${s}" has a nav item`, false); continue; }
        item.click();
        await settle();
        const len = doc.querySelector('.man-content')?.textContent?.length ?? 0;
        check(`manual section "${s}" renders`, len > 50, `${len} chars`);
      }

      /* The manual must be searchable. */
      const search = doc.querySelector('[data-man-search]');
      if (search) {
        search.value = 'reconcil';
        search.dispatchEvent(new win.Event('input', { bubbles: true }));
        await settle();
        const hits = doc.querySelector('.man-content')?.textContent ?? '';
        check('manual search finds results', /result/i.test(hits), hits.slice(0, 60).replace(/\s+/g, ' '));
      }
    }

    /* 5. Write through the UI: create a trip with the form, the way a person
     * does. This is the only way to know the form posts what the API wants. */
    if (process.env.TREK_UI_WRITE === '1') {
      /* Go to My trips first — that is where the button lives. */
      const tripsBtn = [...doc.querySelectorAll('.nav-item')].find((b) => b.textContent.trim() === 'My trips');
      tripsBtn?.click();
      await settle();
      await settle();

      const newTrip = [...doc.querySelectorAll('button')].find((b) => b.textContent.includes('New trip'));
      check('trips screen offers "New trip"', !!newTrip);
      if (newTrip) {
        newTrip.click();
        await settle();
        const form = doc.querySelector('.modal form') ?? doc.querySelector('form');
        const set = (name, v) => {
          const f = form.querySelector(`[name="${name}"]`);
          if (!f) return false;
          f.value = v;
          f.dispatchEvent(new win.Event('input', { bubbles: true }));
          return true;
        };
        const ok = set('destination', 'UI Harness Check')
          && set('purpose', 'Verifying the form posts correctly')
          && set('startDate', '2026-12-01')
          && set('endDate', '2026-12-03');
        check('trip form has the expected fields', ok);
        const before = calls.length;
        /* The modal saves on the button, not on form submit. */
        const saveBtn = form.closest('.modal, .scrim')?.querySelector('[data-save]')
          ?? doc.querySelector('[data-save]');
        if (saveBtn) saveBtn.click();
        else form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
        await settle();
        await settle();
        const posts = calls.slice(before).filter((c) => c.method === 'POST');
        check('submitting the trip form posts it', posts.length === 1,
          posts[0] ? posts[0].url + ' ' + String(posts[0].body).slice(0, 140) : 'no POST');
        const text = bodyText();
        check('the new trip appears in the list', /UI Harness Check/.test(text));
        const at = text.indexOf('UI Harness Check');
        if (at > -1) console.log('      ' + text.slice(Math.max(0, at - 60), at + 160));
      }
    }
  }
}

console.log(`\n${results.filter((r) => !r.ok).length} failed of ${results.length}\n`);
process.exit(results.some((r) => !r.ok) ? 1 : 0);
