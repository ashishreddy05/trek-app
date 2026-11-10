/* Expenses service.
 *
 * An expense may only exist against a trip the company has approved and funded
 * (`active`). A claim against a draft or rejected trip is a request for money
 * nobody agreed to spend.
 *
 * Money: amount is the exact transaction amount in the currency actually spent;
 * base_amount is the snapshot of that amount converted at the rate the trip's
 * currency plan held when the expense was written. Changing the rate later
 * never rewrites a recorded expense.
 */

import { tx } from '../db.js';
import { audit, ACTIONS } from '../audit.js';
import { validateExpense } from './validate.js';
import { WorkflowError } from '../trips/validate.js';
import { multiplyRate } from '../money.js';

export async function listExpenses(db, { scope, team, employeeId, tripId, status, limit = 50, cursor } = {}) {
  const where = [];
  const params = [];
  const add = (sql, val) => { params.push(val); where.push(sql.replace('$?', `$${params.length}`)); };

  if (scope === 'own') {
    add('x.employee_id = $?', employeeId);
  } else if (scope === 'team') {
    const ids = Array.from(team ?? []);
    if (ids.length === 0) return { data: [], nextCursor: null };
    add('x.employee_id = ANY($?)', ids);
  } else if (scope === 'all' || scope === 'finance') {
    /* Company-wide: no id restriction. */
  }

  if (tripId) add('x.trip_id = $?', tripId);
  if (status) add('x.status = $?', status);
  if (cursor) add('x.created_at < $?', cursor);

  params.push(Math.min(limit, 100));

  const rows = await db.many(
    `SELECT x.id, x.company_id, x.trip_id, x.employee_id, x.expense_date,
            x.description, x.category, x.amount, x.currency, x.rate_to_base, x.base_amount,
            x.payment_method, x.status,
            x.submitted_at, x.decided_at, x.decided_by, x.rejection_reason,
            x.created_at, x.updated_at,
            e.name AS employee_name, e.employee_code,
            t.destination AS trip_destination, t.status AS trip_status,
            m.name AS decided_by_name,
            (SELECT count(*)::int FROM expense_bill b WHERE b.expense_id = x.id) AS bill_count
       FROM expense x
       JOIN employee e ON e.id = x.employee_id
       JOIN trip t     ON t.id = x.trip_id
       LEFT JOIN employee m ON m.id = x.decided_by
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY x.expense_date DESC, x.created_at DESC, x.id DESC
      LIMIT $${params.length}`,
    params
  );

  return {
    data: rows,
    nextCursor: rows.length ? rows[rows.length - 1].created_at : null,
  };
}

export async function readExpense(db, id) {
  return db.one(
    `SELECT x.id, x.company_id, x.trip_id, x.employee_id, x.expense_date,
            x.description, x.category, x.amount, x.currency, x.rate_to_base, x.base_amount,
            x.payment_method, x.status,
            x.submitted_at, x.decided_at, x.decided_by, x.rejection_reason,
            x.created_at, x.updated_at,
            e.name AS employee_name, e.employee_code,
            t.destination AS trip_destination, t.status AS trip_status,
            m.name AS decided_by_name
       FROM expense x
       JOIN employee e ON e.id = x.employee_id
       JOIN trip t     ON t.id = x.trip_id
       LEFT JOIN employee m ON m.id = x.decided_by
      WHERE x.id = $1`,
    [id]
  );
}

/**
 * The rate the trip's currency plan holds for this currency.
 *
 * Spending in the trip's own base currency needs no plan row — converting the
 * base currency to itself is the identity. A plan row for it, if present, is
 * still honoured.
 */
async function rateFor(client, tripId, currency) {
  const row = await client.one(
    `SELECT f.rate_to_base, t.base_currency
       FROM trip t LEFT JOIN trip_fx_plan f ON f.trip_id = t.id AND f.currency = $2
      WHERE t.id = $1`,
    [tripId, currency]
  );
  if (!row) {
    throw new WorkflowError(422, 'validation_failed', 'This trip no longer exists.');
  }
  if (row.rate_to_base) return row.rate_to_base;
  if (currency === row.base_currency) return '1.00000000';
  throw new WorkflowError(422, 'validation_failed',
    `No exchange rate is set for ${currency} on this trip. Add it to the currency plan first.`);
}

