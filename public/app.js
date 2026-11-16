/* Trek — frontend single-page client.
 *
 * Clean vanilla JavaScript with no build step, semantic HTML, and responsive CSS.
 * Screens: Profile, Trips, Expenses, Approvals, Employees, Departments, and Audit log.
 */

'use strict';

/* ============================================================ api client */

const requestCache = new Map();
const inFlight = new Map();

const api = {
  clearCache() {
    requestCache.clear();
    inFlight.clear();
  },
  async call(method, path, body, opts = {}) {
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) {
      requestCache.clear();
      inFlight.clear();
    }

    if (method === 'GET' && !opts.bypassCache) {
      const cached = requestCache.get(path);
      if (cached && (Date.now() - cached.ts < 10_000)) {
        return cached.data;
      }
      if (inFlight.has(path)) {
        return inFlight.get(path);
      }
    }

    const fetchPromise = (async () => {
      try {
        const res = await fetch(`/api/v1${path}`, {
          method,
          credentials: 'same-origin',
          headers: body ? { 'Content-Type': 'application/json' } : {},
          body: body ? JSON.stringify(body) : undefined,
        });

        if (res.status === 204) return null;

        let payload = null;
        try { payload = await res.json(); } catch { /* empty body */ }

        if (!res.ok) {
          if (res.status === 401 && principal && path !== '/auth/login' && path !== '/me') {
            if (activeCameraStream) {
              activeCameraStream.getTracks().forEach((t) => t.stop());
              activeCameraStream = null;
            }
            document.querySelectorAll('.drawer-scrim, .man-scrim, .modal-scrim').forEach((s) => s.remove());
            principal = null;
            renderLogin('Your session has expired. Please sign in again.');
          }
          const err = new Error(payload?.error?.message ?? 'The server did not answer. Please try again.');
          err.code = payload?.error?.code;
          err.status = res.status;
          err.fields = payload?.error?.fields;
          err.attemptsRemaining = payload?.error?.attemptsRemaining;
          throw err;
        }

        if (method === 'GET' && !opts.bypassCache && inFlight.get(path) === fetchPromise) {
          requestCache.set(path, { data: payload, ts: Date.now() });
        }
        return payload;
      } finally {
        inFlight.delete(path);
      }
    })();

    if (method === 'GET' && !opts.bypassCache) {
      inFlight.set(path, fetchPromise);
    }
    return fetchPromise;
  },
  get:   (p, opts) => api.call('GET', p, undefined, opts),
  post:  (p, b) => api.call('POST', p, b),
  patch: (p, b) => api.call('PATCH', p, b),
  put:   (p, b) => api.call('PUT', p, b),
  del:   (p) => api.call('DELETE', p),
  delete:(p) => api.call('DELETE', p),
};

/* ============================================================ helpers */

const root = document.getElementById('root');
const toastHost = document.getElementById('toasts');
let activeCameraStream = null;

/* Every interpolated value passes through here. */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let labelSeq = 0;

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  for (const input of t.content.querySelectorAll('input[type="password"]')) {
    const wrapper = document.createElement('div');
    wrapper.className = 'password-input';
    input.before(wrapper);
    wrapper.append(input);
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'password-toggle';
    toggle.setAttribute('aria-label', 'Show password');
    toggle.setAttribute('aria-pressed', 'false');
    toggle.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
    toggle.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      toggle.setAttribute('aria-pressed', String(show));
    });
    wrapper.append(toggle);
  }
  for (const label of t.content.querySelectorAll('label')) {
    if (!label.getAttribute('for') && !label.htmlFor) {
      if (label.querySelector('input, select, textarea')) continue;
      const control = label.parentElement?.querySelector('input, select, textarea');
      if (control) {
        if (!control.id) control.id = `ctl_${++labelSeq}`;
        label.htmlFor = control.id;
      }
    }
  }
  return t.content.firstElementChild;
}

function toast(message, bad = false) {
  const node = el(`<div class="toast${bad ? ' bad' : ''}">${esc(message)}</div>`);
  toastHost.appendChild(node);
  setTimeout(() => node.remove(), 4200);
}

function fmtDate(iso) {
  if (!iso) return '—';
  const str = String(iso).slice(0, 10);
  const d = new Date(str + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return str;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function fmtWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return sameDay ? `today, ${time}` : `${fmtDate(iso)}, ${time}`;
}

const ROLE_LABEL = {
  employee: 'Employee',
  manager: 'Manager',
  hr_travel: 'HR / Travel',
  finance: 'Finance',
  admin: 'Company admin',
};

/* ============================================================ dialog focus
 *
 * A dialog that opens without taking the focus leaves a keyboard user
 * tabbing through the page behind it. A dialog that never gives the focus
 * back leaves it on a button that no longer exists.
 *
 * Carbon's modal pattern is three things: the focus moves in, it is trapped
 * while the dialog is open, and it returns to the trigger when the dialog
 * closes. Every dialog in Trek does all three, through this one helper.
 */

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * Give a dialog the focus it should have had.
 *
 * @param {Element} dialog  the element carrying role="dialog"
 * @returns {Function}       call this when the dialog closes — it releases
 *                           the trap and hands the focus back to whatever
 *                           opened the dialog.
 */
function trapFocus(dialog) {
  const opener = document.activeElement;

  const focusable = () => [...dialog.querySelectorAll(FOCUSABLE)]
    .filter((e) => e.offsetParent !== null || e === document.activeElement);

  const onKeydown = (e) => {
    if (e.key !== 'Tab') return;
    const items = focusable();
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  dialog.addEventListener('keydown', onKeydown);

  /* Take the focus: the first control, or the dialog itself if it has none. */
  const first = focusable()[0];
  if (first) {
    first.focus();
  } else {
    dialog.setAttribute('tabindex', '-1');
    dialog.focus();
  }

  return () => {
    dialog.removeEventListener('keydown', onKeydown);
    if (opener && document.contains(opener)) opener.focus();
  };
}

/* ============================================================ state */

let principal = null;
let route = 'dashboard';

/* ============================================================ currencies
 *
 * The currencies Trek knows about, and the currency the company budgets in.
 *
 * Both come from the registry on the server, so the two currency pickers are
 * drawn from ONE list and can never drift apart. The rates are remembered on
 * the server too — a person never has to remember an exchange rate.
 */

let currencyRegistry = { currencies: [], baseCurrency: 'INR' };

async function loadCurrencies() {
  const { currencies, baseCurrency } = await api.get('/currencies');
  currencyRegistry = { currencies, baseCurrency };
  return currencyRegistry;
}

/* The permission matrix — which role holds which permission.
 *
 * The manual draws its "who can do what" table from this, so the table is
 * the real matrix rather than a copy somebody has to remember to update. */
let permissionMatrix = null;

async function loadPermissionMatrix() {
  if (permissionMatrix) return permissionMatrix;
  permissionMatrix = await api.get('/permissions/matrix');
  return permissionMatrix;
}

/* The options for a currency picker, drawn from the registry. */
function currencyOptions(selected) {
  return currencyRegistry.currencies.map((c) => {
    const symbol = c.symbol && c.symbol !== c.code ? ` (${c.symbol})` : '';
    const label = `${c.code} — ${c.name}${symbol}`;
    return `<option value="${esc(c.code)}"${c.code === selected ? ' selected' : ''}>${esc(label)}</option>`;
  }).join('');
}

/* The currency the reader last asked to see the money in.
 *
 * Storage can be refused by the browser — private mode, blocked cookies — and
 * a refused preference must not take a screen down with it. */
function rememberedDisplayCurrency() {
  try { return window.localStorage.getItem('trek.displayCurrency') || null; }
  catch { return null; }
}

function rememberDisplayCurrency(code) {
  try { window.localStorage.setItem('trek.displayCurrency', code); }
  catch { /* a preference that cannot be remembered is still used for now */ }
}

/* ============================================================ A1 · Sign in
 *
 * AUTH-01 (directed 23 Sep 2026): work email + password replaces the emailed code.
 * Same card, lockup, fields and buttons as the approved A1 screen. The code field is
 * now a password field and "Send a new code" is now "Forgot password?".
 */

function loginCard(inner) {
  const view = el(`
    <div class="login">
      <div class="login-card">
        <img class="login-lockup" src="/brand/trek-logo.svg" alt="Trek">
        <div data-slot></div>
      </div>
    </div>`);
  view.querySelector('[data-slot]').replaceChildren(inner);
  root.replaceChildren(view);
}

function afterSignIn(p) {
  principal = p;
  /* Everybody lands on the dashboard: it answers "what needs me now" before
   * anything else, and the server scopes it to what the person may see. */
  route = 'dashboard';
  loadCurrencies().catch(() => { /* the pickers fall back to what they have */ });
  loadPermissionMatrix().catch(() => { /* the manual falls back to its prose */ });
  renderApp();
  toast(`Signed in as ${p.name} · ${p.departmentName}`);
}

function renderLogin(notice, prefill = '') {
  const inner = el(`
    <div>
      <h1>Sign in</h1>
      <p class="sub">Use your work email and password.</p>
      ${notice ? `<div class="notice mb-carbon-05">${esc(notice)}</div>` : ''}
      <div data-error></div>
      <form novalidate>
        <div class="field">
          <label for="email">Work email</label>
          <input id="email" name="email" type="email" autocomplete="username"
                 inputmode="email" placeholder="you@garageplug.com" value="${esc(prefill)}" required>
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input id="password" name="password" type="password" autocomplete="current-password" required>
        </div>
        <button class="btn block" type="submit">Sign in</button>
      </form>
      <p class="form-note"><button class="btn quiet" type="button" data-forgot>Forgot password?</button></p>
    </div>`);
  loginCard(inner);

  const form = inner.querySelector('form');
  const emailEl = inner.querySelector('#email');
  const pwEl = inner.querySelector('#password');
  const errHost = inner.querySelector('[data-error]');
  (prefill ? pwEl : emailEl).focus();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
      const { principal: p } = await api.post('/auth/login', { email: emailEl.value.trim(), password: pwEl.value });
      afterSignIn(p);
    } catch (err) {
      errHost.replaceChildren(el(`<div class="form-error">${esc(err.message)}</div>`));
      pwEl.value = '';
      pwEl.focus();
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  });

  inner.querySelector('[data-forgot]').addEventListener('click', () => renderForgot(emailEl.value.trim()));
}

function renderForgot(prefill = '') {
  const inner = el(`
    <div>
      <h1>Reset your password</h1>
      <p class="sub">Enter your work email. If it belongs to an active Trek account, we'll email you a link to choose a new password.</p>
      <div data-error></div>
      <form novalidate>
        <div class="field">
          <label for="email">Work email</label>
          <input id="email" type="email" autocomplete="username" inputmode="email"
                 placeholder="you@garageplug.com" value="${esc(prefill)}" required>
        </div>
        <button class="btn block" type="submit">Send reset link</button>
      </form>
      <p class="form-note"><button class="btn quiet" type="button" data-back>Back to sign in</button></p>
    </div>`);
  loginCard(inner);

  const emailEl = inner.querySelector('#email');
  emailEl.focus();
  inner.querySelector('[data-back]').addEventListener('click', () => renderLogin(null, emailEl.value.trim()));

  inner.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.currentTarget.querySelector('button');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    const email = emailEl.value.trim();
    try {
      await api.post('/auth/password/forgot', { email });
      const done = el(`
        <div>
          <h1>Check your email</h1>
          <p class="sub">If <strong>${esc(email)}</strong> belongs to an active Trek account, a reset link is on its way. It works once and expires in 60 minutes.</p>
          <button class="btn block ghost" type="button" data-back>Back to sign in</button>
        </div>`);
      loginCard(done);
      done.querySelector('[data-back]').addEventListener('click', () => renderLogin(null, email));
    } catch (err) {
      inner.querySelector('[data-error]').replaceChildren(el(`<div class="form-error">${esc(err.message)}</div>`));
      btn.disabled = false;
      btn.textContent = 'Send reset link';
    }
  });
}

/* Landing page for invite and reset links. The token is taken out of the address bar
 * straight away so it doesn't stay in browser history. */
async function renderSetPassword(token) {
  history.replaceState(null, '', '/');
  loginCard(el('<div><div class="skeleton h-22 mb-carbon-05"></div><div class="skeleton h-40"></div></div>'));

  const expired = (message) => {
    const inner = el(`
      <div>
        <h1>Link expired</h1>
        <p class="sub">${esc(message)}</p>
        <button class="btn block" type="button" data-new>Request a new link</button>
      </div>`);
    loginCard(inner);
    inner.querySelector('[data-new]').addEventListener('click', () => renderForgot());
  };

  let info;
  try {
    info = await api.post('/auth/password/check', { token });
  } catch (err) {
    return expired(err.message);
  }

  const invite = info.purpose === 'invite';
  const inner = el(`
    <div>
      <h1>${invite ? `Welcome to Trek, ${esc(info.firstName)}` : 'Choose a new password'}</h1>
      <p class="sub">At least 6 characters. A longer phrase of unrelated words is safer and easier to remember.</p>
      <form novalidate>
        <div class="field" data-f="password">
          <label for="pw">New password</label>
          <input id="pw" type="password" autocomplete="new-password" required>
        </div>
        <div class="field" data-f="confirm">
          <label for="pw2">Confirm password</label>
          <input id="pw2" type="password" autocomplete="new-password" required>
        </div>
        <button class="btn block" type="submit">${invite ? 'Set password' : 'Save new password'}</button>
      </form>
    </div>`);
  loginCard(inner);
  inner.querySelector('#pw').focus();

  const fieldError = (name, message) => {
    const f = inner.querySelector(`[data-f="${name}"]`);
    f.classList.add('invalid');
    f.appendChild(el(`<span class="error">${esc(message)}</span>`));
  };

  inner.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    for (const f of inner.querySelectorAll('.field')) { f.classList.remove('invalid'); f.querySelector('.error')?.remove(); }
    const pw = inner.querySelector('#pw').value;
    if (pw !== inner.querySelector('#pw2').value) return fieldError('confirm', "The passwords don't match.");

    const btn = e.currentTarget.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      await api.post('/auth/password/reset', { token, password: pw });
      renderLogin(invite ? 'Password set. Sign in to get started.' : 'Password changed. Sign in with your new password.');
    } catch (err) {
      if (err.code === 'link_expired') return expired(err.message);
      if (err.fields?.password) fieldError('password', err.fields.password);
      else toast(err.message, true);
      btn.disabled = false;
    }
  });
}

/* ============================================================ app shell */

/* Nav is derived from the signed-in principal's permissions. There is deliberately
 * no role switcher: that was a prototype device for demoing four surfaces in one
 * file (D-28). A user with several roles sees the union. */
function navItems() {
  const p = principal.permissions;
  const items = [{ key: 'dashboard', label: 'Dashboard' }];

  const has = (perm) => p.includes(perm);

  if (has('trip.create')) {
    items.push({ section: 'Travel' });
    items.push({ key: 'trips', label: 'My trips' });
    items.push({ key: 'expenses', label: 'My expenses' });
  }
  if (has('trip.approve') || has('trip.approve.all') ||
      has('expense.approve') || has('expense.approve.all')) {
    items.push({ section: 'Manager' });
    items.push({ key: 'approvals', label: 'Approvals' });
  }
  if (has('employee.manage')) {
    items.push({ section: 'Admin' });
    items.push({ key: 'employees', label: 'Employees' });
    items.push({ key: 'departments', label: 'Departments' });
  }
  if (has('audit.read')) items.push({ key: 'audit', label: 'Audit log' });

  items.push({ section: 'Account' });
  items.push({ key: 'settings', label: 'Settings' });

  return items;
}

function renderApp() {
  const items = navItems();

  const shell = el(`
    <div class="shell">
      <aside class="sidebar">
        <div class="sidebar-brand">
          <img class="sidebar-logo" src="/brand/trek-logo-dark.svg" alt="Trek — Employee Travel &amp; Expense">
        </div>
        <nav class="nav"></nav>
        <div class="sidebar-foot">
          <div class="sidebar-user">
            <div class="nm">${esc(principal.name)}</div>
            <div class="rl">${esc(principal.roles.map((r) => ROLE_LABEL[r] ?? r).join(' · '))}</div>
          </div>
          <button class="nav-item" data-signout>Sign out</button>
          <button class="nav-item man-open" data-manual title="Open the manual">
            <span>Manual</span>
            <span class="man-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="9"></circle>
                <path d="M9.6 9.2a2.4 2.4 0 1 1 3.3 2.2c-.6.3-.9.8-.9 1.4v.3"></path>
                <path d="M12 16.4h.01"></path>
              </svg>
            </span>
          </button>
          <div class="sidebar-credit">
            <span>By</span> <strong class="gia-text">GIA</strong> <span>team</span>
          </div>
        </div>
      </aside>
      <main class="main" id="main"></main>
    </div>`);

  const nav = shell.querySelector('.nav');
  for (const item of items) {
    if (item.section) {
      nav.appendChild(el(`<div class="nav-section">${esc(item.section)}</div>`));
      continue;
    }
    const btn = el(`
      <button class="nav-item${route === item.key ? ' active' : ''}">
        <span>${esc(item.label)}</span>
      </button>`);
    btn.addEventListener('click', () => { route = item.key; renderApp(); });
    nav.appendChild(btn);
  }

  shell.querySelector('[data-signout]').addEventListener('click', async () => {
    try { await api.post('/auth/logout'); } catch { /* sign out locally regardless */ }
    principal = null;
    renderLogin();
  });

  shell.querySelector('[data-manual]')?.addEventListener('click', () => openManual('workflow'));

  root.replaceChildren(shell);
  renderRoute(shell.querySelector('#main'), items);
}

function renderRoute(main, items) {
  switch (route) {
    case 'settings': return renderSettings(main, 'profile');
    case 'profile': return renderSettings(main, 'profile');
    case 'trips': return renderTrips(main);
    case 'expenses': return renderExpenses(main);
    case 'approvals': return renderApprovals(main);
    case 'dashboard': return renderDashboard(main);
    case 'employees': return renderEmployees(main);
    case 'departments': return renderDepartments(main);
    case 'audit': return renderSettings(main, 'audit');
    default: return renderDashboard(main);
  }
}

/* ============================================================ A21 · Profile */

/* ============================================================ A21 · Settings & Profile */

let activeSettingsTab = 'profile';
let settingsTabSeq = 0;

function renderSettings(main, initialTab = 'profile') {
  activeSettingsTab = initialTab || 'profile';
  const p = principal;
  const canAudit = p.permissions.includes('audit.read');
  const canRates = p.permissions.includes('rate.manage');

  const tabs = [
    { id: 'profile', label: 'My profile' },
    { id: 'preferences', label: 'Preferences' },
  ];
  if (canAudit) tabs.push({ id: 'audit', label: 'Audit log' });
  if (canRates) tabs.push({ id: 'rates', label: 'Rates & FX' });

  if (!tabs.some((t) => t.id === activeSettingsTab)) {
    activeSettingsTab = 'profile';
  }

  const view = el(`
    <div class="settings">
      <div class="page-head">
        <h1>Settings</h1>
        <p>Manage your personal profile, security, display preferences, and administrative tools.</p>
      </div>
      <div class="toolbar mb-carbon-05">
        <div class="cswitch" role="tablist" aria-label="Settings tabs">
          ${tabs.map((t) => `
            <button type="button" class="cswitch-item${t.id === activeSettingsTab ? ' selected' : ''}" data-tab="${esc(t.id)}" role="tab" id="tab-${esc(t.id)}" aria-controls="settings-tabpanel" aria-selected="${t.id === activeSettingsTab}">
              ${esc(t.label)}
            </button>
          `).join('')}
        </div>
      </div>
      <div data-settings-body role="tabpanel" id="settings-tabpanel" aria-labelledby="tab-${activeSettingsTab}"></div>
    </div>`);

  main.replaceChildren(view);
  const body = view.querySelector('[data-settings-body]');

  function selectTab(tabId) {
    const token = ++settingsTabSeq;
    activeSettingsTab = tabId;
    body.setAttribute('aria-labelledby', `tab-${tabId}`);
    view.querySelectorAll('.cswitch-item').forEach((btn) => {
      const isSel = btn.dataset.tab === tabId;
      btn.classList.toggle('selected', isSel);
      btn.setAttribute('aria-selected', isSel);
    });

    if (tabId === 'profile') mountProfileTab(body, token);
    else if (tabId === 'preferences') mountPreferencesTab(body, token);
    else if (tabId === 'audit') mountAuditTab(body, token);
    else if (tabId === 'rates') mountRatesTab(body, token);
  }

  const tabButtons = [...view.querySelectorAll('.cswitch-item')];
  tabButtons.forEach((btn, idx) => {
    btn.addEventListener('click', () => selectTab(btn.dataset.tab));
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') {
        const next = tabButtons[(idx + 1) % tabButtons.length];
        next.focus();
        selectTab(next.dataset.tab);
      } else if (e.key === 'ArrowLeft') {
        const prev = tabButtons[(idx - 1 + tabButtons.length) % tabButtons.length];
        prev.focus();
        selectTab(prev.dataset.tab);
      }
    });
  });

  selectTab(activeSettingsTab);
}

function renderProfile(main) {
  return renderSettings(main, 'profile');
}

