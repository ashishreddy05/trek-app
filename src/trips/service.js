/* Trips service. */

import { tx } from '../db.js';
import { audit, ACTIONS } from '../audit.js';
import { validateTrip, WorkflowError } from './validate.js';

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
    if (employeeId) add('t.employee_id = $?', employeeId);
  }

  if (status) add('t.status = $?', status);
  if (cursor) add('t.created_at < $?', cursor);

  params.push(Math.min(limit, 100));

  const rows = await db.many(
    `SELECT t.id, t.company_id, t.employee_id, t.destination, t.purpose,
            t.start_date, t.end_date, t.currency, t.status, t.submitted_at, t.decided_at,
            t.decided_by, t.rejection_reason, t.created_at, t.updated_at,
            e.name AS employee_name, e.employee_code,
            m.name AS decided_by_name,
            (SELECT count(*)::int FROM expense x WHERE x.trip_id = t.id) AS expense_count
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
            t.start_date, t.end_date, t.currency, t.status, t.submitted_at, t.decided_at,
            t.decided_by, t.rejection_reason, t.created_at, t.updated_at,
            e.name AS employee_name, e.employee_code,
            m.name AS decided_by_name
       FROM trip t
       JOIN employee e ON e.id = t.employee_id
       LEFT JOIN employee m ON m.id = t.decided_by
      WHERE t.id = $1`,
    [id]
  );
  if (!trip) return null;

  const expenses = await db.many(
    `SELECT x.id, x.trip_id, x.employee_id, x.expense_date, x.description,
            x.category, x.amount, x.currency, x.status, x.submitted_at,
            x.decided_at, x.decided_by, x.rejection_reason, x.created_at
       FROM expense x
      WHERE x.trip_id = $1
      ORDER BY x.expense_date DESC, x.created_at DESC`,
    [id]
  );

  // Exact multi-currency arithmetic using integer minor units (BigInt) - zero IEEE float math
  const currencyCents = {};
  for (const x of expenses) {
    const curr = x.currency || 'USD';
    const [i, f = ''] = String(x.amount || '0.00').split('.');
    const cents = BigInt(i || '0') * 100n + BigInt((f + '00').slice(0, 2));
    currencyCents[curr] = (currencyCents[curr] || 0n) + cents;
  }
  const totalsByCurrency = Object.entries(currencyCents).map(([curr, cents]) => {
    const sign = cents < 0n ? '-' : '';
    const abs = cents < 0n ? -cents : cents;
    const whole = abs / 100n;
    const fraction = abs % 100n;
    return {
      currency: curr,
      amount: `${sign}${whole}.${String(fraction).padStart(2, '0')}`,
    };
  });

  return { ...trip, expenses, totalsByCurrency };
}

export async function createTrip({ input, actor, requestId, ip }) {
  const valid = validateTrip(input);

  return tx(async (client) => {
    const row = await client.one(
      `INSERT INTO trip (employee_id, destination, purpose, start_date, end_date, currency, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'draft')
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

    if (existing.status !== 'draft') {
      throw new WorkflowError(409, 'invalid_transition', `Only draft trips can be edited; this trip is ${existing.status}.`);
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
      previousState: 'draft',
      newState: 'draft',
      detail: `Draft trip to ${valid.destination} (${valid.currency}) updated`,
      metadata: { destination: valid.destination, currency: valid.currency, startDate: valid.startDate, endDate: valid.endDate },
      requestId,
      actorIp: ip,
    });

    return row;
  });
}

export async function submitTrip({ id, actor, requestId, ip }) {
  return tx(async (client) => {
    const trip = await client.one('SELECT * FROM trip WHERE id = $1 FOR UPDATE', [id]);
    if (!trip) return null;

    if (trip.status !== 'draft') {
      throw new WorkflowError(409, 'invalid_transition', `Only draft trips can be submitted; this trip is ${trip.status}.`);
    }

    // Verify employee has an active eligible manager.
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
          SET status = 'submitted', submitted_at = now()
        WHERE id = $1
        RETURNING *`,
      [id]
    );

    await audit(client, {
      actorId: actor.employeeId,
      actorLabel: actor.name,
      action: ACTIONS.TRIP_SUBMIT,
      entityType: 'trip',
      entityId: id,
      previousState: 'draft',
      newState: 'submitted',
      detail: `Trip to ${trip.destination} submitted for manager approval (assigned to ${emp.manager_name})`,
      metadata: { destination: trip.destination, managerId: emp.manager_id },
      requestId,
      actorIp: ip,
    });

    return row;
  });
}

export async function decideTrip({ id, decision, reason, actor, requestId, ip }) {
  if (decision !== 'approve' && decision !== 'reject') {
    throw new WorkflowError(422, 'validation_failed', 'Decision must be either "approve" or "reject".');
  }

  let cleanReason = null;
  if (decision === 'reject') {
    cleanReason = reason !== undefined && reason !== null ? String(reason).trim() : '';
    if (!cleanReason) {
      throw new WorkflowError(422, 'validation_failed', 'A rejection reason is required when rejecting a trip.');
    }
    if (cleanReason.length > 500) {
      throw new WorkflowError(422, 'validation_failed', 'Rejection reason must be 500 characters or fewer.');
    }
  }

  return tx(async (client) => {
    const trip = await client.one('SELECT * FROM trip WHERE id = $1 FOR UPDATE', [id]);
    if (!trip) return null;

    if (trip.status !== 'submitted') {
      throw new WorkflowError(409, 'invalid_transition', `Only submitted trips can be decided; this trip is ${trip.status}.`);
    }

    if (trip.employee_id === actor.employeeId) {
      throw new WorkflowError(403, 'forbidden', 'You cannot approve or reject your own trip.');
    }

    const newStatus = decision === 'approve' ? 'approved' : 'rejected';
    const row = await client.one(
      `UPDATE trip
          SET status = $2, decided_at = now(), decided_by = $3, rejection_reason = $4
        WHERE id = $1
        RETURNING *`,
      [id, newStatus, actor.employeeId, cleanReason]
    );

    await audit(client, {
      actorId: actor.employeeId,
      actorLabel: actor.name,
      action: decision === 'approve' ? ACTIONS.TRIP_APPROVE : ACTIONS.TRIP_REJECT,
      entityType: 'trip',
      entityId: id,
      previousState: 'submitted',
      newState: newStatus,
      detail: `Trip to ${trip.destination} ${decision === 'approve' ? 'approved' : 'rejected by manager'}`,
      reason: cleanReason,
      metadata: { destination: trip.destination, decision },
      requestId,
      actorIp: ip,
    });

    return row;
  });
}
