/* Trips service.
 *
 * THE STATE MACHINE LIVES HERE, in one table, because a workflow spread across
 * routes is a workflow nobody can reason about:
 *
 *   draft ──submit──▶ submitted ──approve──▶ approved ──funds issued──▶ active
 *     ▲                    │                      │                       │
 *     │                    ├──reject──▶ rejected │                       │
 *     │                    │                      │                       │
 *     └──request_changes───┴──▶ changes_requested │                       │
 *                          (edit, then resubmit)  │                       │
 *                                                    │                       │
 *   active ──submit reconciliation──▶ reconciliation_pending ──approve──▶ reconciled
 *        ▲                                          │                        │
 *        └──────────── reject (send back) ──────────┘                        │
 *                                                                           settle
 *                                                                            │
 *                                                                          closed
 *
 * Expenses may only be recorded against an `active` trip — one the company has
 * approved and funded. An expense against a draft trip is a claim for travel
 * nobody agreed to pay for.
 *
 * Money: every amount is a NUMERIC string and every derived base amount is
 * computed by Postgres NUMERIC arithmetic (exact) or by src/money.js (exact
 * BigInt). A float never touches a monetary value.
 */

import { tx } from '../db.js';
import { audit, ACTIONS } from '../audit.js';
import { validateTrip, validateBudgetLine, validateFxPlan, validateFund, WorkflowError } from './validate.js';
import { multiplyRate, sumAmounts, normaliseCurrency } from '../money.js';

/* Where a trip may go next, and who may move it. `any` in the actor column
 * means the trip's owner; `approver` means someone with the matching permission
 * over that employee. */
const TRANSITIONS = {
  draft:               { submit: 'any' },
  changes_requested:   { submit: 'any', resubmit: 'any' },
  submitted:           { approve: 'approver', reject: 'approver', request_changes: 'approver' },
  approved:            { fund: 'funder' },
  active:              { reconcile: 'any' },
  reconciliation_pending: { approve_reconciliation: 'funder', reject_reconciliation: 'funder' },
  reconciled:          { settle: 'funder' },
};

export function canTransition(from, to) {
  return Boolean(TRANSITIONS[from]?.[to]);
}

export async function listTrips(db, { scope, team, employeeId, status, limit = 50, cursor } = {}) {
  const where = [];
  const params = [];
  const add = (sql, val) => { params.push(val); where.push(sql.replace('$?', `$${params.length}`)); };

  if (scope === 'own') {
    add('t.employee_id = $?', employeeId);
  } else if (scope === 'team') {
    const ids = Array.from(team ?? []);
    if (ids.length === 0) return { data: [], nextCursor: null };
    add('t.employee_id = ANY($?)', ids);
  } else if (scope === 'all') {
    /* Company-wide: no id restriction at all. */
  }

  if (status) add('t.status = $?', status);
  if (cursor) add('t.created_at < $?', cursor);

  params.push(Math.min(limit, 100));

  const rows = await db.many(
    `SELECT t.id, t.company_id, t.employee_id, t.destination, t.purpose,
            t.start_date, t.end_date, t.currency, t.base_currency, t.status,
            t.submitted_at, t.decided_at, t.decided_by, t.rejection_reason,
            t.approved_budget_base, t.created_at, t.updated_at,
            e.name AS employee_name, e.employee_code,
            m.name AS decided_by_name,
            (SELECT count(*)::int FROM expense x WHERE x.trip_id = t.id) AS expense_count,
            (SELECT COALESCE(sum(x.base_amount), 0) FROM expense x
              WHERE x.trip_id = t.id AND x.status = 'approved') AS approved_expenses_base
       FROM trip t
       JOIN employee e ON e.id = t.employee_id
       LEFT JOIN employee m ON m.id = t.decided_by
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT $${params.length}`,
    params
  );

  return {
    data: rows,
    nextCursor: rows.length ? rows[rows.length - 1].created_at : null,
  };
}

