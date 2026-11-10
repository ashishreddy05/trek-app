/* HTTP route handlers for the pilot workflow: budget, currency plan, funds,
 * bills, reconciliation, settlement and reporting.
 *
 * Every handler authorises first, through the single guard, and passes the
 * guard's returned scope into the query. A handler never decides scope for
 * itself.
 *
 * The scope target is the OWNER of the record, not the caller. For a trip the
 * owner is the traveller; for an expense and a bill it is the expense's
 * traveller. Resolving that first is what lets `own` scope work — a target of
 * `undefined` never matches anything, so the guard would deny the very people
 * the operation is for.
 */

import { authorize, rejectServerDerived } from '../authz/guard.js';
import {
  readTrip,
  addBudgetLine, removeBudgetLine,
  setFxPlan, removeFxPlan,
  issueFund,
  submitReconciliation, decideReconciliation, settleTrip,
} from '../trips/service.js';
import {
  createBill, listBills, readBillContent, removeBill,
} from '../bills/service.js';
import {
  tripSummary, employeeSummary, dashboardTotals, pendingSettlements,
  toCsv, EMPLOYEE_EXPORT_COLUMNS, TRIP_EXPORT_COLUMNS,
} from '../reports/service.js';
import { readExpense } from '../expenses/service.js';

const notFound = { status: 404, body: { error: { code: 'not_found', message: 'Not found.' } } };

/** The traveller who owns a trip, for the guard's scope target. */
async function tripOwner(ctx, tripId) {
  const row = await ctx.db.one('SELECT id, employee_id FROM trip WHERE id = $1', [tripId]);
  return row?.employee_id ?? null;
}

/** The traveller who owns an expense, for the guard's scope target. */
async function expenseOwner(ctx, expenseId) {
  const row = await ctx.db.one('SELECT id, employee_id FROM expense WHERE id = $1', [expenseId]);
  return row?.employee_id ?? null;
}

/** The traveller who owns a bill, for the guard's scope target. */
async function billOwner(ctx, billId) {
  const row = await ctx.db.one(
    `SELECT b.id, x.employee_id FROM expense_bill b JOIN expense x ON x.id = b.expense_id WHERE b.id = $1`,
    [billId]
  );
  return row?.employee_id ?? null;
}

/* ============================================================== budget */

/* GET /api/v1/trips/:id/budget — the budget lines and the approved figure. */
export async function getTripBudget(ctx) {
  const id = ctx.params.id;
  const owner = await tripOwner(ctx, id);

  await authorize(
    ctx.db, ctx.principal, 'trip.budget.read',
    { employeeId: owner, type: 'trip', id }, ctx.requestId
  );

  if (!owner) return notFound;

  const trip = await ctx.db.one('SELECT id, approved_budget_base FROM trip WHERE id = $1', [id]);
  const lines = await ctx.db.many(
    `SELECT id, category, description, amount, currency, rate_to_base, base_amount, created_at
       FROM trip_budget_line WHERE trip_id = $1 ORDER BY created_at, id`,
    [id]
  );

  return { status: 200, body: { lines, approvedBudgetBase: trip.approved_budget_base } };
}

/* POST /api/v1/trips/:id/budget — add one estimated-expense line. */
export async function postTripBudgetLine(ctx) {
  const id = ctx.params.id;
  const owner = await tripOwner(ctx, id);

  await authorize(
    ctx.db, ctx.principal, 'trip.budget.manage',
    { employeeId: owner, type: 'trip', id }, ctx.requestId
  );

  if (!owner) return notFound;
  rejectServerDerived(ctx.body, ['currency', 'amount', 'baseAmount', 'rateToBase']);

  const line = await addBudgetLine({
    tripId: id,
    input: ctx.body,
    actor: ctx.principal,
    requestId: ctx.requestId,
    ip: ctx.ip,
  });

  if (!line) return notFound;
  return { status: 201, body: { line } };
}

/* DELETE /api/v1/trips/:id/budget/:lineId */
export async function deleteTripBudgetLine(ctx) {
  const id = ctx.params.id;
  const owner = await tripOwner(ctx, id);

  await authorize(
    ctx.db, ctx.principal, 'trip.budget.manage',
    { employeeId: owner, type: 'trip', id }, ctx.requestId
  );

  if (!owner) return notFound;

  const removed = await removeBudgetLine({
    tripId: id,
    lineId: ctx.params.lineId,
    actor: ctx.principal,
    requestId: ctx.requestId,
    ip: ctx.ip,
  });

  if (!removed) return notFound;
  return { status: 204, body: null };
}

/* ============================================================== currency plan */

/* GET /api/v1/trips/:id/forex */
export async function getTripForex(ctx) {
  const id = ctx.params.id;
  const owner = await tripOwner(ctx, id);

  await authorize(
    ctx.db, ctx.principal, 'trip.fx.read',
    { employeeId: owner, type: 'trip', id }, ctx.requestId
  );

  if (!owner) return notFound;

  const trip = await ctx.db.one('SELECT id, base_currency FROM trip WHERE id = $1', [id]);
  const plan = await ctx.db.many(
    `SELECT id, currency, cash_amount, card_amount, rate_to_base,
            gst_amount, topup_fee, service_fee, note
       FROM trip_fx_plan WHERE trip_id = $1 ORDER BY currency`,
    [id]
  );

  return { status: 200, body: { plan, baseCurrency: trip.base_currency } };
}

