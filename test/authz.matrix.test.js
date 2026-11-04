/* Adversarial authorization tests.
 *
 * The requirement being tested: an employee must not be able to reach another
 * employee's records by changing an id in a request.
 *
 * Table-driven over the permission matrix, not spot checks — the point is that adding
 * an operation to OPERATIONS without a scope rule makes a test fail, rather than
 * quietly shipping an open endpoint.
 *
 * Run: npm test   (requires a migrated + seeded database)
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { authorize, AuthzError, reportingTree } from '../src/authz/guard.js';
import { OPERATIONS } from '../src/authz/permissions.js';
import { resolvePrincipal } from '../src/auth/principal.js';
import * as db from '../src/db.js';

/* Seeded pilot employees (003_seed_master_data.sql). */
const SURESH = 'emp_1231';   // Sales employee, reports to Vikram
const NADIA  = 'emp_1232';   // Sales employee, peer of Suresh
const VIKRAM = 'emp_1001';   // VP Sales — manager of both, no manager himself
const RAVI   = 'emp_1002';   // Finance
const SARA   = 'emp_1004';   // HR / Travel
const ASHISH  = 'emp_1000';   // Admin

let P = {};

before(async () => {
  for (const [k, id] of Object.entries({ SURESH, NADIA, VIKRAM, RAVI, SARA, ASHISH })) {
    P[k] = await resolvePrincipal(db, id);
    assert.ok(P[k], `principal ${k} (${id}) must resolve — is the database seeded?`);
  }
  assert.equal(P.ASHISH.email, 'ashishreddy@garageplug.com');
  assert.ok(P.ASHISH.roles.includes('admin'), 'the temporary bootstrap account must be an admin');
});

after(async () => { await db.close(); });

async function denied(principal, operation, target) {
  await assert.rejects(
    () => authorize(db, principal, operation, target),
    (err) => {
      assert.ok(err instanceof AuthzError, `expected AuthzError, got ${err?.constructor?.name}`);
      assert.ok([403, 404].includes(err.status), `expected 403/404, got ${err.status}`);
      return true;
    },
    `${principal.name} must NOT be able to ${operation} on ${JSON.stringify(target)}`
  );
}

async function allowed(principal, operation, target) {
  const result = await authorize(db, principal, operation, target);
  assert.ok(result.scope, `${principal.name} should be able to ${operation}`);
  return result;
}

/* ------------------------------------------------------------------ id substitution */

describe('id substitution — the core adversarial case', () => {
  test('an employee cannot read a peer by substituting their id', async () => {
    await denied(P.SURESH, 'employee.read', { employeeId: NADIA, type: 'employee', id: NADIA });
  });

  test('an employee cannot read their own manager by substituting their id', async () => {
    await denied(P.SURESH, 'employee.read', { employeeId: VIKRAM, type: 'employee', id: VIKRAM });
  });

  test('an employee cannot read Finance by substituting their id', async () => {
    await denied(P.SURESH, 'employee.read', { employeeId: RAVI, type: 'employee', id: RAVI });
  });

  test('an employee CAN read their own record', async () => {
    const r = await allowed(P.SURESH, 'employee.read', { employeeId: SURESH });
    assert.equal(r.scope, 'own');
  });

  test('out-of-scope denial is opaque — 404, not 403, so ids are not an oracle', async () => {
    await assert.rejects(
      () => authorize(db, P.SURESH, 'employee.read', { employeeId: NADIA }),
      (err) => {
        assert.equal(err.status, 404, 'must be indistinguishable from a nonexistent record');
        return true;
      }
    );
  });

  test('a denial for a NONEXISTENT id is identical to one for an out-of-scope id', async () => {
    const a = await authorize(db, P.SURESH, 'employee.read', { employeeId: 'emp_nope' }).catch((e) => e);
    const b = await authorize(db, P.SURESH, 'employee.read', { employeeId: NADIA }).catch((e) => e);
    assert.equal(a.status, b.status);
    assert.equal(a.code, b.code);
    assert.equal(a.message, b.message);
  });
});

/* ------------------------------------------------------------------ team scope */

describe('team scope is the reporting tree, not the department', () => {
  test('a manager can read a direct report', async () => {
    const r = await allowed(P.VIKRAM, 'employee.read', { employeeId: SURESH });
    assert.ok(['team', 'all'].includes(r.scope));
  });

  test('the reporting tree contains all five Sales travellers', async () => {
    const tree = await reportingTree(db, VIKRAM);
    for (const id of [SURESH, NADIA, 'emp_1233', 'emp_1234', 'emp_1235']) {
      assert.ok(tree.has(id), `${id} should be in Vikram's reporting tree`);
    }
  });

  test('the reporting tree excludes the manager themselves', async () => {
    const tree = await reportingTree(db, VIKRAM);
    assert.ok(!tree.has(VIKRAM));
  });

  test('a manager cannot read someone outside their tree who shares no reporting line', async () => {
    await denied(P.VIKRAM, 'employee.read', { employeeId: ASHISH, type: 'employee', id: ASHISH });
  });

  test('sharing a department does not grant access — peers cannot read each other', async () => {
    // Suresh and Nadia are both Sales, both CC-SLS-01. Neither manages the other.
    await denied(P.SURESH, 'employee.read', { employeeId: NADIA });
    await denied(P.NADIA, 'employee.read', { employeeId: SURESH });
  });
});

