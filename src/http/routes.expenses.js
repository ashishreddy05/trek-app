/* HTTP route handlers for Expenses. */

import { authorize, rejectServerDerived } from '../authz/guard.js';
import {
  listExpenses, readExpense, createExpense, updateExpense,
  deleteExpense as removeExpense, submitExpense, decideExpense,
} from '../expenses/service.js';

const notFound = { status: 404, body: { error: { code: 'not_found', message: 'Not found.' } } };

/* GET /api/v1/expenses */
export async function getExpenses(ctx) {
  const requested = ctx.query.get('scope') ?? undefined;

  const { scope, team } = await authorize(
    ctx.db, ctx.principal, 'expense.list', { scope: requested }, ctx.requestId
  );

  const result = await listExpenses(ctx.db, {
    scope,
    team,
    employeeId: ctx.principal.employeeId,
    tripId: ctx.query.get('tripId') ?? undefined,
    status: ctx.query.get('status') ?? undefined,
    limit: Number(ctx.query.get('limit')) || 50,
    cursor: ctx.query.get('cursor') ?? undefined,
  });

  return { status: 200, body: result };
}

/* GET /api/v1/expenses/:id */
export async function getExpense(ctx) {
  const id = ctx.params.id;
  const row = await readExpense(ctx.db, id);

  await authorize(
    ctx.db, ctx.principal, 'expense.read',
    { employeeId: row?.employee_id, type: 'expense', id },
    ctx.requestId
  );

  if (!row) return notFound;
  return { status: 200, body: { expense: row } };
}

/* POST /api/v1/expenses */
export async function postExpense(ctx) {
  await authorize(
    ctx.db, ctx.principal, 'expense.create',
    { employeeId: ctx.principal.employeeId },
    ctx.requestId
  );

  rejectServerDerived(ctx.body, []);

  const expense = await createExpense({
    input: ctx.body,
    actor: ctx.principal,
    requestId: ctx.requestId,
    ip: ctx.ip,
  });

  return { status: 201, body: { expense } };
}

/* PATCH /api/v1/expenses/:id */
export async function patchExpense(ctx) {
  const id = ctx.params.id;
  const existing = await readExpense(ctx.db, id);

  await authorize(
    ctx.db, ctx.principal, 'expense.update',
    { employeeId: existing?.employee_id, type: 'expense', id },
    ctx.requestId
  );

  if (!existing) return notFound;
  rejectServerDerived(ctx.body, []);

  const expense = await updateExpense({
    id,
    input: ctx.body,
    actor: ctx.principal,
    requestId: ctx.requestId,
    ip: ctx.ip,
  });

  return { status: 200, body: { expense } };
}

/* DELETE /api/v1/expenses/:id */
export async function deleteExpense(ctx) {
  const id = ctx.params.id;
  const existing = await readExpense(ctx.db, id);

  await authorize(
    ctx.db, ctx.principal, 'expense.delete',
    { employeeId: existing?.employee_id, type: 'expense', id },
    ctx.requestId
  );

  if (!existing) return notFound;

  await removeExpense({
    id,
    actor: ctx.principal,
    requestId: ctx.requestId,
    ip: ctx.ip,
  });

  return { status: 204, body: null };
}

/* POST /api/v1/expenses/:id/submit */
export async function postSubmitExpense(ctx) {
  const id = ctx.params.id;
  const existing = await readExpense(ctx.db, id);

  await authorize(
    ctx.db, ctx.principal, 'expense.submit',
    { employeeId: existing?.employee_id, type: 'expense', id },
    ctx.requestId
  );

  if (!existing) return notFound;

  const expense = await submitExpense({
    id,
    actor: ctx.principal,
    requestId: ctx.requestId,
    ip: ctx.ip,
  });

  return { status: 200, body: { expense } };
}

/* POST /api/v1/expenses/:id/decide */
export async function postDecideExpense(ctx) {
  const id = ctx.params.id;
  const existing = await readExpense(ctx.db, id);

  await authorize(
    ctx.db, ctx.principal, 'expense.decide',
    { employeeId: existing?.employee_id, type: 'expense', id },
    ctx.requestId
  );

  if (!existing) return notFound;

  const expense = await decideExpense({
    id,
    decision: ctx.body?.decision,
    reason: ctx.body?.reason,
    actor: ctx.principal,
    requestId: ctx.requestId,
    ip: ctx.ip,
  });

  return { status: 200, body: { expense } };
}