/* PUT /api/v1/trips/:id/forex — set (or replace) the plan for one currency. */
export async function putTripForex(ctx) {
  const id = ctx.params.id;
  const owner = await tripOwner(ctx, id);

  await authorize(
    ctx.db, ctx.principal, 'trip.fx.manage',
    { employeeId: owner, type: 'trip', id }, ctx.requestId
  );

  if (!owner) return notFound;
  rejectServerDerived(ctx.body, ['currency', 'rateToBase', 'baseAmount']);

  const plan = await setFxPlan({
    tripId: id,
    input: ctx.body,
    actor: ctx.principal,
    requestId: ctx.requestId,
    ip: ctx.ip,
  });

  if (!plan) return notFound;
  return { status: 200, body: { plan } };
}

/* DELETE /api/v1/trips/:id/forex/:planId */
export async function deleteTripForex(ctx) {
  const id = ctx.params.id;
  const owner = await tripOwner(ctx, id);

  await authorize(
    ctx.db, ctx.principal, 'trip.fx.manage',
    { employeeId: owner, type: 'trip', id }, ctx.requestId
  );

  if (!owner) return notFound;

  const removed = await removeFxPlan({
    tripId: id,
    planId: ctx.params.planId,
    actor: ctx.principal,
    requestId: ctx.requestId,
    ip: ctx.ip,
  });

  if (!removed) return notFound;
  return { status: 204, body: null };
}

/* ============================================================== funds */

/* GET /api/v1/trips/:id/funds */
export async function getTripFunds(ctx) {
  const id = ctx.params.id;
  const owner = await tripOwner(ctx, id);

  await authorize(
    ctx.db, ctx.principal, 'trip.fund.list',
    { employeeId: owner, type: 'trip', id }, ctx.requestId
  );

  if (!owner) return notFound;

  const funds = await ctx.db.many(
    `SELECT f.id, f.kind, f.currency, f.amount, f.rate_to_base, f.base_amount, f.note,
            f.issued_at, f.issued_by, e.name AS issued_by_name
       FROM trip_fund f LEFT JOIN employee e ON e.id = f.issued_by
      WHERE f.trip_id = $1 ORDER BY f.issued_at, f.id`,
    [id]
  );

  return { status: 200, body: { funds } };
}

/* POST /api/v1/trips/:id/funds — Finance issues cash, a forex card, or a top-up. */
export async function postTripFund(ctx) {
  const id = ctx.params.id;
  const owner = await tripOwner(ctx, id);

  await authorize(
    ctx.db, ctx.principal, 'trip.fund.create',
    { employeeId: owner, type: 'trip', id }, ctx.requestId
  );

  if (!owner) return notFound;
  rejectServerDerived(ctx.body, ['currency', 'amount', 'baseAmount', 'rateToBase']);

  const fund = await issueFund({
    tripId: id,
    input: ctx.body,
    actor: ctx.principal,
    requestId: ctx.requestId,
    ip: ctx.ip,
  });

  if (!fund) return notFound;
  return { status: 201, body: { fund } };
}

/* ============================================================== bills */

/* GET /api/v1/expenses/:id/bills */
export async function getExpenseBills(ctx) {
  const id = ctx.params.id;
  const owner = await expenseOwner(ctx, id);

  await authorize(
    ctx.db, ctx.principal, 'bill.read',
    { employeeId: owner, type: 'expense', id }, ctx.requestId
  );

  if (!owner) return notFound;
  const bills = await listBills(ctx.db, id);
  return { status: 200, body: { bills } };
}

/* POST /api/v1/expenses/:id/bills — upload a receipt. */
export async function postExpenseBill(ctx) {
  const id = ctx.params.id;
  const owner = await expenseOwner(ctx, id);

  await authorize(
    ctx.db, ctx.principal, 'bill.create',
    { employeeId: owner, type: 'expense', id }, ctx.requestId
  );

  if (!owner) return notFound;

  const bill = await createBill({
    expenseId: id,
    filename: ctx.body?.filename,
    contentType: ctx.body?.contentType,
    buffer: ctx.body?.content,
    actor: ctx.principal,
    requestId: ctx.requestId,
    ip: ctx.ip,
  });

  if (!bill) return notFound;
  return { status: 201, body: { bill } };
}

/* GET /api/v1/bills/:id/content — download the receipt. */
export async function getBillContent(ctx) {
  const id = ctx.params.id;
  const owner = await billOwner(ctx, id);

  await authorize(
    ctx.db, ctx.principal, 'bill.read',
    { employeeId: owner, type: 'bill', id }, ctx.requestId
  );

  if (!owner) return notFound;

  const bill = await readBillContent(ctx.db, id);
  if (!bill) return notFound;

  return {
    status: 200,
    body: bill.content,
    headers: {
      'Content-Type': bill.content_type,
      'Content-Disposition': `inline; filename="${bill.filename.replace(/"/g, '')}"`,
      'Content-Length': String(bill.byte_size),
    },
  };
}