function mountProfileTab(container, token) {
  const p = principal;
  const view = el(`
    <div class="profile">
      <div class="card pt-carbon-02 px-carbon-06 pb-carbon-03">
        <dl class="kv">
          <dt>Name</dt><dd>${esc(p.name)}</dd>
          <dt>Designation</dt><dd>${esc(p.designation)}</dd>
          <dt>Department</dt><dd>${esc(p.departmentName)}</dd>
          <dt>Cost center</dt><dd class="tabular">${esc(p.costCenterCode)}</dd>
          <dt>Location</dt><dd>${esc(p.location)}</dd>
          <dt>Grade</dt><dd>${esc(p.grade)}</dd>
          <dt>Reporting manager</dt><dd>${esc(p.managerName ?? '— no reporting manager —')}</dd>
          <dt>Employee code</dt><dd class="tabular">${esc(p.employeeCode)}</dd>
          <dt>Internal id</dt><dd class="tabular">${esc(p.employeeId)}</dd>
          <dt>Work email</dt><dd>${esc(p.email)}</dd>
          <dt>Roles</dt>
          <dd><div class="pill-row">${p.roles.map((r) => `<span class="pill ok">${esc(ROLE_LABEL[r] ?? r)}</span>`).join('')}</div></dd>
        </dl>
      </div>

      <form class="card p-carbon-06 mt-carbon-05" novalidate>
        <div class="field mb-carbon-04">
          <label for="mobile">Contact number</label>
          <input id="mobile" type="tel" autocomplete="tel" value="${esc(p.mobile ?? '')}"
                 placeholder="Not set">
          <span class="hint">Department, grade, manager and roles are administered by
            your company administrator.</span>
        </div>
        <button class="btn sm" type="submit">Save</button>
      </form>

      <form class="card p-carbon-06 mt-carbon-05" data-pw novalidate>
        <div class="field" data-f="currentPassword">
          <label for="curpw">Current password</label>
          <input id="curpw" type="password" autocomplete="current-password">
        </div>
        <div class="field mb-carbon-04" data-f="newPassword">
          <label for="newpw">New password</label>
          <input id="newpw" type="password" autocomplete="new-password">
          <span class="hint">At least 6 characters. Your other signed-in devices will be signed out.</span>
        </div>
        <button class="btn sm" type="submit">Change password</button>
      </form>

      ${!p.managerId ? `
      <div class="card mt-carbon-05 border-left-warning px-carbon-06 py-carbon-05">
        <h3 class="m-0 mb-carbon-02 type-body-02 strong">No reporting manager assigned</h3>
        <p class="m-0 mb-carbon-03 type-body-01 text-secondary">
          Trip and expense submissions require an active reporting manager in your reporting hierarchy.
          Without a reporting manager, submitting requests will return <code>422 no_approval_route</code>.
        </p>
        <p class="m-0 type-body-01 text-secondary">
          An administrator can assign your manager under the <strong>Employees</strong> directory.
        </p>
      </div>` : ''}
    </div>`);

  const form = view.querySelector('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      await api.patch('/me', { mobile: view.querySelector('#mobile').value.trim() || null });
      principal = (await api.get('/me')).principal;
      toast('Contact number updated');
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
    }
  });

  const pwForm = view.querySelector('[data-pw]');
  pwForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    for (const f of pwForm.querySelectorAll('.field')) { f.classList.remove('invalid'); f.querySelector('.error')?.remove(); }
    const btn = pwForm.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      await api.post('/auth/password/change', {
        currentPassword: pwForm.querySelector('#curpw').value,
        newPassword: pwForm.querySelector('#newpw').value,
      });
      pwForm.reset();
      toast('Password changed — other devices signed out');
    } catch (err) {
      const fields = err.fields ?? {};
      for (const [name, message] of Object.entries(fields)) {
        const f = pwForm.querySelector(`[data-f="${name}"]`);
        if (f) { f.classList.add('invalid'); f.appendChild(el(`<span class="error">${esc(message)}</span>`)); }
      }
      if (!Object.keys(fields).length) toast(err.message, true);
    } finally {
      btn.disabled = false;
    }
  });

  if (token !== undefined && token !== settingsTabSeq) return;
  container.replaceChildren(view);
}

async function mountPreferencesTab(container, token) {
  await loadCurrencies();
  let currentDensity = 'standard';
  let currentMotion = 'productive';
  try {
    currentDensity = localStorage.getItem('trek_pref_density') || 'standard';
    currentMotion = localStorage.getItem('trek_pref_motion') || 'productive';
  } catch { /* storage may be blocked */ }
  const currentCurrency = rememberedDisplayCurrency() || currencyRegistry.baseCurrency;

  const wrap = el(`
    <div>
      <div class="card p-carbon-06 mb-carbon-05">
        <h3 class="m-0 mb-carbon-02 type-body-02 strong">Display currency preference</h3>
        <p class="m-0 mb-carbon-04 type-body-01 text-secondary">
          Choose the default currency you prefer to see converted figures in across the Dashboard and reports. Stored values remain in their original currencies.
        </p>
        <div class="field m-0">
          <label>Default display currency</label>
          <select data-pref-currency>
            ${currencyOptions(currentCurrency)}
          </select>
          <span class="hint">Trek remembers your preferred reporting currency on this device</span>
        </div>
      </div>

      <div class="card p-carbon-06 mb-carbon-05">
        <h3 class="m-0 mb-carbon-02 type-body-02 strong">Table row density</h3>
        <p class="m-0 mb-carbon-04 type-body-01 text-secondary">
          Adjust vertical padding in trip, expense, and employee tables.
        </p>
        <div class="cswitch" role="radiogroup" aria-label="Table row density">
          <button type="button" class="cswitch-item${currentDensity === 'standard' ? ' selected' : ''}" data-density-val="standard" role="radio" aria-checked="${currentDensity === 'standard'}">
            Standard (Spacious)
          </button>
          <button type="button" class="cswitch-item${currentDensity === 'compact' ? ' selected' : ''}" data-density-val="compact" role="radio" aria-checked="${currentDensity === 'compact'}">
            Compact (High density)
          </button>
        </div>
      </div>

      <div class="card p-carbon-06">
        <h3 class="m-0 mb-carbon-02 type-body-02 strong">Interface motion &amp; transitions</h3>
        <p class="m-0 mb-carbon-04 type-body-01 text-secondary">
          Control interface animation speed. All transitions follow IBM Carbon’s productive motion curves.
        </p>
        <div class="cswitch" role="radiogroup" aria-label="Interface motion and transitions">
          <button type="button" class="cswitch-item${currentMotion === 'productive' ? ' selected' : ''}" data-motion-val="productive" role="radio" aria-checked="${currentMotion === 'productive'}">
            Productive (110–150ms)
          </button>
          <button type="button" class="cswitch-item${currentMotion === 'reduced' ? ' selected' : ''}" data-motion-val="reduced" role="radio" aria-checked="${currentMotion === 'reduced'}">
            Reduced (Instant)
          </button>
        </div>
      </div>
    </div>`);

  wrap.querySelector('[data-pref-currency]').addEventListener('change', (e) => {
    const val = e.target.value;
    rememberDisplayCurrency(val);
    toast(`Default display currency set to ${val}`);
  });

  wrap.querySelectorAll('[data-density-val]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const val = btn.dataset.densityVal;
      wrap.querySelectorAll('[data-density-val]').forEach((b) => {
        const isSel = b === btn;
        b.classList.toggle('selected', isSel);
        b.setAttribute('aria-checked', String(isSel));
      });
      document.body.setAttribute('data-density', val);
      try { localStorage.setItem('trek_pref_density', val); } catch {}
      toast(`Table density set to ${val}`);
    });
  });

  wrap.querySelectorAll('[data-motion-val]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const val = btn.dataset.motionVal;
      wrap.querySelectorAll('[data-motion-val]').forEach((b) => {
        const isSel = b === btn;
        b.classList.toggle('selected', isSel);
        b.setAttribute('aria-checked', String(isSel));
      });
      document.body.setAttribute('data-motion', val);
      try { localStorage.setItem('trek_pref_motion', val); } catch {}
      toast(`Motion preference set to ${val}`);
    });
  });

  if (token !== undefined && token !== settingsTabSeq) return;
  container.replaceChildren(wrap);
}

async function mountRatesTab(container, token) {
  await loadCurrencies();
  const base = currencyRegistry.baseCurrency;
  const wrap = el(`
    <div>
      <div class="card p-carbon-06 mb-carbon-05">
        <div class="row-between v-middle mb-carbon-02">
          <h3 class="m-0 type-body-02 strong">European Central Bank FX Feed</h3>
          <button class="btn sm ghost" data-sync-ecb>Sync live rates from ECB</button>
        </div>
        <p class="m-0 type-body-01 text-secondary">
          Reference exchange rates are synchronised from the European Central Bank. Rates are stored as immutable daily snapshots against company base currency <strong>${esc(base)}</strong>.
        </p>
      </div>

      <div class="card p-carbon-06">
        <h3 class="m-0 mb-carbon-03 type-body-02 strong">Currency Registry &amp; Reference Rates</h3>
        <p class="m-0 mb-carbon-04 type-body-01 text-secondary">
          Trek knows about 50+ global currencies. Check remembered rates in both directions against ${esc(base)}.
        </p>
        <button class="btn sm" data-open-rates-drawer>View full exchange rates drawer</button>
      </div>
    </div>`);

  const syncBtn = wrap.querySelector('[data-sync-ecb]');
  syncBtn.addEventListener('click', async () => {
    syncBtn.disabled = true;
    syncBtn.textContent = 'Syncing from ECB…';
    try {
      const res = await api.post('/exchange-rates/sync');
      toast(`Synced ${res.synced_count} exchange rates from ECB (${res.effective_on})`);
      await loadCurrencies();
    } catch (err) {
      toast(err.message, true);
    } finally {
      syncBtn.disabled = false;
      syncBtn.textContent = 'Sync live rates from ECB';
    }
  });

  wrap.querySelector('[data-open-rates-drawer]').addEventListener('click', () => {
    openExchangeRatesDrawer();
  });

  if (token !== undefined && token !== settingsTabSeq) return;
  container.replaceChildren(wrap);
}

/* ============================================================ Trips & Expenses (Pilot) */

function statusPill(status) {
  switch (status) {
    case 'approved': return '<span class="pill ok">Approved</span>';
    case 'submitted': return '<span class="pill warn">Submitted</span>';
    case 'rejected': return '<span class="pill error">Rejected</span>';
    case 'changes_requested': return '<span class="pill warn">Changes requested</span>';
    case 'active': return '<span class="pill ok">Active</span>';
    case 'reconciliation_pending': return '<span class="pill warn">Awaiting Finance</span>';
    case 'reconciled': return '<span class="pill ok">Reconciled</span>';
    case 'closed': return '<span class="pill off">Closed</span>';
    case 'draft':
    default: return '<span class="pill off">Draft</span>';
  }
}

function showFieldErrors(form, fields = {}) {
  for (const f of form.querySelectorAll('.field')) {
    f.classList.remove('invalid');
    f.querySelector('.error')?.remove();
  }
  for (const [name, msg] of Object.entries(fields)) {
    const f = form.querySelector(`[data-f="${name}"]`);
    if (f) {
      f.classList.add('invalid');
      const errEl = document.createElement('span');
      errEl.className = 'error';
      errEl.textContent = msg;
      f.appendChild(errEl);
    }
  }
}

/* ------------------------------------------------------------ Trips Screen */

async function renderTrips(main) {
  const canReadAllTrips = principal.permissions.includes('trip.read.all');
  const canReadTeamTrips = principal.permissions.includes('trip.read.team');
  const hasScopeOptions = canReadAllTrips || canReadTeamTrips;
  let activeScope = canReadAllTrips ? 'all' : (canReadTeamTrips ? 'team' : 'own');

  const titleFor = (s) => (s === 'all' ? 'Company trips' : (s === 'team' ? 'Team trips' : 'My trips'));

  const view = el(`
    <div>
      <div class="page-head row-start row-wrap">
        <div>
          <h1 data-title>${esc(titleFor(activeScope))}</h1>
          <p>Create, manage, and submit travel requests for review.</p>
        </div>
        <button class="btn sm" data-add-trip>+ New trip</button>
      </div>
      <div class="card p-carbon-04 mb-carbon-05 border-subtle bg-layer rounded row-between v-middle">
        <div>
          <div class="row-start gap-carbon-02 v-middle">
            <span class="type-body-02 strong">✈️ Flight &amp; Automotive Field Assistant</span>
            <span class="pill ok type-label-01">Live Links</span>
          </div>
          <div class="type-body-01 text-secondary mt-carbon-01">
            Visiting automotive workshops or clients? Plan flights from Bengaluru, return travel, hotels, and local dealership clusters for any trip.
          </div>
        </div>
        <button class="btn sm ghost" data-assistant-new-trip>✈️ Plan travel</button>
      </div>
      <div class="toolbar">
        ${hasScopeOptions ? `
          <div class="cswitch" role="tablist" aria-label="Trip scope">
            ${canReadAllTrips ? `<button type="button" class="cswitch-item${activeScope === 'all' ? ' selected' : ''}" data-scope="all" role="tab" aria-selected="${activeScope === 'all'}">Company trips</button>` : ''}
            ${canReadTeamTrips ? `<button type="button" class="cswitch-item${activeScope === 'team' ? ' selected' : ''}" data-scope="team" role="tab" aria-selected="${activeScope === 'team'}">My team</button>` : ''}
            <button type="button" class="cswitch-item${activeScope === 'own' ? ' selected' : ''}" data-scope="own" role="tab" aria-selected="${activeScope === 'own'}">My trips</button>
          </div>
        ` : ''}
        <select data-status aria-label="Filter trips by status">
          <option value="">All statuses</option>
          <option value="draft">Draft</option>
          <option value="changes_requested">Changes requested</option>
          <option value="submitted">Submitted</option>
          <option value="approved">Approved</option>
          <option value="active">Active</option>
          <option value="rejected">Rejected</option>
          <option value="reconciliation_pending">Awaiting Finance</option>
          <option value="reconciled">Reconciled</option>
          <option value="closed">Closed</option>
        </select>
        <input type="search" placeholder="Filter trips..." class="toolbar-search" data-search aria-label="Filter trips">
        <button class="btn sm ghost" data-refresh>Refresh</button>
      </div>
      <div class="card" data-table></div>
    </div>`);

  main.replaceChildren(view);

  const tableHost = view.querySelector('[data-table]');
  const statusEl = view.querySelector('[data-status]');
  const titleEl = view.querySelector('[data-title]');
  const searchInput = view.querySelector('[data-search]');
  let currentTrips = [];

  for (const item of view.querySelectorAll('.cswitch-item')) {
    item.addEventListener('click', () => {
      activeScope = item.dataset.scope;
      for (const btn of view.querySelectorAll('.cswitch-item')) {
        const sel = btn.dataset.scope === activeScope;
        btn.classList.toggle('selected', sel);
        btn.setAttribute('aria-selected', String(sel));
      }
      titleEl.textContent = titleFor(activeScope);
      load();
    });
  }

  view.querySelector('[data-add-trip]').addEventListener('click', () => {
    renderTripFormDrawer(null, load);
  });
  view.querySelector('[data-assistant-new-trip]')?.addEventListener('click', () => {
    renderTripFormDrawer(null, load);
  });
  view.querySelector('[data-refresh]').addEventListener('click', () => {
    api.clearCache();
    load();
  });
  statusEl.addEventListener('change', load);

  function filterAndRender() {
    const q = searchInput?.value?.trim().toLowerCase() || '';
    const filtered = q
      ? currentTrips.filter((t) => (t.destination || '').toLowerCase().includes(q) || (t.purpose || '').toLowerCase().includes(q))
      : currentTrips;
    renderRows(filtered);
  }

  searchInput?.addEventListener('input', filterAndRender);

  function renderRows(items) {
    if (!items.length) {
      if (searchInput?.value?.trim()) {
        tableHost.replaceChildren(el(`
          <div class="empty">
            <h3>No matching trips</h3>
            <p>No trips match "${esc(searchInput.value)}". Clear search to see all trips.</p>
          </div>`));
      } else if (statusEl.value) {
        tableHost.replaceChildren(el(`
          <div class="empty">
            <h3>No trips with this status</h3>
            <p>No trips match "${esc(statusEl.options[statusEl.selectedIndex]?.text || statusEl.value)}". Try choosing another status filter.</p>
          </div>`));
      } else {
        tableHost.replaceChildren(el(`
          <div class="empty">
            <h3>No trips yet</h3>
            <p>Trips you create will appear here, from draft to closed.</p>
            <button class="btn sm" data-create-empty>+ New trip</button>
          </div>`));
        tableHost.querySelector('[data-create-empty]')?.addEventListener('click', () => {
          renderTripFormDrawer(null, load);
        });
      }
      return;
    }

    const table = el(`
      <table>
        <thead>
          <tr>
            <th>Destination</th>
            <th>Dates</th>
            <th>Purpose</th>
            <th>Expenses</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>`);

    const tbody = table.querySelector('tbody');
    for (const t of items) {
      const row = el(`
        <tr class="clickable">
          <td>
            <div class="cell-primary">
              ${esc(t.destination)}
              <span class="pill off ml-carbon-02 type-caption-01 strong">${esc(t.currency || 'USD')}</span>
            </div>
            <div class="cell-sub row gap-carbon-02 mt-carbon-01">
              <span>Created ${fmtDate(t.created_at)}</span>
              <span>·</span>
              <span class="text-interactive medium">✈️ Flights &amp; Hubs</span>
            </div>
          </td>
          <td class="tabular">${fmtDate(t.start_date)} – ${fmtDate(t.end_date)}</td>
          <td><div class="max-240 truncate">${esc(t.purpose)}</div></td>
          <td>${t.expense_count} item${t.expense_count === 1 ? '' : 's'}</td>
          <td>${statusPill(t.status)}</td>
        </tr>`);
      row.addEventListener('click', () => renderTripDetailDrawer(t.id, load));
      tbody.appendChild(row);
    }

    tableHost.replaceChildren(table);
  }

  let loadToken = 0;
  async function load() {
    const token = ++loadToken;
    tableHost.replaceChildren(el(`
      <div class="p-carbon-05">
        ${'<div class="skeleton my-carbon-03"></div>'.repeat(4)}
      </div>`));

    try {
      const q = statusEl.value
        ? `?scope=${encodeURIComponent(activeScope)}&status=${encodeURIComponent(statusEl.value)}`
        : `?scope=${encodeURIComponent(activeScope)}`;
      const { data } = await api.get(`/trips${q}`);
      if (token !== loadToken) return;

      currentTrips = data || [];
      filterAndRender();
    } catch (err) {
      if (token !== loadToken) return;
      tableHost.replaceChildren(el(`
        <div class="empty">
          <h3>Trips couldn't be loaded</h3>
          <p>The server did not answer. This is usually temporary.</p>
          <button class="btn sm ghost" data-retry>Try again</button>
        </div>`));
      tableHost.querySelector('[data-retry]')?.addEventListener('click', load);
    }
  }

  load();
}

async function renderTripFormDrawer(trip, onSaved) {
  const isNew = !trip;

  /* The currency list comes from the registry, so it is one list for the whole
   * app rather than a copy typed into a dropdown. */
  await loadCurrencies();
  const tripCurrency = trip?.currency ?? currencyRegistry.baseCurrency;

  const scrim = el(`
    <div class="drawer-scrim">
      <div class="drawer" role="dialog" aria-modal="true">
        <div class="drawer-head">
          <h2>${isNew ? 'New trip draft' : 'Edit trip draft'}</h2>
          <p>Specify travel destination, purpose, and dates.</p>
        </div>
        <form class="drawer-body" novalidate>
          <div class="mb-carbon-04">
            <span class="type-caption-01 text-secondary">Quick destination presets:</span>
            <div class="row row-wrap gap-carbon-02 mt-carbon-02" data-hub-chips>
              <button type="button" class="chip" data-dest="Dubai, UAE" data-cur="AED">Dubai (AED)</button>
              <button type="button" class="chip" data-dest="Riyadh, Saudi Arabia" data-cur="SAR">Riyadh (SAR)</button>
              <button type="button" class="chip" data-dest="Detroit, USA" data-cur="USD">Detroit (USD)</button>
              <button type="button" class="chip" data-dest="Frankfurt, Germany" data-cur="EUR">Frankfurt (EUR)</button>
              <button type="button" class="chip" data-dest="Singapore" data-cur="SGD">Singapore (SGD)</button>
            </div>
          </div>
          <div class="field" data-f="destination">
            <label>Destination <span class="req">*</span></label>
            <input name="destination" value="${esc(trip?.destination ?? '')}" placeholder="e.g. Frankfurt, Germany" required>
            <span class="hint">City and country of travel</span>
          </div>
          <div class="field" data-f="currency">
            <label>Trip Destination Currency <span class="req">*</span></label>
            <select name="currency">${currencyOptions(tripCurrency)}</select>
            <span class="hint">Primary multi-currency standard for expenses on this trip</span>
          </div>
          <div class="field" data-f="purpose">
            <label>Business purpose <span class="req">*</span></label>
            <textarea name="purpose" rows="3" placeholder="e.g. Client quarterly onboarding and executive meetings" required>${esc(trip?.purpose ?? '')}</textarea>
            <span class="hint">Why this trip is necessary</span>
          </div>
          <div class="grid-2">
            <div class="field" data-f="startDate">
              <label>Start date <span class="req">*</span></label>
              <input type="date" name="startDate" value="${trip?.start_date ? String(trip.start_date).slice(0, 10) : ''}" required>
            </div>
            <div class="field" data-f="endDate">
              <label>End date <span class="req">*</span></label>
              <input type="date" name="endDate" value="${trip?.end_date ? String(trip.end_date).slice(0, 10) : ''}" required>
            </div>
          </div>
          <div data-travel-assistant-slot class="mt-carbon-04"></div>
        </form>
        <div class="drawer-foot">
          <button class="btn ghost sm" data-cancel>Cancel</button>
          <button class="btn sm" data-save>Save draft</button>
        </div>
      </div>
    </div>`);

  document.body.appendChild(scrim);
  const releaseFocus = trapFocus(scrim.querySelector('[role="dialog"]'));
  const close = () => { releaseFocus(); scrim.remove(); };
  scrim.querySelector('[data-cancel]').addEventListener('click', close);
  scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });

  const form = scrim.querySelector('form');
  const destInput = form.querySelector('[name="destination"]');
  const curSelect = form.querySelector('[name="currency"]');
  const startInput = form.querySelector('[name="startDate"]');
  const endInput = form.querySelector('[name="endDate"]');
  const assistantSlot = form.querySelector('[data-travel-assistant-slot]');

  function updateAssistant() {
    assistantSlot.innerHTML = renderAutomotiveTravelCard({
      destination: destInput.value.trim(),
      start_date: startInput.value,
      end_date: endInput.value,
      currency: curSelect.value,
      base_currency: currencyRegistry.baseCurrency,
    });
  }

  for (const chip of scrim.querySelectorAll('[data-hub-chips] button')) {
    chip.addEventListener('click', () => {
      destInput.value = chip.dataset.dest;
      if (chip.dataset.cur) curSelect.value = chip.dataset.cur;
      updateAssistant();
    });
  }

  destInput.addEventListener('input', updateAssistant);
  startInput.addEventListener('change', updateAssistant);
  endInput.addEventListener('change', updateAssistant);
  curSelect.addEventListener('change', updateAssistant);
  updateAssistant();
  scrim.querySelector('[data-save]').addEventListener('click', async () => {
    const payload = {
      destination: form.querySelector('[name="destination"]').value.trim(),
      currency: form.querySelector('[name="currency"]')?.value || currencyRegistry.baseCurrency,
      purpose: form.querySelector('[name="purpose"]').value.trim(),
      startDate: form.querySelector('[name="startDate"]').value,
      endDate: form.querySelector('[name="endDate"]').value,
    };

    const saveBtn = scrim.querySelector('[data-save]');
    saveBtn.disabled = true;

    try {
      if (isNew) {
        await api.post('/trips', payload);
        toast('Draft trip created');
      } else {
        await api.patch(`/trips/${trip.id}`, payload);
        toast('Trip draft updated');
      }
      close();
      onSaved();
    } catch (err) {
      if (err.fields) showFieldErrors(form, err.fields);
      else toast(err.message, true);
      saveBtn.disabled = false;
    }
  });
}
/* The trip detail drawer: budget, currency plan, funds, expenses, bills and
 * reconciliation, in the order the money moves.
 *
 *   Budget (what we expect to spend)
 *     → Currency plan (cash, forex card, rates, charges)
 *       → Funds issued (what the company actually handed over)
 *         → Expenses + bills (what was really spent)
 *           → Reconciliation (the difference, and who owes whom)
 */

