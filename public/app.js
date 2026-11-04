/* Trek — frontend single-page client.
 *
 * Clean vanilla JavaScript with no build step, semantic HTML, and responsive CSS.
 * Screens: Profile, Trips, Expenses, Approvals, Employees, Departments, and Audit log.
 */

'use strict';

/* ============================================================ api client */

const api = {
  async call(method, path, body) {
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
      const err = new Error(payload?.error?.message ?? 'Something went wrong.');
      err.code = payload?.error?.code;
      err.status = res.status;
      err.fields = payload?.error?.fields;
      err.attemptsRemaining = payload?.error?.attemptsRemaining;
      throw err;
    }
    return payload;
  },
  get:   (p) => api.call('GET', p),
  post:  (p, b) => api.call('POST', p, b),
  patch: (p, b) => api.call('PATCH', p, b),
  delete:(p) => api.call('DELETE', p),
};

/* ============================================================ helpers */

const root = document.getElementById('root');
const toastHost = document.getElementById('toasts');

/* Every interpolated value passes through here. */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

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

/* ============================================================ state */

let principal = null;
let route = 'profile';

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
  /* The server decides the landing screen; the client only follows it. */
  route = p.surface === 'admin' ? 'employees' : (p.surface === 'manager' ? 'approvals' : 'trips');
  renderApp();
  toast(`Signed in as ${p.name} · ${p.departmentName}`);
}