/** Money may only be recorded against a trip that is approved and funded. */
async function assertTripAcceptsExpenses(client, trip, action) {
  if (trip.status !== 'active') {
    throw new WorkflowError(409, 'invalid_transition',
      `Expenses can only be recorded once the trip is approved and funded; this trip is ${trip.status}.`);
  }
}

export async function createExpense({ input, actor, requestId, ip }) {
  const valid = validateExpense(input, { requireTrip: true });

  return tx(async (client) => {
    const trip = await client.one('SELECT * FROM trip WHERE id = $1', [valid.tripId]);
    if (!trip || trip.employee_id !== actor.employeeId) {
      throw new WorkflowError(404, 'not_found', 'Trip not found.');
    }

    await assertTripAcceptsExpenses(client, trip, 'created');

    const rate = await rateFor(client, trip.id, valid.currency);
    const base = multiplyRate(valid.amount, rate);

    const row = await client.one(
      `INSERT INTO expense (trip_id, employee_id, expense_date, description, category, amount,
                             currency, rate_to_base, base_amount, payment_method, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'draft')
       RETURNING *`,
      [trip.id, actor.employeeId, valid.date, valid.description, valid.category, valid.amount,
       valid.currency, rate, base, valid.paymentMethod]
    );

    await audit(client, {
      actorId: actor.employeeId,
      actorLabel: actor.name,
      action: ACTIONS.EXPENSE_CREATE,
      entityType: 'expense',
      entityId: row.id,
      relatedType: 'trip',
      relatedId: trip.id,
      newState: 'draft',
      detail: `Draft expense "${valid.description}" (${valid.amount} ${valid.currency}, ${valid.paymentMethod.replace('_', ' ')}) added to trip to ${trip.destination}`,
      metadata: { tripId: trip.id, category: valid.category, amount: valid.amount, currency: valid.currency, baseAmount: base, rateToBase: rate, paymentMethod: valid.paymentMethod },
      requestId,
      actorIp: ip,
    });

    return row;
  });
}

export async function updateExpense({ id, input, actor, requestId, ip }) {
  const valid = validateExpense(input, { requireTrip: false });

  return tx(async (client) => {
    const existing = await client.one('SELECT * FROM expense WHERE id = $1 FOR UPDATE', [id]);
    if (!existing) return null;

    if (existing.status !== 'draft') {
      throw new WorkflowError(409, 'invalid_transition', `Only draft expenses can be edited; this expense is ${existing.status}.`);
    }

    const trip = await client.one('SELECT * FROM trip WHERE id = $1', [existing.trip_id]);
    await assertTripAcceptsExpenses(client, trip, 'edited');

    const rate = await rateFor(client, existing.trip_id, valid.currency);
    const base = multiplyRate(valid.amount, rate);

    const row = await client.one(
      `UPDATE expense
          SET expense_date = $2, description = $3, category = $4, amount = $5, currency = $6,
              rate_to_base = $7, base_amount = $8, payment_method = $9
        WHERE id = $1
        RETURNING *`,
      [id, valid.date, valid.description, valid.category, valid.amount, valid.currency,
       rate, base, valid.paymentMethod]
    );

    await audit(client, {
      actorId: actor.employeeId,
      actorLabel: actor.name,
      action: ACTIONS.EXPENSE_UPDATE,
      entityType: 'expense',
      entityId: id,
      relatedType: 'trip',
      relatedId: existing.trip_id,
      previousState: 'draft',
      newState: 'draft',
      detail: `Expense "${valid.description}" updated (${valid.amount} ${valid.currency})`,
      metadata: { category: valid.category, amount: valid.amount, currency: valid.currency, baseAmount: base, paymentMethod: valid.paymentMethod },
      requestId,
      actorIp: ip,
    });

    return row;
  });
}

export async function deleteExpense({ id, actor, requestId, ip }) {
  return tx(async (client) => {
    const existing = await client.one('SELECT * FROM expense WHERE id = $1 FOR UPDATE', [id]);
    if (!existing) return null;

    if (existing.status !== 'draft') {
      throw new WorkflowError(409, 'invalid_transition', `Only draft expenses can be deleted; this expense is ${existing.status}.`);
    }

    await client.query('DELETE FROM expense WHERE id = $1', [id]);

    await audit(client, {
      actorId: actor.employeeId,
      actorLabel: actor.name,
      action: ACTIONS.EXPENSE_DELETE,
      entityType: 'expense',
      entityId: id,
      relatedType: 'trip',
      relatedId: existing.trip_id,
      previousState: 'draft',
      newState: null,
      detail: `Draft expense "${existing.description}" (${existing.amount} ${existing.currency}) deleted`,
      metadata: { category: existing.category, amount: existing.amount, currency: existing.currency },
      requestId,
      actorIp: ip,
    });

    return true;
  });
}