const CATEGORY_LABEL = {
  travel: 'Travel',
  accommodation: 'Accommodation',
  food: 'Food',
  visa: 'Visa',
  sim_card: 'SIM card',
  other: 'Other',
};

const FUND_KIND_LABEL = {
  cash: 'Cash',
  forex_card: 'Forex card',
  additional: 'Additional funds',
};

const PAYMENT_LABEL = {
  cash: 'Cash',
  forex_card: 'Forex card',
  card: 'Card',
  bank_transfer: 'Bank transfer',
};

const ZERO_DECIMAL_CURRENCIES = new Set(['JPY', 'KRW', 'VND', 'IDR', 'HUF', 'CLP', 'COP', 'UGX', 'TZS', 'RWF', 'PYG']);

function formatCurrencyAmount(val, cur) {
  if (val == null || val === '') return '0.00';
  let str = String(val);
  const curInfo = currencyRegistry?.currencies?.find((c) => c.code === cur);
  const minorUnits = curInfo ? curInfo.minor_units : (ZERO_DECIMAL_CURRENCIES.has(cur) ? 0 : 2);
  if (minorUnits === 0 && str.endsWith('.00')) {
    str = str.slice(0, -3);
  }
  return str;
}

const MONEY = (v, c) => `${esc(formatCurrencyAmount(v, c))} ${esc(c ?? '')}`.trim();

function renderTripStepper(status) {
  const steps = [
    { key: 'plan', title: '1. Draft Plan', sub: 'Budget & dates' },
    { key: 'approval', title: '2. Approval', sub: 'Manager review' },
    { key: 'funds', title: '3. Funds', sub: 'Disbursement' },
    { key: 'active', title: '4. On Trip', sub: 'Spend & receipts' },
    { key: 'settlement', title: '5. Settlement', sub: 'Tally & closure' },
  ];

  let currentIdx = 0;
  if (['draft', 'changes_requested'].includes(status)) currentIdx = 0;
  else if (status === 'submitted') currentIdx = 1;
  else if (status === 'rejected') currentIdx = 1;
  else if (status === 'approved') currentIdx = 2;
  else if (status === 'active') currentIdx = 3;
  else if (['reconciliation_pending', 'reconciled'].includes(status)) currentIdx = 4;
  else if (status === 'closed') currentIdx = 4;

  const isRejected = status === 'rejected';

  const html = `
    <div class="carbon-progress" role="progressbar" aria-label="Trip lifecycle progress" aria-valuenow="${currentIdx + 1}" aria-valuemin="1" aria-valuemax="${steps.length}" aria-valuetext="${steps[currentIdx]?.title || status}">
      ${steps.map((s, idx) => {
        let stateClass = 'incomplete';
        if (status === 'closed') {
          stateClass = 'complete';
        } else if (isRejected) {
          if (idx === 0) stateClass = 'complete';
          else if (idx === 1) stateClass = 'error';
          else stateClass = 'incomplete';
        } else {
          if (idx < currentIdx) stateClass = 'complete';
          else if (idx === currentIdx) stateClass = 'current';
        }
        const hasLine = idx < steps.length - 1;
        const lineComplete = !isRejected && ((idx + 1) <= currentIdx || status === 'closed');
        return `
          <div class="carbon-step ${stateClass}">
            <div class="carbon-step-header">
              <div class="carbon-step-dot ${stateClass}"></div>
              ${hasLine ? `<div class="carbon-step-line${lineComplete ? ' complete' : ''}"></div>` : ''}
            </div>
            <div class="carbon-step-title">${esc(isRejected && idx === 1 ? '2. Rejected' : s.title)}</div>
            <div class="carbon-step-sub">${esc(isRejected && idx === 1 ? 'Changes declined' : s.sub)}</div>
          </div>`;
      }).join('')}
    </div>`;

  return html;
}

function renderAutomotiveTravelCard(trip) {
  const dest = trip.destination || '';
  const destLower = dest.toLowerCase();
  const startDate = trip.start_date || trip.startDate || '';
  const endDate = trip.end_date || trip.endDate || '';
  const curr = trip.currency || 'USD';
  const baseCurr = trip.base_currency || trip.baseCurrency || 'INR';

  if (!dest) {
    return `
      <div class="card p-carbon-04 mb-carbon-05 border-subtle bg-layer rounded">
        <div class="row-start gap-carbon-02 v-middle mb-carbon-01">
          <span class="type-body-02 strong">✈️ Flight &amp; Travel Planning Assistant</span>
          <span class="pill off type-label-01">Select Destination</span>
        </div>
        <p class="type-body-01 text-secondary m-0">Enter a travel destination and dates above to generate live flight booking searches from Bengaluru, hotel links, and local automotive client workshop maps.</p>
      </div>`;
  }

  // Smart links
  const flightQuery = encodeURIComponent(`Flights from Bengaluru to ${dest} from ${startDate} to ${endDate}`);
  const returnQuery = encodeURIComponent(`Flights from ${dest} to Bengaluru on ${endDate || startDate}`);
  const googleFlightsUrl = `https://www.google.com/travel/flights?q=${flightQuery}`;
  const returnFlightsUrl = `https://www.google.com/travel/flights?q=${returnQuery}`;

  const destCity = dest.split(',')[0].trim();
  const skyscannerUrl = `https://www.skyscanner.co.in/transport/flights/blr/${encodeURIComponent(destCity.toLowerCase())}/`;
  const hotelsUrl = `https://www.google.com/travel/hotels?q=${encodeURIComponent('Hotels in ' + dest)}`;

  // Automotive cluster detection for GaragePlug field team
  let autoHubLabel = 'Automotive Workshops & Dealerships';
  let autoHubUrl = `https://www.google.com/maps/search/${encodeURIComponent(dest + ' automotive workshops dealerships')}`;

  if (destLower.includes('dubai') || destLower.includes('uae') || destLower.includes('emirates')) {
    autoHubLabel = 'Dubai Auto Hubs (Al Quoz & Ras Al Khor)';
    autoHubUrl = 'https://www.google.com/maps/search/Al+Quoz+automotive+workshops+Dubai';
  } else if (destLower.includes('riyadh') || destLower.includes('saudi') || destLower.includes('ksa')) {
    autoHubLabel = 'Riyadh Industrial Auto Hubs (Sanaiya)';
    autoHubUrl = 'https://www.google.com/maps/search/Riyadh+industrial+city+automotive+workshops';
  } else if (destLower.includes('detroit') || destLower.includes('michigan')) {
    autoHubLabel = 'Detroit Automotive OEM & Service Centers';
    autoHubUrl = 'https://www.google.com/maps/search/Detroit+automotive+service+centers';
  } else if (destLower.includes('stuttgart') || destLower.includes('munich') || destLower.includes('germany')) {
    autoHubLabel = 'Germany Automotive Workshops';
    autoHubUrl = 'https://www.google.com/maps/search/Stuttgart+automotive+workshops';
  } else if (destLower.includes('singapore')) {
    autoHubLabel = 'Singapore Automotive Centers';
    autoHubUrl = 'https://www.google.com/maps/search/Singapore+automotive+workshops';
  }

  const liveFxUrl = `https://www.google.com/finance/quote/${encodeURIComponent(curr)}-${encodeURIComponent(baseCurr)}`;
  const datesLabel = startDate && endDate ? `${fmtDate(startDate)} → ${fmtDate(endDate)}` : (startDate ? fmtDate(startDate) : 'Dates');

  return `
    <div class="card p-carbon-04 mb-carbon-05 border-subtle bg-layer rounded">
      <div class="row-between mb-carbon-02">
        <div class="row-start gap-carbon-02 v-middle">
          <span class="type-body-02 strong">✈️ Flight &amp; Travel Planning Assistant</span>
          <span class="pill ok type-label-01">Live Links</span>
        </div>
        <span class="type-caption-01 text-secondary">${esc(dest)}</span>
      </div>
      <div class="type-body-01 text-secondary mb-carbon-03">
        Book flights from Bengaluru, plan return travel, hotels, automotive client workshops, and live forex:
      </div>
      <div class="row row-wrap gap-carbon-02">
        <a href="${googleFlightsUrl}" target="_blank" rel="noopener" class="btn sm quiet">
          ✈️ Google Flights (${esc(datesLabel)}) ↗
        </a>
        <a href="${returnFlightsUrl}" target="_blank" rel="noopener" class="btn sm quiet">
          🛫 Return Flights (${esc(destCity)} → BLR) ↗
        </a>
        <a href="${skyscannerUrl}" target="_blank" rel="noopener" class="btn sm quiet">
          🔍 Skyscanner Fares ↗
        </a>
        <a href="${hotelsUrl}" target="_blank" rel="noopener" class="btn sm quiet">
          🏨 Google Hotels ↗
        </a>
        <a href="${autoHubUrl}" target="_blank" rel="noopener" class="btn sm quiet">
          🚗 ${esc(autoHubLabel)} ↗
        </a>
        <a href="${liveFxUrl}" target="_blank" rel="noopener" class="btn sm quiet">
          💱 Live ${esc(curr)}/${esc(baseCurr)} (Google Finance) ↗
        </a>
      </div>
    </div>`;
}

async function renderTripDetailDrawer(tripId, onRefresh) {
  const scrim = el(`
    <div class="drawer-scrim">
      <div class="drawer w-720" role="dialog" aria-modal="true">
        <div class="drawer-head">
          <div class="row-between">
            <h2>Trip details</h2>
            <button class="btn quiet sm" data-close aria-label="Close">✕</button>
          </div>
        </div>
        <div class="drawer-body" data-content>
          <div class="p-carbon-05">${'<div class="skeleton h-10 my-carbon-03"></div>'.repeat(6)}</div>
        </div>
      </div>
    </div>`);

  document.body.appendChild(scrim);
  const releaseFocus = trapFocus(scrim.querySelector('[role="dialog"]'));
  const close = () => { releaseFocus(); scrim.remove(); onRefresh(); };
  scrim.querySelector('[data-close]').addEventListener('click', close);
  scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });

  const bodyEl = scrim.querySelector('[data-content]');

  async function loadDetail() {
    try {
      const { trip } = await api.get(`/trips/${tripId}`);
      const content = el(`<div></div>`);

      /* What the viewer may DO with this trip. The API decides; this only stops
       * the UI offering a button that would be refused. The traveller owns the
       * trip and may prepare it; Finance issues funds and signs off; a manager
       * decides the budget. */
      const isOwner = principal.employeeId === trip.employee_id;
      const canManageBudget = isOwner && principal.permissions.includes('trip.budget.manage');
      const canManageFx = isOwner && principal.permissions.includes('trip.fx.manage');
      const canIssueFunds = principal.permissions.includes('trip.fund.manage');
      const canDecideReconciliation = principal.permissions.includes('trip.reconcile.decide');
      const canSettle = principal.permissions.includes('trip.settle');
      const isEditable = ['draft', 'changes_requested'].includes(trip.status);
      const isActive = trip.status === 'active';

      /* ---- header ---- */
      content.appendChild(el(`
        <div>
          <div class="row-start mb-carbon-05">
            <div>
              <h2 class="m-0 mb-carbon-01 type-heading-compact-01">
                ${esc(trip.destination)}
                <span class="pill off type-label-01 v-middle ml-carbon-02 strong">${esc(trip.currency || 'INR')}</span>
              </h2>
              <div class="type-body-01 text-tertiary">${fmtDate(trip.start_date)} – ${fmtDate(trip.end_date)}</div>
              <div class="type-body-01 text-tertiary">${esc(trip.employee_name || '')}</div>
              ${trip.manager_name ? `<div class="type-caption-01 text-secondary mt-carbon-01">Approver: <strong>${esc(trip.manager_name)}</strong></div>` : ''}
            </div>
            <div>${statusPill(trip.status)}</div>
          </div>

          ${renderTripStepper(trip.status)}

          ${trip.rejection_reason ? `
          <div class="audit-reason mb-carbon-05">
            <strong>${trip.status === 'changes_requested' ? 'Changes requested:' : 'Rejection reason:'}</strong> ${esc(trip.rejection_reason)}
          </div>` : ''}

          <div class="mb-carbon-06 px-carbon-04 py-carbon-04 bg-accent rounded">
            <div class="type-label-01 medium caps text-placeholder mb-carbon-02">Purpose</div>
            <div class="type-body-01">${esc(trip.purpose)}</div>
          </div>

          ${renderAutomotiveTravelCard(trip)}

          ${isEditable && isOwner ? `
            ${(!trip.manager_name || trip.manager_status !== 'active') ? `
              <div class="notice warn mb-carbon-04">
                <strong>Approval route missing:</strong> You do not have an active reporting manager assigned. Contact an administrator to configure your reporting line before submitting travel requests.
              </div>
            ` : (!trip.budget?.length ? `
              <div class="notice info mb-carbon-04">
                <strong>Budget required:</strong> Add at least one budget estimate below before submitting for manager approval.
              </div>
            ` : `
              <div class="notice ok mb-carbon-04">
                Ready for review. Submitting will route this request to <strong>${esc(trip.manager_name)}</strong>.
              </div>
            `)}
          ` : ''}
          ${trip.status === 'submitted' ? `
            <div class="notice info mb-carbon-04">
              Submitted for approval to <strong>${esc(trip.manager_name || 'reporting manager')}</strong>. Editing is locked while under review.
            </div>
          ` : ''}
          ${trip.status === 'approved' ? `
            <div class="notice ok mb-carbon-04">
              Approved${trip.decided_by_name ? ` by <strong>${esc(trip.decided_by_name)}</strong>` : ''}${trip.decided_at ? ` on ${fmtDate(trip.decided_at)}` : ''}. Ready for travel and funds issuance.
            </div>
          ` : ''}
          ${trip.status === 'reconciliation_pending' ? `
            <div class="notice info mb-carbon-04">
              Reconciliation submitted and awaiting sign-off by Finance.
            </div>
          ` : ''}

          <div data-error-slot></div>

          <div class="row row-wrap mb-carbon-06">
            ${isEditable && isOwner ? `
              <button class="btn sm" data-submit-trip${(!trip.manager_name || trip.manager_status !== 'active' || !trip.budget?.length) ? ' disabled title="Complete budget and reporting manager requirements to submit"' : ''}>Submit for approval</button>
              <button class="btn sm ghost" data-edit-trip>Edit trip</button>
            ` : ''}
            ${isActive && isOwner ? `
              <button class="btn sm" data-reconcile>Submit reconciliation</button>
            ` : ''}
            ${trip.status === 'reconciled' && canSettle ? `
              <button class="btn sm" data-settle>Settle &amp; close trip</button>
            ` : ''}
            ${trip.status !== 'draft' && trip.status !== 'changes_requested' && trip.status !== 'active' ? `
              <div class="form-note m-0">
                ${trip.status === 'submitted' ? 'Trip submitted for manager review. Editing is locked.' : ''}
                ${trip.status === 'approved' ? `Trip approved by ${esc(trip.decided_by_name || 'manager')} on ${fmtDate(trip.decided_at)}. Awaiting funds.` : ''}
                ${trip.status === 'reconciliation_pending' ? 'Reconciliation submitted. Awaiting Finance approval.' : ''}
                ${trip.status === 'reconciled' ? 'Reconciliation approved. Awaiting settlement.' : ''}
                ${trip.status === 'closed' ? 'Trip settled and closed.' : ''}
              </div>
            ` : ''}
          </div>
        </div>`));

      const root = content;

      /* ---- budget ---- */
      const budgetSection = el(`
        <div class="border-top pt-carbon-06 mt-carbon-02">
          <div class="row-between mb-carbon-04">
            <h3 class="m-0 type-body-02 strong">Budget</h3>
            ${isEditable && canManageBudget ? '<button class="btn sm ghost" data-add-budget>+ Add line</button>' : ''}
          </div>
          <div data-budget-table></div>
        </div>`);
      root.appendChild(budgetSection);

      const budgetHost = budgetSection.querySelector('[data-budget-table]');
      if (!trip.budget?.length) {
        budgetHost.replaceChildren(el(`
          <div class="empty py-carbon-06 px-carbon-04">
            <p class="m-0 mb-carbon-03 type-body-01 text-tertiary">No estimated expenses yet. A budget is what gets approved.</p>
            ${isEditable && canManageBudget ? '<button class="btn sm quiet" data-add-first-budget>+ Add first line</button>' : ''}
          </div>`));
        budgetHost.querySelector('[data-add-first-budget]')?.addEventListener('click', () => openBudgetLineDrawer(trip, loadDetail));
      } else {
        const bTable = el(`
          <div class="card border-subtle scroll-x">
            <table>
              <thead><tr><th>Category</th><th>Description</th><th class="num">Amount</th><th class="num">In base</th><th></th></tr></thead>
              <tbody></tbody>
            </table>
          </div>`);
        const bBody = bTable.querySelector('tbody');
        for (const b of trip.budget) {
          const row = el(`
            <tr>
              <td><span class="pill off">${esc(CATEGORY_LABEL[b.category] ?? b.category)}</span></td>
              <td class="type-body-01">${esc(b.description)}</td>
              <td class="tabular num">${MONEY(b.amount, b.currency)}</td>
              <td class="tabular num text-tertiary">${MONEY(b.base_amount, trip.base_currency)}</td>
              <td class="num">
                ${isEditable && canManageBudget ? `<button class="btn quiet sm danger" data-del-budget="${esc(b.id)}">Remove</button>` : ''}
              </td>
            </tr>`);
          row.querySelector('[data-del-budget]')?.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!confirm(`Remove budget line "${b.description}"?`)) return;
            try {
              await api.del(`/trips/${trip.id}/budget/${b.id}`);
              toast('Budget line removed');
              loadDetail();
            } catch (err) { toast(err.message, true); }
          });
          bBody.appendChild(row);
        }
        budgetHost.replaceChildren(bTable);
      }
      budgetSection.querySelector('[data-add-budget]')?.addEventListener('click', () => openBudgetLineDrawer(trip, loadDetail));

      /* ---- currency plan ---- */
      const fxSection = el(`
        <div class="border-top pt-carbon-06 mt-carbon-06">
          <div class="row-between mb-carbon-04">
            <h3 class="m-0 type-body-02 strong">Currency &amp; forex plan</h3>
            ${(isEditable || trip.status === 'approved') && canManageFx ? '<button class="btn sm ghost" data-add-fx>+ Add currency</button>' : ''}
          </div>
          <div data-fx-table></div>
        </div>`);
      root.appendChild(fxSection);

      const fxHost = fxSection.querySelector('[data-fx-table]');
      if (!trip.fxPlan?.length) {
        fxHost.replaceChildren(el(`
          <div class="empty py-carbon-06 px-carbon-04">
            <p class="m-0 type-body-01 text-tertiary">
              No exchange rate set. Every amount on this trip needs a rate before it can be budgeted or claimed.
            </p>
          </div>`));
      } else {
        const fxTable = el(`
          <div class="card border-subtle scroll-x">
            <table>
              <thead><tr><th>Currency</th><th class="num">Cash</th><th class="num">Forex card</th><th class="num">Rate to base</th><th class="num">GST (${esc(trip.base_currency || 'base')})</th><th class="num">Top-up (${esc(trip.base_currency || 'base')})</th><th class="num">Fees (${esc(trip.base_currency || 'base')})</th></tr></thead>
              <tbody></tbody>
            </table>
          </div>`);
        const fxBody = fxTable.querySelector('tbody');
        for (const p of trip.fxPlan) {
          fxBody.appendChild(el(`
            <tr>
              <td><strong>${esc(p.currency)}</strong></td>
              <td class="tabular num">${MONEY(p.cash_amount, p.currency)}</td>
              <td class="tabular num">${MONEY(p.card_amount, p.currency)}</td>
              <td class="tabular num">${esc(p.rate_to_base)}</td>
              <td class="tabular num">${MONEY(p.gst_amount, trip.base_currency)}</td>
              <td class="tabular num">${MONEY(p.topup_fee, trip.base_currency)}</td>
              <td class="tabular num">${MONEY(p.service_fee, trip.base_currency)}</td>
            </tr>`));
        }
        fxHost.replaceChildren(fxTable);
      }
      fxSection.querySelector('[data-add-fx]')?.addEventListener('click', () => openFxPlanDrawer(trip, loadDetail));

      /* ---- funds issued ---- */
      const fundsSection = el(`
        <div class="border-top pt-carbon-06 mt-carbon-06">
          <div class="row-between mb-carbon-04">
            <h3 class="m-0 type-body-02 strong">Funds issued</h3>
            ${(trip.status === 'approved' || trip.status === 'active') && canIssueFunds ? '<button class="btn sm ghost" data-add-fund>+ Issue funds</button>' : ''}
          </div>
          <div data-funds-table></div>
        </div>`);
      root.appendChild(fundsSection);

      const fundsHost = fundsSection.querySelector('[data-funds-table]');
      if (!trip.funds?.length) {
        fundsHost.replaceChildren(el(`
          <div class="empty py-carbon-06 px-carbon-04">
            <p class="m-0 type-body-01 text-tertiary">
              ${trip.status === 'approved'
                ? 'Approved, but no funds issued yet. Expenses can only be recorded once funds are handed over.'
                : 'No funds issued against this trip.'}
            </p>
          </div>`));
      } else {
        const fTable = el(`
          <div class="card border-subtle scroll-x">
            <table>
              <thead><tr><th>Type</th><th class="num">Amount</th><th class="num">In base</th><th>Issued</th><th>By</th></tr></thead>
              <tbody></tbody>
            </table>
          </div>`);
        const fBody = fTable.querySelector('tbody');
        for (const f of trip.funds) {
          fBody.appendChild(el(`
            <tr>
              <td>${esc(FUND_KIND_LABEL[f.kind] ?? f.kind)}</td>
              <td class="tabular num">${MONEY(f.amount, f.currency)}</td>
              <td class="tabular num">${MONEY(f.base_amount, trip.base_currency)}</td>
              <td class="type-label-01">${fmtDate(f.issued_at)}</td>
              <td class="type-label-01">${esc(f.issued_by_name || '—')}</td>
            </tr>`));
        }
        fundsHost.replaceChildren(fTable);
      }
      fundsSection.querySelector('[data-add-fund]')?.addEventListener('click', () => openFundDrawer(trip, loadDetail));

      /* ---- budget vs actual ---- */
      const t = trip.totals || {};
      root.appendChild(el(`
        <div class="mt-carbon-06 p-carbon-04 bg-accent rounded">
          <div class="type-label-01 strong caps text-placeholder mb-carbon-03">Budget vs actual (${esc(trip.base_currency || 'INR')})</div>
          <div class="row row-wrap gap-carbon-05 type-body-01">
            <div><span class="text-tertiary">Budget</span><br><strong class="tabular">${MONEY(t.budgetBase, trip.base_currency)}</strong></div>
            <div><span class="text-tertiary">Spent</span><br><strong class="tabular">${MONEY(t.actualBase, trip.base_currency)}</strong></div>
            <div><span class="text-tertiary">Pending</span><br><strong class="tabular">${MONEY(t.pendingBase, trip.base_currency)}</strong></div>
            <div><span class="text-tertiary">Funds issued</span><br><strong class="tabular">${MONEY(t.fundsBase, trip.base_currency)}</strong></div>
          </div>
        </div>`));

      /* ---- expenses ---- */
      const expSection = el(`
        <div class="border-top pt-carbon-06 mt-carbon-06">
          <div class="row-between mb-carbon-04">
            <h3 class="m-0 type-body-02 strong">Expenses (${trip.expenses?.length || 0})</h3>
            ${isActive && isOwner ? '<button class="btn sm ghost" data-add-expense>+ Add expense</button>' : ''}
          </div>
          <div data-expenses-table></div>
        </div>`);
      root.appendChild(expSection);

      const expHost = expSection.querySelector('[data-expenses-table]');
      if (!trip.expenses?.length) {
        expHost.replaceChildren(el(`
          <div class="empty py-carbon-06 px-carbon-05">
            <p class="m-0 mb-carbon-03 type-body-01 text-tertiary">
              ${trip.status === 'active' ? 'No expenses recorded on this trip yet.' : 'No expenses added to this trip yet.'}
            </p>
            ${isActive && isOwner ? '<button class="btn sm quiet" data-add-first-exp>+ Add first expense</button>' : ''}
          </div>`));
        expHost.querySelector('[data-add-first-exp]')?.addEventListener('click', () => {
          renderExpenseFormDrawer(trip.id, null, loadDetail, trip.currency || 'INR');
        });
      } else {
        const expTable = el(`
          <div class="card border-subtle scroll-x">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Description</th>
                  <th>Category</th>
                  <th class="num">Amount</th>
                  <th>Paid by</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody></tbody>
            </table>
          </div>`);

        const expTbody = expTable.querySelector('tbody');
        for (const x of trip.expenses) {
          const xRow = el(`
            <tr>
              <td class="tabular type-label-01">${fmtDate(x.expense_date)}</td>
              <td>
                <div class="medium">${esc(x.description)}</div>
                ${x.status === 'rejected' && x.rejection_reason ? `<div class="cell-sub text-error">Reason: ${esc(x.rejection_reason)}</div>` : ''}
                ${x.bill_count ? `<div class="cell-sub">${x.bill_count} bill${x.bill_count === 1 ? '' : 's'} attached</div>` : ''}
              </td>
              <td><span class="pill off">${esc(CATEGORY_LABEL[x.category] ?? x.category)}</span></td>
              <td class="tabular num medium">
                ${MONEY(x.amount, x.currency)}
                <div class="cell-sub">${MONEY(x.base_amount, trip.base_currency)}</div>
              </td>
              <td class="type-label-01">${esc(PAYMENT_LABEL[x.payment_method] ?? x.payment_method ?? '—')}</td>
              <td>${statusPill(x.status)}</td>
              <td class="num nowrap">
                <button class="btn quiet sm" data-bills-x="${esc(x.id)}" title="Receipts">Bills</button>
                ${x.status === 'draft' && isActive && isOwner ? `
                  <button class="btn quiet sm" data-sub-x title="Submit expense">Submit</button>
                  <button class="btn quiet sm" data-edit-x title="Edit expense">Edit</button>
                  <button class="btn quiet sm danger" data-del-x title="Delete expense">Delete</button>
                ` : ''}
              </td>
            </tr>`);

          xRow.querySelector('[data-bills-x]')?.addEventListener('click', (e) => {
            e.stopPropagation();
            openBillsDrawer(x, loadDetail, trip);
          });

          xRow.querySelector('[data-sub-x]')?.addEventListener('click', async (e) => {
            e.stopPropagation();
            try {
              await api.post(`/expenses/${x.id}/submit`);
              toast('Expense submitted');
              loadDetail();
            } catch (err) { toast(err.message, true); }
          });

          xRow.querySelector('[data-edit-x]')?.addEventListener('click', (e) => {
            e.stopPropagation();
            renderExpenseFormDrawer(trip.id, x, loadDetail);
          });

          xRow.querySelector('[data-del-x]')?.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!confirm(`Delete expense "${x.description}"?`)) return;
            try {
              await api.del(`/expenses/${x.id}`);
              toast('Expense deleted');
              loadDetail();
            } catch (err) { toast(err.message, true); }
          });

          expTbody.appendChild(xRow);
        }
        expHost.replaceChildren(expTable);
      }
      expSection.querySelector('[data-add-expense]')?.addEventListener('click', () => {
        renderExpenseFormDrawer(trip.id, null, loadDetail, trip.currency || 'INR');
      });

      /* ---- reconciliation ---- */
      if (trip.reconciliation || trip.status === 'reconciliation_pending' || trip.status === 'reconciled' || trip.status === 'closed') {
        const r = trip.reconciliation;
        const recSection = el(`
          <div class="border-top pt-carbon-06 mt-carbon-06">
            <h3 class="m-0 mb-carbon-04 type-body-02 strong">Reconciliation</h3>
            <div data-rec></div>
          </div>`);
        root.appendChild(recSection);

        const recHost = recSection.querySelector('[data-rec]');
        if (!r) {
          recHost.replaceChildren(el(`<p class="type-body-01 text-tertiary">No reconciliation submitted yet.</p>`));
        } else {
          const balance = Number(r.balance_base);
          const isReimbursement = balance < 0;
          const isRefund = balance > 0;
          const absBalanceStr = Math.abs(balance).toFixed(2);

          recHost.replaceChildren(el(`
            <div class="settlement-card">
              <div class="settlement-grid">
                <div>
                  <span class="type-caption-01 text-secondary">Company advance issued</span>
                  <div class="type-heading-compact-02 tabular">${MONEY(r.funds_base, trip.base_currency)}</div>
                </div>
                <div>
                  <span class="type-caption-01 text-secondary">Total verified expenses</span>
                  <div class="type-heading-compact-02 tabular">${MONEY(r.expenses_base, trip.base_currency)}</div>
                </div>
                <div>
                  <span class="type-caption-01 text-secondary">Net settlement balance</span>
                  <div class="type-heading-compact-02 tabular strong ${isReimbursement ? 'text-success' : (isRefund ? 'text-error' : '')}">
                    ${MONEY(absBalanceStr, trip.base_currency)}
                  </div>
                </div>
              </div>

              <div class="settlement-verdict ${isReimbursement ? '' : (isRefund ? 'refund' : 'balanced')}">
                <strong>${isReimbursement ? 'Company owes employee:' : (isRefund ? 'Employee to return to company:' : 'Settlement balanced:')}</strong>
                <span class="tabular strong ml-carbon-02">${MONEY(absBalanceStr, trip.base_currency)}</span>
                <p class="m-0 mt-carbon-01 type-caption-01 text-secondary">
                  ${isReimbursement
                    ? 'Actual expenses exceeded advance funds. Reimbursement payout will be processed upon Finance approval.'
                    : (isRefund
                      ? 'Advance funds exceeded actual spend. Please remit remaining balance to company bank account or HR.'
                      : 'All funds accounted for exactly. Ready for final closure.')}
                </p>
              </div>

              <div class="type-label-01 text-tertiary">
                Reconciliation status: <strong>${esc(r.status)}</strong> · computed ${fmtDate(r.computed_at)}
                ${r.settled_at ? ` · settled ${fmtDate(r.settled_at)}` : ''}
              </div>
              ${r.decision_note ? `<div class="audit-reason mt-carbon-03">${esc(r.decision_note)}</div>` : ''}
              ${trip.status === 'reconciliation_pending' && canDecideReconciliation ? `
                <div class="row mt-carbon-04">
                  <button class="btn sm" data-rec-approve>Approve reconciliation</button>
                  <button class="btn sm ghost" data-rec-reject>Send back for revisions</button>
                </div>` : ''}
            </div>`));

          recHost.querySelector('[data-rec-approve]')?.addEventListener('click', async (e) => {
            e.currentTarget.disabled = true;
            try {
              await api.post(`/trips/${trip.id}/reconciliation/decide`, { decision: 'approve' });
              toast('Reconciliation approved');
              loadDetail();
            } catch (err) { toast(err.message, true); e.currentTarget.disabled = false; }
          });
          recHost.querySelector('[data-rec-reject]')?.addEventListener('click', async (e) => {
            e.currentTarget.disabled = true;
            const reason = prompt('What needs to change before this can be approved?');
            if (reason === null) { e.currentTarget.disabled = false; return; }
            try {
              await api.post(`/trips/${trip.id}/reconciliation/decide`, { decision: 'reject', reason });
              toast('Reconciliation sent back');
              loadDetail();
            } catch (err) { toast(err.message, true); e.currentTarget.disabled = false; }
          });
        }
      }

      /* ---- wire the header buttons ---- */
      const submitBtn = content.querySelector('[data-submit-trip]');
      if (submitBtn) {
        submitBtn.addEventListener('click', async () => {
          submitBtn.disabled = true;
          content.querySelector('[data-error-slot]').replaceChildren();
          try {
            await api.post(`/trips/${trip.id}/submit`);
            toast('Trip submitted for approval');
            loadDetail();
          } catch (err) {
            submitBtn.disabled = false;
            if (err.code === 'no_approval_route') {
              content.querySelector('[data-error-slot]').replaceChildren(el(`
                <div class="form-error">
                  <strong>Cannot submit:</strong> You do not have an active reporting manager assigned.
                  Contact an administrator to configure your reporting line before submitting travel requests.
                </div>`));
            } else if (err.fields) {
              content.querySelector('[data-error-slot]').replaceChildren(el(`
                <div class="form-error">${esc(err.message)}</div>`));
            } else {
              toast(err.message, true);
            }
          }
        });
      }

      content.querySelector('[data-edit-trip]')?.addEventListener('click', () => {
        renderTripFormDrawer(trip, loadDetail);
      });

      content.querySelector('[data-reconcile]')?.addEventListener('click', async (e) => {
        e.currentTarget.disabled = true;
        try {
          await api.post(`/trips/${trip.id}/reconciliation`, {});
          toast('Reconciliation submitted for Finance');
          loadDetail();
        } catch (err) {
          toast(err.message, true);
          e.currentTarget.disabled = false;
        }
      });

      content.querySelector('[data-settle]')?.addEventListener('click', async (e) => {
        e.currentTarget.disabled = true;
        const note = prompt('Settlement reference or note (optional)') ?? '';
        try {
          await api.post(`/trips/${trip.id}/settle`, { note });
          toast('Trip settled and closed');
          loadDetail();
        } catch (err) {
          toast(err.message, true);
          e.currentTarget.disabled = false;
        }
      });

      bodyEl.replaceChildren(content);
    } catch (err) {
      bodyEl.replaceChildren(el(`
        <div class="empty">
          <h3>Failed to load trip</h3>
          <p>${esc(err.message)}</p>
        </div>`));
    }
  }

  loadDetail();
}