/* ------------------------------------------------------------------ rule 5 */

describe('a filter parameter is not authorization', () => {
  test('requesting a scope you lack is 403, never a quietly empty result', async () => {
    await denied(P.SURESH, 'employee.list', { scope: 'all' });
    await denied(P.SURESH, 'employee.list', { scope: 'team' });
  });

  test('an undeclared scope is refused rather than ignored', async () => {
    await denied(P.VIKRAM, 'employee.list', { scope: 'everything' });
  });

  test('a manager requesting team scope gets it, with the tree resolved', async () => {
    const r = await allowed(P.VIKRAM, 'employee.list', { scope: 'team' });
    assert.equal(r.scope, 'team');
    assert.ok(r.team instanceof Set);
  });
});

/* ------------------------------------------------------------------ deny by default */

describe('deny by default', () => {
  test('an undeclared operation is denied, not passed through', async () => {
    await denied(P.ASHISH, 'employee.deleteEverything', {});
  });

  test('every declared operation has either public:true or a scopes map', () => {
    for (const [name, spec] of Object.entries(OPERATIONS)) {
      assert.ok(
        spec.public === true || (spec.scopes && Object.keys(spec.scopes).length > 0),
        `operation "${name}" declares neither public:true nor any scope — it would fail closed, ` +
        'but the omission is almost certainly a mistake'
      );
    }
  });

  test('an unauthenticated caller is 401 on any non-public operation', async () => {
    await assert.rejects(
      () => authorize(db, null, 'employee.read', { employeeId: SURESH }),
      (err) => { assert.equal(err.status, 401); return true; }
    );
  });
});

/* ------------------------------------------------------------------ role boundaries */

describe('role boundaries', () => {
  test('HR/Travel has NO expense access — deliberate', () => {
    assert.ok(!P.SARA.permissions.includes('expense.read.all'));
    assert.ok(!P.SARA.permissions.includes('expense.review'));
  });

  test('Admin is NOT an approver — configuration is not authority', () => {
    assert.ok(!P.ASHISH.permissions.includes('trip.approve'));
    assert.ok(!P.ASHISH.permissions.includes('expense.approve'));
  });

  test('Finance cannot manage employees', () => {
    assert.ok(!P.RAVI.permissions.includes('employee.manage'));
  });

  test('only Admin holds audit.read', () => {
    assert.ok(P.ASHISH.permissions.includes('audit.read'));
    for (const k of ['SURESH', 'VIKRAM', 'RAVI', 'SARA']) {
      assert.ok(!P[k].permissions.includes('audit.read'), `${k} must not read the audit log`);
    }
  });

  test('an Admin cannot change their own roles — no self-escalation', async () => {
    await denied(P.ASHISH, 'employee.updateRoles', { employeeId: ASHISH });
  });

  test('an Admin CAN change someone else\'s roles', async () => {
    await allowed(P.ASHISH, 'employee.updateRoles', { employeeId: SURESH });
  });
});

/* ------------------------------------------------------------------ implicit manager */

describe('the implicit manager role', () => {
  test('Vikram is a manager and holds trip.approve', () => {
    assert.ok(P.VIKRAM.roles.includes('manager'));
    assert.ok(P.VIKRAM.permissions.includes('trip.approve'));
  });

  test('an employee with no direct reports is not an implicit manager', () => {
    assert.equal(P.SURESH.isImplicitManager, false);
    assert.ok(!P.SURESH.permissions.includes('trip.approve'));
  });
});

/* ------------------------------------------------------------------ surface */

describe('landing surface is server-derived', () => {
  test('precedence: admin > finance > hr_travel > manager > employee', () => {
    assert.equal(P.ASHISH.surface, 'admin');
    assert.equal(P.RAVI.surface, 'finance');
    assert.equal(P.SARA.surface, 'hr_travel');
    assert.equal(P.VIKRAM.surface, 'manager');
    assert.equal(P.SURESH.surface, 'employee');
  });
});

/* ------------------------------------------------------------------ gated */

describe('gated operations are absent, not stubbed', () => {
  test('trip, expense and settlement operations are not declared yet', () => {
    for (const op of ['trip.create', 'trip.submit', 'approval.decide', 'expense.create', 'settlement.post']) {
      assert.equal(
        OPERATIONS[op], undefined,
        `"${op}" must stay undeclared until its blocking decision is signed (see GATED.md) — ` +
        'declaring it early means guessing at a scope rule'
      );
    }
  });
});