export async function submitExpense({ id, actor, requestId, ip }) {
  return tx(async (client) => {
    const expense = await client.one('SELECT * FROM expense WHERE id = $1 FOR UPDATE', [id]);
    if (!expense) return null;

    if (expense.status !== 'draft') {
      throw new WorkflowError(409, 'invalid_transition', `Only draft expenses can be submitted; this expense is ${expense.status}.`);
    }

    /* Verify the employee has an active eligible manager. */
    const emp = await client.one(
      `SELECT e.manager_id, m.status AS manager_status, m.name AS manager_name
         FROM employee e
         LEFT JOIN employee m ON m.id = e.manager_id
        WHERE e.id = $1`,
      [expense.employee_id]
    );

    if (!emp?.manager_id || emp.manager_status !== 'active') {
      throw new WorkflowError(
        422,
        'no_approval_route',
        'You do not have an active reporting manager assigned. Contact an administrator before submitting expenses.'
      );
    }

    const row = await client.one(
      `UPDATE expense
          SET status = 'submitted', submitted_at = now()
        WHERE id = $1
        RETURNING *`,
      [id]
    );

    await audit(client, {
      actorId: actor.employeeId,
      actorLabel: actor.name,
      action: ACTIONS.EXPENSE_SUBMIT,
      entityType: 'expense',
      entityId: id,
      relatedType: 'trip',
      relatedId: expense.trip_id,
      previousState: 'draft',
      newState: 'submitted',
      detail: `Expense "${expense.description}" submitted for manager approval (assigned to ${emp.manager_name})`,
      metadata: { amount: expense.amount, currency: expense.currency, baseAmount: expense.base_amount, managerId: emp.manager_id },
      requestId,
      actorIp: ip,
    });

    return row;
  });
}

export async function decideExpense({ id, decision, reason, actor, requestId, ip }) {
  if (decision !== 'approve' && decision !== 'reject') {
    throw new WorkflowError(422, 'validation_failed', 'Decision must be either "approve" or "reject".');
  }

  let cleanReason = null;
  if (decision === 'reject') {
    cleanReason = reason !== undefined && reason !== null ? String(reason).trim() : '';
    if (!cleanReason) {
      throw new WorkflowError(422, 'validation_failed', 'A rejection reason is required when rejecting an expense.');
    }
    if (cleanReason.length > 500) {
      throw new WorkflowError(422, 'validation_failed', 'Rejection reason must be 500 characters or fewer.');
    }
  }

  return tx(async (client) => {
    const expense = await client.one('SELECT * FROM expense WHERE id = $1 FOR UPDATE', [id]);
    if (!expense) return null;

    if (expense.status !== 'submitted') {
      throw new WorkflowError(409, 'invalid_transition', `Only submitted expenses can be decided; this expense is ${expense.status}.`);
    }

    if (expense.employee_id === actor.employeeId) {
      throw new WorkflowError(403, 'forbidden', 'You cannot approve or reject your own expense.');
    }

    const newStatus = decision === 'approve' ? 'approved' : 'rejected';
    const row = await client.one(
      `UPDATE expense
          SET status = $2, decided_at = now(), decided_by = $3, rejection_reason = $4
        WHERE id = $1
        RETURNING *`,
      [id, newStatus, actor.employeeId, cleanReason]
    );

    await audit(client, {
      actorId: actor.employeeId,
      actorLabel: actor.name,
      action: decision === 'approve' ? ACTIONS.EXPENSE_APPROVE : ACTIONS.EXPENSE_REJECT,
      entityType: 'expense',
      entityId: id,
      relatedType: 'trip',
      relatedId: expense.trip_id,
      previousState: 'submitted',
      newState: newStatus,
      detail: `Expense "${expense.description}" ${decision === 'approve' ? 'approved' : 'rejected by manager'}`,
      reason: cleanReason,
      metadata: { amount: expense.amount, currency: expense.currency, baseAmount: expense.base_amount, decision },
      requestId,
      actorIp: ip,
    });

    return row;
  });
}
