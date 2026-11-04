/* Trips and Expenses pilot test suite.
 * Run: npm test   (requires a migrated + seeded database ending in _test)
 */

import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../src/db.js';
import { resolvePrincipal } from '../src/auth/principal.js';
import {
  createTrip, updateTrip, submitTrip, decideTrip, readTrip, listTrips,
} from '../src/trips/service.js';
import {
  createExpense, updateExpense, deleteExpense, submitExpense, decideExpense, readExpense, listExpenses,
} from '../src/expenses/service.js';
import { normalizeAmount, validateExpense } from '../src/expenses/validate.js';
import { validateTrip } from '../src/trips/validate.js';
import { authorize } from '../src/authz/guard.js';

after(async () => { await db.close(); });

const SURESH = 'emp_1231';  // Sales traveller (reports to Vikram)
const NADIA = 'emp_1232';   // Sales traveller (peer, reports to Vikram)
const VIKRAM = 'emp_1001';  // VP Sales (manager of Suresh and Nadia; manager_id is NULL)
const SARA = 'emp_1004';    // Travel Desk Lead (manager_id is NULL)

describe('Trips & Expenses — End-to-End Workflow', () => {
  let pSuresh, pVikram, pNadia;
  let tripId, exp1Id, exp2Id;

  test('setup principals', async () => {
    pSuresh = await resolvePrincipal(db, SURESH);
    pVikram = await resolvePrincipal(db, VIKRAM);
    pNadia = await resolvePrincipal(db, NADIA);
    assert.ok(pSuresh, 'Suresh exists');
    assert.ok(pVikram, 'Vikram exists');
    assert.ok(pNadia, 'Nadia exists');
    assert.equal(pSuresh.managerId, VIKRAM, 'Suresh reports to Vikram');
  });

  test('employee can create a draft trip', async () => {
    const trip = await createTrip({
      input: {
        destination: 'Dubai, UAE',
        purpose: 'Quarterly client onboarding meetings',
        startDate: '2026-12-01',
        endDate: '2026-12-05',
      },
      actor: pSuresh,
      requestId: 'req_1',
      ip: '127.0.0.1',
    });

    assert.ok(trip.id);
    assert.equal(trip.employee_id, SURESH);
    assert.equal(trip.destination, 'Dubai, UAE');
    assert.equal(trip.status, 'draft');
    tripId = trip.id;

    // Verify audit event written
    const auditRow = await db.one(
      `SELECT * FROM audit_event WHERE entity_type = 'trip' AND entity_id = $1 ORDER BY id DESC LIMIT 1`,
      [tripId]
    );
    assert.equal(auditRow.action, 'trip.create');
    assert.equal(auditRow.actor_id, SURESH);
    assert.equal(auditRow.new_state, 'draft');
  });

  test('employee can edit their draft trip', async () => {
    const updated = await updateTrip({
      id: tripId,
      input: {
        destination: 'Dubai & Abu Dhabi, UAE',
        purpose: 'Quarterly client onboarding and site visits',
        startDate: '2026-12-01',
        endDate: '2026-12-06',
      },
      actor: pSuresh,
      requestId: 'req_2',
      ip: '127.0.0.1',
    });

    assert.equal(updated.destination, 'Dubai & Abu Dhabi, UAE');
    assert.equal(updated.purpose, 'Quarterly client onboarding and site visits');
    const endDateStr = updated.end_date instanceof Date
      ? updated.end_date.toISOString().slice(0, 10)
      : String(updated.end_date).slice(0, 10);
    assert.equal(endDateStr, '2026-12-06');

    const auditRow = await db.one(
      `SELECT * FROM audit_event WHERE entity_type = 'trip' AND entity_id = $1 AND action = 'trip.update' LIMIT 1`,
      [tripId]
    );
    assert.ok(auditRow);
    assert.equal(auditRow.previous_state, 'draft');
    assert.equal(auditRow.new_state, 'draft');
  });

  test('employee can add draft expenses to their trip', async () => {
    const exp1 = await createExpense({
      input: {
        tripId,
        date: '2026-12-02',
        description: 'Hotel stay (4 nights)',
        category: 'lodging',
        amount: '1250.50',
        currency: 'SAR',
      },
      actor: pSuresh,
      requestId: 'req_3',
      ip: '127.0.0.1',
    });

    assert.ok(exp1.id);
    assert.equal(exp1.status, 'draft');
    assert.equal(exp1.amount, '1250.50');
    assert.equal(exp1.currency, 'SAR');
    exp1Id = exp1.id;

    const exp2 = await createExpense({
      input: {
        tripId,
        date: '2026-12-03',
        description: 'Team dinner with client',
        category: 'meals',
        amount: '85.00',
        currency: 'SAR',
      },
      actor: pSuresh,
      requestId: 'req_4',
      ip: '127.0.0.1',
    });

    assert.ok(exp2.id);
    assert.equal(exp2.amount, '85.00');
    exp2Id = exp2.id;

    // Verify trip detail now returns the 2 expenses
    const tripWithExp = await readTrip(db, tripId);
    assert.equal(tripWithExp.expenses.length, 2);
  });

  test('employee can edit a draft expense', async () => {
    const updated = await updateExpense({
      id: exp2Id,
      input: {
        date: '2026-12-03',
        description: 'Team dinner with client (updated bill)',
        category: 'meals',
        amount: '95.50',
        currency: 'SAR',
      },
      actor: pSuresh,
      requestId: 'req_5',
      ip: '127.0.0.1',
    });

    assert.equal(updated.amount, '95.50');
    assert.equal(updated.description, 'Team dinner with client (updated bill)');

    const auditRow = await db.one(
      `SELECT * FROM audit_event WHERE entity_type = 'expense' AND entity_id = $1 AND action = 'expense.update' LIMIT 1`,
      [exp2Id]
    );
    assert.ok(auditRow);
  });

  test('employee can submit their trip', async () => {
    const submitted = await submitTrip({
      id: tripId,
      actor: pSuresh,
      requestId: 'req_6',
      ip: '127.0.0.1',
    });

    assert.equal(submitted.status, 'submitted');
    assert.ok(submitted.submitted_at);

    const auditRow = await db.one(
      `SELECT * FROM audit_event WHERE entity_type = 'trip' AND entity_id = $1 AND action = 'trip.submit' LIMIT 1`,
      [tripId]
    );
    assert.ok(auditRow);
    assert.equal(auditRow.previous_state, 'draft');
    assert.equal(auditRow.new_state, 'submitted');
  });

  test('employee can submit their expenses', async () => {
    const sub1 = await submitExpense({ id: exp1Id, actor: pSuresh, requestId: 'req_7', ip: '127.0.0.1' });
    const sub2 = await submitExpense({ id: exp2Id, actor: pSuresh, requestId: 'req_8', ip: '127.0.0.1' });

    assert.equal(sub1.status, 'submitted');
    assert.equal(sub2.status, 'submitted');
  });

  test('manager can see submitted trips in their reporting tree', async () => {
    const { team } = await authorize(db, pVikram, 'trip.list', { scope: 'team' });
    const list = await listTrips(db, { scope: 'team', team, status: 'submitted' });

    assert.ok(list.data.some((t) => t.id === tripId));
    const found = list.data.find((t) => t.id === tripId);
    assert.equal(found.employee_name, 'Suresh Kumar');
  });

  test('manager can approve the submitted trip', async () => {
    const approved = await decideTrip({
      id: tripId,
      decision: 'approve',
      actor: pVikram,
      requestId: 'req_9',
      ip: '127.0.0.1',
    });

    assert.equal(approved.status, 'approved');
    assert.equal(approved.decided_by, VIKRAM);
    assert.ok(approved.decided_at);

    const auditRow = await db.one(
      `SELECT * FROM audit_event WHERE entity_type = 'trip' AND entity_id = $1 AND action = 'trip.approve' LIMIT 1`,
      [tripId]
    );
    assert.ok(auditRow);
    assert.equal(auditRow.actor_id, VIKRAM);
    assert.equal(auditRow.previous_state, 'submitted');
    assert.equal(auditRow.new_state, 'approved');
  });

  test('manager can approve one expense and reject another with reason', async () => {
    const app1 = await decideExpense({
      id: exp1Id,
      decision: 'approve',
      actor: pVikram,
      requestId: 'req_10',
      ip: '127.0.0.1',
    });
    assert.equal(app1.status, 'approved');

    const rej2 = await decideExpense({
      id: exp2Id,
      decision: 'reject',
      reason: 'Exceeds per-meal policy guidelines',
      actor: pVikram,
      requestId: 'req_11',
      ip: '127.0.0.1',
    });
    assert.equal(rej2.status, 'rejected');
    assert.equal(rej2.rejection_reason, 'Exceeds per-meal policy guidelines');

    // Verify rejection audit record includes verbatim reason
    const auditRow = await db.one(
      `SELECT * FROM audit_event WHERE entity_type = 'expense' AND entity_id = $1 AND action = 'expense.reject' LIMIT 1`,
      [exp2Id]
    );
    assert.ok(auditRow);
    assert.equal(auditRow.reason, 'Exceeds per-meal policy guidelines');
    assert.equal(auditRow.new_state, 'rejected');
  });
});

