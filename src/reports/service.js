/* Reporting — the Finance and Management dashboard, and the export.
 *
 * Every number is a SUM over NUMERIC columns, so it is exact. There is no
 * rounding layer and no float anywhere in this file.
 *
 * The dashboard is scope-driven: the same query set answers "my team" for a
 * manager and "the company" for Finance and Admin, because the guard already
 * decided which scope the caller may see.
 *
 * SHOWING MONEY IN ANOTHER CURRENCY
 *
 * A company prepares its budget in one currency and may want to read the
 * result in another. So a report can be asked for a display currency. The
 * stored amounts are never rewritten — a second number is produced to show
 * beside each one, together with the rate that produced it and the day that
 * rate was effective. A currency with no remembered rate produces no number
 * at all, because a converted figure nobody can account for is worse than an
 * honest blank.
 */

import { sumAmounts, multiplyRate } from '../money.js';
import { baseCurrency, rateFor, sumAcrossBases } from '../currency/service.js';

/**
 * The rows the dashboard is built from, filtered to the scope the guard
 * granted.
 *
 * scope:
 *   own    one employee's trips
 *   team   the caller's reporting tree
 *   all    company-wide
 *   finance  company-wide, money view
 */
export async function reportingScope(db, { scope, team, employeeId }) {
  const params = [];
  const add = (val) => { params.push(val); return `$${params.length}`; };

  let clause = '';
  if (scope === 'own') {
    clause = `t.employee_id = ${add(employeeId)}`;
  } else if (scope === 'team') {
    const ids = Array.from(team ?? []);
    if (!ids.length) return { clause: 'FALSE', params };
    clause = `t.employee_id = ANY(${add(ids)})`;
  } else if (scope === 'all' || scope === 'finance') {
    clause = '';
  } else {
    return { clause: 'FALSE', params };
  }
  return { clause, params };
}

/**
 * The rate that turns a stored (base) amount into the display currency.
 *
 * "How many display units does one base unit buy" — which is the `to_base`
 * question for the pair (base → display).
 */
export async function displayRate(db, { base, display }) {
  if (!base) return null;
  if (!display || display === base) return { rate: '1.00000000', effectiveOn: null };
  return rateFor(db, { currency: base, base: display, direction: 'to_base' });
}

/**
 * How a report should describe the currency it is shown in.
 *
 * This is what a reader sees next to the numbers: which currency, which rate,
 * and the day that rate was effective. `rate` is null when the rate is not
 * known — the honest answer, rather than a number nobody can account for.
 */
export async function describeDisplay(db, { display }) {
  const base = await baseCurrency(db);
  if (!display || display === base) {
    return { currency: base, baseCurrency: base, rate: '1.00000000', effectiveOn: null, known: true };
  }
  const found = await displayRate(db, { base, display });
  return {
    currency: display,
    baseCurrency: base,
    rate: found?.rate ?? null,
    effectiveOn: found?.effectiveOn ?? null,
    known: Boolean(found?.rate),
  };
}

/**
 * Apply a rate to an amount.
 *
 * Truncating, never rounding: a converted amount must never exceed the money
 * it came from.
 */
function convert(amount, rate) {
  if (amount === null || amount === undefined) return null;
  if (!rate) return null;
  return multiplyRate(String(amount), rate.rate);
}

/**
 * The rates needed to show a set of base currencies in the display currency,
 * looked up ONCE per currency rather than once per row — a report of 500
 * trips must not run 500 rate lookups.
 */
async function ratesFor(db, { bases, display }) {
  const rates = new Map();
  for (const base of [...new Set(bases.filter(Boolean))]) {
    rates.set(base, await displayRate(db, { base, display }));
  }
  return rates;
}

/**
 * One row per trip: budget, spend, funds and balance, plus counts.
 */
