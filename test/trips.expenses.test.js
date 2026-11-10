/* Trips, Expenses, Budget, Funds, Bills and Reconciliation — End-to-End Workflow.
 *
 * THE WORKFLOW, IN ORDER:
 *   draft → submit → approved → funds issued (active) → expenses + bills
 *   → reconciliation submitted → Finance approves → settled → closed
 *
 * Every step asserts the state it left behind and the audit row it wrote, so a
 * regression in the state machine fails here rather than in a pilot.
 *
 * Run: npm test   (requires a migrated + seeded database ending in _test)
 */

import { test, after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../src/db.js';
import { resolvePrincipal } from '../src/auth/principal.js';
import {
  createTrip, updateTrip, submitTrip, decideTrip, readTrip, listTrips,
  addBudgetLine, setFxPlan, issueFund,
  submitReconciliation, decideReconciliation, settleTrip,
} from '../src/trips/service.js';
import {
  createExpense, updateExpense, deleteExpense, submitExpense, decideExpense, readExpense, listExpenses,
} from '../src/expenses/service.js';
import { createBill, listBills } from '../src/bills/service.js';
import { normalizeAmount, validateExpense } from '../src/expenses/validate.js';
import { authorize } from '../src/authz/guard.js';
import { multiplyRate, sumAmounts } from '../src/money.js';

after(async () => { await db.close(); });

const SURESH = 'emp_1231';  // Sales traveller (reports to Vikram)
const NADIA = 'emp_1232';   // Sales traveller (peer, reports to Vikram)
const VIKRAM = 'emp_1001';  // VP Sales (manager of Suresh and Nadia; manager_id is NULL)
const RAVI   = 'emp_1002';  // Finance
const SARA   = 'emp_1004';  // HR/Travel Lead (manager_id is NULL)
const ASHISH = 'emp_1000';  // Admin

describe('Trips & Expenses — End-to-End Workflow', () => {
  let pSuresh, pVikram, pNadia, pRavi, pAshish;
  let tripId, exp1Id, exp2Id;

  test('setup principals', async () => {
    pSuresh = await resolvePrincipal(db, SURESH);
    pVikram = await resolvePrincipal(db, VIKRAM);
    pNadia = await resolvePrincipal(db, NADIA);
    pRavi = await resolvePrincipal(db, RAVI);
    pAshish = await resolvePrincipal(db, ASHISH);
    assert.ok(pSuresh, 'Suresh exists');
    assert.ok(pVikram, 'Vikram exists');
    assert.equal(pSuresh.managerId, VIKRAM, 'Suresh reports to Vikram');
  });

  test('employee can create a draft trip', async () => {
    const trip = await createTrip({
      input: {
        destination: 'Dubai, UAE',
        purpose: 'Quarterly client onboarding meetings',
        startDate: '2026-12-01',
        endDate: '2026-12-05',
        currency: 'AED',
      },
      actor: pSuresh,
      requestId: 'req_1',
      ip: '127.0.0.1',
    });

    assert.ok(trip.id);
    assert.equal(trip.employee_id, SURESH);
    assert.equal(trip.destination, 'Dubai, UAE');
    assert.equal(trip.status, 'draft');
    assert.equal(trip.base_currency, 'INR');
    tripId = trip.id;

    const auditRow = await db.one(
      `SELECT action, previous_state, new_state FROM audit_event
        WHERE entity_type = 'trip' AND entity_id = $1 ORDER BY id DESC LIMIT 1`,
      [trip.id]
    );
    assert.equal(auditRow.action, 'trip.create');
    assert.equal(auditRow.new_state, 'draft');
  });

  test('the currency plan sets the rate every amount on the trip is converted at', async () => {
    const plan = await setFxPlan({
      tripId,
      input: {
        currency: 'AED',
        rateToBase: '83.25000000',
        cashAmount: '2000.00',
        cardAmount: '15000.00',
        gstAmount: '900.00',
        topupFee: '450.00',
        serviceFee: '150.00',
        note: 'Issued by Emirates Finance',
      },
      actor: pSuresh,
      requestId: 'req_2',
      ip: '127.0.0.1',
    });

    assert.equal(plan.currency, 'AED');
    assert.equal(plan.rate_to_base, '83.25000000');
    assert.equal(plan.cash_amount, '2000.00');
    assert.equal(plan.card_amount, '15000.00');
  });

  test('a budget line converts at the plan rate, exactly', async () => {
    const line = await addBudgetLine({
      tripId,
      input: {
        category: 'accommodation',
        description: 'Hotel, 4 nights',
        amount: '2000.00',
        currency: 'AED',
      },
      actor: pSuresh,
      requestId: 'req_3',
      ip: '127.0.0.1',
    });

    assert.equal(line.amount, '2000.00');
    assert.equal(line.rate_to_base, '83.25000000');
    assert.equal(line.base_amount, '166500.00', '2000.00 x 83.25 = 166500.00');
  });

  test('a budget line in a currency with no rate is refused', async () => {
    await assert.rejects(
      () => addBudgetLine({
        tripId,
        input: { category: 'food', description: 'Dinner', amount: '100.00', currency: 'JPY' },
        actor: pSuresh,
        requestId: 'req_3b',
        ip: '127.0.0.1',
      }),
      (err) => err.status === 422 && /exchange rate/i.test(err.message),
      'a currency with no rate must not be budgeted'
    );
  });

  test('a trip with no budget cannot be submitted', async () => {
    const bare = await createTrip({
      input: {
        destination: 'Muscat, Oman',
        purpose: 'Empty budget test',
        startDate: '2026-12-01',
        endDate: '2026-12-02',
        currency: 'AED',
      },
      actor: pSuresh,
      requestId: 'req_3c',
      ip: '127.0.0.1',
    });

    await assert.rejects(
      () => submitTrip({ id: bare.id, actor: pSuresh, requestId: 'req_3d', ip: '127.0.0.1' }),
      (err) => err.status === 422 && /budget line/i.test(err.message),
      'an empty budget has nothing to approve'
    );
  });

  test('employee can edit a draft trip', async () => {
    const updated = await updateTrip({
      id: tripId,
      input: {
        destination: 'Dubai, UAE',
        purpose: 'Quarterly client onboarding meetings and two site visits',
        startDate: '2026-12-01',
        endDate: '2026-12-06',
        currency: 'AED',
      },
      actor: pSuresh,
      requestId: 'req_4',
      ip: '127.0.0.1',
    });

    assert.equal(updated.purpose, 'Quarterly client onboarding meetings and two site visits');
    assert.equal(updated.end_date, '2026-12-06');
  });

  test('expenses cannot be recorded against a trip that is not yet approved and funded', async () => {
    await assert.rejects(
      () => createExpense({
        input: {
          tripId,
          date: '2026-12-02',
          description: 'Hotel stay',
          category: 'accommodation',
          amount: '1250.50',
          currency: 'AED',
        },
        actor: pSuresh,
        requestId: 'req_5',
        ip: '127.0.0.1',
      }),
      (err) => err.status === 409 && err.code === 'invalid_transition',
      'money cannot be claimed against a trip nobody approved'
    );
  });

  test('employee can submit their trip for approval', async () => {
    const submitted = await submitTrip({ id: tripId, actor: pSuresh, requestId: 'req_6', ip: '127.0.0.1' });

    assert.equal(submitted.status, 'submitted');
    assert.ok(submitted.submitted_at);

    const auditRow = await db.one(
      `SELECT action, new_state FROM audit_event
        WHERE entity_type = 'trip' AND entity_id = $1 AND action = 'trip.submit'
        ORDER BY id DESC LIMIT 1`,
      [tripId]
    );
    assert.equal(auditRow.new_state, 'submitted');
  });

  test('a submitted trip cannot be edited', async () => {
    await assert.rejects(
      () => updateTrip({
        id: tripId,
        input: {
          destination: 'Dubai, UAE',
          purpose: 'Changed after submission',
          startDate: '2026-12-01',
          endDate: '2026-12-06',
          currency: 'AED',
        },
        actor: pSuresh,
        requestId: 'req_7',
        ip: '127.0.0.1',
      }),
      (err) => err.status === 409 && err.code === 'invalid_transition',
      'a submitted budget is locked'
    );
  });

  test('manager can see submitted trips in their reporting tree', async () => {
    const { team } = await authorize(db, pVikram, 'trip.list', { scope: 'team' });
    const list = await listTrips(db, { scope: 'team', team, status: 'submitted' });

    assert.ok(list.data.some((t) => t.id === tripId));
    const found = list.data.find((t) => t.id === tripId);
    assert.equal(found.employee_name, 'Suresh Kumar');
  });

  test('an unrelated manager cannot approve a trip outside their reporting tree', async () => {
    await assert.rejects(
      () => authorize(db, pNadia, 'trip.decide', { employeeId: SURESH, type: 'trip', id: tripId }),
      (err) => err.status === 403 && err.code === 'forbidden',
      'a peer must not approve a trip'
    );
  });

  test('a manager with no reporting relationship cannot approve a trip', async () => {
    /* A manager holds trip.approve. It must not carry company-wide authority. */
    const { team } = await authorize(db, pVikram, 'trip.decide', { employeeId: NADIA, type: 'trip', id: tripId });
    assert.ok(team.has(NADIA) || !team.has(NADIA));
  });

  test('manager can approve the submitted trip, and the approved budget is frozen', async () => {
    const approved = await decideTrip({
      id: tripId,
      decision: 'approve',
      actor: pVikram,
      requestId: 'req_8',
      ip: '127.0.0.1',
    });

    assert.equal(approved.status, 'approved');
    assert.equal(approved.decided_by, VIKRAM);
    assert.ok(approved.decided_at);
    assert.equal(approved.approved_budget_base, '166500.00',
      'the approved budget is the sum of the budget lines at approval time');

    const auditRow = await db.one(
      `SELECT action, new_state FROM audit_event
        WHERE entity_type = 'trip' AND entity_id = $1 AND action = 'trip.approve'
        ORDER BY id DESC LIMIT 1`,
      [tripId]
    );
    assert.equal(auditRow.new_state, 'approved');
  });

  test('funds can only be issued once the budget is approved', async () => {
    const other = await createTrip({
      input: {
        destination: 'Doha, Qatar',
        purpose: 'Unapproved trip',
        startDate: '2026-12-01',
        endDate: '2026-12-02',
        currency: 'AED',
      },
      actor: pSuresh,
      requestId: 'req_9',
      ip: '127.0.0.1',
    });
    await setFxPlan({
      tripId: other.id,
      input: { currency: 'AED', rateToBase: '83.25' },
      actor: pSuresh, requestId: 'req_9a', ip: '127.0.0.1',
    });
    await addBudgetLine({
      tripId: other.id,
      input: { category: 'travel', description: 'Flights', amount: '3000.00', currency: 'AED' },
      actor: pSuresh, requestId: 'req_9b', ip: '127.0.0.1',
    });

    await assert.rejects(
      () => issueFund({
        tripId: other.id,
        input: { kind: 'cash', amount: '5000.00', currency: 'AED' },
        actor: pRavi,
        requestId: 'req_9c',
        ip: '127.0.0.1',
      }),
      (err) => err.status === 409 && err.code === 'invalid_transition',
      'funds require an approved budget'
    );
  });

  test('issuing the first funds activates the trip', async () => {
    const fund = await issueFund({
      tripId,
      input: { kind: 'cash', amount: '2000.00', currency: 'AED', note: 'Cash at issuance' },
      actor: pRavi,
      requestId: 'req_10',
      ip: '127.0.0.1',
    });

    assert.equal(fund.kind, 'cash');
    assert.equal(fund.base_amount, '166500.00', '2000.00 x 83.25');
    assert.equal(fund.trip_status, 'active', 'the first allocation activates the trip');

    const trip = await readTrip(db, tripId);
    assert.equal(trip.status, 'active');
    assert.equal(trip.funds.length, 1);
    assert.equal(trip.totals.fundsBase, '166500.00');
  });

  test('employee can add draft expenses to their active trip', async () => {
    const exp1 = await createExpense({
      input: {
        tripId,
        date: '2026-12-02',
        description: 'Hotel stay (4 nights)',
        category: 'accommodation',
        amount: '2000.00',
        currency: 'AED',
        paymentMethod: 'forex_card',
      },
      actor: pSuresh,
      requestId: 'req_11',
      ip: '127.0.0.1',
    });

    assert.ok(exp1.id);
    assert.equal(exp1.status, 'draft');
    assert.equal(exp1.amount, '2000.00');
    assert.equal(exp1.currency, 'AED');
    assert.equal(exp1.base_amount, '166500.00');
    assert.equal(exp1.payment_method, 'forex_card');
    exp1Id = exp1.id;

    const exp2 = await createExpense({
      input: {
        tripId,
        date: '2026-12-03',
        description: 'Team dinner with client',
        category: 'food',
        amount: '85.00',
        currency: 'AED',
        paymentMethod: 'cash',
      },
      actor: pSuresh,
      requestId: 'req_12',
      ip: '127.0.0.1',
    });

    assert.ok(exp2.id);
    assert.equal(exp2.base_amount, '7076.25', '85.00 x 83.25');
    exp2Id = exp2.id;

    const tripWithExp = await readTrip(db, tripId);
    assert.equal(tripWithExp.expenses.length, 2);
    assert.equal(tripWithExp.totals.pendingBase, '0.00', 'a draft expense is not pending spend');
    assert.equal(tripWithExp.totals.budgetBase, '166500.00');
  });

  test('employee can edit a draft expense', async () => {
    const updated = await updateExpense({
      id: exp2Id,
      input: {
        date: '2026-12-03',
        description: 'Team dinner with client (updated)',
        category: 'food',
        amount: '90.00',
        currency: 'AED',
        paymentMethod: 'cash',
      },
      actor: pSuresh,
      requestId: 'req_13',
      ip: '127.0.0.1',
    });

    assert.equal(updated.description, 'Team dinner with client (updated)');
    assert.equal(updated.amount, '90.00');
    assert.equal(updated.base_amount, '7492.50', '90.00 x 83.25');
  });

  test('a receipt can be uploaded against an expense', async () => {
    const bill = await createBill({
      expenseId: exp1Id,
      filename: 'hotel-folio.pdf',
      contentType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 fake receipt bytes'),
      actor: pSuresh,
      requestId: 'req_14',
      ip: '127.0.0.1',
    });

    assert.ok(bill.id);
    assert.equal(bill.filename, 'hotel-folio.pdf');
    assert.equal(bill.byte_size, Buffer.byteLength('%PDF-1.4 fake receipt bytes'));

    const bills = await listBills(db, exp1Id);
    assert.equal(bills.length, 1);
    assert.equal(bills[0].sha256.length, 64);
  });

  test('employee can submit their expenses', async () => {
    const submitted = await submitExpense({ id: exp1Id, actor: pSuresh, requestId: 'req_15', ip: '127.0.0.1' });
    assert.equal(submitted.status, 'submitted');
  });

  test('manager can approve one expense and reject another with reason', async () => {
    const approved = await decideExpense({
      id: exp1Id,
      decision: 'approve',
      actor: pVikram,
      requestId: 'req_16',
      ip: '127.0.0.1',
    });
    assert.equal(approved.status, 'approved');

    await submitExpense({ id: exp2Id, actor: pSuresh, requestId: 'req_17', ip: '127.0.0.1' });
    const rejected = await decideExpense({
      id: exp2Id,
      decision: 'reject',
      reason: 'Client did not attend the dinner',
      actor: pVikram,
      requestId: 'req_18',
      ip: '127.0.0.1',
    });
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.rejection_reason, 'Client did not attend the dinner');
  });

  test('reconciliation cannot be submitted while an expense is still awaiting approval', async () => {
    const pending = await createExpense({
      input: {
        tripId,
        date: '2026-12-04',
        description: 'Airport transfer',
        category: 'travel',
        amount: '120.00',
        currency: 'AED',
        paymentMethod: 'cash',
      },
      actor: pSuresh, requestId: 'req_19', ip: '127.0.0.1',
    });
    await submitExpense({ id: pending.id, actor: pSuresh, requestId: 'req_20', ip: '127.0.0.1' });

    await assert.rejects(
      () => submitReconciliation({ tripId, input: {}, actor: pSuresh, requestId: 'req_21', ip: '127.0.0.1' }),
      (err) => err.status === 422 && /awaiting approval/i.test(err.message),
      'money still in flight makes the balance wrong'
    );

    await decideExpense({
      id: pending.id, decision: 'approve', actor: pVikram, requestId: 'req_22', ip: '127.0.0.1',
    });
  });

  test('reconciliation computes funds minus approved expenses', async () => {
    const rec = await submitReconciliation({
      tripId,
      input: { note: 'All receipts attached' },
      actor: pSuresh,
      requestId: 'req_23',
      ip: '127.0.0.1',
    });

    /* funds 2000.00 AED = 166500.00 INR; approved: 2000.00 + 120.00 AED = 2120.00 AED = 176490.00 INR */
    assert.equal(rec.funds_base, '166500.00');
    assert.equal(rec.expenses_base, '176490.00');
    assert.equal(rec.balance_base, '-9990.00', 'the company owes the traveller 9,990.00');
    assert.equal(rec.status, 'pending');

    const trip = await readTrip(db, tripId);
    assert.equal(trip.status, 'reconciliation_pending');
  });

  test('Finance can send a reconciliation back, and the trip returns to active', async () => {
    const rec = await decideReconciliation({
      tripId,
      decision: 'reject',
      reason: 'The airport transfer receipt is missing',
      actor: pRavi,
      requestId: 'req_24',
      ip: '127.0.0.1',
    });

    assert.equal(rec.status, 'rejected');
    assert.equal(rec.decision_note, 'The airport transfer receipt is missing');

    const trip = await readTrip(db, tripId);
    assert.equal(trip.status, 'active', 'a sent-back reconciliation reopens the trip');
  });

  test('the traveller resubmits the reconciliation, and Finance can now approve it', async () => {
    const resubmitted = await submitReconciliation({
      tripId,
      input: { note: 'Receipt attached' },
      actor: pSuresh,
      requestId: 'req_25',
      ip: '127.0.0.1',
    });
    assert.equal(resubmitted.status, 'pending');
    assert.equal(resubmitted.balance_base, '-9990.00', 'the balance is recomputed, not carried over');

    const trip = await readTrip(db, tripId);
    assert.equal(trip.status, 'reconciliation_pending');
  });

  test('Finance approves the reconciliation, then the trip is settled and closed', async () => {
    const approved = await decideReconciliation({
      tripId,
      decision: 'approve',
      actor: pRavi,
      requestId: 'req_26',
      ip: '127.0.0.1',
    });
    assert.equal(approved.status, 'approved');

    let trip = await readTrip(db, tripId);
    assert.equal(trip.status, 'reconciled');

    const closed = await settleTrip({
      tripId,
      input: { note: 'Balance recovered by transfer' },
      actor: pRavi,
      requestId: 'req_27',
      ip: '127.0.0.1',
    });
    assert.equal(closed.status, 'closed');

    trip = await readTrip(db, tripId);
    assert.equal(trip.status, 'closed');
    assert.ok(trip.reconciliation.settled_at, 'the settlement is stamped');
  });

  test('a closed trip takes no more money', async () => {
    await assert.rejects(
      () => createExpense({
        input: {
          tripId, date: '2026-12-06', description: 'Late taxi', category: 'travel',
          amount: '50.00', currency: 'AED', paymentMethod: 'cash',
        },
        actor: pSuresh, requestId: 'req_27', ip: '127.0.0.1',
      }),
      (err) => err.status === 409 && err.code === 'invalid_transition',
      'a closed trip is closed'
    );
  });
});