describe('Negative Tests — Authorization & Security', () => {
  let pSuresh, pNadia, pVikram, pSara;
  let testTrip, testExp;

  test('setup test records', async () => {
    pSuresh = await resolvePrincipal(db, SURESH);
    pNadia = await resolvePrincipal(db, NADIA);
    pVikram = await resolvePrincipal(db, VIKRAM);
    pSara = await resolvePrincipal(db, SARA);

    testTrip = await createTrip({
      input: { destination: 'Paris, France', purpose: 'Conference', startDate: '2026-11-10', endDate: '2026-11-14' },
      actor: pSuresh, requestId: 'neg_1', ip: '127.0.0.1',
    });

    testExp = await createExpense({
      input: { tripId: testTrip.id, date: '2026-11-10', description: 'Train ticket', category: 'transport', amount: '120.00', currency: 'EUR' },
      actor: pSuresh, requestId: 'neg_2', ip: '127.0.0.1',
    });
  });

  test('peer cannot read another employee trip — opaque 404', async () => {
    await assert.rejects(
      () => authorize(db, pNadia, 'trip.read', { employeeId: SURESH, type: 'trip', id: testTrip.id }),
      (err) => err.status === 404 && err.code === 'not_found',
      'out-of-scope trip read must return opaque 404'
    );
  });

  test('peer cannot read another employee expense — opaque 404', async () => {
    await assert.rejects(
      () => authorize(db, pNadia, 'expense.read', { employeeId: SURESH, type: 'expense', id: testExp.id }),
      (err) => err.status === 404 && err.code === 'not_found',
      'out-of-scope expense read must return opaque 404'
    );
  });

  test('unrelated manager cannot approve trip outside their reporting tree', async () => {
    // Sara is HR/Travel Lead; Suresh is not in her reporting tree
    await assert.rejects(
      () => authorize(db, pSara, 'trip.decide', { employeeId: SURESH, type: 'trip', id: testTrip.id }),
      (err) => err.status === 403 && err.code === 'forbidden',
      'Sara cannot decide trips outside her reporting tree'
    );
  });

  test('manager cannot approve their own trip (selfForbidden)', async () => {
    await assert.rejects(
      () => authorize(db, pVikram, 'trip.decide', { employeeId: VIKRAM, type: 'trip', id: 'trp_mock' }),
      (err) => err.status === 403 && err.code === 'forbidden',
      'manager cannot approve their own trip'
    );
  });

  test('manager cannot approve their own expense (selfForbidden)', async () => {
    await assert.rejects(
      () => authorize(db, pVikram, 'expense.decide', { employeeId: VIKRAM, type: 'expense', id: 'exp_mock' }),
      (err) => err.status === 403 && err.code === 'forbidden',
      'manager cannot approve their own expense'
    );
  });
});