export async function readTrip(db, id) {
  const trip = await db.one(
    `SELECT t.id, t.company_id, t.employee_id, t.destination, t.purpose,
            t.start_date, t.end_date, t.currency, t.base_currency, t.status,
            t.submitted_at, t.decided_at, t.decided_by, t.rejection_reason,
            t.approved_budget_base, t.created_at, t.updated_at,
            e.name AS employee_name, e.employee_code,
            m.name AS decided_by_name
       FROM trip t
       JOIN employee e ON e.id = t.employee_id
       LEFT JOIN employee m ON m.id = t.decided_by
      WHERE t.id = $1`,
    [id]
  );
  if (!trip) return null;

  const [budget, fx, funds, expenses, reconciliation] = await Promise.all([
    db.many(
      `SELECT id, category, description, amount, currency, rate_to_base, base_amount, created_at
         FROM trip_budget_line WHERE trip_id = $1 ORDER BY created_at, id`,
      [id]
    ),
    db.many(
      `SELECT id, currency, cash_amount, card_amount, rate_to_base,
              gst_amount, topup_fee, service_fee, note
         FROM trip_fx_plan WHERE trip_id = $1 ORDER BY currency`,
      [id]
    ),
    db.many(
      `SELECT f.id, f.kind, f.currency, f.amount, f.rate_to_base, f.base_amount, f.note,
              f.issued_at, f.issued_by, e.name AS issued_by_name
         FROM trip_fund f LEFT JOIN employee e ON e.id = f.issued_by
        WHERE f.trip_id = $1 ORDER BY f.issued_at, f.id`,
      [id]
    ),
    db.many(
      `SELECT x.id, x.trip_id, x.employee_id, x.expense_date, x.description,
              x.category, x.amount, x.currency, x.rate_to_base, x.base_amount,
              x.payment_method, x.status, x.submitted_at, x.decided_at,
              x.decided_by, x.rejection_reason, x.created_at, x.updated_at,
              (SELECT count(*)::int FROM expense_bill b WHERE b.expense_id = x.id) AS bill_count
         FROM expense x WHERE x.trip_id = $1
        ORDER BY x.expense_date DESC, x.created_at DESC, x.id DESC`,
      [id]
    ),
    db.one(
      `SELECT id, trip_id, funds_base, expenses_base, balance_base, status,
              computed_at, decided_by, decided_at, decision_note,
              settled_by, settled_at, settlement_note
         FROM trip_reconciliation WHERE trip_id = $1`,
      [id]
    ),
  ]);

  /* Budget versus actual, in base currency, from the stored snapshots. */
  const budgetBase = sumAmounts(budget.map((b) => b.base_amount));
  const actualBase = sumAmounts(
    expenses.filter((x) => x.status === 'approved').map((x) => x.base_amount)
  );
  const fundsBase = sumAmounts(funds.map((f) => f.base_amount));

  return {
    ...trip,
    budget,
    fxPlan: fx,
    funds,
    expenses,
    reconciliation,
    totals: {
      budgetBase,
      actualBase,
      fundsBase,
      varianceBase: sumAmounts([budgetBase, `-${actualBase}`]),
      pendingBase: sumAmounts(
        expenses.filter((x) => x.status === 'submitted').map((x) => x.base_amount)
      ),
    },
  };
}

export async function createTrip({ input, actor, requestId, ip }) {
  const valid = validateTrip(input);

  return tx(async (client) => {
    const row = await client.one(
      `INSERT INTO trip (employee_id, destination, purpose, start_date, end_date, currency, base_currency, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'INR', 'draft')
       RETURNING *`,
      [actor.employeeId, valid.destination, valid.purpose, valid.startDate, valid.endDate, valid.currency]
    );

    await audit(client, {
      actorId: actor.employeeId,
      actorLabel: actor.name,
      action: ACTIONS.TRIP_CREATE,
      entityType: 'trip',
      entityId: row.id,
      newState: 'draft',
      detail: `Draft trip to ${valid.destination} (${valid.currency}) created (${valid.startDate} to ${valid.endDate})`,
      metadata: { destination: valid.destination, currency: valid.currency, startDate: valid.startDate, endDate: valid.endDate },
      requestId,
      actorIp: ip,
    });

    return row;
  });
}