export async function tripSummary(db, { scope, team, employeeId, display }) {
  const { clause, params } = await reportingScope(db, { scope, team, employeeId });

  const rows = await db.many(
    `SELECT t.id, t.destination, t.start_date, t.end_date, t.status, t.currency, t.base_currency,
            t.approved_budget_base, t.created_at,
            e.id AS employee_id, e.name AS employee_name, e.employee_code,
            d.name AS department_name,
            COALESCE(b.budget_base, 0)        AS budget_base,
            COALESCE(x.spent_base, 0)         AS spent_base,
            COALESCE(x.pending_base, 0)       AS pending_base,
            COALESCE(f.funds_base, 0)         AS funds_base,
            COALESCE(x.expense_count, 0)      AS expense_count,
            COALESCE(bl.bill_count, 0)        AS bill_count
       FROM trip t
       JOIN employee e ON e.id = t.employee_id
       JOIN department d ON d.id = e.department_id
       LEFT JOIN LATERAL (
            SELECT sum(base_amount) AS budget_base FROM trip_budget_line b WHERE b.trip_id = t.id
       ) b ON true
       LEFT JOIN LATERAL (
            SELECT sum(base_amount) FILTER (WHERE status = 'approved')  AS spent_base,
                   sum(base_amount) FILTER (WHERE status = 'submitted') AS pending_base,
                   count(*)                                          AS expense_count
              FROM expense x WHERE x.trip_id = t.id
       ) x ON true
       LEFT JOIN LATERAL (
            SELECT sum(base_amount) AS funds_base FROM trip_fund f WHERE f.trip_id = t.id
       ) f ON true
       LEFT JOIN LATERAL (
            SELECT count(*) AS bill_count FROM expense_bill bb WHERE bb.trip_id = t.id
       ) bl ON true
      ${clause ? 'WHERE ' + clause : ''}
      ORDER BY t.created_at DESC
      LIMIT 500`,
    params
  );

  const rates = await ratesFor(db, { bases: rows.map((r) => r.base_currency), display });

  return rows.map((r) => {
    const rate = rates.get(r.base_currency);
    const budget = convert(r.budget_base, rate);
    const spent = convert(r.spent_base, rate);
    const pending = convert(r.pending_base, rate);
    const funds = convert(r.funds_base, rate);

    return {
      ...r,
      bill_count: Number(r.bill_count ?? 0),
      balance_base: sumAmounts([r.funds_base ?? '0', `-${r.spent_base ?? '0'}`]),
      variance_base: r.budget_base !== null
        ? sumAmounts([String(r.budget_base), `-${r.spent_base ?? '0'}`])
        : null,
      /* The same numbers, shown in the currency the reader asked for. The
       * balance and the variance are worked out from the shown parts, not
       * converted after the fact, so the displayed arithmetic adds up. */
      budget_display: budget,
      spent_display: spent,
      pending_display: pending,
      funds_display: funds,
      balance_display: funds === null || spent === null
        ? null
        : sumAmounts([funds, `-${spent}`]),
      variance_display: budget === null || spent === null
        ? null
        : sumAmounts([budget, `-${spent}`]),
    };
  });
}

/**
 * Employee-wise spend, for the management report.
 *
 * Money is grouped by the currency it is stored in, because two currencies
 * cannot be added before they are converted. The groups are merged back into
 * one row per employee here, keeping each part separate so the conversion can
 * be exact.
 */