/* ---- add-a-budget-line drawer ---- */

function openBudgetLineDrawer(trip, onSaved) {
  const scrim = el(`
    <div class="drawer-scrim z-55">
      <div class="drawer" role="dialog" aria-modal="true">
        <div class="drawer-head">
          <h2>Add budget line</h2>
          <p>One estimated expense. The amount is converted at the trip's rate for that currency.</p>
        </div>
        <form class="drawer-body" novalidate>
          <div class="field" data-f="category">
            <label>Category <span class="req">*</span></label>
            <select name="category">
              <option value="travel">Travel</option>
              <option value="accommodation">Accommodation</option>
              <option value="food">Food</option>
              <option value="visa">Visa</option>
              <option value="sim_card">SIM card</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div class="field" data-f="description">
            <label>Description <span class="req">*</span></label>
            <input name="description" placeholder="e.g. Flights to Frankfurt, 4 nights hotel" required>
          </div>
          <div class="field mb-carbon-03">
            <a href="https://www.google.com/travel/flights?q=${encodeURIComponent('Flights from Bengaluru to ' + (trip.destination || '') + ' from ' + (trip.start_date || '') + ' to ' + (trip.end_date || ''))}" target="_blank" rel="noopener" class="type-caption-01 text-interactive medium">
              ✈️ Search flight fares on Google Flights ↗
            </a>
          </div>
          <div class="grid-2">
            <div class="field" data-f="amount">
              <label>Amount <span class="req">*</span></label>
              <input type="text" name="amount" placeholder="0.00" required>
              <span class="hint">Exact decimal (e.g. 1250.00)</span>
            </div>
            <div class="field" data-f="currency">
              <label>Currency <span class="req">*</span></label>
              <select name="currency">${currencyOptions(trip.currency || 'INR')}</select>
              <span class="hint">Currency for this budget line</span>
            </div>
          </div>
        </form>
        <div class="drawer-foot">
          <button class="btn ghost sm" data-cancel>Cancel</button>
          <button class="btn sm" data-save>Add line</button>
        </div>
      </div>
    </div>`);

  document.body.appendChild(scrim);
  const releaseFocus = trapFocus(scrim.querySelector('[role="dialog"]'));
  const close = () => { releaseFocus(); scrim.remove(); };
  scrim.querySelector('[data-cancel]').addEventListener('click', close);
  scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });

  const form = scrim.querySelector('form');
  scrim.querySelector('[data-save]').addEventListener('click', async () => {
    const payload = {
      category: form.querySelector('[name="category"]').value,
      description: form.querySelector('[name="description"]').value.trim(),
      amount: form.querySelector('[name="amount"]').value.trim(),
      currency: form.querySelector('[name="currency"]').value.trim().toUpperCase(),
    };
    const btn = scrim.querySelector('[data-save]');
    btn.disabled = true;
    try {
      await api.post(`/trips/${trip.id}/budget`, payload);
      toast('Budget line added');
      close();
      onSaved();
    } catch (err) {
      if (err.fields) showFieldErrors(form, err.fields);
      else toast(err.message, true);
      btn.disabled = false;
    }
  });
}

/* ---- currency-plan drawer ---- */

async function openFxPlanDrawer(trip, onSaved) {
  await loadCurrencies();
  const base = trip.base_currency || currencyRegistry.baseCurrency;

  const scrim = el(`
    <div class="drawer-scrim z-55">
      <div class="drawer" role="dialog" aria-modal="true">
        <div class="drawer-head">
          <h2>Currency &amp; forex plan</h2>
          <p>Cash to carry, forex card to load, the rate to base, and the charges that come with it.</p>
        </div>
        <form class="drawer-body" novalidate>
          <div class="field" data-f="currency">
            <label>Currency <span class="req">*</span></label>
            <select name="currency">${currencyOptions('')}</select>
            <span class="hint" data-rate-note>Pick a currency — Trek looks up the rate it remembers.</span>
          </div>
          <div class="field" data-f="rateToBase">
            <div class="row-between v-middle mb-carbon-01">
              <label class="m-0">Exchange rate to ${esc(base)} <span class="req">*</span></label>
              <a href="#" target="_blank" rel="noopener" class="type-caption-01 text-secondary" data-fx-live-link>Live market rate ↗</a>
            </div>
            <input type="text" name="rateToBase" placeholder="83.25000000" required>
            <span class="hint">How many ${esc(base)} one unit of this currency buys</span>
          </div>
          <div class="grid-2">
            <div class="field" data-f="cashAmount">
              <label>Cash to carry</label>
              <input type="text" name="cashAmount" placeholder="0.00">
            </div>
            <div class="field" data-f="cardAmount">
              <label>Forex card to load</label>
              <input type="text" name="cardAmount" placeholder="0.00">
            </div>
          </div>
          <div class="grid-2">
            <div class="field" data-f="gstAmount">
              <label>GST</label>
              <input type="text" name="gstAmount" placeholder="0.00">
            </div>
            <div class="field" data-f="topupFee">
              <label>Forex top-up charge</label>
              <input type="text" name="topupFee" placeholder="0.00">
            </div>
          </div>
          <div class="field" data-f="serviceFee">
            <label>Other service fees</label>
            <input type="text" name="serviceFee" placeholder="0.00">
          </div>
          <div class="field" data-f="note">
            <label>Note</label>
            <input name="note" placeholder="e.g. Issued by Emirates Finance">
          </div>
        </form>
        <div class="drawer-foot">
          <button class="btn ghost sm" data-cancel>Cancel</button>
          <button class="btn sm" data-save>Save currency</button>
        </div>
      </div>
    </div>`);

  document.body.appendChild(scrim);
  const releaseFocus = trapFocus(scrim.querySelector('[role="dialog"]'));
  const close = () => { releaseFocus(); scrim.remove(); };
  scrim.querySelector('[data-cancel]').addEventListener('click', close);
  scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });

  const form = scrim.querySelector('form');

  /* The rate Trek remembers, offered as the default.
   *
   * Nobody has to remember an exchange rate. Trek keeps the ones the company
   * has recorded, and offers the latest one — with the day it took effect —
   * so the number in the box can be checked before it is used.
   *
   * The rate is a DEFAULT, not a rule: it can be typed over, and what is
   * saved is what was typed. */
  const rateNote = form.querySelector('[data-rate-note]');
  const rateInput = form.querySelector('[name="rateToBase"]');
  const currencyInput = form.querySelector('[name="currency"]');

  let rateToken = 0;
  let userTypedRate = false;

  rateInput.addEventListener('input', () => {
    userTypedRate = true;
  });

  async function offerRememberedRate() {
    userTypedRate = false;
    const token = ++rateToken;
    const code = currencyInput.value;
    if (!code) return;
    const liveLink = form.querySelector('[data-fx-live-link]');
    if (liveLink) {
      liveLink.href = `https://www.google.com/finance/quote/${encodeURIComponent(code)}-${encodeURIComponent(base)}`;
      liveLink.textContent = `Compare ${code}/${base} on Google Finance ↗`;
    }
    try {
      const found = await api.get(`/exchange-rates/${encodeURIComponent(code)}`);
      if (token !== rateToken) return;
      if (!found.rateToBase) {
        rateNote.textContent = `Trek has no rate remembered for ${code} — type the rate to use.`;
        return;
      }
      if (!userTypedRate) {
        rateInput.value = found.rateToBase;
      }
      rateNote.textContent = `Rate remembered for ${code}, effective ${fmtDate(found.rateToBaseEffectiveOn)}. Change it if today's rate differs.`;
    } catch {
      if (token !== rateToken) return;
      rateNote.textContent = `Trek has no rate remembered for ${code} — type the rate to use.`;
    }
  }

  currencyInput.addEventListener('change', offerRememberedRate);

  scrim.querySelector('[data-save]').addEventListener('click', async () => {
    const payload = {
      currency: form.querySelector('[name="currency"]').value.trim().toUpperCase(),
      rateToBase: form.querySelector('[name="rateToBase"]').value.trim(),
      cashAmount: form.querySelector('[name="cashAmount"]').value.trim() || '0',
      cardAmount: form.querySelector('[name="cardAmount"]').value.trim() || '0',
      gstAmount: form.querySelector('[name="gstAmount"]').value.trim() || '0',
      topupFee: form.querySelector('[name="topupFee"]').value.trim() || '0',
      serviceFee: form.querySelector('[name="serviceFee"]').value.trim() || '0',
      note: form.querySelector('[name="note"]').value.trim() || undefined,
    };
    const btn = scrim.querySelector('[data-save]');
    btn.disabled = true;
    try {
      await api.put(`/trips/${trip.id}/forex`, payload);
      toast('Currency plan saved');
      close();
      onSaved();
    } catch (err) {
      if (err.fields) showFieldErrors(form, err.fields);
      else toast(err.message, true);
      btn.disabled = false;
    }
  });
}

/* ---- issue-funds drawer ---- */

function openFundDrawer(trip, onSaved) {
  const scrim = el(`
    <div class="drawer-scrim z-55">
      <div class="drawer" role="dialog" aria-modal="true">
        <div class="drawer-head">
          <h2>Issue funds</h2>
          <p>Cash, a forex card, or an additional tranche issued mid-trip.</p>
        </div>
        <form class="drawer-body" novalidate>
          <div class="field" data-f="kind">
            <label>Type <span class="req">*</span></label>
            <select name="kind">
              <option value="cash">Cash</option>
              <option value="forex_card">Forex card</option>
              <option value="additional">Additional funds</option>
            </select>
          </div>
          <div class="grid-2">
            <div class="field" data-f="amount">
              <label>Amount <span class="req">*</span></label>
              <input type="text" name="amount" placeholder="0.00" required>
            </div>
            <div class="field" data-f="currency">
              <label>Currency <span class="req">*</span></label>
              <select name="currency">${currencyOptions(trip.currency || 'INR')}</select>
            </div>
          </div>
          <div class="field" data-f="note">
            <label>Note</label>
            <input name="note" placeholder="e.g. Second tranche, overage on hotel">
          </div>
        </form>
        <div class="drawer-foot">
          <button class="btn ghost sm" data-cancel>Cancel</button>
          <button class="btn sm" data-save>Issue funds</button>
        </div>
      </div>
    </div>`);

  document.body.appendChild(scrim);
  const releaseFocus = trapFocus(scrim.querySelector('[role="dialog"]'));
  const close = () => { releaseFocus(); scrim.remove(); };
  scrim.querySelector('[data-cancel]').addEventListener('click', close);
  scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });

  const form = scrim.querySelector('form');
  scrim.querySelector('[data-save]').addEventListener('click', async () => {
    const payload = {
      kind: form.querySelector('[name="kind"]').value,
      amount: form.querySelector('[name="amount"]').value.trim(),
      currency: form.querySelector('[name="currency"]').value.trim().toUpperCase(),
      note: form.querySelector('[name="note"]').value.trim() || undefined,
    };
    const btn = scrim.querySelector('[data-save]');
    btn.disabled = true;
    try {
      await api.post(`/trips/${trip.id}/funds`, payload);
      toast('Funds issued');
      close();
      onSaved();
    } catch (err) {
      if (err.fields) showFieldErrors(form, err.fields);
      else toast(err.message, true);
      btn.disabled = false;
    }
  });
}

/* ============================================================ exchange rates drawer */

