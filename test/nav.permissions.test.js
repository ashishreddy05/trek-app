/* The nav must match the permission matrix.
 *
 * The client decides which screens to offer by checking permission strings,
 * and the server decides what those strings grant. When the two disagree the
 * failure is silent and insulting: the API refuses with 403 while the person
 * is told the screen does not exist.
 *
 * That is not hypothetical. `trip.approve` and `trip.approve.all` are
 * different permissions on purpose — the first is a manager's team tier, the
 * second the company tier. An admin or a finance user holds only the second,
 * so a nav that checked only the first hid Approvals from exactly the people
 * who can use it.
 *
 * These tests read the real client and the real matrix, so the pair cannot
 * drift apart without the build failing.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PERMISSIONS_BY_ROLE } from '../src/authz/permissions.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const client = await readFile(join(ROOT, 'public/app.js'), 'utf8');

/* The permission strings a nav gate tests for.
 *
 * The gate is the `if (has(...))` that guards the nav item, so read backwards
 * from the push to the enclosing condition. A gate may be a block
 * (`if (...) { ... }`) or a one-liner (`if (...) items.push(...)`), and the
 * condition may wrap over several lines — so the condition is bounded by the
 * parenthesis that closes it. */
function gatesFor(navItem) {
  const pushAt = client.indexOf(`{ key: '${navItem}'`);
  assert.ok(pushAt > -1, `the nav must offer "${navItem}"`);
  const before = client.slice(0, pushAt);
  const condStart = before.lastIndexOf('if (');
  assert.ok(condStart > -1, `the nav must gate "${navItem}" on a permission`);

  let depth = 0;
  let end = condStart;
  for (; end < before.length; end++) {
    if (before[end] === '(') depth++;
    else if (before[end] === ')') { depth--; if (depth === 0) break; }
  }
  const cond = before.slice(condStart, end + 1);
  return [...cond.matchAll(/has\('([a-z.]+)'\)/g)].map((m) => m[1]);
}

/* Every permission the matrix can grant. */
const allPermissions = new Set(Object.values(PERMISSIONS_BY_ROLE).flat());

/* The roles a set of permissions admits. */
const rolesHolding = (perms) => Object.entries(PERMISSIONS_BY_ROLE)
  .filter(([, held]) => perms.some((p) => held.includes(p)))
  .map(([role]) => role)
  .sort();

describe('the nav offers what the permissions allow', () => {
  test('Approvals is offered to every role that can approve', () => {
    /* Both tiers count: a manager approves within their tree, an admin or a
     * finance user approves anywhere. Checking only the team tier hides the
     * screen from the company tier. */
    const gates = gatesFor('approvals');
    assert.ok(gates.includes('trip.approve'), 'the team tier must be checked');
    assert.ok(gates.includes('trip.approve.all'), 'the company tier must be checked too');
    assert.ok(gates.includes('expense.approve.all'), 'expenses are approved company-wide too');

    /* Exactly the roles that can approve — no more, no fewer. */
    const canApprove = rolesHolding(['trip.approve', 'trip.approve.all', 'expense.approve', 'expense.approve.all']);
    assert.deepEqual(rolesHolding(gates), canApprove);
    assert.deepEqual(canApprove, ['admin', 'finance', 'manager']);
  });

  test('every permission the nav checks exists in the matrix', () => {
    const checked = [...client.matchAll(/has\('([a-z.]+)'\)/g)].map((m) => m[1]);
    assert.ok(checked.length > 0, 'expected the nav to check permissions');
    for (const perm of checked) {
      assert.ok(allPermissions.has(perm), `the nav checks "${perm}", which no role holds`);
    }
  });

  test('the audit log is offered exactly to the roles that can read it', () => {
    const gates = gatesFor('audit');
    assert.deepEqual(gates, ['audit.read'], 'the gate must check audit.read and nothing else');
    assert.deepEqual(rolesHolding(gates), rolesHolding(['audit.read']));
  });

  test('each nav screen is gated on a permission its viewers hold', () => {
    /* A screen nobody but one role can use must be gated on that role's
     * permission — otherwise it is offered to everyone. The two admin screens
     * share one gate, which is deliberate: they are one job. */
    for (const [item, permission] of [['employees', 'employee.manage'], ['departments', 'employee.manage']]) {
      const gates = gatesFor(item);
      assert.ok(gates.includes(permission), `"${item}" must be gated on ${permission}`);
      assert.deepEqual(
        rolesHolding(gates), rolesHolding([permission]),
        `"${item}" must be offered to exactly the roles that hold ${permission}`
      );
    }

    /* The dashboard is the one screen several roles legitimately share. */
    const dash = gatesFor('dashboard');
    assert.deepEqual(
      rolesHolding(dash), rolesHolding(['report.team', 'report.finance', 'report.all'])
    );
  });
});