export async function employeeSummary(db, { scope, team, employeeId, display }) {
  const { clause, params } = await reportingScope(db, { scope, team, employeeId });

  const rows = await db.many(
    `SELECT e.id AS employee_id, e.name, e.employee_code, e.grade, e.location,
            d.name AS department_name,
            t.base_currency AS base,
            count(DISTINCT t.id)::int                        AS trip_count,
            COALESCE(sum(x.spent_base), 0)                   AS spent_base,
            COALESCE(sum(x.pending_base), 0)                 AS pending_base
       FROM employee e
       JOIN department d ON d.id = e.department_id
       LEFT JOIN trip t ON t.employee_id = e.id
       LEFT JOIN LATERAL (
            SELECT sum(base_amount) FILTER (WHERE status = 'approved')  AS spent_base,
                   sum(base_amount) FILTER (WHERE status = 'submitted') AS pending_base
              FROM expense x WHERE x.trip_id = t.id
       ) x ON true
      ${clause ? 'WHERE ' + clause : ''}
      GROUP BY e.id, e.name, e.employee_code, e.grade, e.location, d.name, t.base_currency
      ORDER BY sum(x.spent_base) DESC NULLS LAST, e.name`,
    params
  );

  /* One row per employee. The SQL groups by base currency; here the groups
   * are folded back together, keeping the parts apart so each can be
   * converted before it is added. */
  const merged = new Map();
  for (const r of rows) {
    const entry = merged.get(r.employee_id) ?? {
      employee_id: r.employee_id,
      name: r.name,
      employee_code: r.employee_code,
      grade: r.grade,
      location: r.location,
      department_name: r.department_name,
      trip_count: 0,
      spent_base: '0.00',
      pending_base: '0.00',
      parts: [],
    };
    entry.trip_count += r.trip_count ?? 0;
    if (r.base) {
      entry.parts.push({ base: r.base, spent: r.spent_base ?? '0', pending: r.pending_base ?? '0' });
    }
    merged.set(r.employee_id, entry);
  }

  const list = [...merged.values()];
  const companyBase = await baseCurrency(db);

  for (const entry of list) {
    const spentBase = await sumAcrossBases(db, {
      amounts: entry.parts.map((p) => p.spent),
      bases: entry.parts.map((p) => p.base),
      toDisplay: companyBase,
    });
    const pendingBase = await sumAcrossBases(db, {
      amounts: entry.parts.map((p) => p.pending),
      bases: entry.parts.map((p) => p.base),
      toDisplay: companyBase,
    });
    entry.spent_base = spentBase.total ?? '0.00';
    entry.pending_base = pendingBase.total ?? '0.00';

    const spent = await sumAcrossBases(db, {
      amounts: entry.parts.map((p) => p.spent),
      bases: entry.parts.map((p) => p.base),
      toDisplay: display,
    });
    const pending = await sumAcrossBases(db, {
      amounts: entry.parts.map((p) => p.pending),
      bases: entry.parts.map((p) => p.base),
      toDisplay: display,
    });
    entry.spent_display = spent.total;
    entry.pending_display = pending.total;
    /* The parts are how the conversion was worked out — not part of the
     * answer. */
    delete entry.parts;
  }

  return list;
}