export async function updateTrip({ id, input, actor, requestId, ip }) {
  const valid = validateTrip(input);

  return tx(async (client) => {
    const existing = await client.one('SELECT * FROM trip WHERE id = $1 FOR UPDATE', [id]);
    if (!existing) return null;

    if (!['draft', 'changes_requested'].includes(existing.status)) {
      throw new WorkflowError(409, 'invalid_transition', `Only a draft trip can be edited; this trip is ${existing.status}.`);
    }

    const row = await client.one(
      `UPDATE trip
          SET destination = $2, purpose = $3, start_date = $4, end_date = $5, currency = $6
        WHERE id = $1
        RETURNING *`,
      [id, valid.destination, valid.purpose, valid.startDate, valid.endDate, valid.currency]
    );

    await audit(client, {
      actorId: actor.employeeId,
      actorLabel: actor.name,
      action: ACTIONS.TRIP_UPDATE,
      entityType: 'trip',
      entityId: id,
      previousState: existing.status,
      newState: existing.status,
      detail: `Draft trip to ${valid.destination} updated`,
      metadata: { destination: valid.destination, currency: valid.currency, startDate: valid.startDate, endDate: valid.endDate },
      requestId,
      actorIp: ip,
    });

    return row;
  });
}

/* ------------------------------------------------------------------ workflow */

export async function submitTrip({ id, actor, requestId, ip }) {
  return tx(async (client) => {
    const trip = await client.one('SELECT * FROM trip WHERE id = $1 FOR UPDATE', [id]);
    if (!trip) return null;

    if (!['draft', 'changes_requested'].includes(trip.status)) {
      throw new WorkflowError(409, 'invalid_transition', `Only a draft trip can be submitted; this trip is ${trip.status}.`);
    }

    /* A budget is what is being approved. An empty budget has nothing to approve. */
    const budget = await client.many(
      'SELECT base_amount FROM trip_budget_line WHERE trip_id = $1',
      [id]
    );
    if (!budget.length) {
      throw new WorkflowError(422, 'validation_failed',
        'Add at least one budget line before submitting this trip for approval.');
    }

    /* The approver must exist: an active reporting manager, or Finance. */
    const emp = await client.one(
      `SELECT e.manager_id, m.status AS manager_status, m.name AS manager_name
         FROM employee e
         LEFT JOIN employee m ON m.id = e.manager_id
        WHERE e.id = $1`,
      [trip.employee_id]
    );

    if (!emp?.manager_id || emp.manager_status !== 'active') {
      throw new WorkflowError(
        422,
        'no_approval_route',
        'You do not have an active reporting manager assigned. Contact an administrator before submitting travel requests.'
      );
    }

    const row = await client.one(
      `UPDATE trip
          SET status = 'submitted', submitted_at = now(), rejection_reason = NULL
        WHERE id = $1
        RETURNING *`,
      [id]
    );

    const resubmit = trip.status === 'changes_requested';

    await audit(client, {
      actorId: actor.employeeId,
      actorLabel: actor.name,
      action: resubmit ? ACTIONS.TRIP_RESUBMIT : ACTIONS.TRIP_SUBMIT,
      entityType: 'trip',
      entityId: id,
      previousState: trip.status,
      newState: 'submitted',
      detail: `Trip to ${trip.destination} submitted for approval (assigned to ${emp.manager_name})`,
      metadata: { destination: trip.destination, managerId: emp.manager_id, budgetLines: budget.length },
      requestId,
      actorIp: ip,
    });

    return row;
  });
}

/**
 * Approve, reject, or request changes on a submitted trip.
 *
 * `approve` also freezes the approved budget: the sum of the budget lines at
 * approval time is what Finance is approving, and reconciliation compares
 * against that number later.
 */
