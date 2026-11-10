/* Reporting — the Finance and Management dashboard, and the export.
 *
 * Every number is a SUM over NUMERIC columns, so it is exact. There is no
 * rounding layer and no float anywhere in this file.
 *
 * The dashboard is scope-driven: the same query set answers "my team" for a
 * manager and "the company" for Finance and Admin, because the guard already
 * decided which scope the caller may see.
 */

import { sumAmounts } from '../money.js';

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
  }
  return { clause, params };
}

/**
 * One row per trip: budget, spend, funds and balance, plus counts.
 */
export async function tripSummary(db, { scope, team, employeeId }) {
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

  return rows.map((r) => ({
    ...r,
    bill_count: Number(r.bill_count ?? 0),
    balance_base: sumAmounts([r.funds_base ?? '0', `-${r.spent_base ?? '0'}`]),
    variance_base: r.budget_base !== null
      ? sumAmounts([String(r.budget_base), `-${r.spent_base ?? '0'}`])
      : null,
  }));
}

/**
 * Employee-wise spend, for the management report.
 */
export async function employeeSummary(db, { scope, team, employeeId }) {
  const { clause, params } = await reportingScope(db, { scope, team, employeeId });

  return db.many(
    `SELECT e.id AS employee_id, e.name, e.employee_code, e.grade, e.location,
            d.name AS department_name,
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
      GROUP BY e.id, e.name, e.employee_code, e.grade, e.location, d.name
      ORDER BY sum(x.spent_base) DESC NULLS LAST, e.name
      LIMIT 500`,
    params
  );
}

/** Headline counters for the dashboard. */
export async function dashboardTotals(db, { scope, team, employeeId }) {
  const { clause, params } = await reportingScope(db, { scope, team, employeeId });

  const row = await db.one(
    `SELECT count(DISTINCT t.id)::int                                   AS trips,
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
      ${clause ? 'WHERE ' + clause : ''}`,
    params
  );

  return row;
}

/** Settlements still owed, in either direction. */
export async function pendingSettlements(db, { scope, team, employeeId }) {
  const { clause, params } = await reportingScope(db, { scope, team, employeeId });

  return db.many(
    `SELECT r.id, r.trip_id, r.funds_base, r.expenses_base, r.balance_base, r.status, r.computed_at,
            t.destination, e.name AS employee_name, e.employee_code
       FROM trip_reconciliation r
       JOIN trip t ON t.id = r.trip_id
       JOIN employee e ON e.id = t.employee_id
      ${clause ? 'WHERE ' + clause : ''}
      ORDER BY r.computed_at DESC
      LIMIT 200`,
    params
  );
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