/* DELETE /api/v1/bills/:id */
export async function deleteBillRoute(ctx) {
  const id = ctx.params.id;
  const owner = await billOwner(ctx, id);

  await authorize(
    ctx.db, ctx.principal, 'bill.delete',
    { employeeId: owner, type: 'bill', id }, ctx.requestId
  );

  if (!owner) return notFound;

  const removed = await removeBill({
    id,
    actor: ctx.principal,
    requestId: ctx.requestId,
    ip: ctx.ip,
  });

  if (!removed) return notFound;
  return { status: 204, body: null };
}

/* ============================================================== reconciliation */

/* GET /api/v1/trips/:id/reconciliation */
export async function getTripReconciliation(ctx) {
  const id = ctx.params.id;
  const owner = await tripOwner(ctx, id);

  await authorize(
    ctx.db, ctx.principal, 'trip.reconciliation.read',
    { employeeId: owner, type: 'trip', id }, ctx.requestId
  );

  if (!owner) return notFound;

  const reconciliation = await ctx.db.one(
    `SELECT id, trip_id, funds_base, expenses_base, balance_base, status,
            computed_at, decided_by, decided_at, decision_note,
            settled_by, settled_at, settlement_note
       FROM trip_reconciliation WHERE trip_id = $1`,
    [id]
  );

  return { status: 200, body: { reconciliation } };
}

/* POST /api/v1/trips/:id/reconciliation — the traveller submits for review. */
export async function postTripReconciliation(ctx) {
  const id = ctx.params.id;
  const owner = await tripOwner(ctx, id);

  await authorize(
    ctx.db, ctx.principal, 'trip.reconciliation.submit',
    { employeeId: owner, type: 'trip', id }, ctx.requestId
  );

  if (!owner) return notFound;

  const reconciliation = await submitReconciliation({
    tripId: id,
    input: ctx.body ?? {},
    actor: ctx.principal,
    requestId: ctx.requestId,
    ip: ctx.ip,
  });

  if (!reconciliation) return notFound;
  return { status: 201, body: { reconciliation } };
}

/* POST /api/v1/trips/:id/reconciliation/decide — Finance approves or sends back. */
export async function postTripReconciliationDecision(ctx) {
  const id = ctx.params.id;
  const owner = await tripOwner(ctx, id);

  await authorize(
    ctx.db, ctx.principal, 'trip.reconciliation.decide',
    { employeeId: owner, type: 'trip', id }, ctx.requestId
  );

  if (!owner) return notFound;

  const reconciliation = await decideReconciliation({
    tripId: id,
    decision: ctx.body?.decision,
    reason: ctx.body?.reason,
    actor: ctx.principal,
    requestId: ctx.requestId,
    ip: ctx.ip,
  });

  if (!reconciliation) return notFound;
  return { status: 200, body: { reconciliation } };
}

/* POST /api/v1/trips/:id/settle — close the trip once the money has moved. */
export async function postTripSettlement(ctx) {
  const id = ctx.params.id;
  const owner = await tripOwner(ctx, id);

  await authorize(
    ctx.db, ctx.principal, 'trip.settle',
    { employeeId: owner, type: 'trip', id }, ctx.requestId
  );

  if (!owner) return notFound;

  const trip = await settleTrip({
    tripId: id,
    input: ctx.body ?? {},
    actor: ctx.principal,
    requestId: ctx.requestId,
    ip: ctx.ip,
  });

  if (!trip) return notFound;
  return { status: 200, body: { trip } };
}

/* ============================================================== reporting */

/* GET /api/v1/dashboard */
export async function getDashboard(ctx) {
  const requested = ctx.query.get('scope') ?? undefined;

  const { scope, team } = await authorize(
    ctx.db, ctx.principal, 'dashboard.read', { scope: requested }, ctx.requestId
  );

  const args = { scope, team, employeeId: ctx.principal.employeeId };

  const [totals, trips, employees, settlements] = await Promise.all([
    dashboardTotals(ctx.db, args),
    tripSummary(ctx.db, args),
    employeeSummary(ctx.db, args),
    pendingSettlements(ctx.db, args),
  ]);

  return { status: 200, body: { scope, totals, trips, employees, settlements } };
}

/* GET /api/v1/reports/export.csv?kind=employees|trips */
export async function getReportExport(ctx) {
  const requested = ctx.query.get('scope') ?? undefined;

  const { scope, team } = await authorize(
    ctx.db, ctx.principal, 'report.export', { scope: requested }, ctx.requestId
  );

  const args = { scope, team, employeeId: ctx.principal.employeeId };
  const kind = (ctx.query.get('kind') ?? 'employees').toLowerCase();

  const csv = kind === 'trips'
    ? toCsv(await tripSummary(ctx.db, args), TRIP_EXPORT_COLUMNS)
    : toCsv(await employeeSummary(ctx.db, args), EMPLOYEE_EXPORT_COLUMNS);

  return {
    status: 200,
    body: csv,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="trek-${kind}-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  };
}