export async function decideTrip({ id, decision, reason, actor, requestId, ip }) {
  const VALID = ['approve', 'reject', 'request_changes'];
  if (!VALID.includes(decision)) {
    throw new WorkflowError(422, 'validation_failed', 'Decision must be approve, reject or request_changes.');
  }

  let cleanReason = null;
  if (decision !== 'approve') {
    cleanReason = reason !== undefined && reason !== null ? String(reason).trim() : '';
    if (!cleanReason) {
      throw new WorkflowError(422, 'validation_failed',
        decision === 'reject'
          ? 'A rejection reason is required when rejecting a trip.'
          : 'Say what needs to change so the traveller can fix it.');
    }
    if (cleanReason.length > 500) {
      throw new WorkflowError(422, 'validation_failed', 'Reason must be 500 characters or fewer.');
    }
  }

  return tx(async (client) => {
    const trip = await client.one('SELECT * FROM trip WHERE id = $1 FOR UPDATE', [id]);
    if (!trip) return null;

    if (trip.status !== 'submitted') {
      throw new WorkflowError(409, 'invalid_transition', `Only a submitted trip can be decided; this trip is ${trip.status}.`);
    }

    if (trip.employee_id === actor.employeeId) {
      throw new WorkflowError(403, 'forbidden', 'You cannot decide your own trip.');
    }

    const newStatus = decision === 'approve' ? 'approved'
      : decision === 'reject' ? 'rejected' : 'changes_requested';

    let approvedBudget = null;
    if (decision === 'approve') {
      const lines = await client.many(
        'SELECT base_amount FROM trip_budget_line WHERE trip_id = $1',
        [id]
      );
      approvedBudget = sumAmounts(lines.map((l) => l.base_amount));
    }

    const row = await client.one(
      `UPDATE trip
          SET status = $2, decided_at = now(), decided_by = $3,
              rejection_reason = $4,
              approved_budget_base = COALESCE($5, approved_budget_base)
        WHERE id = $1
        RETURNING *`,
      [id, newStatus, actor.employeeId, cleanReason, approvedBudget]
    );

    await audit(client, {
      actorId: actor.employeeId,
      actorLabel: actor.name,
      action: decision === 'approve' ? ACTIONS.TRIP_APPROVE
        : decision === 'reject' ? ACTIONS.TRIP_REJECT : ACTIONS.TRIP_REQUEST_CHANGES,
      entityType: 'trip',
      entityId: id,
      previousState: 'submitted',
      newState: newStatus,
      detail: decision === 'approve'
        ? `Trip to ${trip.destination} approved (budget ${approvedBudget} ${trip.base_currency})`
        : decision === 'reject'
          ? `Trip to ${trip.destination} rejected`
          : `Changes requested on trip to ${trip.destination}`,
      reason: cleanReason,
      metadata: { destination: trip.destination, decision, approvedBudgetBase: approvedBudget },
      requestId,
      actorIp: ip,
    });

    return row;
  });
}

/* ------------------------------------------------------------------ budget */

/**
 * The exchange rate for a currency on this trip, taken from the forex plan.
 *
 * Every money row stores the rate it used, so a later change to the plan never
 * rewrites money that was already budgeted, spent or issued.
 */
async function rateFor(client, tripId, currency) {
  const row = await client.one(
    'SELECT rate_to_base FROM trip_fx_plan WHERE trip_id = $1 AND currency = $2',
    [tripId, currency]
  );
  if (!row) {
    throw new WorkflowError(422, 'validation_failed',
      `No exchange rate is set for ${currency} on this trip. Add it to the currency plan first.`);
  }
  return row.rate_to_base;
}