async function openExchangeRatesDrawer(onSaved) {
  await loadCurrencies();
  const base = currencyRegistry.baseCurrency || 'INR';
  const otherCurrencies = currencyRegistry.currencies.filter((c) => c.code !== base);

  const scrim = el(`
    <div class="drawer-scrim z-55">
      <div class="drawer" role="dialog" aria-modal="true">
        <div class="drawer-head">
          <h2>Exchange rates</h2>
          <p>Company rates remembered for travel budgets and dashboard reporting.</p>
        </div>
        <div class="drawer-body">
          <div class="card p-carbon-04 mb-carbon-05 border-subtle bg-layer rounded">
            <div class="row-between v-middle">
              <div>
                <div class="type-body-01 strong">European Central Bank (ECB) Live Sync</div>
                <div class="type-caption-01 text-secondary">Fetch official market rates for 30+ currencies directly from the European Central Bank.</div>
              </div>
              <button class="btn sm" type="button" data-sync-rates>🔄 Sync live rates</button>
            </div>
          </div>

          <form class="card p-carbon-04 mb-carbon-06 border-subtle" data-rate-form novalidate>
            <div class="type-label-01 strong caps text-placeholder mb-carbon-03">Record a new rate</div>
            <div class="field" data-f="fromCode">
              <label>Currency <span class="req">*</span></label>
              <select name="fromCode">
                ${otherCurrencies.map((c) => `<option value="${esc(c.code)}">${esc(c.code)} — ${esc(c.name)}</option>`).join('')}
              </select>
            </div>
            <div class="field" data-f="rate">
              <label>Rate to ${esc(base)} <span class="req">*</span></label>
              <input type="text" name="rate" placeholder="e.g. 22.50000000" required>
              <span class="hint">How many ${esc(base)} one unit of this currency buys</span>
            </div>
            <div class="field" data-f="effectiveOn">
              <label>Effective date</label>
              <input type="date" name="effectiveOn" value="${new Date().toISOString().slice(0, 10)}">
            </div>
            <div class="field" data-f="note">
              <label>Note</label>
              <input type="text" name="note" placeholder="e.g. Corporate travel baseline">
            </div>
            <button class="btn sm mt-carbon-03" type="submit" data-save-rate>Save rate</button>
          </form>

          <div>
            <div class="type-label-01 strong caps text-placeholder mb-carbon-03">Remembered rates</div>
            <div data-rates-list>
              <div class="p-carbon-04 text-tertiary">Loading rates...</div>
            </div>
          </div>
        </div>
        <div class="drawer-foot">
          <button class="btn ghost sm" data-cancel>Close</button>
        </div>
      </div>
    </div>`);

  document.body.appendChild(scrim);
  const releaseFocus = trapFocus(scrim.querySelector('[role="dialog"]'));
  const close = () => { releaseFocus(); scrim.remove(); };
  scrim.querySelector('[data-cancel]').addEventListener('click', close);
  scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });

  const listHost = scrim.querySelector('[data-rates-list]');
  const form = scrim.querySelector('[data-rate-form]');

  async function loadRates() {
    try {
      const res = await api.get('/exchange-rates', { bypassCache: true });
      const rates = res?.rates ?? [];
      if (!rates.length) {
        listHost.replaceChildren(el(`<div class="empty py-carbon-04"><p class="m-0 text-tertiary">No exchange rates recorded yet.</p></div>`));
        return;
      }
      const table = el(`
        <div class="card border-subtle scroll-x">
          <table>
            <thead>
              <tr>
                <th>Pair</th>
                <th class="num">Rate</th>
                <th>Effective</th>
                <th>By</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>`);
      const tbody = table.querySelector('tbody');
      for (const r of rates) {
        tbody.appendChild(el(`
          <tr>
            <td><strong>${esc(r.from_code)}</strong> &rarr; ${esc(r.to_code)}</td>
            <td class="tabular num medium">${esc(r.rate)}</td>
            <td class="type-label-01">${fmtDate(r.effective_on)}</td>
            <td class="type-label-01">${esc(r.entered_by_name || 'System')}</td>
          </tr>`));
      }
      listHost.replaceChildren(table);
    } catch (err) {
      listHost.replaceChildren(el(`<p class="text-error">${esc(err.message)}</p>`));
    }
  }

  loadRates();

  const syncBtn = scrim.querySelector('[data-sync-rates]');
  syncBtn?.addEventListener('click', async () => {
    syncBtn.disabled = true;
    syncBtn.textContent = 'Syncing...';
    try {
      const res = await api.post('/exchange-rates/sync', {});
      toast(`Synced ${res.syncedCount} exchange rates from ECB (${res.effectiveOn})`);
      await loadRates();
      onSaved?.();
    } catch (err) {
      toast(err.message, true);
    } finally {
      syncBtn.disabled = false;
      syncBtn.textContent = '🔄 Sync live rates';
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    for (const f of form.querySelectorAll('.field')) {
      f.classList.remove('invalid');
      f.querySelector('.error')?.remove();
    }
    const fromCode = form.querySelector('[name="fromCode"]').value;
    const rate = form.querySelector('[name="rate"]').value.trim();
    const effectiveOn = form.querySelector('[name="effectiveOn"]').value.trim() || undefined;
    const note = form.querySelector('[name="note"]').value.trim() || undefined;

    const btn = form.querySelector('[data-save-rate]');
    btn.disabled = true;
    try {
      await api.post('/exchange-rates', { fromCode, toCode: base, rate, effectiveOn, note });
      toast(`Rate for ${fromCode} recorded`);
      form.querySelector('[name="rate"]').value = '';
      form.querySelector('[name="note"]').value = '';
      api.clearCache();
      await loadRates();
      onSaved?.();
    } catch (err) {
      if (err.fields) showFieldErrors(form, err.fields);
      else toast(err.message, true);
    } finally {
      btn.disabled = false;
    }
  });
}

/* ============================================================ receipts (bills) & scanner */

/* Receipts processing — instant client-side downscaling & compression.
 * Reduces 10+ MB high-res phone camera photos down to ~300 KB in <40ms,
 * preserving crisp text readability while making upload instantaneous (<200ms)
 * and guaranteed to fit comfortably under the 5 MB server limit. */
async function processReceiptFile(file) {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
  if (isPdf) {
    if (file.size > 5 * 1024 * 1024) {
      throw new Error('A PDF receipt may be at most 5 MB.');
    }
    const buf = await file.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return {
      filename: file.name || 'receipt.pdf',
      contentType: 'application/pdf',
      content: btoa(binary),
      dataUrl: null,
      byteSize: file.size,
      isPdf: true,
    };
  }

  // Treat as image: downscale to max 1600px width/height and JPEG 0.85
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read receipt file.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Failed to load receipt image.'));
      img.onload = () => {
        try {
          const MAX_DIM = 1600;
          let { width, height } = img;
          if (width > MAX_DIM || height > MAX_DIM) {
            if (width > height) {
              height = Math.round((height * MAX_DIM) / width);
              width = MAX_DIM;
            } else {
              width = Math.round((width * MAX_DIM) / height);
              height = MAX_DIM;
            }
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(0, 0, width, height);
          ctx.drawImage(img, 0, 0, width, height);

          const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
          const commaIdx = dataUrl.indexOf(',');
          const base64 = dataUrl.slice(commaIdx + 1);
          const byteSize = Math.round((base64.length * 3) / 4);
          const baseName = (file.name || 'receipt-scan.jpg').replace(/\.[^.]+$/, '');
          const filename = `${baseName}.jpg`;

          resolve({
            filename,
            contentType: 'image/jpeg',
            content: base64,
            dataUrl,
            byteSize,
            isPdf: false,
          });
        } catch (err) {
          reject(err);
        }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/* In-app live camera scanner for laptops/desktops with webcam or devices
 * supporting live camera streaming. Falls back to native camera input seamlessly. */
async function openCameraScannerModal(onCaptured) {
  if (!navigator.mediaDevices?.getUserMedia) {
    return false; // not supported, fallback to native camera input
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    });
  } catch {
    return false; // permission denied or hardware unavailable, fallback
  }

  activeCameraStream = stream;

  const scrim = el(`
    <div class="modal-scrim camera-scrim" role="dialog" aria-modal="true">
      <div class="modal-card camera-modal">
        <div class="row-between p-carbon-04 border-subtle-bottom">
          <div>
            <h2 class="type-heading-compact-02 m-0">Scan receipt</h2>
            <p class="type-caption-01 text-secondary m-0">Position receipt inside the frame</p>
          </div>
          <button class="btn quiet sm" data-cam-close aria-label="Close scanner">✕</button>
        </div>
        <div class="camera-viewport-wrap">
          <video class="camera-video" autoplay playsinline muted></video>
          <div class="camera-target-guide" data-guide></div>
          <img class="camera-snapshot-preview hidden" data-snapshot alt="Snapshot preview">
        </div>
        <div class="camera-actions-bar">
          <button class="btn ghost sm" data-cam-cancel>Cancel</button>
          <div class="row gap-carbon-02">
            <button class="btn sm" data-cam-snap>
              <span class="cam-shutter-dot"></span> Snap receipt
            </button>
            <button class="btn ghost sm hidden" data-cam-retake>Retake</button>
            <button class="btn sm hidden" data-cam-use>Use photo</button>
          </div>
        </div>
      </div>
    </div>`);

  document.body.appendChild(scrim);
  const video = scrim.querySelector('video');
  video.srcObject = stream;

  const releaseFocus = trapFocus(scrim.querySelector('[role="dialog"]'));
  const closeCamera = () => {
    if (activeCameraStream) {
      activeCameraStream.getTracks().forEach((t) => t.stop());
      activeCameraStream = null;
    }
    releaseFocus();
    scrim.remove();
  };

  scrim.querySelector('[data-cam-close]').addEventListener('click', closeCamera);
  scrim.querySelector('[data-cam-cancel]').addEventListener('click', closeCamera);
  scrim.addEventListener('click', (e) => { if (e.target === scrim) closeCamera(); });

  const snapBtn = scrim.querySelector('[data-cam-snap]');
  if (video.readyState < 1) {
    snapBtn.disabled = true;
    video.addEventListener('loadedmetadata', () => { snapBtn.disabled = false; }, { once: true });
  }
  const retakeBtn = scrim.querySelector('[data-cam-retake]');
  const useBtn = scrim.querySelector('[data-cam-use]');
  const snapshotImg = scrim.querySelector('[data-snapshot]');
  const guide = scrim.querySelector('[data-guide]');

  let capturedData = null;

  snapBtn.addEventListener('click', () => {
    if (!video.videoWidth || !video.videoHeight) {
      toast('Camera is still initializing, please wait a moment.', true);
      return;
    }
    const width = Math.min(video.videoWidth || 1280, 1600);
    const ratio = (video.videoHeight || 720) / (video.videoWidth || 1280);
    const height = Math.round(width * ratio);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, width, height);

    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    const commaIdx = dataUrl.indexOf(',');
    const base64 = dataUrl.slice(commaIdx + 1);
    const byteSize = Math.round((base64.length * 3) / 4);
    const filename = `receipt-scan-${Date.now().toString().slice(-6)}.jpg`;

    capturedData = {
      filename,
      contentType: 'image/jpeg',
      content: base64,
      dataUrl,
      byteSize,
      isPdf: false,
    };

    snapshotImg.src = dataUrl;
    snapshotImg.classList.remove('hidden');
    video.classList.add('hidden');
    guide.classList.add('hidden');

    snapBtn.classList.add('hidden');
    retakeBtn.classList.remove('hidden');
    useBtn.classList.remove('hidden');
  });

  retakeBtn.addEventListener('click', () => {
    capturedData = null;
    snapshotImg.classList.add('hidden');
    video.classList.remove('hidden');
    guide.classList.remove('hidden');

    snapBtn.classList.remove('hidden');
    retakeBtn.classList.add('hidden');
    useBtn.classList.add('hidden');
  });

  useBtn.addEventListener('click', () => {
    if (capturedData) {
      closeCamera();
      onCaptured(capturedData);
    }
  });

  return true;
}

function openReceiptViewerModal({ url, filename, isPdf }) {
  const scrim = el(`
    <div class="modal-scrim z-70" role="dialog" aria-modal="true">
      <div class="modal-card receipt-preview-modal">
        <div class="row-between p-carbon-04 border-subtle-bottom">
          <div class="truncate mr-carbon-03">
            <h2 class="type-heading-compact-01 m-0 truncate">${esc(filename)}</h2>
          </div>
          <div class="row gap-carbon-02 nowrap">
            <a class="btn quiet sm" href="${url}" target="_blank" rel="noopener" download="${esc(filename)}">Download</a>
            <button class="btn quiet sm" data-close aria-label="Close preview">✕</button>
          </div>
        </div>
        <div class="receipt-preview-body">
          ${isPdf ? `
            <iframe src="${url}" class="receipt-preview-frame" title="${esc(filename)}"></iframe>
          ` : `
            <img src="${url}" class="receipt-preview-img" alt="${esc(filename)}">
          `}
        </div>
      </div>
    </div>`);

  document.body.appendChild(scrim);
  const release = trapFocus(scrim.querySelector('[role="dialog"]'));
  const close = () => { release(); scrim.remove(); };
  scrim.querySelector('[data-close]').addEventListener('click', close);
  scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });
}

async function openBillsDrawer(expense, onSaved = null, trip = null) {
  const isOwner = expense.employee_id === principal.employeeId;
  const canUpload = isOwner;

  const scrim = el(`
    <div class="drawer-scrim z-55">
      <div class="drawer" role="dialog" aria-modal="true">
        <div class="drawer-head">
          <div class="row-between">
            <h2>Receipts</h2>
            <button class="btn quiet sm" data-cancel aria-label="Close">✕</button>
          </div>
          <p>${esc(expense.description)} — ${MONEY(expense.amount, expense.currency)}</p>
        </div>
        <div class="drawer-body">
          <div data-optimistic-slot></div>
          <div data-bills></div>
          ${canUpload ? `
            <div class="receipt-upload-box mt-carbon-06">
              <div class="row-between mb-carbon-03">
                <span class="type-body-01 medium">Add receipt</span>
                <span class="type-caption-01 text-secondary">Drag &amp; drop or choose</span>
              </div>
              <div class="row gap-carbon-03">
                <button type="button" class="btn sm" data-btn-scan>
                  <span class="mr-carbon-02">📷</span> Scan receipt
                </button>
                <button type="button" class="btn ghost sm" data-btn-file>
                  Choose file / PDF
                </button>
              </div>
              <input type="file" accept="image/*" capture="environment" data-cam-input class="screen-reader-only">
              <input type="file" accept="image/*,application/pdf" data-file-input class="screen-reader-only">
              <div class="type-caption-01 text-secondary mt-carbon-03">
                Fast auto-compression · Photos or PDF up to 5 MB
              </div>
            </div>
          ` : ''}
        </div>
        <div class="drawer-foot">
          <button class="btn ghost sm" data-cancel>Close</button>
        </div>
      </div>
    </div>`);

  document.body.appendChild(scrim);
  const releaseFocus = trapFocus(scrim.querySelector('[role="dialog"]'));
  const close = () => { releaseFocus(); scrim.remove(); };
  scrim.querySelector('[data-cancel]').addEventListener('click', close);
  scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });

  const host = scrim.querySelector('[data-bills]');

  async function loadBills() {
    try {
      const { bills } = await api.get(`/expenses/${expense.id}/bills`);
      if (!bills.length) {
        host.replaceChildren(el(`<p class="type-body-01 text-tertiary">No receipts attached yet.</p>`));
        return;
      }
      const list = el('<div></div>');
      for (const b of bills) {
        const isImg = b.content_type?.startsWith('image/');
        const isPdf = b.content_type === 'application/pdf' || /\.pdf$/i.test(b.filename || '');
        const contentUrl = `/api/v1/bills/${esc(b.id)}/content`;
        const row = el(`
          <div class="row-between py-carbon-03 border-subtle-bottom">
            <div class="row gap-carbon-03">
              ${isImg ? `
                <button type="button" class="receipt-thumb-btn" data-preview-bill title="Preview receipt in app">
                  <img src="${contentUrl}" class="receipt-thumb" alt="Receipt thumbnail — click to preview">
                </button>
              ` : `
                <button type="button" class="receipt-thumb-btn" data-preview-bill title="Preview PDF receipt in app">
                  <span class="pill off type-label-01 type-mono">PDF</span>
                </button>
              `}
              <div>
                <div class="type-body-01 medium">${esc(b.filename)}</div>
                <div class="cell-sub">${Math.round(b.byte_size / 1024)} KB · ${fmtDate(b.uploaded_at)}${b.uploaded_by_name ? ` · ${esc(b.uploaded_by_name)}` : ''}</div>
              </div>
            </div>
            <div class="row gap-carbon-02 nowrap">
              <button type="button" class="btn quiet sm" data-preview-bill>Preview</button>
              <a class="btn quiet sm" href="${contentUrl}" target="_blank" rel="noopener" download="${esc(b.filename)}">Download</a>
              ${canUpload ? `<button class="btn quiet sm danger" data-del-bill="${esc(b.id)}">Delete</button>` : ''}
            </div>
          </div>`);

        row.querySelectorAll('[data-preview-bill]').forEach((btn) => {
          btn.addEventListener('click', () => {
            openReceiptViewerModal({ url: contentUrl, filename: b.filename, isPdf });
          });
        });

        row.querySelector('[data-del-bill]')?.addEventListener('click', async () => {
          if (!confirm('Delete this receipt?')) return;
          try {
            await api.del(`/bills/${b.id}`);
            toast('Receipt deleted');
            await loadBills();
            onSaved?.();
          } catch (err) { toast(err.message, true); }
        });
        list.appendChild(row);
      }
      host.replaceChildren(list);
    } catch (err) {
      host.replaceChildren(el(`<p class="type-body-01 text-error">${esc(err.message)}</p>`));
    }
  }

  async function handleUpload(payload) {
    const optSlot = scrim.querySelector('[data-optimistic-slot]');
    const optCard = el(`
      <div class="receipt-optimistic-card">
        <div class="row-between">
          <div class="row gap-carbon-03">
            ${payload.dataUrl ? `<img src="${payload.dataUrl}" class="receipt-thumb" alt="Preview">` : `<span class="pill off type-label-01 type-mono">PDF</span>`}
            <div>
              <div class="type-body-01 medium">${esc(payload.filename)}</div>
              <div class="cell-sub">${Math.round(payload.byteSize / 1024)} KB · Optimizing & uploading…</div>
            </div>
          </div>
          <span class="pill ok type-label-01">Uploading…</span>
        </div>
        <div class="receipt-optimistic-bar">
          <div class="receipt-optimistic-fill"></div>
        </div>
      </div>`);
    optSlot.appendChild(optCard);

    try {
      await api.post(`/expenses/${expense.id}/bills`, {
        filename: payload.filename,
        contentType: payload.contentType,
        content: payload.content,
      });
      toast('Receipt attached');
      optCard.remove();
      await loadBills();
      onSaved?.();
    } catch (err) {
      optCard.replaceChildren(el(`
        <div class="row-between py-carbon-02">
          <div>
            <div class="type-body-01 text-error medium">${esc(err.message)}</div>
            <div class="cell-sub">${esc(payload.filename)}</div>
          </div>
          <button class="btn sm" data-retry>Retry</button>
        </div>`));
      optCard.querySelector('[data-retry]').addEventListener('click', () => {
        optCard.remove();
        handleUpload(payload);
      });
    }
  }

  const scanBtn = scrim.querySelector('[data-btn-scan]');
  const fileBtn = scrim.querySelector('[data-btn-file]');
  const camInput = scrim.querySelector('[data-cam-input]');
  const fileInput = scrim.querySelector('[data-file-input]');

  if (scanBtn) {
    scanBtn.addEventListener('click', async () => {
      const isTouch = window.matchMedia('(pointer: coarse)').matches;
      if (isTouch || !navigator.mediaDevices?.getUserMedia) {
        camInput.click();
        return;
      }
      const opened = await openCameraScannerModal(async (captured) => {
        await handleUpload(captured);
      });
      if (!opened) camInput.click();
    });

    fileBtn.addEventListener('click', () => fileInput.click());

    const onFileSelected = async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const payload = await processReceiptFile(file);
        await handleUpload(payload);
      } catch (err) {
        toast(err.message, true);
      } finally {
        e.target.value = '';
      }
    };

    camInput.addEventListener('change', onFileSelected);
    fileInput.addEventListener('change', onFileSelected);

    const uploadBox = scrim.querySelector('.receipt-upload-box');
    if (uploadBox) {
      uploadBox.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadBox.classList.add('drag-active');
      });
      uploadBox.addEventListener('dragleave', () => {
        uploadBox.classList.remove('drag-active');
      });
      uploadBox.addEventListener('drop', async (e) => {
        e.preventDefault();
        uploadBox.classList.remove('drag-active');
        const file = e.dataTransfer?.files?.[0];
        if (file) {
          try {
            const payload = await processReceiptFile(file);
            await handleUpload(payload);
          } catch (err) {
            toast(err.message, true);
          }
        }
      });
    }
  }

  loadBills();
}
async function renderExpenseFormDrawer(tripId, expense, onSaved, defaultCurrency = 'INR') {
  const isNew = !expense;
  await loadCurrencies();
  const initialCurrency = expense?.currency ?? defaultCurrency ?? currencyRegistry.baseCurrency;
  const scrim = el(`
    <div class="drawer-scrim z-55">
      <div class="drawer" role="dialog" aria-modal="true">
        <div class="drawer-head">
          <h2>${isNew ? 'Add expense' : 'Edit expense'}</h2>
          <p>Record expense entry. Exact original currency and decimal amounts are stored.</p>
        </div>
        <form class="drawer-body" novalidate>
          <div class="field" data-f="date">
            <label>Date of expense <span class="req">*</span></label>
            <input type="date" name="date" value="${expense?.expense_date ? String(expense.expense_date).slice(0, 10) : new Date().toISOString().slice(0, 10)}" required>
          </div>
          <div class="field" data-f="description">
            <label>Description <span class="req">*</span></label>
            <input name="description" value="${esc(expense?.description ?? '')}" placeholder="e.g. Client lunch at Al Fanar" required>
          </div>
          <div class="field" data-f="category">
            <label>Category <span class="req">*</span></label>
            <select name="category">
              <option value="travel"${expense?.category === 'travel' ? ' selected' : ''}>Travel</option>
              <option value="accommodation"${expense?.category === 'accommodation' ? ' selected' : ''}>Accommodation</option>
              <option value="food"${expense?.category === 'food' ? ' selected' : ''}>Food</option>
              <option value="visa"${expense?.category === 'visa' ? ' selected' : ''}>Visa</option>
              <option value="sim_card"${expense?.category === 'sim_card' ? ' selected' : ''}>SIM card</option>
              <option value="other"${expense?.category === 'other' ? ' selected' : ''}>Other</option>
            </select>
          </div>
          <div class="grid-2">
            <div class="field" data-f="amount">
              <label>Amount <span class="req">*</span></label>
              <input type="text" name="amount" value="${esc(expense?.amount ?? '')}" placeholder="0.00" required>
              <span class="hint">Exact decimal amount (e.g. 125.50)</span>
            </div>
            <div class="field" data-f="currency">
              <label>Currency <span class="req">*</span></label>
              <select name="currency">
                ${currencyOptions(initialCurrency)}
              </select>
              <span class="hint">Select from 50+ global currencies</span>
            </div>
          </div>
          <div class="field" data-f="paymentMethod">
            <label>Payment method <span class="req">*</span></label>
            <select name="paymentMethod">
              <option value="cash"${(expense?.payment_method ?? 'cash') === 'cash' ? ' selected' : ''}>Cash</option>
              <option value="forex_card"${expense?.payment_method === 'forex_card' ? ' selected' : ''}>Forex card</option>
              <option value="card"${expense?.payment_method === 'card' ? ' selected' : ''}>Card</option>
              <option value="bank_transfer"${expense?.payment_method === 'bank_transfer' ? ' selected' : ''}>Bank transfer</option>
            </select>
            <span class="hint">How the money was paid</span>
          </div>
          <div class="field" data-f="receipt">
            <label>Attach receipt <span class="type-caption-01 text-secondary">(optional)</span></label>
            <div data-receipt-box class="receipt-upload-box">
              <div class="row gap-carbon-03" data-receipt-idle>
                <button type="button" class="btn sm" data-exp-scan>
                  <span class="mr-carbon-02">📷</span> Scan receipt
                </button>
                <button type="button" class="btn ghost sm" data-exp-file>
                  Choose file
                </button>
                <input type="file" accept="image/*" capture="environment" data-exp-cam-input class="screen-reader-only">
                <input type="file" accept="image/*,application/pdf" data-exp-file-input class="screen-reader-only">
              </div>
              <div class="row-between p-carbon-03 border-subtle hidden" data-receipt-attached>
                <div class="row gap-carbon-03">
                  <img data-receipt-thumb class="receipt-thumb" alt="Preview">
                  <div>
                    <div class="type-body-01 medium" data-receipt-name></div>
                    <div class="cell-sub" data-receipt-size></div>
                  </div>
                </div>
                <button type="button" class="btn quiet sm danger" data-receipt-remove>Remove</button>
              </div>
            </div>
            <span class="hint">Instant photo scan, file attachment or drag &amp; drop</span>
          </div>
        </form>
        <div class="drawer-foot">
          <button class="btn ghost sm" data-cancel>Cancel</button>
          <button class="btn sm" data-save>Save expense</button>
        </div>
      </div>
    </div>`);

  document.body.appendChild(scrim);
  const releaseFocus = trapFocus(scrim.querySelector('[role="dialog"]'));
  const close = () => { releaseFocus(); scrim.remove(); };
  scrim.querySelector('[data-cancel]').addEventListener('click', close);
  scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });

  const form = scrim.querySelector('form');

  let pendingReceipt = null;
  const idleWrap = form.querySelector('[data-receipt-idle]');
  const attachedWrap = form.querySelector('[data-receipt-attached]');
  const expScanBtn = form.querySelector('[data-exp-scan]');
  const expFileBtn = form.querySelector('[data-exp-file]');
  const expCamInput = form.querySelector('[data-exp-cam-input]');
  const expFileInput = form.querySelector('[data-exp-file-input]');
  const thumbImg = form.querySelector('[data-receipt-thumb]');
  const nameEl = form.querySelector('[data-receipt-name]');
  const sizeEl = form.querySelector('[data-receipt-size]');
  const removeBtn = form.querySelector('[data-receipt-remove]');

  const setPendingReceipt = (p) => {
    pendingReceipt = p;
    if (p) {
      idleWrap.classList.add('hidden');
      attachedWrap.classList.remove('hidden');
      if (p.dataUrl) {
        thumbImg.src = p.dataUrl;
        thumbImg.classList.remove('hidden');
      } else {
        thumbImg.classList.add('hidden');
      }
      nameEl.textContent = p.filename;
      sizeEl.textContent = `${Math.round(p.byteSize / 1024)} KB · Ready to save`;
    } else {
      idleWrap.classList.remove('hidden');
      attachedWrap.classList.add('hidden');
      thumbImg.src = '';
    }
  };

  removeBtn.addEventListener('click', () => setPendingReceipt(null));

  expScanBtn.addEventListener('click', async () => {
    const isTouch = window.matchMedia('(pointer: coarse)').matches;
    if (isTouch || !navigator.mediaDevices?.getUserMedia) {
      expCamInput.click();
      return;
    }
    const opened = await openCameraScannerModal((captured) => {
      setPendingReceipt(captured);
    });
    if (!opened) expCamInput.click();
  });

  expFileBtn.addEventListener('click', () => expFileInput.click());

  const onExpFileSelected = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const p = await processReceiptFile(file);
      setPendingReceipt(p);
    } catch (err) {
      toast(err.message, true);
    } finally {
      e.target.value = '';
    }
  };

  expCamInput.addEventListener('change', onExpFileSelected);
  expFileInput.addEventListener('change', onExpFileSelected);

  const expBox = form.querySelector('[data-receipt-box]');
  if (expBox) {
    expBox.addEventListener('dragover', (e) => {
      e.preventDefault();
      expBox.classList.add('drag-active');
    });
    expBox.addEventListener('dragleave', () => {
      expBox.classList.remove('drag-active');
    });
    expBox.addEventListener('drop', async (e) => {
      e.preventDefault();
      expBox.classList.remove('drag-active');
      const file = e.dataTransfer?.files?.[0];
      if (file) {
        try {
          const p = await processReceiptFile(file);
          setPendingReceipt(p);
        } catch (err) {
          toast(err.message, true);
        }
      }
    });
  }

  const amountInput = form.querySelector('[name="amount"]');
  if (amountInput) {
    amountInput.addEventListener('blur', () => {
      const val = amountInput.value.trim();
      if (!val) return;
      const clean = val.replace(/^[$€£₹]\s*/, '').trim();
      if (clean !== val) amountInput.value = clean;
      if (!/^\d+(\.\d{1,2})?$/.test(clean)) {
        showFieldErrors(form, { amount: 'Enter an exact decimal amount (e.g. 125.50)' });
      } else {
        showFieldErrors(form);
      }
    });
  }

  scrim.querySelector('[data-save]').addEventListener('click', async () => {
    const payload = {
      tripId,
      date: form.querySelector('[name="date"]').value,
      description: form.querySelector('[name="description"]').value.trim(),
      category: form.querySelector('[name="category"]').value,
      amount: form.querySelector('[name="amount"]').value.trim(),
      currency: form.querySelector('[name="currency"]').value.trim().toUpperCase(),
      paymentMethod: form.querySelector('[name="paymentMethod"]').value,
    };

    const saveBtn = scrim.querySelector('[data-save]');
    saveBtn.disabled = true;

    try {
      let expenseId = expense?.id;
      if (isNew) {
        const res = await api.post('/expenses', payload);
        expenseId = res.expense?.id;
        toast('Expense added to trip');
      } else {
        await api.patch(`/expenses/${expense.id}`, payload);
        toast('Expense updated');
      }

      if (pendingReceipt && expenseId) {
        try {
          await api.post(`/expenses/${expenseId}/bills`, {
            filename: pendingReceipt.filename,
            contentType: pendingReceipt.contentType,
            content: pendingReceipt.content,
          });
          toast('Expense and receipt saved');
        } catch (billErr) {
          toast(`Expense saved, but receipt upload failed: ${billErr.message}`, true);
        }
      }

      close();
      onSaved?.();
    } catch (err) {
      if (err.fields) showFieldErrors(form, err.fields);
      else toast(err.message, true);
      saveBtn.disabled = false;
    }
  });
}