describe('Negative Tests — Approval Route & Validation Guards', () => {
  let pVikram, pSuresh;

  test('setup', async () => {
    pVikram = await resolvePrincipal(db, VIKRAM);
    pSuresh = await resolvePrincipal(db, SURESH);
  });

  test('employee with no manager gets 422 no_approval_route on trip submit', async () => {
    // Vikram has manager_id = NULL
    const vikramTrip = await createTrip({
      input: { destination: 'London, UK', purpose: 'Exec meeting', startDate: '2026-11-20', endDate: '2026-11-23' },
      actor: pVikram, requestId: 'no_route_1', ip: '127.0.0.1',
    });

    await assert.rejects(
      () => submitTrip({ id: vikramTrip.id, actor: pVikram, requestId: 'no_route_2', ip: '127.0.0.1' }),
      (err) => err.status === 422 && err.code === 'no_approval_route',
      'must fail with 422 no_approval_route when employee has no manager'
    );
  });

  test('invalid dates are rejected with 422', () => {
    // End before start
    assert.throws(
      () => validateTrip({ destination: 'Dubai', purpose: 'Work', startDate: '2026-12-10', endDate: '2026-12-05' }),
      (err) => err.status === 422 && Boolean(err.fields.endDate)
    );

    // Malformed date
    assert.throws(
      () => validateTrip({ destination: 'Dubai', purpose: 'Work', startDate: '2026-02-31', endDate: '2026-03-01' }),
      (err) => err.status === 422 && Boolean(err.fields.startDate)
    );

    // Missing destination
    assert.throws(
      () => validateTrip({ destination: '  ', purpose: 'Work', startDate: '2026-12-01', endDate: '2026-12-05' }),
      (err) => err.status === 422 && Boolean(err.fields.destination)
    );
  });

  test('exact money validation rejects negative, zero, or float precision errors', () => {
    assert.equal(normalizeAmount('0'), null);
    assert.equal(normalizeAmount('0.00'), null);
    assert.equal(normalizeAmount('-25.00'), null);
    assert.equal(normalizeAmount('abc'), null);
    assert.equal(normalizeAmount('12.345'), null, 'more than 2 decimals refused');
    assert.equal(normalizeAmount('125'), '125.00');
    assert.equal(normalizeAmount('125.5'), '125.50');
    assert.equal(normalizeAmount('125.50'), '125.50');

    // Currency validation
    assert.throws(
      () => validateExpense({ tripId: 'trp_1', date: '2026-12-01', description: 'Lunch', category: 'meals', amount: '25.00', currency: 'SAR1' }),
      (err) => err.status === 422 && Boolean(err.fields.currency)
    );

    // Category validation
    assert.throws(
      () => validateExpense({ tripId: 'trp_1', date: '2026-12-01', description: 'Lunch', category: 'space-travel', amount: '25.00', currency: 'SAR' }),
      (err) => err.status === 422 && Boolean(err.fields.category)
    );
  });

  test('rejection requires non-empty reason', async () => {
    const trip = await createTrip({
      input: { destination: 'Riyadh', purpose: 'Onsite', startDate: '2026-12-10', endDate: '2026-12-12' },
      actor: pSuresh, requestId: 'rej_1', ip: '127.0.0.1',
    });
    await submitTrip({ id: trip.id, actor: pSuresh, requestId: 'rej_2', ip: '127.0.0.1' });

    await assert.rejects(
      () => decideTrip({ id: trip.id, decision: 'reject', reason: '', actor: pVikram, requestId: 'rej_3', ip: '127.0.0.1' }),
      (err) => err.status === 422 && err.code === 'validation_failed',
      'rejection without reason must fail'
    );
  });

  test('duplicate decision on already decided trip is rejected (409)', async () => {
    const trip = await createTrip({
      input: { destination: 'Riyadh', purpose: 'Onsite', startDate: '2026-12-10', endDate: '2026-12-12' },
      actor: pSuresh, requestId: 'dup_1', ip: '127.0.0.1',
    });
    await submitTrip({ id: trip.id, actor: pSuresh, requestId: 'dup_2', ip: '127.0.0.1' });
    await decideTrip({ id: trip.id, decision: 'approve', actor: pVikram, requestId: 'dup_3', ip: '127.0.0.1' });

    // Attempt second decision
    await assert.rejects(
      () => decideTrip({ id: trip.id, decision: 'approve', actor: pVikram, requestId: 'dup_4', ip: '127.0.0.1' }),
      (err) => err.status === 409 && err.code === 'invalid_transition',
      'duplicate decision must fail with 409'
    );
  });

  test('cannot edit a submitted or approved trip', async () => {
    const trip = await createTrip({
      input: { destination: 'Dammam', purpose: 'Customer meeting', startDate: '2026-12-15', endDate: '2026-12-16' },
      actor: pSuresh, requestId: 'edit_sub_1', ip: '127.0.0.1',
    });
    await submitTrip({ id: trip.id, actor: pSuresh, requestId: 'edit_sub_2', ip: '127.0.0.1' });

    await assert.rejects(
      () => updateTrip({ id: trip.id, input: { destination: 'Jeddah', purpose: 'New purpose', startDate: '2026-12-15', endDate: '2026-12-16' }, actor: pSuresh, requestId: 'edit_sub_3', ip: '127.0.0.1' }),
      (err) => err.status === 409 && err.code === 'invalid_transition',
      'cannot edit a submitted trip'
    );
  });

  test('cannot delete a submitted or approved expense', async () => {
    const trip = await createTrip({
      input: { destination: 'Dammam', purpose: 'Customer meeting', startDate: '2026-12-15', endDate: '2026-12-16' },
      actor: pSuresh, requestId: 'del_sub_1', ip: '127.0.0.1',
    });
    const exp = await createExpense({
      input: { tripId: trip.id, date: '2026-12-15', description: 'Fuel', category: 'transport', amount: '60.00', currency: 'SAR' },
      actor: pSuresh, requestId: 'del_sub_2', ip: '127.0.0.1',
    });
    await submitExpense({ id: exp.id, actor: pSuresh, requestId: 'del_sub_3', ip: '127.0.0.1' });

    await assert.rejects(
      () => deleteExpense({ id: exp.id, actor: pSuresh, requestId: 'del_sub_4', ip: '127.0.0.1' }),
      (err) => err.status === 409 && err.code === 'invalid_transition',
      'cannot delete a submitted expense'
    );
  });
});