export async function addBudgetLine({ tripId, input, actor, requestId, ip }) {
  const valid = validateBudgetLine(input);

  return tx(async (client) => {
    const trip = await client.one('SELECT * FROM trip WHERE id = $1 FOR UPDATE', [tripId]);
    if (!trip) return null;

    if (!['draft', 'changes_requested'].includes(trip.status)) {
      throw new WorkflowError(409, 'invalid_transition',
        `Budget lines can only be added while the trip is a draft; this trip is ${trip.status}.`);
    }

    const rate = await rateFor(client, tripId, valid.currency);
    const base = multiplyRate(valid.amount, rate);

    const row = await client.one(
      `INSERT INTO trip_budget_line
         (trip_id, category, description, amount, currency, rate_to_base, base_amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [tripId, valid.category, valid.description, valid.amount, valid.currency, rate, base]
    );

    await audit(client, {
      actorId: actor.employeeId,
      actorLabel: actor.name,
      action: ACTIONS.TRIP_BUDGET_ADD,
      entityType: 'trip_budget_line',
      entityId: row.id,
      relatedType: 'trip',
      relatedId: tripId,
      newState: 'draft',
      detail: `Budget line "${valid.description}" (${valid.amount} ${valid.currency}) added to trip to ${trip.destination}`,
      metadata: { category: valid.category, amount: valid.amount, currency: valid.currency, baseAmount: base, rateToBase: rate },
      requestId,
      actorIp: ip,
    });

    return row;
  });
}

export async function removeBudgetLine({ tripId, lineId, actor, requestId, ip }) {
  return tx(async (client) => {
    const trip = await client.one('SELECT * FROM trip WHERE id = $1 FOR UPDATE', [tripId]);
    if (!trip) return null;

    if (!['draft', 'changes_requested'].includes(trip.status)) {
      throw new WorkflowError(409, 'invalid_transition',
        `Budget lines can only be removed while the trip is a draft; this trip is ${trip.status}.`);
    }

    const line = await client.one(
      'SELECT * FROM trip_budget_line WHERE id = $1 AND trip_id = $2',
      [lineId, tripId]
    );
    if (!line) return null;

    await client.query('DELETE FROM trip_budget_line WHERE id = $1', [lineId]);

    await audit(client, {
      actorId: actor.employeeId,
      actorLabel: actor.name,
      action: ACTIONS.TRIP_BUDGET_REMOVE,
      entityType: 'trip_budget_line',
      entityId: lineId,
      relatedType: 'trip',
      relatedId: tripId,
      previousState: 'draft',
      newState: null,
      detail: `Budget line "${line.description}" (${line.amount} ${line.currency}) removed from trip to ${trip.destination}`,
      metadata: { category: line.category, amount: line.amount, currency: line.currency },
      requestId,
      actorIp: ip,
    });

    return true;
  });
}

/* ------------------------------------------------------------------ forex plan */

export async function setFxPlan({ tripId, input, actor, requestId, ip }) {
  const valid = validateFxPlan(input);

  return tx(async (client) => {
    const trip = await client.one('SELECT * FROM trip WHERE id = $1 FOR UPDATE', [tripId]);
    if (!trip) return null;

    if (!['draft', 'changes_requested', 'approved'].includes(trip.status)) {
      throw new WorkflowError(409, 'invalid_transition',
        `The currency plan can only be changed before the trip is active; this trip is ${trip.status}.`);
    }

    const row = await client.one(
      `INSERT INTO trip_fx_plan
         (trip_id, currency, cash_amount, card_amount, rate_to_base, gst_amount, topup_fee, service_fee, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (trip_id, currency) DO UPDATE
         SET cash_amount = EXCLUDED.cash_amount,
             card_amount = EXCLUDED.card_amount,
             rate_to_base = EXCLUDED.rate_to_base,
             gst_amount = EXCLUDED.gst_amount,
             topup_fee = EXCLUDED.topup_fee,
             service_fee = EXCLUDED.service_fee,
             note = EXCLUDED.note
       RETURNING *`,
      [tripId, valid.currency, valid.cashAmount, valid.cardAmount, valid.rateToBase,
       valid.gstAmount, valid.topupFee, valid.serviceFee, valid.note]
    );

    await audit(client, {
      actorId: actor.employeeId,
      actorLabel: actor.name,
      action: ACTIONS.TRIP_FX_SET,
      entityType: 'trip_fx_plan',
      entityId: row.id,
      relatedType: 'trip',
      relatedId: tripId,
      newState: 'set',
      detail: `Currency plan for ${valid.currency} set on trip to ${trip.destination} (rate ${valid.rateToBase}, cash ${valid.cashAmount}, card ${valid.cardAmount})`,
      metadata: { currency: valid.currency, rateToBase: valid.rateToBase, gstAmount: valid.gstAmount, topupFee: valid.topupFee, serviceFee: valid.serviceFee },
      requestId,
      actorIp: ip,
    });

    return row;
  });
}

export async function removeFxPlan({ tripId, planId, actor, requestId, ip }) {
  return tx(async (client) => {
    const trip = await client.one('SELECT * FROM trip WHERE id = $1 FOR UPDATE', [tripId]);
    if (!trip) return null;

    if (!['draft', 'changes_requested'].includes(trip.status)) {
      throw new WorkflowError(409, 'invalid_transition',
        `The currency plan can only be changed while the trip is a draft; this trip is ${trip.status}.`);
    }

    const plan = await client.one('SELECT * FROM trip_fx_plan WHERE id = $1 AND trip_id = $2', [planId, tripId]);
    if (!plan) return null;

    await client.query('DELETE FROM trip_fx_plan WHERE id = $1', [planId]);

    await audit(client, {
      actorId: actor.employeeId,
      actorLabel: actor.name,
      action: ACTIONS.TRIP_FX_REMOVE,
      entityType: 'trip_fx_plan',
      entityId: planId,
      relatedType: 'trip',
      relatedId: tripId,
      previousState: 'set',
      newState: null,
      detail: `Currency plan for ${plan.currency} removed from trip to ${trip.destination}`,
      metadata: { currency: plan.currency },
      requestId,
      actorIp: ip,
    });

    return true;
  });
}

/* ------------------------------------------------------------------ funds */

/**
 * Issue funds against an approved trip. The first allocation moves the trip to
 * `active`, which is when expenses may start being recorded.
 */
export async function issueFund({ tripId, input, actor, requestId, ip }) {
  const valid = validateFund(input);

  return tx(async (client) => {
    const trip = await client.one('SELECT * FROM trip WHERE id = $1 FOR UPDATE', [tripId]);
    if (!trip) return null;

    if (!['approved', 'active'].includes(trip.status)) {
      throw new WorkflowError(409, 'invalid_transition',
        `Funds are issued only after the budget is approved; this trip is ${trip.status}.`);
    }

    const rate = await rateFor(client, tripId, valid.currency);
    const base = multiplyRate(valid.amount, rate);

    const row = await client.one(
      `INSERT INTO trip_fund (trip_id, kind, currency, amount, rate_to_base, base_amount, note, issued_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [tripId, valid.kind, valid.currency, valid.amount, rate, base, valid.note, actor.employeeId]
    );

    const activated = trip.status === 'approved';
    if (activated) {
      await client.query(`UPDATE trip SET status = 'active' WHERE id = $1`, [tripId]);
    }

    await audit(client, {
      actorId: actor.employeeId,
      actorLabel: actor.name,
      action: ACTIONS.TRIP_FUND_ISSUE,
      entityType: 'trip_fund',
      entityId: row.id,
      relatedType: 'trip',
      relatedId: tripId,
      newState: 'issued',
      detail: `${valid.kind.replace('_', ' ')} of ${valid.amount} ${valid.currency} issued for trip to ${trip.destination}`,
      metadata: { kind: valid.kind, amount: valid.amount, currency: valid.currency, baseAmount: base, rateToBase: rate, tripActivated: activated },
      requestId,
      actorIp: ip,
    });

    return { ...row, trip_status: activated ? 'active' : trip.status };
  });
}

/* ------------------------------------------------------------------ reconciliation */

/**
 * Compute the reconciliation for a trip and submit it for Finance.
 *
 * The numbers are snapshotted, not recomputed later: a decision is made against
 * a fixed set of figures, and the audit trail records what they were.
 */
export async function submitReconciliation({ tripId, input, actor, requestId, ip }) {
  const note = input?.note !== undefined && input?.note !== null
    ? String(input.note).trim().slice(0, 1000) : null;

  return tx(async (client) => {
    const trip = await client.one('SELECT * FROM trip WHERE id = $1 FOR UPDATE', [tripId]);
    if (!trip) return null;

    if (trip.status !== 'active') {
      throw new WorkflowError(409, 'invalid_transition',
        `A reconciliation can only be submitted while the trip is active; this trip is ${trip.status}.`);
    }

    /* Money that is still in flight is not a settled number: an undecided
     * expense would make the balance wrong. */
    const pending = await client.one(
      `SELECT count(*)::int AS n FROM expense WHERE trip_id = $1 AND status = 'submitted'`,
      [tripId]
    );
    if (pending.n > 0) {
      throw new WorkflowError(422, 'validation_failed',
        `${pending.n} expense${pending.n === 1 ? '' : 's'} on this trip ${pending.n === 1 ? 'is' : 'are'} still awaiting approval. Approve or reject them before reconciling.`);
    }

    const [funds, expenses] = await Promise.all([
      client.many('SELECT base_amount FROM trip_fund WHERE trip_id = $1', [tripId]),
      client.many(`SELECT base_amount FROM expense WHERE trip_id = $1 AND status = 'approved'`, [tripId]),
    ]);

    const fundsBase = sumAmounts(funds.map((f) => f.base_amount));
    const expensesBase = sumAmounts(expenses.map((e) => e.base_amount));
    const balanceBase = sumAmounts([fundsBase, `-${expensesBase}`]);

    const row = await client.one(
      `INSERT INTO trip_reconciliation
         (trip_id, funds_base, expenses_base, balance_base, status, decision_note)
       VALUES ($1, $2, $3, $4, 'pending', $5)
       ON CONFLICT (trip_id) DO UPDATE
         SET funds_base = EXCLUDED.funds_base,
             expenses_base = EXCLUDED.expenses_base,
             balance_base = EXCLUDED.balance_base,
             status = 'pending',
             decision_note = EXCLUDED.decision_note,
             computed_at = now(),
             decided_by = NULL,
             decided_at = NULL
       RETURNING *`,
      [tripId, fundsBase, expensesBase, balanceBase, note]
    );

    await client.query(`UPDATE trip SET status = 'reconciliation_pending' WHERE id = $1`, [tripId]);

    await audit(client, {
      actorId: actor.employeeId,
      actorLabel: actor.name,
      action: ACTIONS.TRIP_RECONCILE_SUBMIT,
      entityType: 'trip_reconciliation',
      entityId: row.id,
      relatedType: 'trip',
      relatedId: tripId,
      previousState: 'active',
      newState: 'pending',
      detail: `Reconciliation submitted for trip to ${trip.destination}: funds ${fundsBase}, spent ${expensesBase}, balance ${balanceBase} ${trip.base_currency}`,
      reason: note,
      metadata: { fundsBase, expensesBase, balanceBase },
      requestId,
      actorIp: ip,
    });

    return row;
  });
}

/** Finance approves or rejects a reconciliation. */
export async function decideReconciliation({ tripId, decision, reason, actor, requestId, ip }) {
  if (decision !== 'approve' && decision !== 'reject') {
    throw new WorkflowError(422, 'validation_failed', 'Decision must be approve or reject.');
  }

  let cleanReason = null;
  if (decision === 'reject') {
    cleanReason = reason !== undefined && reason !== null ? String(reason).trim() : '';
    if (!cleanReason) {
      throw new WorkflowError(422, 'validation_failed', 'A reason is required when rejecting a reconciliation.');
    }
    if (cleanReason.length > 500) {
      throw new WorkflowError(422, 'validation_failed', 'Reason must be 500 characters or fewer.');
    }
  }

  return tx(async (client) => {
    const trip = await client.one('SELECT * FROM trip WHERE id = $1 FOR UPDATE', [tripId]);
    if (!trip) return null;

    if (trip.status !== 'reconciliation_pending') {
      throw new WorkflowError(409, 'invalid_transition',
        `Only a pending reconciliation can be decided; this trip is ${trip.status}.`);
    }

    const rec = await client.one('SELECT * FROM trip_reconciliation WHERE trip_id = $1 FOR UPDATE', [tripId]);
    if (!rec) {
      throw new WorkflowError(409, 'invalid_transition', 'This trip has no reconciliation to decide.');
    }

    const newStatus = decision === 'approve' ? 'approved' : 'rejected';

    const row = await client.one(
      `UPDATE trip_reconciliation
          SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4
        WHERE trip_id = $1
        RETURNING *`,
      [tripId, newStatus, actor.employeeId, cleanReason]
    );

    await client.query(
      `UPDATE trip SET status = $2 WHERE id = $1`,
      [tripId, decision === 'approve' ? 'reconciled' : 'active']
    );

    await audit(client, {
      actorId: actor.employeeId,
      actorLabel: actor.name,
      action: decision === 'approve' ? ACTIONS.TRIP_RECONCILE_APPROVE : ACTIONS.TRIP_RECONCILE_REJECT,
      entityType: 'trip_reconciliation',
      entityId: rec.id,
      relatedType: 'trip',
      relatedId: tripId,
      previousState: 'pending',
      newState: newStatus,
      detail: decision === 'approve'
        ? `Reconciliation approved for trip to ${trip.destination} (balance ${rec.balance_base} ${trip.base_currency})`
        : `Reconciliation sent back for trip to ${trip.destination}`,
      reason: cleanReason,
      metadata: { balanceBase: rec.balance_base, decision },
      requestId,
      actorIp: ip,
    });

    return row;
  });
}

/** Close the trip after the money has moved. */
export async function settleTrip({ tripId, input, actor, requestId, ip }) {
  const note = input?.note !== undefined && input?.note !== null
    ? String(input.note).trim().slice(0, 1000) : null;

  return tx(async (client) => {
    const trip = await client.one('SELECT * FROM trip WHERE id = $1 FOR UPDATE', [tripId]);
    if (!trip) return null;

    if (trip.status !== 'reconciled') {
      throw new WorkflowError(409, 'invalid_transition',
        `A trip can only be settled after its reconciliation is approved; this trip is ${trip.status}.`);
    }

    const rec = await client.one('SELECT * FROM trip_reconciliation WHERE trip_id = $1', [tripId]);
    if (!rec) {
      throw new WorkflowError(409, 'invalid_transition', 'This trip has no reconciliation.');
    }

    await client.query(
      `UPDATE trip_reconciliation SET settled_by = $2, settled_at = now(), settlement_note = $3 WHERE trip_id = $1`,
      [tripId, actor.employeeId, note]
    );

    const row = await client.one(`UPDATE trip SET status = 'closed' WHERE id = $1 RETURNING *`, [tripId]);

    await audit(client, {
      actorId: actor.employeeId,
      actorLabel: actor.name,
      action: ACTIONS.TRIP_SETTLE,
      entityType: 'trip',
      entityId: tripId,
      previousState: 'reconciled',
      newState: 'closed',
      detail: `Trip to ${trip.destination} settled and closed (balance ${rec.balance_base} ${trip.base_currency})`,
      reason: note,
      metadata: { balanceBase: rec.balance_base, fundsBase: rec.funds_base, expensesBase: rec.expenses_base },
      requestId,
      actorIp: ip,
    });

    return row;
  });
}