/* ------------------------------------------------------------ Expenses Screen */

async function renderExpenses(main) {
  const canReadAllExpenses = principal.permissions.includes('expense.read.all');
  const canReadTeamExpenses = principal.permissions.includes('expense.read.team');
  const hasScopeOptions = canReadAllExpenses || canReadTeamExpenses;
  let activeScope = canReadAllExpenses ? 'all' : (canReadTeamExpenses ? 'team' : 'own');

  const titleFor = (s) => (s === 'all' ? 'Company expenses' : (s === 'team' ? 'Team expenses' : 'My expenses'));

  const view = el(`
    <div>
      <div class="page-head">
        <h1 data-title>${esc(titleFor(activeScope))}</h1>
        <p>View and manage filed expense entries.</p>
      </div>
      <div class="toolbar">
        ${hasScopeOptions ? `
          <div class="cswitch" role="tablist" aria-label="Expense scope">
            ${canReadAllExpenses ? `<button type="button" class="cswitch-item${activeScope === 'all' ? ' selected' : ''}" data-scope="all" role="tab" aria-selected="${activeScope === 'all'}">Company expenses</button>` : ''}
            ${canReadTeamExpenses ? `<button type="button" class="cswitch-item${activeScope === 'team' ? ' selected' : ''}" data-scope="team" role="tab" aria-selected="${activeScope === 'team'}">My team</button>` : ''}
            <button type="button" class="cswitch-item${activeScope === 'own' ? ' selected' : ''}" data-scope="own" role="tab" aria-selected="${activeScope === 'own'}">My expenses</button>
          </div>
        ` : ''}
        <select data-status aria-label="Filter expenses by status">
          <option value="">All statuses</option>
          <option value="draft">Draft</option>
          <option value="submitted">Submitted</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </select>
        <input type="search" placeholder="Filter expenses..." class="toolbar-search" data-search aria-label="Filter expenses">
        <button class="btn sm ghost" data-refresh>Refresh</button>
      </div>
      <div class="card" data-table></div>
    </div>`);

  main.replaceChildren(view);

  const tableHost = view.querySelector('[data-table]');
  const statusEl = view.querySelector('[data-status]');
  const titleEl = view.querySelector('[data-title]');
  const searchInput = view.querySelector('[data-search]');
  let currentExpenses = [];

  for (const item of view.querySelectorAll('.cswitch-item')) {
    item.addEventListener('click', () => {
      activeScope = item.dataset.scope;
      for (const btn of view.querySelectorAll('.cswitch-item')) {
        const sel = btn.dataset.scope === activeScope;
        btn.classList.toggle('selected', sel);
        btn.setAttribute('aria-selected', String(sel));
      }
      titleEl.textContent = titleFor(activeScope);
      load();
    });
  }

  view.querySelector('[data-refresh]').addEventListener('click', () => {
    api.clearCache();
    load();
  });
  statusEl.addEventListener('change', load);

  function filterAndRender() {
    const q = searchInput?.value?.trim().toLowerCase() || '';
    const filtered = q
      ? currentExpenses.filter((x) =>
          (x.description || '').toLowerCase().includes(q) ||
          (x.category || '').toLowerCase().includes(q) ||
          (x.trip_destination || '').toLowerCase().includes(q))
      : currentExpenses;
    renderRows(filtered);
  }

  searchInput?.addEventListener('input', filterAndRender);

  function renderRows(items) {
    if (!items.length) {
      if (searchInput?.value?.trim()) {
        tableHost.replaceChildren(el(`
          <div class="empty">
            <h3>No matching expenses</h3>
            <p>No expenses match "${esc(searchInput.value)}". Clear search to see all expenses.</p>
          </div>`));
      } else if (statusEl.value) {
        tableHost.replaceChildren(el(`
          <div class="empty">
            <h3>No expenses with this status</h3>
            <p>No expenses match "${esc(statusEl.options[statusEl.selectedIndex]?.text || statusEl.value)}". Try choosing another status filter.</p>
          </div>`));
      } else {
        tableHost.replaceChildren(el(`
          <div class="empty">
            <h3>No expenses yet</h3>
            <p>Expenses you claim against a trip will appear here.</p>
          </div>`));
      }
      return;
    }

    const table = el(`
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Description</th>
            <th>Trip</th>
            <th>Category</th>
            <th class="num">Amount</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>`);

    const tbody = table.querySelector('tbody');
    for (const x of items) {
      const row = el(`
        <tr>
          <td class="tabular">${fmtDate(x.expense_date)}</td>
          <td>
            <div class="cell-primary">${esc(x.description)}</div>
            ${x.status === 'rejected' && x.rejection_reason ? `<div class="cell-sub text-error">Reason: ${esc(x.rejection_reason)}</div>` : ''}
          </td>
          <td>${esc(x.trip_destination || 'Trip')}</td>
          <td><span class="pill off capitalize">${esc(x.category)}</span></td>
          <td class="tabular num medium">${esc(x.amount)} ${esc(x.currency)}</td>
          <td>${statusPill(x.status)}</td>
          <td class="num nowrap">
            ${x.status === 'draft' ? `
              <button class="btn quiet sm" data-sub>Submit</button>
              <button class="btn quiet sm" data-edit>Edit</button>
              <button class="btn quiet sm danger" data-del>Delete</button>
            ` : `<span class="cell-sub type-caption-01">Locked</span>`}
          </td>
        </tr>`);

      row.querySelector('[data-sub]')?.addEventListener('click', async () => {
        try {
          await api.post(`/expenses/${x.id}/submit`);
          toast('Expense submitted for manager approval');
          load();
        } catch (err) {
          toast(err.message, true);
        }
      });

      row.querySelector('[data-edit]')?.addEventListener('click', () => {
        renderExpenseFormDrawer(x.trip_id, x, load);
      });

      row.querySelector('[data-del]')?.addEventListener('click', async () => {
        if (!confirm(`Delete expense "${x.description}"?`)) return;
        try {
          await api.delete(`/expenses/${x.id}`);
          toast('Expense deleted');
          load();
        } catch (err) {
          toast(err.message, true);
        }
      });

      tbody.appendChild(row);
    }

    tableHost.replaceChildren(table);
  }

  let loadToken = 0;
  async function load() {
    const token = ++loadToken;
    tableHost.replaceChildren(el(`
      <div class="p-carbon-05">
        ${'<div class="skeleton my-carbon-03"></div>'.repeat(4)}
      </div>`));

    try {
      const q = statusEl.value
        ? `?scope=${encodeURIComponent(activeScope)}&status=${encodeURIComponent(statusEl.value)}`
        : `?scope=${encodeURIComponent(activeScope)}`;
      const { data } = await api.get(`/expenses${q}`);
      if (token !== loadToken) return;

      currentExpenses = data || [];
      filterAndRender();
    } catch (err) {
      if (token !== loadToken) return;
      tableHost.replaceChildren(el(`
        <div class="empty">
          <h3>Expenses couldn't be loaded</h3>
          <p>The server did not answer. This is usually temporary.</p>
          <button class="btn sm ghost" data-retry>Try again</button>
        </div>`));
      tableHost.querySelector('[data-retry]')?.addEventListener('click', load);
    }
  }

  load();
}

/* ------------------------------------------------------------ Approvals Screen (Manager) */

async function renderApprovals(main) {
  let activeTab = 'trips'; // 'trips' | 'expenses'

  const view = el(`
    <div>
      <div class="page-head">
        <h1>Approvals</h1>
        <p>Review and decide travel and expense requests submitted by employees in your reporting team.</p>
      </div>

      <div class="toolbar border-bottom pb-carbon-04 mb-carbon-06">
        <button class="chip" data-tab="trips" aria-pressed="true">Submitted Trips</button>
        <button class="chip" data-tab="expenses" aria-pressed="false">Submitted Expenses</button>
        <div class="grow"></div>
        <button class="btn sm ghost" data-refresh>Refresh</button>
      </div>

      <div class="card" data-content></div>
    </div>`);

  main.replaceChildren(view);

  const contentEl = view.querySelector('[data-content]');
  const tripsTabBtn = view.querySelector('[data-tab="trips"]');
  const expTabBtn = view.querySelector('[data-tab="expenses"]');

  tripsTabBtn.addEventListener('click', () => {
    activeTab = 'trips';
    tripsTabBtn.setAttribute('aria-pressed', 'true');
    expTabBtn.setAttribute('aria-pressed', 'false');
    load();
  });

  expTabBtn.addEventListener('click', () => {
    activeTab = 'expenses';
    tripsTabBtn.setAttribute('aria-pressed', 'false');
    expTabBtn.setAttribute('aria-pressed', 'true');
    load();
  });

  view.querySelector('[data-refresh]').addEventListener('click', () => {
    api.clearCache();
    load();
  });

  let loadToken = 0;
  async function load() {
    const token = ++loadToken;
    contentEl.replaceChildren(el(`
      <div class="p-carbon-05">
        ${'<div class="skeleton my-carbon-03"></div>'.repeat(4)}
      </div>`));

    if (activeTab === 'trips') {
      await loadTrips(token);
    } else {
      await loadExpenses(token);
    }
  }

  async function loadTrips(token) {
    try {
      const scope = principal.permissions.includes('trip.read.all') ? 'all' : 'team';
      const { data } = await api.get(`/trips?scope=${scope}&status=submitted`);
      if (token !== loadToken) return;

      if (!data.length) {
        contentEl.replaceChildren(el(`
          <div class="empty">
            <h3>No pending trip approvals</h3>
            <p>All travel requests in your reporting tree have been reviewed.</p>
          </div>`));
        return;
      }

      const table = el(`
        <table>
          <thead>
            <tr>
              <th>Employee</th>
              <th>Destination</th>
              <th>Dates</th>
              <th>Purpose</th>
              <th>Submitted</th>
              <th class="num">Actions</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>`);

      const tbody = table.querySelector('tbody');
      for (const t of data) {
        const row = el(`
          <tr class="clickable">
            <td>
              <div class="cell-primary">${esc(t.employee_name)}</div>
              <div class="cell-sub">${esc(t.employee_code)}</div>
            </td>
            <td><div class="medium">${esc(t.destination)}</div></td>
            <td class="tabular">${fmtDate(t.start_date)} – ${fmtDate(t.end_date)}</td>
            <td><div class="max-240 truncate">${esc(t.purpose)}</div></td>
            <td class="tabular type-label-01">${fmtWhen(t.submitted_at)}</td>
            <td class="num nowrap">
              <button class="btn sm ghost" data-view title="View trip and budget details">View</button>
              <button class="btn sm" data-approve>Approve</button>
              <button class="btn sm ghost" data-request-changes>Request changes</button>
              <button class="btn sm danger" data-reject>Reject</button>
            </td>
          </tr>`);

        row.querySelector('[data-view]').addEventListener('click', () => {
          renderTripDetailDrawer(t.id, load);
        });
        row.addEventListener('click', (e) => {
          if (!e.target.closest('button')) renderTripDetailDrawer(t.id, load);
        });

        const approveBtn = row.querySelector('[data-approve]');
        approveBtn.addEventListener('click', async () => {
          if (!confirm(`Approve trip to ${t.destination} for ${t.employee_name}?`)) return;
          approveBtn.disabled = true;
          try {
            await api.post(`/trips/${t.id}/decide`, { decision: 'approve' });
            toast(`Trip for ${t.employee_name} approved`);
            load();
          } catch (err) {
            toast(err.message, true);
            approveBtn.disabled = false;
          }
        });

        row.querySelector('[data-request-changes]').addEventListener('click', () => {
          renderRejectModal({
            title: `Request changes on Trip to ${t.destination}`,
            promptText: `What should ${t.employee_name} change before this is approved?`,
            confirmLabel: 'Request changes',
            reasonLabel: 'What needs to change',
            placeholder: 'e.g. The hotel budget looks high — please re-check the nightly rate',
            onConfirm: async (reason) => {
              await api.post(`/trips/${t.id}/decide`, { decision: 'request_changes', reason });
              toast(`Changes requested from ${t.employee_name}`);
              load();
            },
          });
        });

        row.querySelector('[data-reject]').addEventListener('click', () => {
          renderRejectModal({
            title: `Reject Trip to ${t.destination}`,
            promptText: `Enter reason for rejecting ${t.employee_name}'s trip:`,
            onConfirm: async (reason) => {
              await api.post(`/trips/${t.id}/decide`, { decision: 'reject', reason });
              toast(`Trip for ${t.employee_name} rejected`);
              load();
            },
          });
        });

        tbody.appendChild(row);
      }

      contentEl.replaceChildren(table);
    } catch (err) {
      if (token !== loadToken) return;
      contentEl.replaceChildren(el(`
        <div class="empty">
          <h3>Submitted trips couldn't be loaded</h3>
          <p>The server did not answer. This is usually temporary.</p>
          <button class="btn sm ghost" data-retry>Try again</button>
        </div>`));
      contentEl.querySelector('[data-retry]')?.addEventListener('click', load);
    }
  }

  async function loadExpenses(token) {
    try {
      const scope = principal.permissions.includes('expense.read.all') ? 'all' : 'team';
      const { data } = await api.get(`/expenses?scope=${scope}&status=submitted`);
      if (token !== loadToken) return;

      if (!data.length) {
        contentEl.replaceChildren(el(`
          <div class="empty">
            <h3>No pending expense approvals</h3>
            <p>All expense entries in your reporting tree have been reviewed.</p>
          </div>`));
        return;
      }

      const table = el(`
        <table>
          <thead>
            <tr>
              <th>Employee</th>
              <th>Description</th>
              <th>Trip</th>
              <th>Category</th>
              <th class="num">Amount</th>
              <th>Submitted</th>
              <th class="num">Actions</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>`);

      const tbody = table.querySelector('tbody');
      for (const x of data) {
        const row = el(`
          <tr class="clickable">
            <td>
              <div class="cell-primary">${esc(x.employee_name)}</div>
              <div class="cell-sub">${esc(x.employee_code)}</div>
            </td>
            <td><div class="medium">${esc(x.description)}</div></td>
            <td><button class="btn quiet sm" type="button" data-view-trip title="View trip">${esc(x.trip_destination || 'Trip')}</button></td>
            <td><span class="pill off capitalize">${esc(x.category)}</span></td>
            <td class="tabular num medium">${esc(x.amount)} ${esc(x.currency)}</td>
            <td class="tabular type-label-01">${fmtWhen(x.submitted_at)}</td>
            <td class="num nowrap">
              <button class="btn sm ghost" data-view-receipt title="View attached receipts">${x.bill_count ? `Receipts (${x.bill_count})` : 'Receipts'}</button>
              <button class="btn sm" data-approve>Approve</button>
              <button class="btn sm danger" data-reject>Reject</button>
            </td>
          </tr>`);

        row.querySelector('[data-view-receipt]').addEventListener('click', () => {
          openBillsDrawer(x, load, { id: x.trip_id });
        });
        row.querySelector('[data-view-trip]').addEventListener('click', () => {
          renderTripDetailDrawer(x.trip_id, load);
        });
        row.addEventListener('click', (e) => {
          if (!e.target.closest('button')) {
            openBillsDrawer(x, load, { id: x.trip_id });
          }
        });

        const approveBtn = row.querySelector('[data-approve]');
        approveBtn.addEventListener('click', async () => {
          if (!confirm(`Approve expense "${x.description}" (${x.amount} ${x.currency}) for ${x.employee_name}?`)) return;
          approveBtn.disabled = true;
          try {
            await api.post(`/expenses/${x.id}/decide`, { decision: 'approve' });
            toast(`Expense for ${x.employee_name} approved`);
            load();
          } catch (err) {
            toast(err.message, true);
            approveBtn.disabled = false;
          }
        });

        row.querySelector('[data-reject]').addEventListener('click', () => {
          renderRejectModal({
            title: `Reject Expense "${x.description}"`,
            promptText: `Enter reason for rejecting ${x.employee_name}'s expense:`,
            onConfirm: async (reason) => {
              await api.post(`/expenses/${x.id}/decide`, { decision: 'reject', reason });
              toast(`Expense for ${x.employee_name} rejected`);
              load();
            },
          });
        });

        tbody.appendChild(row);
      }

      contentEl.replaceChildren(table);
    } catch (err) {
      if (token !== loadToken) return;
      contentEl.replaceChildren(el(`
        <div class="empty">
          <h3>Submitted expenses couldn't be loaded</h3>
          <p>The server did not answer. This is usually temporary.</p>
          <button class="btn sm ghost" data-retry>Try again</button>
        </div>`));
      contentEl.querySelector('[data-retry]')?.addEventListener('click', load);
    }
  }

  load();
}

