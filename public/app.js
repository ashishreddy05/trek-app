/* Trek — frontend.
 *
 * PROVISIONAL — Slot 1 (frontend framework) is unsigned. Plain JS with no build step
 * is the choice that keeps Slot 1 open: nothing to migrate off, the same reasoning
 * that put raw SQL behind ST-02. If Slot 1 signs React/Next, this file and
 * styles.css are the specification to port.
 *
 * Screens are recreations of the approved prototypes — A1 Sign in (password, AUTH-01), A21 Profile,
 * B16/B17/B18 Employees, B19 Departments, B23 Audit log. No screen here is invented,
 * and blocked screens state their blocking decision rather than showing fake data.
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
  return t.content.firstElementChild;
}

function toast(message, bad = false) {
  const node = el(`<div class="toast${bad ? ' bad' : ''}">${esc(message)}</div>`);
  toastHost.appendChild(node);
  setTimeout(() => node.remove(), 4200);
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
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
  route = p.surface === 'admin' ? 'employees' : 'profile';
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
    const btn = form.querySelector('button');
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
      <p class="sub">At least 12 characters. A short phrase of unrelated words is easier to remember than a jumble of symbols.</p>
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

    const btn = e.currentTarget.querySelector('button');
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
    items.push({ key: 'trips', label: 'My trips', blocked: 'BD-06 / BD-07' });
    items.push({ key: 'expenses', label: 'My expenses', blocked: 'BD-08' });
  }
  if (has('trip.approve')) {
    items.push({ section: 'Manager' });
    items.push({ key: 'approvals', label: 'Approvals', blocked: 'BD-02 / BD-09' });
  }
  if (has('expense.review')) {
    items.push({ section: 'Finance' });
    items.push({ key: 'review', label: 'Expense review', blocked: 'BD-08 / ST-03' });
    items.push({ key: 'settlements', label: 'Settlements', blocked: 'ST-03' });
  }
  if (has('booking.manage')) {
    items.push({ section: 'Travel desk' });
    items.push({ key: 'bookings', label: 'Bookings', blocked: 'BD-06 / BD-07' });
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
      <button class="nav-item${route === item.key ? ' active' : ''}${item.blocked ? ' blocked' : ''}"
              ${item.blocked ? `title="Blocked on ${esc(item.blocked)}"` : ''}>
        <span>${esc(item.label)}</span>
        ${item.blocked ? '<span class="nav-count">gated</span>' : ''}
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
  const item = items.find((i) => i.key === route);

  if (item?.blocked) return renderGated(main, item);

  switch (route) {
    case 'profile': return renderProfile(main);
    case 'employees': return renderEmployees(main);
    case 'departments': return renderDepartments(main);
    case 'audit': return renderAudit(main);
    default: return renderProfile(main);
  }
}

/* Blocked screens name their decision. Never a fake empty state — a plausible-looking
 * empty trip list would imply the feature works. */
const BLOCK_DETAIL = {
  'BD-06 / BD-07': [
    'Trips carry a destination band that selects which policy limits apply. No entity stores a band, and <code>trip.country</code> is a split string fragment that cannot be joined on.',
    'BD-06 adds the band master data and <code>trip.band_id</code>. BD-07 changes <code>trip.country</code> to an ISO country code.',
  ],
  'BD-08': [
    'The mobile and console prototypes use different expense categories and payment modes. Reporting rolls up by category, so the two would produce different numbers from the same data.',
    'BD-08 fixes one canonical vocabulary for each. Until then the expense table cannot be created.',
  ],
  'BD-02 / BD-09': [
    'Four seeded employees have no reporting manager, so their approval chain has no first approver. Vikram Shetty is one of them — the Sales pilot approver, and also a traveller.',
    'BD-02 sets the fallback approver. BD-09 settles whether the department-head step resolves via <code>department.head_id</code> or the manager\'s manager.',
  ],
  'BD-08 / ST-03': [
    'Finance review reads expenses, which need BD-08\'s category vocabulary.',
    'ST-03 fixes the exact decimal type for every monetary column. It is effectively irreversible once data exists, so no money column has been created.',
  ],
  'ST-03': [
    'Settlement arithmetic needs the exact decimal type for every monetary column — <code>NUMERIC(14,2)</code> or integer minor units.',
    'The choice is effectively irreversible once data exists, so no money column has been created yet.',
  ],
};