/** Headline counters for the dashboard. */
export async function dashboardTotals(db, { scope, team, employeeId, display }) {
  const { clause, params } = await reportingScope(db, { scope, team, employeeId });

  /* Money is grouped by the currency it is stored in. The groups partition the
   * trips, so the counts add up across them — and the money in two currencies
   * is kept apart until each part has been converted. */
  const rows = await db.many(
    `SELECT t.base_currency AS base,
            count(DISTINCT t.id)::int                                              AS trips,
            count(DISTINCT t.id) FILTER (WHERE t.status = 'submitted')::int            AS awaiting_approval,
            count(DISTINCT t.id) FILTER (WHERE t.status = 'active')::int               AS active_trips,
            count(DISTINCT t.id) FILTER (WHERE t.status = 'reconciliation_pending')::int AS awaiting_reconciliation,
            count(DISTINCT t.id) FILTER (WHERE t.status = 'reconciled')::int           AS awaiting_settlement,
            COALESCE(sum(x.spent_base), 0)                                              AS spent_base,
            COALESCE(sum(x.pending_base), 0)                                            AS pending_base,
            COALESCE(sum(f.funds_base), 0)                                              AS funds_base
       FROM trip t
       LEFT JOIN LATERAL (
            SELECT sum(base_amount) FILTER (WHERE status = 'approved')  AS spent_base,
                   sum(base_amount) FILTER (WHERE status = 'submitted') AS pending_base
              FROM expense x WHERE x.trip_id = t.id
       ) x ON true
       LEFT JOIN LATERAL (
            SELECT sum(base_amount) AS funds_base FROM trip_fund f WHERE f.trip_id = t.id
       ) f ON true
      ${clause ? 'WHERE ' + clause : ''}
      GROUP BY t.base_currency`,
    params
  );

  const totals = {
    trips: 0,
    awaiting_approval: 0,
    active_trips: 0,
    awaiting_reconciliation: 0,
    awaiting_settlement: 0,
    spent_base: '0.00',
    pending_base: '0.00',
    funds_base: '0.00',
  };

  const parts = { spent: [], pending: [], funds: [] };
  for (const r of rows) {
    totals.trips += r.trips ?? 0;
    totals.awaiting_approval += r.awaiting_approval ?? 0;
    totals.active_trips += r.active_trips ?? 0;
    totals.awaiting_reconciliation += r.awaiting_reconciliation ?? 0;
    totals.awaiting_settlement += r.awaiting_settlement ?? 0;
    parts.spent.push({ base: r.base, amount: r.spent_base ?? '0' });
    parts.pending.push({ base: r.base, amount: r.pending_base ?? '0' });
    parts.funds.push({ base: r.base, amount: r.funds_base ?? '0' });
  }

  /* When adding base amounts across trips, convert across bases to the company's
   * current base currency. If all trips share the company base, this is exact 1:1.
   * If historic trips exist under a previous base currency, each part is converted
   * at the remembered rate rather than adding dissimilar currencies together. */
  const companyBase = await baseCurrency(db);
  const spentBase = await sumAcrossBases(db, {
    amounts: parts.spent.map((p) => p.amount),
    bases: parts.spent.map((p) => p.base),
    toDisplay: companyBase,
  });
  const pendingBase = await sumAcrossBases(db, {
    amounts: parts.pending.map((p) => p.amount),
    bases: parts.pending.map((p) => p.base),
    toDisplay: companyBase,
  });
  const fundsBase = await sumAcrossBases(db, {
    amounts: parts.funds.map((p) => p.amount),
    bases: parts.funds.map((p) => p.base),
    toDisplay: companyBase,
  });

  totals.spent_base = spentBase.total ?? '0.00';
  totals.pending_base = pendingBase.total ?? '0.00';
  totals.funds_base = fundsBase.total ?? '0.00';

  const spent = await sumAcrossBases(db, {
    amounts: parts.spent.map((p) => p.amount),
    bases: parts.spent.map((p) => p.base),
    toDisplay: display,
  });
  const pending = await sumAcrossBases(db, {
    amounts: parts.pending.map((p) => p.amount),
    bases: parts.pending.map((p) => p.base),
    toDisplay: display,
  });
  const funds = await sumAcrossBases(db, {
    amounts: parts.funds.map((p) => p.amount),
    bases: parts.funds.map((p) => p.base),
    toDisplay: display,
  });

  totals.spent_display = spent.total;
  totals.pending_display = pending.total;
  totals.funds_display = funds.total;
  /* The currency whose rate is missing, so the reader is told WHY a figure is
   * blank instead of wondering. */
  totals.display_missing = spent.missing ?? pending.missing ?? funds.missing ?? null;

  totals.trips_truncated = totals.trips > 500;
  totals.truncated = totals.trips > 500;

  return totals;
}