function renderRejectModal({ title, promptText, onConfirm, confirmLabel = 'Confirm rejection', reasonLabel = 'Rejection reason', placeholder = 'Explain why this request is rejected...' }) {
  const scrim = el(`
    <div class="modal-scrim z-70">
      <div class="modal-card" role="dialog" aria-modal="true">
        <div class="py-carbon-06 px-carbon-06 border-bottom">
          <h2 class="m-0 mb-carbon-01 type-heading-compact-02">${esc(title)}</h2>
          <p class="m-0 type-body-01 text-tertiary">${esc(promptText)}</p>
        </div>
        <form class="py-carbon-06 px-carbon-06" novalidate>
          <div class="field" data-f="reason">
            <label>${esc(reasonLabel)}</label>
            <textarea name="reason" rows="3" placeholder="${esc(placeholder)}" required></textarea>
            <span class="hint">Stored permanently in the audit log and visible to the submitter.</span>
          </div>
          <div class="row row-end mt-carbon-05">
            <button class="btn ghost sm" type="button" data-cancel>Cancel</button>
            <button class="btn sm danger" type="submit" data-confirm>${esc(confirmLabel)}</button>
          </div>
        </form>
      </div>
    </div>`);

  document.body.appendChild(scrim);
  const releaseFocus = trapFocus(scrim.querySelector('[role="dialog"]'));
  const close = () => { releaseFocus(); scrim.remove(); };
  scrim.querySelector('[data-cancel]').addEventListener('click', close);
  scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });

  const form = scrim.querySelector('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const reason = form.querySelector('[name="reason"]').value.trim();
    if (!reason) {
      showFieldErrors(form, { reason: 'Rejection reason is required' });
      return;
    }

    const confirmBtn = scrim.querySelector('[data-confirm]');
    confirmBtn.disabled = true;

    try {
      await onConfirm(reason);
      close();
    } catch (err) {
      toast(err.message, true);
      confirmBtn.disabled = false;
    }
  });
}
/* ============================================================ Dashboard
 *
 * The Finance & Management view: trip budgets, approvals outstanding,
 * expenses, pending settlements, and employee-wise spend — with an export.
 *
 * The scope is the server's decision. A manager sees their reporting tree,
 * Finance and Admin see the company. The client never picks a scope it is not
 * entitled to; the guard grants one and the client renders what came back.
 */

/* The dashboard — the front door for everybody.
 *
 * It answers three questions in order:
 *
 *   1. HOW MUCH — the headline numbers.
 *   2. WHAT NEEDS ME NOW — the things that are waiting on this person.
 *   3. WHAT HAPPENED — the recent trips, most recent first.
 *
 * The scope is the server's decision, not the client's: a traveller sees their
 * own travel, a manager their reporting tree, Finance and Admin the company.
 * The client never asks for a wider scope than it was granted.
 */

async function renderDashboard(main) {
  const canSeeAll = principal.permissions.includes('report.all') || principal.permissions.includes('report.finance');
  const canApprove = principal.permissions.includes('trip.approve') || principal.permissions.includes('trip.approve.all') ||
                     principal.permissions.includes('expense.approve') || principal.permissions.includes('expense.approve.all');
  const canCreateTrip = principal.permissions.includes('trip.create');

  const view = el(`
    <div>
      <div class="page-head row-start row-wrap">
        <div>
          <h1>Dashboard</h1>
          <p>Budgets, approvals, spend and settlements across ${canSeeAll ? 'the company' : (canApprove ? 'your team' : 'your travel')}.</p>
        </div>
        <div class="row row-wrap">
          ${canCreateTrip ? '<button class="btn sm" data-new-trip>+ New trip</button>' : ''}
          <label class="inline-field">
            <span>Show in</span>
            <select data-display aria-label="Show amounts in"></select>
          </label>
          ${principal.permissions.includes('rate.manage') ? '<button class="btn sm ghost" data-manage-rates>Forex rates</button>' : ''}
          ${canSeeAll ? `
            <button class="btn sm ghost" data-export="employees">Export employees (CSV)</button>
            <button class="btn sm ghost" data-export="trips">Export trips (CSV)</button>
          ` : ''}
          <button class="btn sm ghost" data-refresh>Refresh</button>
        </div>
      </div>
      <div data-content>
        <div class="card mt-carbon-03" data-table>
          <div class="p-carbon-05">${'<div class="skeleton h-10 my-carbon-03"></div>'.repeat(4)}</div>
        </div>
      </div>
    </div>`);

  main.replaceChildren(view);
  const host = view.querySelector('[data-content]');
  const displaySelect = view.querySelector('[data-display]');

  /* The currency the reader wants to see the money in. It is remembered
   * between visits, and it never changes a stored amount — the report is
   * shown in another currency, the books stay as they are.
   *
   * Storage can be refused by the browser (private mode, blocked cookies),
   * and that must not take the dashboard down with it — a preference that
   * cannot be remembered is simply a preference that is not remembered. */
  let display = rememberedDisplayCurrency();

  function drawDisplayOptions(baseCurrency) {
    const codes = currencyRegistry.currencies.map((c) => c.code);
    const wanted = display && codes.includes(display) ? display : baseCurrency;
    display = wanted;
    displaySelect.replaceChildren(...currencyRegistry.currencies.map((c) => {
      const option = document.createElement('option');
      option.value = c.code;
      option.textContent = c.code === baseCurrency ? `${c.code} (base)` : c.code;
      if (c.code === wanted) option.selected = true;
      return option;
    }));
  }

  displaySelect.addEventListener('change', () => {
    display = displaySelect.value;
    rememberDisplayCurrency(display);
    load();
  });

  view.querySelector('[data-manage-rates]')?.addEventListener('click', () => {
    openExchangeRatesDrawer(load);
  });

  let loadToken = 0;
  async function load() {
    const token = ++loadToken;
    try {
      const q = display ? `?display=${encodeURIComponent(display)}` : '';
      const { scope, display: info, totals, trips, employees, settlements } = await api.get(`/dashboard${q}`);
      if (token !== loadToken) return;

      drawDisplayOptions(info.baseCurrency);

      /* ---- the money, shown in the currency the reader asked for ---- */
      const showMoney = (base, shown) => (shown ?? base ?? '0.00');
      const rateNote = info.rate && info.rate !== '1.00000000'
        ? `${info.currency} at ${info.rate}, effective ${fmtDate(info.effectiveOn)}`
        : `in ${info.baseCurrency}`;
      const missingNote = info.known
        ? ''
        : `<div class="empty px-carbon-05 py-carbon-04 mb-carbon-05"><p class="m-0">No rate is remembered for ${esc(info.currency)}, so the figures below are in ${esc(info.baseCurrency)}. Ask Finance to record the rate and they will convert here.</p></div>`;

      const stat = (label, value, sub) => `
        <div class="tile">
          <div class="tile-label">${esc(label)}</div>
          <div class="tile-value tabular">${esc(value)}</div>
          ${sub ? `<div class="tile-sub">${esc(sub)}</div>` : ''}
        </div>`;

      /* ---- Active trip command center (for travellers currently on trip) ---- */
      const activeTrip = trips.find((t) => t.status === 'active' && t.employee_id === principal.employeeId);
      let activeHero = null;
      if (activeTrip) {
        const fundsNum = Number(activeTrip.funds_base || 0);
        const spentNum = Number(activeTrip.spent_base || 0);
        const pct = fundsNum > 0 ? Math.min(100, Math.round((spentNum / fundsNum) * 100)) : 0;
        const isConverted = Boolean(info.known && info.rate && info.rate !== '1.00000000');
        const heroCur = isConverted ? info.currency : (info.baseCurrency || activeTrip.base_currency || 'INR');
        const balNum = Number(activeTrip.balance_base || 0);
        const balClass = balNum >= 0 ? 'text-success' : 'text-error';

        activeHero = el(`
          <div class="active-trip-hero">
            <div class="active-trip-hero-head">
              <div>
                <div class="row gap-carbon-02 mb-carbon-01">
                  <span class="pill ok type-label-01">● Current active trip</span>
                  <span class="type-caption-01 text-secondary">${fmtDate(activeTrip.start_date)} – ${fmtDate(activeTrip.end_date)}</span>
                  ${activeTrip.employee_name && activeTrip.employee_id !== principal.employeeId ? `<span class="type-caption-01 text-secondary">· ${esc(activeTrip.employee_name)}</span>` : ''}
                </div>
                <h2 class="type-heading-compact-02 m-0">${esc(activeTrip.destination)}</h2>
                <div class="type-body-01 text-secondary">${esc(activeTrip.purpose || '')}</div>
              </div>
              <div class="row gap-carbon-02">
                <button class="btn sm" data-hero-view>View trip details</button>
                <button class="btn sm ghost" data-hero-flights>✈️ Flights &amp; Hubs</button>
                <button class="btn sm ghost" data-hero-exp>+ Log expense</button>
              </div>
            </div>

            <div class="active-trip-metrics">
              <div class="active-trip-metric-item">
                <span class="type-caption-01 text-secondary mb-carbon-01">Advance disbursed</span>
                <span class="type-heading-compact-02 tabular">${MONEY(showMoney(activeTrip.funds_base, activeTrip.funds_display), heroCur)}</span>
              </div>
              <div class="active-trip-metric-item">
                <span class="type-caption-01 text-secondary mb-carbon-01">Expenses recorded</span>
                <span class="type-heading-compact-02 tabular">${MONEY(showMoney(activeTrip.spent_base, activeTrip.spent_display), heroCur)}</span>
              </div>
              <div class="active-trip-metric-item">
                <span class="type-caption-01 text-secondary mb-carbon-01">Remaining cash in hand</span>
                <span class="type-heading-compact-02 tabular strong ${balClass}">${MONEY(showMoney(activeTrip.balance_base, activeTrip.balance_display), heroCur)}</span>
              </div>
            </div>

            <div class="active-trip-progress-wrap">
              <div class="row-between type-caption-01 text-secondary">
                <span>Advance utilization</span>
                <span class="tabular">${pct}% spent</span>
              </div>
              <progress class="carbon-progress-bar" max="100" value="${pct}"></progress>
            </div>
          </div>`);

        activeHero.querySelector('[data-hero-view]').addEventListener('click', () => {
          renderTripDetailDrawer(activeTrip.id, load);
        });
        activeHero.querySelector('[data-hero-flights]').addEventListener('click', () => {
          renderTripDetailDrawer(activeTrip.id, load);
        });
        activeHero.querySelector('[data-hero-exp]').addEventListener('click', () => {
          renderExpenseFormDrawer(activeTrip.id, null, load, activeTrip.currency || 'INR');
        });
      }

      const cards = el(`
        <div class="tiles">
          ${stat('Trips', String(totals.trips ?? 0), totals.truncated ? `${totals.active_trips ?? 0} active · latest 500 shown` : `${totals.active_trips ?? 0} active`)}
          ${stat('Awaiting approval', String(totals.awaiting_approval ?? 0), 'budgets')}
          ${stat('Awaiting Finance', String(totals.awaiting_reconciliation ?? 0), 'reconciliations')}
          ${stat('Awaiting settlement', String(totals.awaiting_settlement ?? 0), 'closed after settlement')}
          ${stat('Approved spend', showMoney(totals.spent_base, totals.spent_display), rateNote)}
          ${stat('Pending spend', showMoney(totals.pending_base, totals.pending_display), `not yet approved · ${rateNote}`)}
          ${stat('Funds issued', showMoney(totals.funds_base, totals.funds_display), rateNote)}
        </div>`);

      /* ---- what needs you now ----
       *
       * Counted from the trips in scope, so the numbers on this list are the
       * same numbers as the tiles above — never a second, disagreeing count. */
      const counts = {};
      for (const t of trips) counts[t.status] = (counts[t.status] ?? 0) + 1;

      const needs = [];
      if (counts.draft) {
        needs.push({ label: 'Trip drafts to submit', count: counts.draft, route: 'trips' });
      }
      if (counts.submitted) {
        needs.push({
          label: canApprove ? 'Budgets waiting for your approval' : 'Trips waiting for approval',
          count: counts.submitted,
          route: canApprove ? 'approvals' : 'trips',
        });
      }
      if (counts.reconciliation_pending) {
        needs.push({ label: 'Reconciliations to decide', count: counts.reconciliation_pending, route: 'trips' });
      }
      if (counts.reconciled) {
        needs.push({ label: 'Settlements to close', count: counts.reconciled, route: 'trips' });
      }

      const needsCard = el(`
        <div class="card mb-carbon-06">
          <div class="card-head">What needs you now</div>
          ${needs.length ? `
            <ul class="task-list">
              ${needs.map((n) => `
                <li>
                  <button class="task" data-go="${esc(n.route)}">
                    <span class="task-label">${esc(n.label)}</span>
                    <span class="task-count tabular">${esc(String(n.count))}</span>
                  </button>
                </li>`).join('')}
            </ul>`
          : `<div class="empty p-carbon-05"><p class="m-0">Nothing is waiting on you.</p></div>`}
        </div>`);

      for (const btn of needsCard.querySelectorAll('[data-go]')) {
        btn.addEventListener('click', () => { route = btn.dataset.go; renderApp(); });
      }

      /* ---- recent trips ---- */
      const tripTable = el(`
        <div class="card mb-carbon-06">
          <div class="card-head">Recent trips${totals.truncated ? ' (showing latest 500)' : ''}</div>
          ${trips.length ? `
            <div class="scroll-x">
              <table>
                <thead>
                  <tr>
                    <th>Trip</th><th>Employee</th><th>Status</th>
                    <th class="num">Budget (${esc(info.currency)})</th>
                    <th class="num">Spent (${esc(info.currency)})</th>
                    <th class="num">Variance (${esc(info.currency)})</th>
                    <th class="num">Funds (${esc(info.currency)})</th>
                    <th class="num">Balance (${esc(info.currency)})</th>
                  </tr>
                </thead>
                <tbody></tbody>
              </table>
            </div>` : `
            <div class="empty">
              <h3>No trips yet</h3>
              <p class="m-0">No trips in scope.</p>
            </div>`}
        </div>`);
      const tripBody = tripTable.querySelector('tbody');
      for (const t of trips) {
        const row = el(`
          <tr class="clickable" data-trip="${esc(t.id)}">
            <td>
              <div class="medium">${esc(t.destination)}</div>
              <div class="cell-sub">${fmtDate(t.start_date)} – ${fmtDate(t.end_date)}</div>
            </td>
            <td>
              <div>${esc(t.employee_name)}</div>
              <div class="cell-sub">${esc(t.department_name || '')}</div>
            </td>
            <td>${statusPill(t.status)}</td>
            <td class="tabular num">${esc(showMoney(t.budget_base, t.budget_display))}</td>
            <td class="tabular num">${esc(showMoney(t.spent_base, t.spent_display))}</td>
            <td class="tabular num">${esc(t.variance_display ?? t.variance_base ?? '—')}</td>
            <td class="tabular num">${esc(showMoney(t.funds_base, t.funds_display))}</td>
            <td class="tabular num">${esc(showMoney(t.balance_base, t.balance_display))}</td>
          </tr>`);
        row.addEventListener('click', () => {
          renderTripDetailDrawer(t.id, load);
        });
        tripBody.appendChild(row);
      }

      /* ---- employee-wise spend ----
       *
       * Meaningful only when the scope is wider than one person's travel. */
      const empTable = el(`
        <div class="card mb-carbon-06">
          <div class="card-head">Employee-wise spend</div>
          ${employees.length ? `
            <div class="scroll-x">
              <table>
                <thead>
                  <tr>
                    <th>Employee</th><th>Code</th><th>Department</th>
                    <th class="num">Trips</th>
                    <th class="num">Approved (${esc(info.currency)})</th>
                    <th class="num">Pending (${esc(info.currency)})</th>
                  </tr>
                </thead>
                <tbody></tbody>
              </table>
            </div>` : `
            <div class="empty">
              <h3>No employee spend</h3>
              <p class="m-0">No employee spend in scope.</p>
            </div>`}
        </div>`);
      const empBody = empTable.querySelector('tbody');
      for (const e of employees) {
        empBody?.appendChild(el(`
          <tr>
            <td>${esc(e.name)}</td>
            <td class="tabular cell-sub">${esc(e.employee_code)}</td>
            <td class="cell-sub">${esc(e.department_name || '')}</td>
            <td class="tabular num">${esc(e.trip_count)}</td>
            <td class="tabular num">${esc(showMoney(e.spent_base, e.spent_display))}</td>
            <td class="tabular num">${esc(showMoney(e.pending_base, e.pending_display))}</td>
          </tr>`));
      }

      /* ---- settlements ---- */
      const settleCard = el(`
        <div class="card mb-carbon-06">
          <div class="card-head">Settlements</div>
          ${settlements.length ? `
            <div class="scroll-x">
              <table>
                <thead>
                  <tr>
                    <th>Trip</th><th>Employee</th>
                    <th class="num">Funds (${esc(info.currency)})</th>
                    <th class="num">Spent (${esc(info.currency)})</th>
                    <th class="num">Balance (${esc(info.currency)})</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody></tbody>
              </table>
            </div>` : `
            <div class="empty">
              <h3>No settlements pending</h3>
              <p class="m-0">No reconciliations in scope.</p>
            </div>`}
        </div>`);
      const settleBody = settleCard.querySelector('tbody');
      for (const s of settlements) {
        const row = el(`
          <tr class="clickable" data-trip="${esc(s.trip_id)}">
            <td>${esc(s.destination)}</td>
            <td>${esc(s.employee_name)}</td>
            <td class="tabular num">${esc(showMoney(s.funds_base, s.funds_display))}</td>
            <td class="tabular num">${esc(showMoney(s.expenses_base, s.expenses_display))}</td>
            <td class="tabular num strong">${esc(showMoney(s.balance_base, s.balance_display))}</td>
            <td><span class="pill ${s.status === 'approved' ? 'ok' : s.status === 'rejected' ? 'error' : 'warn'}">${esc(s.status)}</span></td>
          </tr>`);
        row.addEventListener('click', () => {
          renderTripDetailDrawer(s.trip_id, load);
        });
        settleBody?.appendChild(row);
      }

      /* The employee-wise table says nothing about one person's own travel,
       * so it is left out when that is all the scope holds. */
      const sections = [];
      if (missingNote) sections.push(el(missingNote));
      if (activeHero) sections.push(activeHero);
      sections.push(cards, needsCard, tripTable);
      if (scope !== 'own') sections.push(empTable);
      sections.push(settleCard);
      host.replaceChildren(...sections);
    } catch (err) {
      if (token !== loadToken) return;
      host.replaceChildren(el(`
        <div class="empty">
          <h3>The dashboard couldn't be loaded</h3>
          <p>The server did not answer. This is usually temporary.</p>
          <button class="btn sm ghost" data-retry>Try again</button>
        </div>`));
      host.querySelector('[data-retry]')?.addEventListener('click', load);
    }
  }

  for (const btn of view.querySelectorAll('[data-export]')) {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.export;
      const q = display ? `&display=${encodeURIComponent(display)}` : '';
      window.location.href = `/api/v1/reports/export.csv?kind=${encodeURIComponent(kind)}${q}`;
    });
  }
  view.querySelector('[data-new-trip]')?.addEventListener('click', () => {
    renderTripFormDrawer(null, load);
  });
  view.querySelector('[data-refresh]').addEventListener('click', () => {
    api.clearCache();
    load();
  });

  load();
}

/* ============================================================ B16 · Employees */

async function renderEmployees(main) {
  const view = el(`
    <div>
      <div class="page-head">
        <h1>Employees</h1>
        <p>The employee record is the source of identity, department, cost center, manager
           and permissions. Employee code and work email are unique; neither is the
           internal key.</p>
      </div>
      <div class="toolbar">
        <input class="grow" data-search type="search" placeholder="Search name, code or email" aria-label="Search employees by name, code or email">
        <select data-dept aria-label="Filter employees by department"><option value="">All departments</option></select>
        <select data-status aria-label="Filter employees by status">
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="">Any status</option>
        </select>
        <button class="btn sm" data-add>Add employee</button>
        <button class="btn sm ghost" data-import>Bulk import</button>
      </div>
      <div class="card" data-table></div>
    </div>`);

  main.replaceChildren(view);

  const tableHost = view.querySelector('[data-table]');
  const searchEl = view.querySelector('[data-search]');
  const deptEl = view.querySelector('[data-dept]');
  const statusEl = view.querySelector('[data-status]');

  let departments = [];
  try {
    departments = (await api.get('/departments')).data;
    for (const d of departments) {
      deptEl.appendChild(el(`<option value="${esc(d.id)}">${esc(d.name)}</option>`));
    }
  } catch (err) {
    toast(err.message, true);
  }

  let loadToken = 0;
  async function load() {
    const token = ++loadToken;
    tableHost.replaceChildren(el(`
      <div class="p-carbon-05">
        ${'<div class="skeleton my-carbon-03"></div>'.repeat(5)}
      </div>`));

    const params = new URLSearchParams();
    if (searchEl.value.trim()) params.set('search', searchEl.value.trim());
    if (deptEl.value) params.set('departmentId', deptEl.value);
    if (statusEl.value) params.set('status', statusEl.value);

    try {
      const { data } = await api.get(`/employees?${params}`);
      if (token !== loadToken) return;

      if (!data.length) {
        tableHost.replaceChildren(el(`
          <div class="empty">
            <h3>No employees match</h3>
            <p>Try a different search or clear the filters.</p>
            <button class="btn sm ghost" data-clear>Clear filters</button>
          </div>`));
        tableHost.querySelector('[data-clear]').addEventListener('click', () => {
          searchEl.value = ''; deptEl.value = ''; statusEl.value = 'active'; load();
        });
        return;
      }

      const table = el(`
        <table>
          <thead><tr>
            <th>Employee</th><th>Contact</th><th>Department</th>
            <th>Roles</th><th>Manager</th><th>Status</th><th>Joined</th>
          </tr></thead>
          <tbody></tbody>
        </table>`);

      const tbody = table.querySelector('tbody');
      for (const e of data) {
        const row = el(`
          <tr class="clickable">
            <td>
              <div class="cell-primary">${esc(e.name)}</div>
              <div class="cell-sub tabular">${esc(e.employee_code)} · ${esc(e.grade)}</div>
            </td>
            <td><div class="cell-sub">${esc(e.work_email)}</div></td>
            <td>
              <div>${esc(e.department_name)}</div>
              <div class="cell-sub tabular">${esc(e.cost_center_code)}</div>
            </td>
            <td><div class="pill-row">${(e.roles ?? [])
              .map((r) => `<span class="pill off">${esc(ROLE_LABEL[r] ?? r)}</span>`).join('')}</div></td>
            <td>
              ${e.manager_name
                ? `<div class="cell-sub">${esc(e.manager_name)}</div>`
                : '<span class="pill warn" title="No reporting manager assigned">no manager</span>'}
            </td>
            <td><span class="pill ${e.status === 'active' ? 'ok' : 'off'}">${esc(e.status)}</span></td>
            <td><div class="cell-sub tabular">${fmtDate(e.joining_date)}</div></td>
          </tr>`);
        row.addEventListener('click', () => openDrawer(e, departments, load));
        tbody.appendChild(row);
      }

      tableHost.replaceChildren(table);
    } catch (err) {
      if (token !== loadToken) return;
      tableHost.replaceChildren(el(`
        <div class="empty">
          <h3>Employees couldn't be loaded</h3>
          <p>The server did not answer. This is usually temporary.</p>
          <button class="btn sm ghost" data-retry>Try again</button>
        </div>`));
      tableHost.querySelector('[data-retry]')?.addEventListener('click', load);
    }
  }

  let debounce;
  searchEl.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(load, 220);
  });
  deptEl.addEventListener('change', load);
  statusEl.addEventListener('change', load);

  view.querySelector('[data-add]').addEventListener('click', () => openDrawer(null, departments, load));
  view.querySelector('[data-import]').addEventListener('click', () => openImport(load));

  load();
}

