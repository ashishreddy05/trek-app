/* The Trek manual.
 *
 * A help system inside the app, not a document somebody has to find. It opens
 * from a small icon in the sidebar, works offline, and is searchable.
 *
 * The content is DATA, not markup: the same strings can be checked against the
 * code, and a section that names an endpoint can be verified to exist.
 */

const MANUAL = {
  /* ------------------------------------------------------------------ the
   * workflow, stage by stage. Every stage says who acts, what they see, and
   * what unlocks next — the questions a new user actually has. */
  workflow: {
    title: 'The workflow',
    intro: 'A trip moves through eight stages. Money only moves in one direction, and each stage unlocks exactly one thing.',
    stages: [
      {
        n: 1,
        name: 'Trip creation',
        who: 'Traveller',
        what: 'Open My trips and start a new trip. Give it a destination, a business purpose, the dates, and the currency you will spend in.',
        note: 'It stays a draft. Nothing is visible to anyone else yet.',
      },
      {
        n: 2,
        name: 'Budget preparation',
        who: 'Traveller',
        what: 'Add the estimated expenses — one line each: category, description, amount, currency. Then set the currency plan: how much cash you need to carry, how much to load on a forex card, the exchange rate to the base currency (INR), and any GST, top-up charges or service fees.',
        note: 'Every currency you use needs a rate. Money in the base currency needs no plan at all — converting INR to INR is the identity.',
      },
      {
        n: 3,
        name: 'Approval',
        who: 'Manager (or Finance)',
        what: 'Your manager reviews the budget and picks one of three: approve it, request changes with a reason, or reject it with a reason.',
        note: 'Request changes sends the trip back to you to edit and resubmit. The reason is always shown to you.',
      },
      {
        n: 4,
        name: 'Fund allocation',
        who: 'Finance',
        what: 'Finance records what the company actually handed over: cash, a forex card, or an extra tranche issued mid-trip.',
        note: 'The first allocation activates the trip. Until then, no expense can be claimed against it.',
      },
      {
        n: 5,
        name: 'Daily expenses & bills',
        who: 'Traveller',
        what: 'Record each expense: date, category, description, amount, the currency you actually paid in, and how you paid (cash, forex card, card, bank transfer). Attach the receipt as a photo or PDF.',
        note: 'Submit each expense to your manager for approval. An expense can only be claimed against an active trip.',
      },
      {
        n: 6,
        name: 'Final reconciliation',
        who: 'Traveller → Finance',
        what: 'When the trip is over, submit it for reconciliation. The system totals the funds issued against the approved spend and gives you a balance.',
        note: 'A positive balance is money you owe the company. A negative balance is money the company owes you. Every expense must be decided first — money still in flight would make the balance wrong.',
      },
      {
        n: 7,
        name: 'Finance approval',
        who: 'Finance',
        what: 'Finance approves the reconciliation, or sends it back with a reason if something is missing.',
        note: 'Sent back means the trip reopens so you can fix it and resubmit.',
      },
      {
        n: 8,
        name: 'Settlement & closure',
        who: 'Finance',
        what: 'Finance records the settlement — how the balance was settled — and closes the trip.',
        note: 'A closed trip takes no more money. If something comes up afterwards, raise a new trip.',
      },
    ],
  },

  /* ------------------------------------------------------------------ what
   * each role can and cannot do. */
  roles: {
    title: 'Who can do what',
    intro: 'Every role sees the same screens but different amounts of it. A permission is a promise the server keeps, not a hint in the interface.',
    rows: [
      { role: 'Traveller', can: 'Create trips and budgets, set currency plans, record expenses and receipts, submit for approval and reconciliation.' },
      { role: 'Manager', can: 'See and decide the trips and expenses of their reporting tree — the people who report to them, directly or through someone else.' },
      { role: 'Finance', can: 'Read every trip in the company, approve budgets and reconciliations company-wide, issue funds, settle and close trips.' },
      { role: 'Travel desk', can: 'Read every trip in the company and manage travel documents.' },
      { role: 'Admin', can: 'Manage employees, departments, cost centres and roles, and read the full audit log.' },
    ],
    notes: [
      'A manager can never approve their own request, and can never decide on someone outside their reporting tree.',
      'Company-wide authority and reporting-tree authority are separate permissions. A manager holds the second, never the first.',
      'Someone whose account is deactivated loses access immediately, and every session they had is revoked.',
    ],
  },

  /* ------------------------------------------------------------------ the
   * states a trip and an expense can be in, and what each one allows. */
  states: {
    title: 'States',
    intro: 'The stage a record is in decides what can happen to it. The server enforces this — the interface only shows you the buttons that would work.',
    trip: [
      { s: 'Draft', d: 'You are still preparing it. Editable, and nobody else can see it.' },
      { s: 'Submitted', d: 'Waiting for an approver. Locked while it is being reviewed.' },
      { s: 'Changes requested', d: 'Sent back to you with a reason. Edit it and submit again.' },
      { s: 'Approved', d: 'The budget is agreed and frozen. Waiting for Finance to issue funds.' },
      { s: 'Rejected', d: 'Refused with a reason. Raise a new trip if the trip is still needed.' },
      { s: 'Active', d: 'Funds issued. This is when expenses can be recorded.' },
      { s: 'Awaiting Finance', d: 'Reconciliation submitted, waiting on Finance.' },
      { s: 'Reconciled', d: 'Finance approved the reconciliation. Waiting on settlement.' },
      { s: 'Closed', d: 'Settled and closed. No more money can be claimed against it.' },
    ],
    expense: [
      { s: 'Draft', d: 'Not yet submitted. Editable and deletable.' },
      { s: 'Submitted', d: 'Waiting for your manager.' },
      { s: 'Approved', d: 'Counted towards the reconciliation.' },
      { s: 'Rejected', d: 'Refused with a reason.' },
    ],
  },

  /* ------------------------------------------------------------------ the
   * money rules, because these are the ones that bite. */
  money: {
    title: 'Money',
    intro: 'The rules are deliberately strict. A reimbursement off by one paisa is a real bug, so nothing in Trek uses floating-point arithmetic.',
    rules: [
      { t: 'Amounts are exact decimals', d: 'Stored as NUMERIC(14,2) in the database and handled as exact strings. No float ever touches a monetary value, on either side of the wire.' },
      { t: 'Rates are entered, not fetched', d: 'You set the exchange rate on the trip’s currency plan. There is no FX provider behind it, and a rate is never applied twice.' },
      { t: 'Conversions are snapshots', d: 'Every amount stores the rate it used. If the rate on the plan changes later, money already budgeted, spent or issued is never rewritten — the arithmetic stays auditable.' },
      { t: 'The base currency is INR', d: 'Budget-versus-actual and reconciliation are computed in INR, so a trip spent across several currencies still has one comparable number.' },
      { t: 'One category vocabulary', d: 'Budget lines and expenses use the same list — travel, accommodation, food, visa, SIM card, other — so budget-versus-actual compares like with like.' },
      { t: 'The balance tells you who owes whom', d: 'Positive means the traveller returns money to the company. Negative means the company reimburses the traveller.' },
    ],
  },

  /* ------------------------------------------------------------------ the
   * things that go wrong, and what to do about them. */
  troubleshooting: {
    title: 'When something goes wrong',
    intro: 'Almost every message in Trek says what to do next. These are the ones worth reading twice. The messages are quoted exactly as the app shows them, so you can match one against the screen in front of you.',
    items: [
      { q: '“No exchange rate is set for AED on this trip. Add it to the currency plan first.”', a: 'Every currency you spend in needs a rate on the trip’s currency plan. The base currency (INR) does not — converting it to itself is the identity.' },
      { q: '“Expenses can only be recorded once the trip is approved and funded; this trip is draft.”', a: 'The trip has to be approved, and Finance has to have issued funds. That is what makes it active.' },
      { q: '“You do not have an active reporting manager assigned.”', a: 'Your account has no manager, so nothing you submit can be approved. An Admin sets your reporting line under Employees.' },
      { q: '“1 expense on this trip is still awaiting approval. Approve or reject them before reconciling.”', a: 'The reconciliation needs every expense decided — approved or rejected. Money still in flight makes the balance wrong.' },
      { q: '“Add at least one budget line before submitting this trip for approval.”', a: 'A budget is what gets approved. Add at least one estimated-expense line to the trip first.' },
      { q: '“Only a draft trip can be edited; this trip is submitted.”', a: 'The stage does not allow that action. You cannot submit a closed trip or edit one under review.' },
      { q: '“Only draft expenses can be deleted; this expense is approved.”', a: 'An expense that has been submitted cannot be deleted. The decision is recorded; raise a correcting expense instead.' },
      { q: '“Only submitted expenses can be decided; this expense is approved.”', a: 'An expense can only be decided once, while it is with your manager.' },
      { q: '“Only a pending reconciliation can be decided; this trip is active.”', a: 'A reconciliation that Finance sent back has to be resubmitted by the traveller first.' },
      { q: '“Funds are issued only after the budget is approved; this trip is draft.”', a: 'Approval and funding are separate steps. The budget is approved first; then Finance issues the cash or the card.' },
      { q: '“A reconciliation can only be submitted while the trip is active; this trip is draft.”', a: 'Reconciliation happens after the trip is over and funded, not while it is being planned.' },
      { q: '“A trip can only be settled after its reconciliation is approved; this trip is active.”', a: 'Finance approves the reconciliation first; the settlement and the closure follow it.' },
      { q: '“You do not have access to this.”', a: 'Either it is outside your reporting tree, or you do not hold that permission. An Admin can widen it.' },
      { q: '“Not found.”', a: 'Deliberately identical to a record that does not exist, so ids cannot be guessed to find out who has what.' },
      { q: 'Too many failed attempts.', a: 'Five failures for one email in fifteen minutes locks that email. Wait it out, or have an Admin issue a reset link.' },
      { q: 'A reset link never arrived.', a: 'Email may not be switched on yet. An Admin can issue a link from the command line instead.' },
    ],
  },

  /* ------------------------------------------------------------------ the
   * screens, so the interface is itself documented. */
  screens: {
    title: 'The screens',
    intro: 'What each part of the app is for.',
    items: [
      { t: 'My profile', d: 'Your record, your roles, your contact number. You can change your contact number and your password. Your department, grade, manager and roles are set by an Admin.' },
      { t: 'My trips', d: 'Every trip you have raised, with its stage and its budget against actual spend. Open one to prepare it, submit it, record expenses and reconcile it.' },
      { t: 'My expenses', d: 'Every expense you have claimed across all trips, filterable by trip and stage.' },
      { t: 'Approvals', d: 'For managers: the trips and expenses waiting on your decision, from the people who report to you.' },
      { t: 'Dashboard', d: 'For managers and Finance: budgets, approvals outstanding, spend, pending settlements, and employee-wise totals. Export to CSV for Excel.' },
      { t: 'Employees', d: 'For Admin: add people, set their reporting line, department, grade and roles, and deactivate an account.' },
      { t: 'Departments', d: 'For Admin: departments, their cost centres, their head, and how many active people each has.' },
      { t: 'Audit log', d: 'For Admin: every action, with who did it, when, and what changed before and after. It cannot be edited or deleted — by anyone, including the database owner.' },
    ],
  },

  /* ------------------------------------------------------------------ the
   * vocabulary. */
  glossary: {
    title: 'Words',
    intro: 'The terms used across Trek, and what each one means here.',
    items: [
      { t: 'Base currency', d: 'INR. The currency everything is converted into for comparison.' },
      { t: 'Budget line', d: 'One estimated expense on a trip: category, description, amount, currency.' },
      { t: 'Currency plan', d: 'Per currency on a trip: cash to carry, forex card to load, exchange rate to base, and the charges (GST, top-up, service fees).' },
      { t: 'Funds issued', d: 'What the company actually handed over: cash, a forex card, or an additional tranche.' },
      { t: 'Bill', d: 'The receipt behind an expense — a photo or a PDF.' },
      { t: 'Reconciliation', d: 'The end-of-trip arithmetic: funds received against approved spend, and the balance.' },
      { t: 'Settlement', d: 'How the balance was settled, after which the trip closes.' },
      { t: 'Reporting tree', d: 'Who reports to you, directly or through someone else. It is never a department or an office location.' },
      { t: 'Opaque denial', d: 'Out-of-scope reads answer the same way as records that do not exist, so ids cannot be enumerated.' },
      { t: 'Audit event', d: 'An immutable record of one action: who, when, what changed before and after.' },
    ],
  },

  /* ------------------------------------------------------------------ the
   * technical reference, for whoever inherits this. */
  reference: {
    title: 'Reference',
    intro: 'The parts you only need when something is wrong.',
    items: [
      { t: 'Health', d: 'GET /healthz is liveness. GET /readyz is readiness: it also checks that every shipped migration is applied with an unchanged checksum.' },
      { t: 'Migrations', d: 'Forward-only and checksummed. A changed file that has already been applied stops the runner. Fix a mistake with a new migration, never by editing an old one.' },
      { t: 'The database role', d: 'The app connects as trek_app, which cannot update the audit log and cannot rewrite the schema. The owner credentials are for migrations only.' },
      { t: 'Errors', d: 'Errors carry a stable code — validation_failed, no_approval_route, invalid_transition, forbidden, not_found, mail_disabled — so the same problem always reads the same way.' },
      { t: 'Passwords', d: 'At least 6 characters, not the email or the person’s name, not the company name, not a dictionary word. Failed attempts are counted in the database, so the lockout survives a restart.' },
      { t: 'Sessions', d: 'An opaque token in an HttpOnly cookie; only its SHA-256 is stored. Sessions are revoked the moment an account is deactivated.' },
      { t: 'The API', d: 'Everything the interface does is a documented endpoint under /api/v1. See docs/API_REFERENCE.md.' },
    ],
  },
};