function renderGated(main, item) {
  const lines = BLOCK_DETAIL[item.blocked] ?? [];
  main.replaceChildren(el(`
    <div>
      <div class="page-head">
        <h1>${esc(item.label)}</h1>
        <p>Not built — blocked on an unsigned business decision.</p>
      </div>
      <div class="gated">
        <h2>Blocked on ${esc(item.blocked)}</h2>
        ${lines.map((l) => `<p>${l}</p>`).join('')}
        <ul>
          <li>The approved design for this screen exists and is unchanged.</li>
          <li>No placeholder value or provisional enum has been introduced.</li>
          <li>Sign the decision in <code>TREK-BUSINESS-DECISION-REGISTER.md</code> to unblock it.</li>
        </ul>
      </div>
    </div>`));
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
          <span class="hint">At least 12 characters. Your other signed-in devices will be signed out.</span>
        </div>
        <button class="btn sm" type="submit">Change password</button>
      </form>

      ${!p.managerId ? `
      <div class="gated" style="margin-top:16px">
        <h2>No reporting manager on your record</h2>
        <p>Travel requests need a resolvable approval route. Yours cannot be resolved,
           so a request would be refused with <code>422 no_approval_route</code>.</p>
        <p>This is <strong>BD-02</strong> — the company must define the fallback approver
           for employees without a manager. It is not something the system can choose.</p>
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
    const btn = pwForm.querySelector('button');
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
                : '<span class="pill warn" title="No approval route — BD-02">no manager</span>'}
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
            ? 'Employee code and work email must be unique.'
            : `${esc(employee.employee_code)} · ${esc(employee.department_name)}`}</p>
        </div>
        <form class="drawer-body" novalidate>
          <div class="grid-2">
            <div class="field" data-f="employeeCode">
              <label>Employee code</label>
              <input name="employeeCode" value="${esc(employee?.employee_code ?? '')}" required>
              <span class="hint">Unique · login-adjacent</span>
            </div>
            <div class="field" data-f="name">
              <label>Full name</label>
              <input name="name" value="${esc(employee?.name ?? '')}" required>
            </div>
            <div class="field" data-f="workEmail">
              <label>Work email</label>
              <input name="workEmail" type="email" value="${esc(employee?.work_email ?? '')}" required>
              <span class="hint">Unique · login identity</span>
            </div>
            <div class="field" data-f="mobile">
              <label>Mobile</label>
              <input name="mobile" type="tel" value="${esc(employee?.mobile ?? '')}">
            </div>
            <div class="field" data-f="departmentId">
              <label>Department</label>
              <select name="departmentId" required>
                ${departments.map((d) => `<option value="${esc(d.id)}"${
                  d.id === employee?.department_id ? ' selected' : ''}>${esc(d.name)}</option>`).join('')}
              </select>
              <span class="hint">Master data · sets the cost center</span>
            </div>
            <div class="field" data-f="designation">
              <label>Designation</label>
              <input name="designation" value="${esc(employee?.designation ?? '')}" required>
            </div>
            <div class="field" data-f="grade">
              <label>Grade</label>
              <select name="grade" required>
                ${['G1','G2','G3','G4','G5','G6'].map((g) =>
                  `<option${g === (employee?.grade ?? 'G3') ? ' selected' : ''}>${g}</option>`).join('')}
              </select>
              <span class="hint">Drives policy limits</span>
            </div>
            <div class="field" data-f="location">
              <label>Location</label>
              <input name="location" value="${esc(employee?.location ?? '')}" required>
            </div>
            <div class="field" data-f="managerId">
              <label>Reporting manager</label>
              <select name="managerId">
                <option value="">— no reporting manager —</option>
                ${managers.filter((m) => m.id !== employee?.id).map((m) =>
                  `<option value="${esc(m.id)}"${m.id === employee?.manager_id ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}
              </select>
              <span class="hint">Master data · routes approvals</span>
            </div>
            <div class="field" data-f="joiningDate">
              <label>Joining date</label>
              <input name="joiningDate" type="date"
                     value="${esc((employee?.joining_date ?? '').toString().slice(0, 10))}" required>
            </div>
          </div>

          ${isNew ? '' : `
          <div class="field" data-f="roles" style="margin-top:8px">
            <label>Roles</label>
            <div class="chips">
              ${Object.entries(ROLE_LABEL).map(([k, label]) => `
                <button type="button" class="chip" data-role="${esc(k)}"
                        aria-pressed="${(employee.roles ?? []).includes(k)}">${esc(label)}</button>`).join('')}
            </div>
            <span class="hint">Role changes are saved separately and audited on their own.</span>
          </div>`}
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
      grade: fd.get('grade'),
      location: fd.get('location')?.trim(),
      managerId: fd.get('managerId') || null,
      joiningDate: fd.get('joiningDate'),
    };

    const btn = scrim.querySelector('[data-save]');
    btn.disabled = true;
    try {
      if (isNew) {
        await api.post('/employees', payload);
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
    route = p.surface === 'admin' ? 'employees' : 'profile';
    renderApp();
  } catch {
    /* No live session — the expected path on a cold load. */
    renderLogin();
  }
})();