/** Settlements still owed, in either direction. */
export async function pendingSettlements(db, { scope, team, employeeId, display }) {
  const { clause, params } = await reportingScope(db, { scope, team, employeeId });

  const rows = await db.many(
    `SELECT r.id, r.trip_id, r.funds_base, r.expenses_base, r.balance_base, r.status, r.computed_at,
            t.destination, t.base_currency, e.name AS employee_name, e.employee_code
       FROM trip_reconciliation r
       JOIN trip t ON t.id = r.trip_id
       JOIN employee e ON e.id = t.employee_id
      ${clause ? 'WHERE ' + clause : ''}
      ORDER BY r.computed_at DESC
      LIMIT 200`,
    params
  );

  const rates = await ratesFor(db, { bases: rows.map((r) => r.base_currency), display });

  return rows.map((r) => {
    const rate = rates.get(r.base_currency);
    const funds = convert(r.funds_base, rate);
    const expenses = convert(r.expenses_base, rate);
    return {
      ...r,
      funds_display: funds,
      expenses_display: expenses,
      balance_display: funds === null || expenses === null
        ? null
        : sumAmounts([funds, `-${expenses}`]),
    };
  });
}

/**
 * CSV export of the employee-wise report. One file, plain RFC 4180 quoting, so
 * it opens in Excel and Numbers without a converter.
 */
export function toCsv(rows, columns) {
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.map((c) => escape(c.label)).join(',');
  const body = rows.map((r) => columns.map((c) => escape(c.get(r))).join(',')).join('\n');
  return `${head}\n${body}\n`;
}

export const EMPLOYEE_EXPORT_COLUMNS = [
  { label: 'Employee code', get: (r) => r.employee_code },
  { label: 'Name', get: (r) => r.name },
  { label: 'Department', get: (r) => r.department_name },
  { label: 'Grade', get: (r) => r.grade },
  { label: 'Location', get: (r) => r.location },
  { label: 'Trips', get: (r) => r.trip_count },
  { label: 'Approved spend (base)', get: (r) => r.spent_base },
  { label: 'Pending spend (base)', get: (r) => r.pending_base },
];

export const TRIP_EXPORT_COLUMNS = [
  { label: 'Trip', get: (r) => r.destination },
  { label: 'Employee', get: (r) => r.employee_name },
  { label: 'Employee code', get: (r) => r.employee_code },
  { label: 'Department', get: (r) => r.department_name },
  { label: 'Status', get: (r) => r.status },
  { label: 'Start', get: (r) => r.start_date },
  { label: 'End', get: (r) => r.end_date },
  { label: 'Budget (base)', get: (r) => r.budget_base ?? '0.00' },
  { label: 'Spent (base)', get: (r) => r.spent_base ?? '0.00' },
  { label: 'Variance (base)', get: (r) => r.variance_base ?? '' },
  { label: 'Funds issued (base)', get: (r) => r.funds_base ?? '0.00' },
  { label: 'Balance (base)', get: (r) => r.balance_base },
  { label: 'Expenses', get: (r) => r.expense_count },
  { label: 'Bills', get: (r) => r.bill_count },
];

/**
 * The export columns for the currency the reader asked for.
 *
 * The base columns are always there — they are what is actually stored. The
 * display columns are added only when a different currency was asked for, so
 * a file never carries the same column twice under two names.
 */
export function exportColumns(base, kind, display) {
  const columns = kind === 'trips' ? [...TRIP_EXPORT_COLUMNS] : [...EMPLOYEE_EXPORT_COLUMNS];
  if (!display || display === base) return columns;

  if (kind === 'trips') {
    columns.push(
      { label: `Budget (${display})`, get: (r) => r.budget_display ?? '' },
      { label: `Spent (${display})`, get: (r) => r.spent_display ?? '' },
      { label: `Variance (${display})`, get: (r) => r.variance_display ?? '' },
      { label: `Funds issued (${display})`, get: (r) => r.funds_display ?? '' },
      { label: `Balance (${display})`, get: (r) => r.balance_display ?? '' }
    );
  } else {
    columns.push(
      { label: `Approved spend (${display})`, get: (r) => r.spent_display ?? '' },
      { label: `Pending spend (${display})`, get: (r) => r.pending_display ?? '' }
    );
  }
  return columns;
}