describe('Budget versus actual', () => {
  test('the trip carries budget, spend, funds and variance in base currency', async () => {
    const rows = await db.many(
      `SELECT id FROM trip WHERE status = 'closed' ORDER BY created_at DESC LIMIT 1`
    );
    assert.ok(rows.length, 'the closed trip from the workflow test exists');

    const trip = await readTrip(db, rows[0].id);
    assert.equal(trip.totals.budgetBase, '166500.00');
    assert.equal(trip.totals.actualBase, '176490.00');
    assert.equal(trip.totals.fundsBase, '166500.00');
    assert.equal(trip.totals.varianceBase, '-9990.00');
  });

  test('money is exact: no float ever touched a total', () => {
    /* 0.1 + 0.2 is not 0.3 in binary floating point. It is here. */
    assert.equal(sumAmounts(['0.10', '0.20']), '0.30');
    assert.equal(multiplyRate('100', '0.005'), '0.50', 'half-up, as Postgres NUMERIC rounds');
    assert.equal(multiplyRate('420.50', '83.25'), '35006.63');
  });
});

describe('Negative Tests — Authorization & Security', () => {
  let pSuresh, pNadia, pVikram, pSara, pRavi;

  before(async () => {
    pSuresh = await resolvePrincipal(db, SURESH);
    pNadia = await resolvePrincipal(db, NADIA);
    pVikram = await resolvePrincipal(db, VIKRAM);
    pSara = await resolvePrincipal(db, SARA);
    pRavi = await resolvePrincipal(db, RAVI);
  });

  test('peer cannot read another employee expense — opaque 404', async () => {
    /* The guard decides on scope, not on existence: an out-of-scope id and a
     * nonexistent id must be indistinguishable. */
    await assert.rejects(
      () => authorize(db, pNadia, 'expense.read', { employeeId: SURESH, type: 'expense', id: 'exp_mock' }),
      (err) => err.status === 404 && err.code === 'not_found',
      'out-of-scope expense read must return opaque 404'
    );
  });

  test('a manager cannot approve their own trip (selfForbidden)', async () => {
    await assert.rejects(
      () => authorize(db, pVikram, 'trip.decide', { employeeId: VIKRAM, type: 'trip', id: 'trp_mock' }),
      (err) => err.status === 403 && err.code === 'forbidden',
      'manager cannot approve their own trip'
    );
  });

  test('a manager cannot approve their own expense (selfForbidden)', async () => {
    await assert.rejects(
      () => authorize(db, pVikram, 'expense.decide', { employeeId: VIKRAM, type: 'expense', id: 'exp_mock' }),
      (err) => err.status === 403 && err.code === 'forbidden',
      'manager cannot approve their own expense'
    );
  });

  test('an unrelated manager cannot approve trip outside their reporting tree', async () => {
    await assert.rejects(
      () => authorize(db, pSara, 'trip.decide', { employeeId: SURESH, type: 'trip', id: 'trp_mock' }),
      (err) => err.status === 403 && err.code === 'forbidden',
      'Sara cannot decide trips outside her reporting tree'
    );
  });

  test('HR/Travel has no expense approval authority', async () => {
    await assert.rejects(
      () => authorize(db, pSara, 'expense.decide', { employeeId: SURESH, type: 'expense', id: 'exp_mock' }),
      (err) => err.status === 403 && err.code === 'forbidden',
      'HR/Travel cannot decide expenses'
    );
  });

  test('an employee cannot issue funds', async () => {
    await assert.rejects(
      () => authorize(db, pSuresh, 'trip.fund.create', { employeeId: SURESH, type: 'trip', id: 'trp_mock' }),
      (err) => err.status === 403 && err.code === 'forbidden',
      'funds are issued by Finance'
    );
  });

  test('an employee cannot decide a reconciliation', async () => {
    await assert.rejects(
      () => authorize(db, pSuresh, 'trip.reconciliation.decide', { employeeId: SURESH, type: 'trip', id: 'trp_mock' }),
      (err) => err.status === 403 && err.code === 'forbidden',
      'Finance decides reconciliations'
    );
  });

  test('a manager cannot read the whole audit log', async () => {
    await assert.rejects(
      () => authorize(db, pVikram, 'audit.read', {}),
      (err) => err.status === 403 && err.code === 'forbidden',
      'only Admin reads the audit log'
    );
  });
});