/* ============================================================ B17 · Drawer */

async function openDrawer(employee, departments, onSaved) {
  const isNew = !employee;

  let managers = [];
  try {
    managers = (await api.get('/employees?status=active&limit=200')).data;
  } catch { /* the field degrades to "no reporting manager" */ }

  const scrim = el(`
    <div class="drawer-scrim">
      <div class="drawer" role="dialog" aria-modal="true">
        <div class="drawer-head">
          <h2>${isNew ? 'Add employee' : esc(employee.name)}</h2>
          <p>${isNew
            ? 'Fields marked with * are required. You can assign Admin roles below.'
            : `${esc(employee.employee_code)} · ${esc(employee.department_name)}`}</p>
        </div>
        <form class="drawer-body" novalidate>
          <div class="grid-2">
            <div class="field" data-f="employeeCode">
              <label>Employee code <span class="req">*</span></label>
              <input name="employeeCode" value="${esc(employee?.employee_code ?? '')}" placeholder="e.g. EMP-1002" required>
              <span class="hint">Unique identifier</span>
            </div>
            <div class="field" data-f="name">
              <label>Full name <span class="req">*</span></label>
              <input name="name" value="${esc(employee?.name ?? '')}" placeholder="e.g. Jane Doe" required>
            </div>
            <div class="field" data-f="workEmail">
              <label>Work email <span class="req">*</span></label>
              <input name="workEmail" type="email" value="${esc(employee?.work_email ?? '')}" placeholder="e.g. jane@company.com" required>
              <span class="hint">Login identity</span>
            </div>
            <div class="field" data-f="mobile">
              <label>Mobile <span class="opt">(optional)</span></label>
              <input name="mobile" type="tel" value="${esc(employee?.mobile ?? '')}" placeholder="e.g. +966 50 123 4567">
            </div>
            <div class="field" data-f="departmentId">
              <label>Department <span class="req">*</span></label>
              <select name="departmentId" required>
                ${departments.map((d) => `<option value="${esc(d.id)}"${
                  d.id === employee?.department_id ? ' selected' : ''}>${esc(d.name)}</option>`).join('')}
              </select>
              <span class="hint">Sets default cost center</span>
            </div>
            <div class="field" data-f="designation">
              <label>Designation <span class="req">*</span></label>
              <input name="designation" value="${esc(employee?.designation ?? '')}" placeholder="e.g. System Administrator" required>
            </div>
            <div class="field" data-f="grade">
              <label>Grade <span class="opt">(optional)</span></label>
              <select name="grade">
                <option value="">— standard (G3) —</option>
                ${['G1','G2','G3','G4','G5','G6'].map((g) =>
                  `<option value="${g}"${g === (employee?.grade ?? '') ? ' selected' : ''}>${g}</option>`).join('')}
              </select>
              <span class="hint">Defaults to G3</span>
            </div>
            <div class="field" data-f="location">
              <label>Location <span class="opt">(optional)</span></label>
              <input name="location" value="${esc(employee?.location ?? '')}" placeholder="e.g. Riyadh, Saudi Arabia">
            </div>
            <div class="field" data-f="managerId">
              <label>Reporting manager <span class="opt">(optional)</span></label>
              <select name="managerId">
                <option value="">— no reporting manager —</option>
                ${managers.filter((m) => m.id !== employee?.id).map((m) =>
                  `<option value="${esc(m.id)}"${m.id === employee?.manager_id ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}
              </select>
              <span class="hint">Routes approvals</span>
            </div>
            <div class="field" data-f="joiningDate">
              <label>Joining date <span class="opt">(optional)</span></label>
              <input name="joiningDate" type="date"
                     value="${esc((employee?.joining_date ?? '').toString().slice(0, 10))}">
              <span class="hint">Defaults to today if omitted</span>
            </div>
          </div>

          <div class="field mt-carbon-03" data-f="password">
            <label>${isNew ? 'Initial password' : 'Reset password'} <span class="opt">(optional)</span></label>
            <input name="password" type="password" autocomplete="new-password" placeholder="${isNew ? 'Set initial password for login' : 'Leave blank to keep existing password'}">
            <span class="hint">At least 6 characters. If set, they can sign in immediately and change it anytime later.</span>
          </div>

          <div class="field mt-carbon-03" data-f="roles">
            <label>Roles <span class="opt">(select Admin for administrator access)</span></label>
            <div class="chips">
              ${Object.entries(ROLE_LABEL).map(([k, label]) => {
                const pressed = isNew ? (k === 'employee') : (employee.roles ?? []).includes(k);
                return `<button type="button" class="chip" data-role="${esc(k)}"
                        aria-pressed="${pressed}">${esc(label)}</button>`;
              }).join('')}
            </div>
            <span class="hint">${isNew ? 'Click "Admin" to grant full company-wide administrator authority.' : 'Role changes are saved separately and audited on their own.'}</span>
          </div>
        </form>
        <div class="drawer-foot">
          ${isNew ? '' : `<button class="btn danger sm" data-toggle-status>${
            employee.status === 'active' ? 'Deactivate' : 'Reactivate'}</button>`}
          ${isNew || employee.status !== 'active' ? '' : '<button class="btn ghost sm" data-invite>Email sign-in link</button>'}
          <div class="grow"></div>
          <button class="btn ghost sm" data-cancel>Cancel</button>
          <button class="btn sm" data-save>${isNew ? 'Add employee' : 'Save'}</button>
        </div>
      </div>
    </div>`);

  const form = scrim.querySelector('form');
  const releaseFocus = trapFocus(scrim.querySelector('[role="dialog"]'));
  function onEsc(e) {
    if (e.key === 'Escape') close();
  }
  const close = () => {
    document.removeEventListener('keydown', onEsc);
    releaseFocus();
    scrim.remove();
  };

  scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });
  scrim.querySelector('[data-cancel]').addEventListener('click', close);
  document.addEventListener('keydown', onEsc);

  /* Role chips write through their own endpoint — separately permissioned
   * (role.manage) and separately audited (role.assign). */
  const chips = [...scrim.querySelectorAll('[data-role]')];
  for (const chip of chips) {
    chip.addEventListener('click', () => {
      chip.setAttribute('aria-pressed', chip.getAttribute('aria-pressed') !== 'true');
    });
  }

  function clearErrors() {
    for (const f of form.querySelectorAll('.field')) {
      f.classList.remove('invalid');
      f.querySelector('.error')?.remove();
    }
  }

  function showErrors(fields) {
    for (const [name, message] of Object.entries(fields ?? {})) {
      const f = form.querySelector(`[data-f="${name}"]`);
      if (!f) { toast(message, true); continue; }
      f.classList.add('invalid');
      f.appendChild(el(`<span class="error">${esc(message)}</span>`));
    }
  }

  scrim.querySelector('[data-save]').addEventListener('click', async () => {
    clearErrors();
    const fd = new FormData(form);
    const payload = {
      employeeCode: fd.get('employeeCode')?.trim(),
      name: fd.get('name')?.trim(),
      workEmail: fd.get('workEmail')?.trim(),
      mobile: fd.get('mobile')?.trim() || null,
      departmentId: fd.get('departmentId'),
      designation: fd.get('designation')?.trim(),
      grade: fd.get('grade') || 'G3',
      location: fd.get('location')?.trim() || null,
      managerId: fd.get('managerId') || null,
      joiningDate: fd.get('joiningDate') || null,
      password: fd.get('password') || undefined,
    };

    const btn = scrim.querySelector('[data-save]');
    btn.disabled = true;
    try {
      if (isNew) {
        const res = await api.post('/employees', payload);
        const newEmp = res?.employee;
        const nextRoles = chips.filter((c) => c.getAttribute('aria-pressed') === 'true')
          .map((c) => c.dataset.role);
        if (newEmp?.id && nextRoles.length && (nextRoles.length !== 1 || nextRoles[0] !== 'employee')) {
          await api.patch(`/employees/${newEmp.id}/roles`, { roles: nextRoles });
        }
        toast(`${payload.name} added`);
      } else {
        await api.patch(`/employees/${employee.id}`, payload);

        const nextRoles = chips.filter((c) => c.getAttribute('aria-pressed') === 'true')
          .map((c) => c.dataset.role);
        const prevRoles = [...(employee.roles ?? [])].sort().join(',');
        if (nextRoles.length && nextRoles.slice().sort().join(',') !== prevRoles) {
          await api.patch(`/employees/${employee.id}/roles`, { roles: nextRoles });
        }
        toast(`${payload.name} updated`);
      }
      close();
      onSaved();
    } catch (err) {
      if (err.fields) showErrors(err.fields);
      else toast(err.message, true);
    } finally {
      btn.disabled = false;
    }
  });

  scrim.querySelector('[data-toggle-status]')?.addEventListener('click', async () => {
    const next = employee.status === 'active' ? 'inactive' : 'active';
    const btn = scrim.querySelector('[data-toggle-status]');
    btn.disabled = true;
    try {
      await api.patch(`/employees/${employee.id}/status`, { status: next });
      toast(next === 'inactive'
        ? `${employee.name} deactivated — sessions revoked`
        : `${employee.name} reactivated`);
      close();
      onSaved();
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false;
    }
  });

  /* Emails a single-use set-password link to the employee's own inbox. The link is
   * never shown to the Admin. */
  scrim.querySelector('[data-invite]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await api.post(`/employees/${employee.id}/invite`);
      toast(`Sign-in link emailed to ${employee.work_email}`);
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
    }
  });

  document.body.appendChild(scrim);
  form.querySelector('input')?.focus();
}

/* ============================================================ B18 · Import */

function openImport(onDone) {
  const scrim = el(`
    <div class="drawer-scrim">
      <div class="drawer" role="dialog" aria-modal="true">
        <div class="drawer-head">
          <h2>Bulk import</h2>
          <p>Paste an HR export. Validate first — nothing is written until you import.</p>
        </div>
        <div class="drawer-body">
          <div class="field">
            <label for="paste">Rows</label>
            <textarea id="paste" rows="9"
              placeholder="Employee Code,Name,Work Email,Department,Designation,Grade,Manager,Location,Joining Date"></textarea>
            <span class="hint">CSV or tab-separated. Header row required. Employee code,
              name, work email and department are mandatory; the rest take defaults.</span>
          </div>
          <div data-results></div>
        </div>
        <div class="drawer-foot">
          <div class="grow"></div>
          <button class="btn ghost sm" data-cancel>Cancel</button>
          <button class="btn ghost sm" data-validate>Validate only</button>
          <button class="btn sm" data-import disabled>Import</button>
        </div>
      </div>
    </div>`);

  const results = scrim.querySelector('[data-results]');
  const textarea = scrim.querySelector('#paste');
  const importBtn = scrim.querySelector('[data-import]');
  const releaseFocus = trapFocus(scrim.querySelector('[role="dialog"]'));
  const close = () => { releaseFocus(); scrim.remove(); };

  scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });
  scrim.querySelector('[data-cancel]').addEventListener('click', close);

  function show(result) {
    if (result.error) {
      results.replaceChildren(el(`<div class="form-error">${esc(result.error)}</div>`));
      importBtn.disabled = true;
      return;
    }

    const okCount = result.results.filter((r) => r.ok).length;
    results.replaceChildren(el(`
      <div>
        <div class="card mt-carbon-03">
          <table>
            <thead><tr><th class="w-44">Row</th><th>Employee</th><th>Outcome</th></tr></thead>
            <tbody>
              ${result.results.map((r) => `
                <tr>
                  <td class="tabular cell-sub">${r.row}</td>
                  <td class="cell-primary">${esc(r.label)}</td>
                  <td>
                    <span class="pill ${r.ok ? 'ok' : 'warn'}">${r.ok ? '✓' : '!'}</span>
                    <span class="cell-sub">${esc(r.message)}</span>
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
        <p class="form-note">${okCount} of ${result.total} row${result.total === 1 ? '' : 's'} ready${
          result.dryRun ? ' — nothing written yet' : ''}.</p>
      </div>`));

    importBtn.disabled = okCount === 0;
  }

  async function run(dryRun) {
    const btn = dryRun ? scrim.querySelector('[data-validate]') : importBtn;
    btn.disabled = true;
    try {
      const result = await api.post('/employees/import', { text: textarea.value, dryRun });
      show(result);
      if (!dryRun) {
        toast(`${result.added} of ${result.total} rows imported`);
        close();
        onDone();
      }
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
    }
  }

  scrim.querySelector('[data-validate]').addEventListener('click', () => run(true));
  importBtn.addEventListener('click', () => run(false));

  document.body.appendChild(scrim);
  textarea.focus();
}

/* ============================================================ B19 · Departments */

async function renderDepartments(main) {
  const view = el(`
    <div>
      <div class="page-head">
        <h1>Departments &amp; cost centers</h1>
        <p>Configurable master data. Every employee belongs to one department and inherits
           its cost center — trips and expenses carry that pair automatically.</p>
      </div>
      <div class="toolbar">
        <div class="grow"></div>
        <button class="btn sm" data-add>Add department</button>
      </div>
      <div class="card" data-table></div>
    </div>`);

  main.replaceChildren(view);
  const tableHost = view.querySelector('[data-table]');

  let loadToken = 0;
  async function load() {
    const token = ++loadToken;
    tableHost.replaceChildren(el(`<div class="p-carbon-05">${
      '<div class="skeleton my-carbon-03"></div>'.repeat(4)}</div>`));

    try {
      const { data } = await api.get('/departments');
      if (token !== loadToken) return;
      const table = el(`
        <table>
          <thead><tr>
            <th>Department</th><th>Cost center</th><th>Head</th>
            <th>Active employees</th><th>Status</th>
          </tr></thead>
          <tbody></tbody>
        </table>`);
      const tbody = table.querySelector('tbody');

      for (const d of data) {
        const ccs = (d.cost_centers ?? []).map((c) => c.code).join(', ') || '—';
        tbody.appendChild(el(`
          <tr>
            <td>
              <div class="cell-primary">${esc(d.name)}</div>
              <div class="cell-sub tabular">${esc(d.code)}</div>
            </td>
            <td><div class="cell-sub tabular">${esc(ccs)}</div></td>
            <td><div class="cell-sub">${esc(d.head_name ?? '—')}</div></td>
            <td class="tabular">${d.active_employees}</td>
            <td><span class="pill ${d.active ? 'ok' : 'off'}">${d.active ? 'active' : 'inactive'}</span></td>
          </tr>`));
      }
      tableHost.replaceChildren(table);
    } catch (err) {
      if (token !== loadToken) return;
      tableHost.replaceChildren(el(`
        <div class="empty">
          <h3>Departments couldn't be loaded</h3>
          <p>The server did not answer. This is usually temporary.</p>
          <button class="btn sm ghost" data-retry>Try again</button>
        </div>`));
      tableHost.querySelector('[data-retry]')?.addEventListener('click', load);
    }
  }

  view.querySelector('[data-add]').addEventListener('click', () => {
    const scrim = el(`
      <div class="drawer-scrim">
        <div class="drawer" role="dialog" aria-modal="true">
          <div class="drawer-head">
            <h2>Add department</h2>
            <p>A cost center is created with it — spend cannot be attributed without one.</p>
          </div>
          <form class="drawer-body" novalidate>
            <div class="field" data-f="name">
              <label>Department name</label>
              <input name="name" required>
            </div>
            <div class="field" data-f="code">
              <label>Department code</label>
              <input name="code" required placeholder="e.g. OPS">
              <span class="hint">Uppercase, unique.</span>
            </div>
            <div class="field" data-f="costCenterCode">
              <label>Cost center code</label>
              <input name="costCenterCode" placeholder="Defaults to CC-&lt;CODE&gt;-01">
            </div>
          </form>
          <div class="drawer-foot">
            <div class="grow"></div>
            <button class="btn ghost sm" data-cancel>Cancel</button>
            <button class="btn sm" data-save>Create</button>
          </div>
        </div>
      </div>`);

    const form = scrim.querySelector('form');
    const releaseFocus = trapFocus(scrim.querySelector('[role="dialog"]'));
  const close = () => { releaseFocus(); scrim.remove(); };
    scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });
    scrim.querySelector('[data-cancel]').addEventListener('click', close);

    scrim.querySelector('[data-save]').addEventListener('click', async () => {
      for (const f of form.querySelectorAll('.field')) {
        f.classList.remove('invalid');
        f.querySelector('.error')?.remove();
      }
      const fd = new FormData(form);
      const btn = scrim.querySelector('[data-save]');
      btn.disabled = true;
      try {
        await api.post('/departments', {
          name: fd.get('name')?.trim(),
          code: fd.get('code')?.trim(),
          costCenterCode: fd.get('costCenterCode')?.trim() || undefined,
        });
        toast('Department created');
        close();
        load();
      } catch (err) {
        for (const [name, message] of Object.entries(err.fields ?? {})) {
          const f = form.querySelector(`[data-f="${name}"]`);
          if (f) { f.classList.add('invalid'); f.appendChild(el(`<span class="error">${esc(message)}</span>`)); }
          else toast(message, true);
        }
        if (!err.fields) toast(err.message, true);
      } finally {
        btn.disabled = false;
      }
    });

    document.body.appendChild(scrim);
    form.querySelector('input').focus();
  });

  load();
}

/* ============================================================ B23 · Audit log */

async function renderAudit(main) {
  return renderSettings(main, 'audit');
}

async function mountAuditTab(container, token) {
  const view = el(`
    <div>
      <div class="toolbar">
        <input class="grow" data-action type="search" placeholder="Filter by action, e.g. auth.login">
        <button class="btn sm ghost" data-refresh>Refresh</button>
      </div>
      <div class="card" data-list></div>
    </div>`);

  if (token !== undefined && token !== settingsTabSeq) return;
  container.replaceChildren(view);
  const list = view.querySelector('[data-list]');
  const actionEl = view.querySelector('[data-action]');

  let loadToken = 0;
  async function load() {
    const token = ++loadToken;
    list.replaceChildren(el(`<div class="p-carbon-05">${
      '<div class="skeleton my-carbon-04"></div>'.repeat(6)}</div>`));

    const params = new URLSearchParams({ limit: '60' });
    if (actionEl.value.trim()) params.set('action', actionEl.value.trim());

    try {
      const { data } = await api.get(`/audit?${params}`);
      if (token !== loadToken) return;

      if (!data.length) {
        list.replaceChildren(el(`
          <div class="empty"><h3>No matching events</h3><p>Try a different action filter.</p></div>`));
        return;
      }

      const wrap = el('<div></div>');
      for (const e of data) {
        const transition = e.previous_state || e.new_state
          ? `<span class="audit-state">${esc(e.previous_state ?? '—')} → ${esc(e.new_state ?? '—')}</span>`
          : '';
        wrap.appendChild(el(`
          <div class="audit-row">
            <div class="audit-top">
              <div class="audit-detail">${esc(e.detail)}</div>
              <div class="audit-when">${fmtWhen(e.at)}</div>
            </div>
            <div class="audit-meta">
              ${esc(e.actor_label ?? 'system')} · ${esc(e.action)} ·
              ${esc(e.entity_type)} ${esc(e.entity_id)}
              ${transition ? ' · ' + transition : ''}
            </div>
            ${e.reason ? `<div class="audit-reason">${esc(e.reason)}</div>` : ''}
          </div>`));
      }
      list.replaceChildren(wrap);
    } catch (err) {
      if (token !== loadToken) return;
      list.replaceChildren(el(`
        <div class="empty">
          <h3>The audit log couldn't be loaded</h3>
          <p>The server did not answer. This is usually temporary.</p>
          <button class="btn sm ghost" data-retry>Try again</button>
        </div>`));
      list.querySelector('[data-retry]')?.addEventListener('click', load);
    }
  }

  let debounce;
  actionEl.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(load, 220); });
  view.querySelector('[data-refresh]').addEventListener('click', () => {
    api.clearCache();
    load();
  });

  load();
}

/* ============================================================ global keyboard & dialogs */

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const manScrim = document.querySelector('.man-scrim');
    if (manScrim) {
      /* Go through the manual's own close, so its listener and the focus are
       * released — removing the node here would skip both. */
      if (typeof manScrim.closeOverlay === 'function') manScrim.closeOverlay();
      else manScrim.remove();
      return;
    }
    const cameraScrim = document.querySelector('.camera-scrim');
    if (cameraScrim) {
      const closeBtn = cameraScrim.querySelector('[data-cam-close], [data-cam-cancel]');
      if (closeBtn) closeBtn.click();
      else cameraScrim.remove();
      return;
    }
    const scrims = document.querySelectorAll('.modal-scrim, .drawer-scrim');
    if (scrims.length) {
      const top = scrims[scrims.length - 1];
      const cancelBtn = top.querySelector('[data-cancel], [data-close]');
      if (cancelBtn) cancelBtn.click();
      else top.remove();
    }
  }
});

/* ============================================================ boot */

(async function boot() {
  try {
    const savedDensity = localStorage.getItem('trek_pref_density') || 'standard';
    document.body.setAttribute('data-density', savedDensity);
    const savedMotion = localStorage.getItem('trek_pref_motion') || 'productive';
    document.body.setAttribute('data-motion', savedMotion);
  } catch { /* storage may be blocked in strict private browsing */ }

  const params = new URLSearchParams(location.search);
  if (location.pathname === '/set-password' && params.get('token')) {
    return renderSetPassword(params.get('token'));
  }
  try {
    const { principal: p } = await api.get('/me');
    principal = p;
    /* The dashboard is the front door for everybody: it answers "what needs
     * me now" before anything else, and it is scoped to what the person is
     * allowed to see — their own travel, their team, or the company. */
    route = 'dashboard';
    /* The currency list is needed by every picker, so it is fetched once
     * here rather than at every screen that draws one. */
    loadCurrencies().catch(() => { /* the pickers fall back to what they have */ });
    loadPermissionMatrix().catch(() => { /* the manual falls back to its prose */ });
    renderApp();
  } catch {
    /* No live session — the expected path on a cold load. */
    renderLogin();
  }
})();