function renderLogin(notice, prefill = '') {
  const inner = el(`
    <div>
      <h1>Sign in</h1>
      <p class="sub">Use your work email and password.</p>
      ${notice ? `<p class="form-note" style="margin:0 0 16px">${esc(notice)}</p>` : ''}
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
  loginCard(el('<div><div class="skeleton" style="height:22px;margin-bottom:18px"></div><div class="skeleton" style="height:40px"></div></div>'));

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
  const items = [{ key: 'profile', label: 'My profile' }];

  const has = (perm) => p.includes(perm);

  if (has('trip.create')) {
    items.push({ section: 'Travel' });
    items.push({ key: 'trips', label: 'My trips' });
    items.push({ key: 'expenses', label: 'My expenses' });
  }
  if (has('trip.approve') || has('expense.approve')) {
    items.push({ section: 'Manager' });
    items.push({ key: 'approvals', label: 'Approvals' });
  }
  if (has('employee.manage')) {
    items.push({ section: 'Admin' });
    items.push({ key: 'employees', label: 'Employees' });
    items.push({ key: 'departments', label: 'Departments' });
  }
  if (has('audit.read')) items.push({ key: 'audit', label: 'Audit log' });

  return items;
}

function renderApp() {
  const items = navItems();

  const shell = el(`
    <div class="shell">
      <aside class="sidebar">
        <img class="sidebar-mark" src="/brand/trek-mark-dark.svg" alt="Trek">
        <nav class="nav"></nav>
        <div class="sidebar-foot">
          <div class="sidebar-user">
            <div class="nm">${esc(principal.name)}</div>
            <div class="rl">${esc(principal.roles.map((r) => ROLE_LABEL[r] ?? r).join(' · '))}</div>
          </div>
          <button class="nav-item" data-signout>Sign out</button>
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

  root.replaceChildren(shell);
  renderRoute(shell.querySelector('#main'), items);
}

function renderRoute(main, items) {
  switch (route) {
    case 'profile': return renderProfile(main);
    case 'trips': return renderTrips(main);
    case 'expenses': return renderExpenses(main);
    case 'approvals': return renderApprovals(main);
    case 'employees': return renderEmployees(main);
    case 'departments': return renderDepartments(main);
    case 'audit': return renderAudit(main);
    default: return renderProfile(main);
  }
}

/* ============================================================ A21 · Profile */

function renderProfile(main) {
  const p = principal;
  const view = el(`
    <div class="profile">
      <div class="page-head">
        <h1>My profile</h1>
        <p>Your employee record is the source of your identity, department, cost center,
           manager and permissions. Only your contact number is editable here.</p>
      </div>
      <div class="card" style="padding:4px 20px 8px">
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

      <form class="card" style="padding:20px;margin-top:16px" novalidate>
        <div class="field" style="margin-bottom:12px">
          <label for="mobile">Contact number</label>
          <input id="mobile" type="tel" autocomplete="tel" value="${esc(p.mobile ?? '')}"
                 placeholder="Not set">
          <span class="hint">Department, grade, manager and roles are administered by
            your company administrator.</span>
        </div>
        <button class="btn sm" type="submit">Save</button>
      </form>

      <form class="card" data-pw style="padding:20px;margin-top:16px" novalidate>
        <div class="field" data-f="currentPassword">
          <label for="curpw">Current password</label>
          <input id="curpw" type="password" autocomplete="current-password">
        </div>
        <div class="field" data-f="newPassword" style="margin-bottom:12px">
          <label for="newpw">New password</label>
          <input id="newpw" type="password" autocomplete="new-password">
          <span class="hint">At least 6 characters. Your other signed-in devices will be signed out.</span>
        </div>
        <button class="btn sm" type="submit">Change password</button>
      </form>

      ${!p.managerId ? `
      <div class="card" style="margin-top:16px; border-left: 3px solid var(--warn); padding: 18px 20px;">
        <h3 style="margin: 0 0 6px; font-size: 15px; font-weight: 600;">No reporting manager assigned</h3>
        <p style="margin: 0 0 8px; font-size: 13.5px; color: var(--ink-72);">
          Trip and expense submissions require an active reporting manager in your reporting hierarchy.
          Without a reporting manager, submitting requests will return <code>422 no_approval_route</code>.
        </p>
        <p style="margin: 0; font-size: 13px; color: var(--ink-72);">
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

  main.replaceChildren(view);
}

/* ============================================================ Trips & Expenses (Pilot) */

function statusPill(status) {
  switch (status) {
    case 'approved': return '<span class="pill ok">Approved</span>';
    case 'submitted': return '<span class="pill warn">Submitted</span>';
    case 'rejected': return '<span class="pill" style="color:var(--danger);background:rgba(138,74,17,.12)">Rejected</span>';
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

  const view = el(`
    <div>
      <div class="page-head" style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px">
        <div>
          <h1>${canReadAllTrips ? 'Trips' : 'My trips'}</h1>
          <p>Create, manage, and submit travel requests for review.</p>
        </div>
        <button class="btn sm" data-add-trip>+ New trip</button>
      </div>
      <div class="toolbar">
        ${canReadAllTrips ? `
          <select data-scope>
            <option value="all">Company trips</option>
            <option value="own">My trips only</option>
          </select>
        ` : ''}
        <select data-status>
          <option value="">All statuses</option>
          <option value="draft">Draft</option>
          <option value="submitted">Submitted</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </select>
        <button class="btn sm ghost" data-refresh>Refresh</button>
      </div>
      <div class="card" data-table></div>
    </div>`);

  main.replaceChildren(view);

  const tableHost = view.querySelector('[data-table]');
  const statusEl = view.querySelector('[data-status]');
  const scopeEl = view.querySelector('[data-scope]');

  view.querySelector('[data-add-trip]').addEventListener('click', () => {
    renderTripFormDrawer(null, load);
  });
  view.querySelector('[data-refresh]').addEventListener('click', load);
  statusEl.addEventListener('change', load);
  scopeEl?.addEventListener('change', load);

  async function load() {
    tableHost.replaceChildren(el(`
      <div style="padding:16px">
        ${'<div class="skeleton" style="margin:10px 0"></div>'.repeat(4)}
      </div>`));

    try {
      const activeScope = scopeEl ? scopeEl.value : 'own';
      const q = statusEl.value
        ? `?scope=${encodeURIComponent(activeScope)}&status=${encodeURIComponent(statusEl.value)}`
        : `?scope=${encodeURIComponent(activeScope)}`;
      const { data } = await api.get(`/trips${q}`);

      if (!data.length) {
        tableHost.replaceChildren(el(`
          <div class="empty">
            <h3>No trips found</h3>
            <p>You have no travel requests in this status. Create a new trip to get started.</p>
            <button class="btn sm" data-create-empty>+ Create trip</button>
          </div>`));
        tableHost.querySelector('[data-create-empty]')?.addEventListener('click', () => {
          renderTripFormDrawer(null, load);
        });
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
      for (const t of data) {
        const row = el(`
          <tr class="clickable">
            <td>
              <div class="cell-primary">
                ${esc(t.destination)}
                <span class="pill off" style="margin-left:6px;font-size:11px;font-weight:600">${esc(t.currency || 'USD')}</span>
              </div>
              <div class="cell-sub">Created ${fmtDate(t.created_at)}</div>
            </td>
            <td class="tabular">${fmtDate(t.start_date)} – ${fmtDate(t.end_date)}</td>
            <td><div style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.purpose)}</div></td>
            <td>${t.expense_count} item${t.expense_count === 1 ? '' : 's'}</td>
            <td>${statusPill(t.status)}</td>
          </tr>`);
        row.addEventListener('click', () => renderTripDetailDrawer(t.id, load));
        tbody.appendChild(row);
      }

      tableHost.replaceChildren(table);
    } catch (err) {
      tableHost.replaceChildren(el(`
        <div class="empty">
          <h3>Failed to load trips</h3>
          <p>${esc(err.message)}</p>
          <button class="btn sm ghost" data-retry>Retry</button>
        </div>`));
      tableHost.querySelector('[data-retry]')?.addEventListener('click', load);
    }
  }

  load();
}

function renderTripFormDrawer(trip, onSaved) {
  const isNew = !trip;
  const scrim = el(`
    <div class="drawer-scrim">
      <div class="drawer" role="dialog" aria-modal="true">
        <div class="drawer-head">
          <h2>${isNew ? 'New trip draft' : 'Edit trip draft'}</h2>
          <p>Specify travel destination, purpose, and dates.</p>
        </div>
        <form class="drawer-body" novalidate>
          <div class="field" data-f="destination">
            <label>Destination <span class="req">*</span></label>
            <input name="destination" value="${esc(trip?.destination ?? '')}" placeholder="e.g. Frankfurt, Germany" required>
            <span class="hint">City and country of travel</span>
          </div>
          <div class="field" data-f="currency">
            <label>Trip Destination Currency <span class="req">*</span></label>
            <select name="currency">
              <option value="USD"${(trip?.currency || 'USD') === 'USD' ? ' selected' : ''}>USD — US Dollar ($)</option>
              <option value="EUR"${trip?.currency === 'EUR' ? ' selected' : ''}>EUR — Euro (€)</option>
              <option value="GBP"${trip?.currency === 'GBP' ? ' selected' : ''}>GBP — British Pound (£)</option>
              <option value="SAR"${trip?.currency === 'SAR' ? ' selected' : ''}>SAR — Saudi Riyal (SAR)</option>
              <option value="AED"${trip?.currency === 'AED' ? ' selected' : ''}>AED — UAE Dirham (AED)</option>
              <option value="INR"${trip?.currency === 'INR' ? ' selected' : ''}>INR — Indian Rupee (₹)</option>
              <option value="SGD"${trip?.currency === 'SGD' ? ' selected' : ''}>SGD — Singapore Dollar (S$)</option>
              <option value="JPY"${trip?.currency === 'JPY' ? ' selected' : ''}>JPY — Japanese Yen (¥)</option>
              <option value="CAD"${trip?.currency === 'CAD' ? ' selected' : ''}>CAD — Canadian Dollar (C$)</option>
              <option value="AUD"${trip?.currency === 'AUD' ? ' selected' : ''}>AUD — Australian Dollar (A$)</option>
              <option value="CHF"${trip?.currency === 'CHF' ? ' selected' : ''}>CHF — Swiss Franc (CHF)</option>
            </select>
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
        </form>
        <div class="drawer-foot">
          <button class="btn ghost sm" data-cancel>Cancel</button>
          <button class="btn sm" data-save>Save draft</button>
        </div>
      </div>
    </div>`);

  document.body.appendChild(scrim);
  const close = () => scrim.remove();
  scrim.querySelector('[data-cancel]').addEventListener('click', close);
  scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });

  const form = scrim.querySelector('form');
  scrim.querySelector('[data-save]').addEventListener('click', async () => {
    const payload = {
      destination: form.querySelector('[name="destination"]').value.trim(),
      currency: form.querySelector('[name="currency"]')?.value || 'USD',
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

async function renderTripDetailDrawer(tripId, onRefresh) {
  const scrim = el(`
    <div class="drawer-scrim">
      <div class="drawer" style="width:min(640px, 100%)" role="dialog" aria-modal="true">
        <div class="drawer-head">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
            <h2>Trip details</h2>
            <button class="btn quiet sm" data-close aria-label="Close">✕</button>
          </div>
        </div>
        <div class="drawer-body" data-content>
          <div style="padding:16px">${'<div class="skeleton" style="margin:10px 0"></div>'.repeat(5)}</div>
        </div>
      </div>
    </div>`);

  document.body.appendChild(scrim);
  const close = () => { scrim.remove(); onRefresh(); };
  scrim.querySelector('[data-close]').addEventListener('click', close);
  scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });

  const bodyEl = scrim.querySelector('[data-content]');

  async function loadDetail() {
    try {
      const { trip } = await api.get(`/trips/${tripId}`);

      const content = el(`
        <div>
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:16px">
            <div>
              <h2 style="margin:0 0 4px;font-size:19px;font-weight:600">
                ${esc(trip.destination)}
                <span class="pill off" style="font-size:12px;vertical-align:middle;margin-left:6px;font-weight:600">${esc(trip.currency || 'USD')}</span>
              </h2>
              <div style="font-size:13px;color:var(--ink-62)">${fmtDate(trip.start_date)} – ${fmtDate(trip.end_date)}</div>
            </div>
            <div>${statusPill(trip.status)}</div>
          </div>

          ${trip.totalsByCurrency?.length ? `
          <div style="margin-bottom:16px;padding:10px 14px;background:var(--canvas);border-radius:var(--r-sm);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
            <div style="font-size:12px;font-weight:600;text-transform:uppercase;color:var(--ink-50)">Expense Totals by Currency:</div>
            <div style="font-size:13.5px;font-weight:600">
              ${trip.totalsByCurrency.map(t => `<span class="pill off" style="margin-left:6px;font-size:12px">${esc(t.amount)} ${esc(t.currency)}</span>`).join('')}
            </div>
          </div>` : ''}

          ${trip.status === 'rejected' && trip.rejection_reason ? `
          <div class="audit-reason" style="margin-bottom:18px">
            <strong>Rejection reason:</strong> ${esc(trip.rejection_reason)}
          </div>` : ''}

          <div style="margin-bottom:20px;padding:12px 14px;background:var(--canvas);border-radius:var(--r-sm)">
            <div style="font-size:12px;font-weight:500;text-transform:uppercase;color:var(--ink-50);margin-bottom:4px">Purpose</div>
            <div style="font-size:13.5px">${esc(trip.purpose)}</div>
          </div>

          <div data-error-slot></div>

          <div style="display:flex;gap:8px;margin-bottom:24px;flex-wrap:wrap">
            ${trip.status === 'draft' ? `
              <button class="btn sm" data-submit-trip>Submit for approval</button>
              <button class="btn sm ghost" data-edit-trip>Edit trip</button>
            ` : `
              <div class="form-note" style="margin:0">
                ${trip.status === 'submitted' ? 'Trip submitted for manager review. Editing is locked.' : ''}
                ${trip.status === 'approved' ? `Trip approved by ${esc(trip.decided_by_name || 'manager')} on ${fmtDate(trip.decided_at)}.` : ''}
              </div>
            `}
          </div>

          <div style="border-top:1px solid var(--line);padding-top:20px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
              <h3 style="margin:0;font-size:15px;font-weight:600">Expenses (${trip.expenses?.length || 0})</h3>
              ${trip.status === 'draft' ? `<button class="btn sm ghost" data-add-expense>+ Add expense</button>` : ''}
            </div>
            <div data-expenses-table></div>
          </div>
        </div>`);

      // Wire submit trip
      const submitBtn = content.querySelector('[data-submit-trip]');
      if (submitBtn) {
        submitBtn.addEventListener('click', async () => {
          submitBtn.disabled = true;
          content.querySelector('[data-error-slot]').replaceChildren();
          try {
            await api.post(`/trips/${trip.id}/submit`);
            toast('Trip submitted for manager approval');
            loadDetail();
          } catch (err) {
            submitBtn.disabled = false;
            if (err.code === 'no_approval_route') {
              content.querySelector('[data-error-slot]').replaceChildren(el(`
                <div class="form-error">
                  <strong>Cannot submit:</strong> You do not have an active reporting manager assigned.
                  Contact an administrator to configure your reporting line before submitting travel requests.
                </div>`));
            } else {
              toast(err.message, true);
            }
          }
        });
      }

      // Wire edit trip
      const editBtn = content.querySelector('[data-edit-trip]');
      if (editBtn) {
        editBtn.addEventListener('click', () => {
          renderTripFormDrawer(trip, loadDetail);
        });
      }

      // Wire add expense
      const addExpBtn = content.querySelector('[data-add-expense]');
      if (addExpBtn) {
        addExpBtn.addEventListener('click', () => {
          renderExpenseFormDrawer(trip.id, null, loadDetail, trip.currency || 'USD');
        });
      }

      // Render expenses table
      const expHost = content.querySelector('[data-expenses-table]');
      if (!trip.expenses?.length) {
        expHost.replaceChildren(el(`
          <div class="empty" style="padding:24px 16px">
            <p style="margin:0 0 10px;font-size:13.5px;color:var(--ink-62)">No expenses added to this trip yet.</p>
            ${trip.status === 'draft' ? `<button class="btn sm quiet" data-add-first-exp>+ Add first expense</button>` : ''}
          </div>`));
        expHost.querySelector('[data-add-first-exp]')?.addEventListener('click', () => {
          renderExpenseFormDrawer(trip.id, null, loadDetail, trip.currency || 'USD');
        });
      } else {
        const expTable = el(`
          <div class="card" style="border:1px solid var(--line-soft)">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Description</th>
                  <th>Category</th>
                  <th style="text-align:right">Amount</th>
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
              <td class="tabular" style="font-size:12.5px">${fmtDate(x.expense_date)}</td>
              <td>
                <div style="font-weight:500">${esc(x.description)}</div>
                ${x.status === 'rejected' && x.rejection_reason ? `<div class="cell-sub" style="color:var(--danger)">Reason: ${esc(x.rejection_reason)}</div>` : ''}
              </td>
              <td><span class="pill off" style="text-transform:capitalize">${esc(x.category)}</span></td>
              <td class="tabular" style="text-align:right;font-weight:500">${esc(x.amount)} ${esc(x.currency)}</td>
              <td>${statusPill(x.status)}</td>
              <td style="text-align:right;white-space:nowrap">
                ${x.status === 'draft' ? `
                  <button class="btn quiet sm" data-sub-x title="Submit expense">Submit</button>
                  <button class="btn quiet sm" data-edit-x title="Edit expense">Edit</button>
                  <button class="btn quiet sm danger" data-del-x title="Delete expense">Delete</button>
                ` : `<span class="cell-sub" style="font-size:11.5px">Locked</span>`}
              </td>
            </tr>`);

          xRow.querySelector('[data-sub-x]')?.addEventListener('click', async (e) => {
            e.stopPropagation();
            try {
              await api.post(`/expenses/${x.id}/submit`);
              toast('Expense submitted');
              loadDetail();
            } catch (err) {
              toast(err.message, true);
            }
          });

          xRow.querySelector('[data-edit-x]')?.addEventListener('click', (e) => {
            e.stopPropagation();
            renderExpenseFormDrawer(trip.id, x, loadDetail);
          });

          xRow.querySelector('[data-del-x]')?.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!confirm(`Delete expense "${x.description}"?`)) return;
            try {
              await api.delete(`/expenses/${x.id}`);
              toast('Expense deleted');
              loadDetail();
            } catch (err) {
              toast(err.message, true);
            }
          });

          expTbody.appendChild(xRow);
        }
        expHost.replaceChildren(expTable);
      }

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

function renderExpenseFormDrawer(tripId, expense, onSaved, defaultCurrency = 'USD') {
  const isNew = !expense;
  const initialCurrency = expense?.currency ?? defaultCurrency ?? 'USD';
  const scrim = el(`
    <div class="drawer-scrim" style="z-index:55">
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
              <option value="meals"${expense?.category === 'meals' ? ' selected' : ''}>Meals</option>
              <option value="lodging"${expense?.category === 'lodging' ? ' selected' : ''}>Lodging</option>
              <option value="transport"${expense?.category === 'transport' ? ' selected' : ''}>Transport</option>
              <option value="airfare"${expense?.category === 'airfare' ? ' selected' : ''}>Airfare</option>
              <option value="supplies"${expense?.category === 'supplies' ? ' selected' : ''}>Supplies</option>
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
              <input type="text" name="currency" list="expense-currencies" maxlength="3" style="text-transform:uppercase" value="${esc(initialCurrency)}" required>
              <datalist id="expense-currencies">
                <option value="USD">USD — US Dollar ($)</option>
                <option value="EUR">EUR — Euro (€)</option>
                <option value="GBP">GBP — British Pound (£)</option>
                <option value="SAR">SAR — Saudi Riyal (SAR)</option>
                <option value="AED">AED — UAE Dirham (AED)</option>
                <option value="INR">INR — Indian Rupee (₹)</option>
                <option value="SGD">SGD — Singapore Dollar (S$)</option>
                <option value="JPY">JPY — Japanese Yen (¥)</option>
                <option value="CAD">CAD — Canadian Dollar (C$)</option>
                <option value="AUD">AUD — Australian Dollar (A$)</option>
                <option value="CHF">CHF — Swiss Franc (CHF)</option>
              </datalist>
              <span class="hint">Select common currency or type 3-letter code</span>
            </div>
          </div>
        </form>
        <div class="drawer-foot">
          <button class="btn ghost sm" data-cancel>Cancel</button>
          <button class="btn sm" data-save>Save expense</button>
        </div>
      </div>
    </div>`);

  document.body.appendChild(scrim);
  const close = () => scrim.remove();
  scrim.querySelector('[data-cancel]').addEventListener('click', close);
  scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });

  const form = scrim.querySelector('form');
  scrim.querySelector('[data-save]').addEventListener('click', async () => {
    const payload = {
      tripId,
      date: form.querySelector('[name="date"]').value,
      description: form.querySelector('[name="description"]').value.trim(),
      category: form.querySelector('[name="category"]').value,
      amount: form.querySelector('[name="amount"]').value.trim(),
      currency: form.querySelector('[name="currency"]').value.trim().toUpperCase(),
    };

    const saveBtn = scrim.querySelector('[data-save]');
    saveBtn.disabled = true;

    try {
      if (isNew) {
        await api.post('/expenses', payload);
        toast('Expense added to trip');
      } else {
        await api.patch(`/expenses/${expense.id}`, payload);
        toast('Expense updated');
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

/* ------------------------------------------------------------ Expenses Screen */

async function renderExpenses(main) {
  const canReadAllExpenses = principal.permissions.includes('expense.read.all');

  const view = el(`
    <div>
      <div class="page-head">
        <h1>${canReadAllExpenses ? 'Expenses' : 'My expenses'}</h1>
        <p>View and manage filed expense entries.</p>
      </div>
      <div class="toolbar">
        ${canReadAllExpenses ? `
          <select data-scope>
            <option value="all">Company expenses</option>
            <option value="own">My expenses only</option>
          </select>
        ` : ''}
        <select data-status>
          <option value="">All statuses</option>
          <option value="draft">Draft</option>
          <option value="submitted">Submitted</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </select>
        <button class="btn sm ghost" data-refresh>Refresh</button>
      </div>
      <div class="card" data-table></div>
    </div>`);

  main.replaceChildren(view);

  const tableHost = view.querySelector('[data-table]');
  const statusEl = view.querySelector('[data-status]');
  const scopeEl = view.querySelector('[data-scope]');

  view.querySelector('[data-refresh]').addEventListener('click', load);
  statusEl.addEventListener('change', load);
  scopeEl?.addEventListener('change', load);

  async function load() {
    tableHost.replaceChildren(el(`
      <div style="padding:16px">
        ${'<div class="skeleton" style="margin:10px 0"></div>'.repeat(4)}
      </div>`));

    try {
      const activeScope = scopeEl ? scopeEl.value : 'own';
      const q = statusEl.value
        ? `?scope=${encodeURIComponent(activeScope)}&status=${encodeURIComponent(statusEl.value)}`
        : `?scope=${encodeURIComponent(activeScope)}`;
      const { data } = await api.get(`/expenses${q}`);

      if (!data.length) {
        tableHost.replaceChildren(el(`
          <div class="empty">
            <h3>No expenses found</h3>
            <p>You have no expense entries in this status. Add expenses directly within your trips.</p>
          </div>`));
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
              <th style="text-align:right">Amount</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>`);

      const tbody = table.querySelector('tbody');
      for (const x of data) {
        const row = el(`
          <tr>
            <td class="tabular">${fmtDate(x.expense_date)}</td>
            <td>
              <div class="cell-primary">${esc(x.description)}</div>
              ${x.status === 'rejected' && x.rejection_reason ? `<div class="cell-sub" style="color:var(--danger)">Reason: ${esc(x.rejection_reason)}</div>` : ''}
            </td>
            <td>${esc(x.trip_destination || 'Trip')}</td>
            <td><span class="pill off" style="text-transform:capitalize">${esc(x.category)}</span></td>
            <td class="tabular" style="text-align:right;font-weight:500">${esc(x.amount)} ${esc(x.currency)}</td>
            <td>${statusPill(x.status)}</td>
            <td style="text-align:right;white-space:nowrap">
              ${x.status === 'draft' ? `
                <button class="btn quiet sm" data-sub>Submit</button>
                <button class="btn quiet sm" data-edit>Edit</button>
                <button class="btn quiet sm danger" data-del>Delete</button>
              ` : `<span class="cell-sub" style="font-size:11.5px">Locked</span>`}
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
    } catch (err) {
      tableHost.replaceChildren(el(`
        <div class="empty">
          <h3>Failed to load expenses</h3>
          <p>${esc(err.message)}</p>
        </div>`));
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

      <div class="toolbar" style="border-bottom:1px solid var(--line);padding-bottom:12px;margin-bottom:20px">
        <button class="chip" data-tab="trips" aria-pressed="true">Submitted Trips</button>
        <button class="chip" data-tab="expenses" aria-pressed="false">Submitted Expenses</button>
        <div style="flex:1"></div>
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

  view.querySelector('[data-refresh]').addEventListener('click', load);

  async function load() {
    contentEl.replaceChildren(el(`
      <div style="padding:16px">
        ${'<div class="skeleton" style="margin:10px 0"></div>'.repeat(4)}
      </div>`));

    if (activeTab === 'trips') {
      await loadTrips();
    } else {
      await loadExpenses();
    }
  }

  async function loadTrips() {
    try {
      const scope = principal.permissions.includes('trip.read.all') ? 'all' : 'team';
      const { data } = await api.get(`/trips?scope=${scope}&status=submitted`);

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
              <th style="text-align:right">Actions</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>`);

      const tbody = table.querySelector('tbody');
      for (const t of data) {
        const row = el(`
          <tr>
            <td>
              <div class="cell-primary">${esc(t.employee_name)}</div>
              <div class="cell-sub">${esc(t.employee_code)}</div>
            </td>
            <td><div style="font-weight:500">${esc(t.destination)}</div></td>
            <td class="tabular">${fmtDate(t.start_date)} – ${fmtDate(t.end_date)}</td>
            <td><div style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.purpose)}</div></td>
            <td class="tabular" style="font-size:12.5px">${fmtWhen(t.submitted_at)}</td>
            <td style="text-align:right;white-space:nowrap">
              <button class="btn sm" data-approve>Approve</button>
              <button class="btn sm danger" data-reject>Reject</button>
            </td>
          </tr>`);

        row.querySelector('[data-approve]').addEventListener('click', async () => {
          if (!confirm(`Approve trip to ${t.destination} for ${t.employee_name}?`)) return;
          try {
            await api.post(`/trips/${t.id}/decide`, { decision: 'approve' });
            toast(`Trip for ${t.employee_name} approved`);
            load();
          } catch (err) {
            toast(err.message, true);
          }
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
      contentEl.replaceChildren(el(`
        <div class="empty">
          <h3>Failed to load submitted trips</h3>
          <p>${esc(err.message)}</p>
        </div>`));
    }
  }

  async function loadExpenses() {
    try {
      const scope = principal.permissions.includes('expense.read.all') ? 'all' : 'team';
      const { data } = await api.get(`/expenses?scope=${scope}&status=submitted`);

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
              <th style="text-align:right">Amount</th>
              <th>Submitted</th>
              <th style="text-align:right">Actions</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>`);

      const tbody = table.querySelector('tbody');
      for (const x of data) {
        const row = el(`
          <tr>
            <td>
              <div class="cell-primary">${esc(x.employee_name)}</div>
              <div class="cell-sub">${esc(x.employee_code)}</div>
            </td>
            <td><div style="font-weight:500">${esc(x.description)}</div></td>
            <td>${esc(x.trip_destination || 'Trip')}</td>
            <td><span class="pill off" style="text-transform:capitalize">${esc(x.category)}</span></td>
            <td class="tabular" style="text-align:right;font-weight:500">${esc(x.amount)} ${esc(x.currency)}</td>
            <td class="tabular" style="font-size:12.5px">${fmtWhen(x.submitted_at)}</td>
            <td style="text-align:right;white-space:nowrap">
              <button class="btn sm" data-approve>Approve</button>
              <button class="btn sm danger" data-reject>Reject</button>
            </td>
          </tr>`);

        row.querySelector('[data-approve]').addEventListener('click', async () => {
          if (!confirm(`Approve expense "${x.description}" (${x.amount} ${x.currency}) for ${x.employee_name}?`)) return;
          try {
            await api.post(`/expenses/${x.id}/decide`, { decision: 'approve' });
            toast(`Expense for ${x.employee_name} approved`);
            load();
          } catch (err) {
            toast(err.message, true);
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
      contentEl.replaceChildren(el(`
        <div class="empty">
          <h3>Failed to load submitted expenses</h3>
          <p>${esc(err.message)}</p>
        </div>`));
    }
  }

  load();
}

function renderRejectModal({ title, promptText, onConfirm }) {
  const scrim = el(`
    <div class="modal-scrim" style="z-index:70">
      <div class="modal-card" role="dialog" aria-modal="true">
        <div style="padding:20px 24px;border-bottom:1px solid var(--line)">
          <h2 style="margin:0 0 4px;font-size:17px;font-weight:600">${esc(title)}</h2>
          <p style="margin:0;font-size:13px;color:var(--ink-62)">${esc(promptText)}</p>
        </div>
        <form style="padding:20px 24px" novalidate>
          <div class="field" data-f="reason">
            <label>Rejection reason</label>
            <textarea name="reason" rows="3" placeholder="Explain why this request is rejected..." required></textarea>
            <span class="hint">Stored permanently in the audit log and visible to the submitter.</span>
          </div>
          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px">
            <button class="btn ghost sm" type="button" data-cancel>Cancel</button>
            <button class="btn sm danger" type="submit" data-confirm>Confirm rejection</button>
          </div>
        </form>
      </div>
    </div>`);

  document.body.appendChild(scrim);
  const close = () => scrim.remove();
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
        <input class="grow" data-search type="search" placeholder="Search name, code or email">
        <select data-dept><option value="">All departments</option></select>
        <select data-status>
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

  async function load() {
    tableHost.replaceChildren(el(`
      <div style="padding:16px">
        ${'<div class="skeleton" style="margin:10px 0"></div>'.repeat(5)}
      </div>`));

    const params = new URLSearchParams();
    if (searchEl.value.trim()) params.set('search', searchEl.value.trim());
    if (deptEl.value) params.set('departmentId', deptEl.value);
    if (statusEl.value) params.set('status', statusEl.value);

    try {
      const { data } = await api.get(`/employees?${params}`);

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
      tableHost.replaceChildren(el(`
        <div class="empty">
          <h3>Couldn't load employees</h3>
          <p>${esc(err.message)}</p>
          <button class="btn sm ghost" data-retry>Try again</button>
        </div>`));
      tableHost.querySelector('[data-retry]').addEventListener('click', load);
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

          <div class="field" data-f="password" style="margin-top:6px">
            <label>${isNew ? 'Initial password' : 'Reset password'} <span class="opt">(optional)</span></label>
            <input name="password" type="password" autocomplete="new-password" placeholder="${isNew ? 'Set initial password for login' : 'Leave blank to keep existing password'}">
            <span class="hint">At least 6 characters. If set, they can sign in immediately and change it anytime later.</span>
          </div>

          <div class="field" data-f="roles" style="margin-top:8px">
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
          <div style="flex:1"></div>
          <button class="btn ghost sm" data-cancel>Cancel</button>
          <button class="btn sm" data-save>${isNew ? 'Add employee' : 'Save'}</button>
        </div>
      </div>
    </div>`);

  const form = scrim.querySelector('form');
  const close = () => scrim.remove();

  scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });
  scrim.querySelector('[data-cancel]').addEventListener('click', close);
  document.addEventListener('keydown', function onEsc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc); }
  });

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
          <div style="flex:1"></div>
          <button class="btn ghost sm" data-cancel>Cancel</button>
          <button class="btn ghost sm" data-validate>Validate only</button>
          <button class="btn sm" data-import disabled>Import</button>
        </div>
      </div>
    </div>`);

  const results = scrim.querySelector('[data-results]');
  const textarea = scrim.querySelector('#paste');
  const importBtn = scrim.querySelector('[data-import]');
  const close = () => scrim.remove();

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
      <div class="card" style="margin-top:8px">
        <table>
          <thead><tr><th style="width:44px">Row</th><th>Employee</th><th>Outcome</th></tr></thead>
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
        result.dryRun ? ' — nothing written yet' : ''}.</p>`));

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

  async function load() {
    tableHost.replaceChildren(el(`<div style="padding:16px">${
      '<div class="skeleton" style="margin:10px 0"></div>'.repeat(4)}</div>`));

    try {
      const { data } = await api.get('/departments');
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
      tableHost.replaceChildren(el(`
        <div class="empty"><h3>Couldn't load departments</h3><p>${esc(err.message)}</p></div>`));
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
            <div style="flex:1"></div>
            <button class="btn ghost sm" data-cancel>Cancel</button>
            <button class="btn sm" data-save>Create</button>
          </div>
        </div>
      </div>`);

    const form = scrim.querySelector('form');
    const close = () => scrim.remove();
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
  const view = el(`
    <div>
      <div class="page-head">
        <h1>Audit log</h1>
        <p>Append-only and permanent. Every business action is recorded with actor,
           timestamp, previous state and new state. Nothing can edit or delete it —
           there is no write endpoint at any privilege level.</p>
      </div>
      <div class="toolbar">
        <input class="grow" data-action type="search" placeholder="Filter by action, e.g. auth.login">
        <button class="btn sm ghost" data-refresh>Refresh</button>
      </div>
      <div class="card" data-list></div>
    </div>`);

  main.replaceChildren(view);
  const list = view.querySelector('[data-list]');
  const actionEl = view.querySelector('[data-action]');

  async function load() {
    list.replaceChildren(el(`<div style="padding:16px">${
      '<div class="skeleton" style="margin:12px 0"></div>'.repeat(6)}</div>`));

    const params = new URLSearchParams({ limit: '60' });
    if (actionEl.value.trim()) params.set('action', actionEl.value.trim());

    try {
      const { data } = await api.get(`/audit?${params}`);

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
      list.replaceChildren(el(`
        <div class="empty"><h3>Couldn't load the audit log</h3><p>${esc(err.message)}</p></div>`));
    }
  }

  let debounce;
  actionEl.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(load, 220); });
  view.querySelector('[data-refresh]').addEventListener('click', load);

  load();
}

/* ============================================================ boot */

(async function boot() {
  const params = new URLSearchParams(location.search);
  if (location.pathname === '/set-password' && params.get('token')) {
    return renderSetPassword(params.get('token'));
  }
  try {
    const { principal: p } = await api.get('/me');
    principal = p;
    route = p.surface === 'admin' ? 'employees' : (p.surface === 'manager' ? 'approvals' : 'trips');
    renderApp();
  } catch {
    /* No live session — the expected path on a cold load. */
    renderLogin();
  }
})();