describe('Audit & Transaction Integrity', () => {
  let pSuresh;

  test('setup', async () => {
    pSuresh = await resolvePrincipal(db, SURESH);
  });

  test('failed transaction rolls back both business write and audit event together', async () => {
    const beforeAuditCount = await db.one('SELECT count(*)::int AS n FROM audit_event');
    const beforeTripCount = await db.one('SELECT count(*)::int AS n FROM trip');

    // Simulate an operation that writes to trip, writes to audit, and then fails
    await assert.rejects(
      () => db.tx(async (client) => {
        await client.query(
          `INSERT INTO trip (employee_id, destination, purpose, start_date, end_date)
           VALUES ($1, 'Failed City', 'Crash test', '2026-12-01', '2026-12-05')`,
          [SURESH]
        );
        const { audit, ACTIONS } = await import('../src/audit.js');
        await audit(client, {
          actorId: SURESH,
          actorLabel: pSuresh.name,
          action: ACTIONS.TRIP_CREATE,
          entityType: 'trip',
          entityId: 'trp_will_rollback',
          newState: 'draft',
          detail: 'Should roll back',
        });
        throw new Error('Simulated failure before commit');
      }),
      /Simulated failure before commit/
    );

    const afterAuditCount = await db.one('SELECT count(*)::int AS n FROM audit_event');
    const afterTripCount = await db.one('SELECT count(*)::int AS n FROM trip');

    assert.equal(afterAuditCount.n, beforeAuditCount.n, 'audit event must roll back on failure');
    assert.equal(afterTripCount.n, beforeTripCount.n, 'trip write must roll back on failure');
  });
});