/* ------------------------------------------------------------------ the
 * help button and the panel. */

function manualIcon() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9"></circle>
    <path d="M9.6 9.2a2.4 2.4 0 1 1 3.3 2.2c-.6.3-.9.8-.9 1.4v.3"></path>
    <path d="M12 16.4h.01"></path>
  </svg>`;
}

/* Every section, flattened into searchable entries. */
function manualIndex() {
  const out = [];
  for (const [key, section] of Object.entries(MANUAL)) {
    const title = section.title;
    const parts = [];

    if (section.stages) {
      for (const s of section.stages) parts.push({ h: `${s.n}. ${s.name}`, b: `${s.who} — ${s.what} ${s.note}`, t: title });
    }
    if (section.rows) {
      for (const r of section.rows) parts.push({ h: r.role, b: r.can, t: title });
    }
    if (section.trip) {
      for (const s of section.trip) parts.push({ h: s.s, b: s.d, t: title });
    }
    if (section.expense) {
      for (const s of section.expense) parts.push({ h: s.s, b: s.d, t: title });
    }
    if (section.rules) {
      for (const r of section.rules) parts.push({ h: r.t, b: r.d, t: title });
    }
    if (section.items) {
      /* A troubleshooting item is a question and an answer. */
      if (section.items[0]?.q !== undefined) {
        for (const i of section.items) parts.push({ h: i.q, b: i.a, t: title });
      } else {
        for (const i of section.items) parts.push({ h: i.t, b: i.d, t: title });
      }
    }
    if (section.notes) {
      for (const n of section.notes) parts.push({ h: 'Note', b: n, t: title });
    }
    out.push({ key, title, intro: section.intro, parts });
  }
  return out;
}

function manualBody(section) {
  const s = MANUAL[section];
  if (!s) return '';

  let html = `<div class="man-intro">${esc(s.intro)}</div>`;

  if (s.stages) {
    html += '<ol class="man-stages">';
    for (const st of s.stages) {
      html += `
        <li class="man-stage">
          <div class="man-stage-head">
            <span class="man-num">${st.n}</span>
            <div>
              <div class="man-stage-name">${esc(st.name)}</div>
              <div class="man-who">${esc(st.who)}</div>
            </div>
          </div>
          <p class="man-p">${esc(st.what)}</p>
          <p class="man-note">${esc(st.note)}</p>
        </li>`;
    }
    html += '</ol>';
  }

  if (s.rows) {
    html += '<div class="man-rows">';
    for (const r of s.rows) {
      html += `
        <div class="man-row">
          <div class="man-row-role">${esc(r.role)}</div>
          <div class="man-row-can">${esc(r.can)}</div>
        </div>`;
    }
    html += '</div>';
  }

  if (s.trip || s.expense) {
    for (const [label, list] of [['Trip', s.trip], ['Expense', s.expense]]) {
      if (!list) continue;
      html += `<div class="man-sub">${esc(label)}</div><div class="man-rows">`;
      for (const row of list) {
        html += `
          <div class="man-row">
            <div class="man-row-role">${esc(row.s)}</div>
            <div class="man-row-can">${esc(row.d)}</div>
          </div>`;
      }
      html += '</div>';
    }
  }

  if (s.rules) {
    html += '<div class="man-rows">';
    for (const r of s.rules) {
      html += `
        <div class="man-row">
          <div class="man-row-role">${esc(r.t)}</div>
          <div class="man-row-can">${esc(r.d)}</div>
        </div>`;
    }
    html += '</div>';
  }

  if (s.items) {
    /* A troubleshooting item is a question and an answer, not a title and a
     * definition — it reads differently and is searched differently. */
    if (s.items[0]?.q !== undefined) {
      html += '<div class="man-qa">';
      for (const i of s.items) {
        html += `
          <div class="man-qa-item">
            <div class="man-q">${esc(i.q)}</div>
            <div class="man-a">${esc(i.a)}</div>
          </div>`;
      }
      html += '</div>';
    } else {
      html += '<div class="man-rows">';
      for (const i of s.items) {
        html += `
          <div class="man-row">
            <div class="man-row-role">${esc(i.t)}</div>
            <div class="man-row-can">${esc(i.d)}</div>
          </div>`;
      }
      html += '</div>';
    }
  }

  if (s.notes) {
    html += '<ul class="man-notes">';
    for (const n of s.notes) html += `<li>${esc(n)}</li>`;
    html += '</ul>';
  }

  return html;
}

/** Open the manual. `section` may name a section to start on. */
function openManual(section = 'workflow') {
  const index = manualIndex();

  const scrim = el(`
    <div class="man-scrim">
      <div class="man-panel" role="dialog" aria-modal="true" aria-label="Trek manual">
        <div class="man-head">
          <div>
            <h2 class="man-title">Trek manual</h2>
            <p class="man-sub">How the workflow runs, and what each screen does.</p>
          </div>
          <button class="man-close" data-close aria-label="Close the manual">✕</button>
        </div>
        <div class="man-search">
          <input type="search" data-man-search placeholder="Search the manual — try &quot;reconciliation&quot; or &quot;403&quot;" aria-label="Search the manual">
        </div>
        <div class="man-body">
          <nav class="man-nav" data-man-nav></nav>
          <div class="man-content" data-man-content></div>
        </div>
      </div>
    </div>`);

  document.body.appendChild(scrim);
  const contentEl = scrim.querySelector('[data-man-content]');
  const navEl = scrim.querySelector('[data-man-nav]');
  const searchEl = scrim.querySelector('[data-man-search]');

  const close = () => scrim.remove();
  scrim.querySelector('[data-close]').addEventListener('click', close);
  scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });
  document.addEventListener('keydown', function onEsc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc); }
  });

  /* ---- navigation ---- */
  function renderNav(activeKey) {
    /* el() returns the FIRST element of the fragment, so the buttons are
     * wrapped in a single container. */
    navEl.replaceChildren(el(`
      <div>
        ${index.map((s) => `
          <button class="man-nav-item${s.key === activeKey ? ' active' : ''}" data-man-go="${esc(s.key)}">
            ${esc(s.title)}
          </button>`).join('')}
      </div>
    `));
    for (const b of navEl.querySelectorAll('[data-man-go]')) {
      b.addEventListener('click', () => show(b.dataset.manGo));
    }
  }

  /* ---- a section ---- */
  function show(key) {
    renderNav(key);
    contentEl.innerHTML = manualBody(key);
    contentEl.scrollTop = 0;
  }

  /* ---- search across every section ---- */
  function search(term) {
    const q = term.trim().toLowerCase();
    if (!q) { show(section); return; }

    const hits = [];
    for (const s of index) {
      for (const p of s.parts) {
        if (`${p.h} ${p.b} ${p.t}`.toLowerCase().includes(q)) hits.push({ section: s.key, ...p });
      }
    }

    renderNav(section);
    if (!hits.length) {
      contentEl.innerHTML = `
        <div class="man-empty">
          <h3>Nothing found for “${esc(term)}”</h3>
          <p>Try a shorter word, or browse the sections on the left.</p>
        </div>`;
      return;
    }

    contentEl.innerHTML = `
      <div class="man-intro">${hits.length} result${hits.length === 1 ? '' : 's'} for “${esc(term)}”</div>
      <div class="man-rows">
        ${hits.map((h) => `
          <div class="man-row">
            <div class="man-row-role">${esc(h.h)}</div>
            <div class="man-row-can">${esc(h.b)}<div class="man-hit-from">${esc(h.t)}</div></div>
          </div>`).join('')}
      </div>`;
  }

  searchEl.addEventListener('input', () => search(searchEl.value));

  show(section);
  searchEl.focus();
  return scrim;
}

