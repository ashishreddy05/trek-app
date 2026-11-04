#!/usr/bin/env node
/* Seeding is done by migration 003, not by this script.
 *
 * Seed data is a migration so it cannot be forgotten, cannot run twice, and is
 * recorded in schema_migrations like any other schema change.
 *
 * This file exists to say so, and to verify the seed landed.
 */

import * as db from '../src/db.js';

const checks = [
  ['company',      'SELECT count(*)::int n FROM company',                       1],
  ['departments',  'SELECT count(*)::int n FROM department',                     6],
  ['cost centers', 'SELECT count(*)::int n FROM cost_center',                    6],
  ['employees',    'SELECT count(*)::int n FROM employee',                       1],
  ['accounts',     'SELECT count(*)::int n FROM account',                        1],
  ['identities',   'SELECT count(*)::int n FROM account_identity',               1],
  ['Sales active', "SELECT count(*)::int n FROM employee WHERE department_id='dep_sls' AND status='active'", 0],
];

let ok = true;
console.log('\nVerifying seed state\n');

for (const [label, sql, expected] of checks) {
  const row = await db.one(sql).catch(() => null);
  if (!row) { console.log(`  ✗ ${label}: query failed — are migrations applied?`); ok = false; continue; }
  const pass = row.n === expected;
  if (!pass) ok = false;
  console.log(`  ${pass ? '✓' : '✗'} ${label}: ${row.n}${pass ? '' : ` (expected ${expected})`}`);
}

/* The approval-route gap that blocks the pilot. Reported here because it is the
 * finding most likely to be discovered too late. */
const orphans = await db.many(
  `SELECT id, employee_code, name FROM employee
    WHERE manager_id IS NULL AND status = 'active' ORDER BY employee_code`
).catch(() => []);

if (orphans.length) {
  console.log('\n⚠ Employees with no manager — no approval route until BD-02 is signed:\n');
  for (const o of orphans) console.log(`    ${o.employee_code}  ${o.name}`);
  console.log(
    '\n  Once BD-01\'s guard is built, their own travel requests are correctly refused\n' +
    '  with 422 no_approval_route. Configure real reporting relationships before\n' +
    '  enabling travel approvals. See GATED.md.\n'
  );
}

await db.close();
process.exit(ok ? 0 : 1);
