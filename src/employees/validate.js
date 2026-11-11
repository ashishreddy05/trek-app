/* Employee validation.
 *
 * Every rule and every message here comes from TREK-DEVELOPER-HANDOFF.md §6 and the
 * approved prototype. Messages are user-facing approved copy — do not reword them.
 *
 * Nothing in this file is a business decision: the rules were specified, and the
 * uniqueness/cycle checks are mechanical.
 */

import { passwordProblem } from '../auth/password-policy.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GRADES = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6'];
const ROLES = ['employee', 'manager', 'hr_travel', 'finance', 'admin'];

const REQUIRED = [
  ['employeeCode', 'Employee code is required'],
  ['name', 'Name is required'],
  ['workEmail', 'Work email is required'],
  ['departmentId', 'Department is required'],
  ['designation', 'Designation is required'],
];

export class ValidationError extends Error {
  constructor(fields, message = 'Please correct the highlighted fields.') {
    super(message);
    this.status = 422;
    this.code = 'validation_failed';
    this.fields = fields;
  }
}

/**
 * @param {object} db      transaction client
 * @param {object} input   candidate employee
 * @param {string|null} existingId  set when updating, so uniqueness excludes self
 */
export async function validateEmployee(db, input, existingId = null) {
  const fields = {};

  for (const [key, msg] of REQUIRED) {
    const v = input[key];
    if (v === undefined || v === null || String(v).trim() === '') fields[key] = msg;
  }

  if (input.workEmail && !EMAIL_RE.test(String(input.workEmail).trim())) {
    fields.workEmail = 'Enter a valid work email address';
  }

  if (input.password) {
    const prob = passwordProblem(input.password, { email: input.workEmail, name: input.name });
    if (prob) fields.password = prob;
  }

  if (input.grade && !GRADES.includes(input.grade)) {
    fields.grade = `Grade must be one of ${GRADES.join(', ')}`;
  }

  if (input.roles) {
    const bad = input.roles.filter((r) => !ROLES.includes(r));
    if (bad.length) fields.roles = `Unknown role${bad.length > 1 ? 's' : ''}: ${bad.join(', ')}`;
  }

  if (input.joiningDate && Number.isNaN(Date.parse(input.joiningDate))) {
    fields.joiningDate = 'Enter a valid date';
  }

  /* Uniqueness. The error names the clashing employee — approved copy is
   * "Already used by the traveller Kumar", not "must be unique". */
  if (input.employeeCode && !fields.employeeCode) {
    const clash = await db.one(
      `SELECT name FROM employee
        WHERE upper(employee_code) = upper($1) AND ($2::text IS NULL OR id <> $2)`,
      [String(input.employeeCode).trim(), existingId]
    );
    if (clash) fields.employeeCode = `Already used by ${clash.name}`;
  }

  if (input.workEmail && !fields.workEmail) {
    const clash = await db.one(
      `SELECT name FROM employee
        WHERE lower(work_email) = lower($1) AND ($2::text IS NULL OR id <> $2)`,
      [String(input.workEmail).trim(), existingId]
    );
    if (clash) fields.workEmail = `Already used by ${clash.name}`;
  }

  /* Referential checks, so a bad id surfaces as a field error rather than a 500. */
  if (input.departmentId && !fields.departmentId) {
    const dept = await db.one('SELECT id, active FROM department WHERE id = $1', [input.departmentId]);
    if (!dept) fields.departmentId = 'Unknown department';
    else if (!dept.active) fields.departmentId = 'That department is not active';
  }

  /* Reporting relationships. */
  if (input.managerId) {
    if (existingId && input.managerId === existingId) {
      fields.managerId = 'An employee cannot report to themselves';
    } else {
      const mgr = await db.one(
        `SELECT id, status FROM employee WHERE id = $1`,
        [input.managerId]
      );
      if (!mgr) fields.managerId = 'Unknown manager';
      else if (mgr.status !== 'active') fields.managerId = 'That manager is not active';
      else if (existingId) {
        /* Deeper cycles (A→B→A) are not catchable in a constraint. D-13 asked for
         * detection; the check itself carries no business content. A cycle would break
         * approval-chain resolution and every team-scope query. */
        const cycle = await db.one(
          `WITH RECURSIVE up AS (
             SELECT id, manager_id FROM employee WHERE id = $1
             UNION ALL
             SELECT e.id, e.manager_id FROM employee e JOIN up ON e.id = up.manager_id
           )
           SELECT 1 AS hit FROM up WHERE id = $2 LIMIT 1`,
          [input.managerId, existingId]
        );
        if (cycle) {
          fields.managerId = 'That would create a reporting loop';
        }
      }
    }
  }

  if (Object.keys(fields).length) throw new ValidationError(fields);
}

/* On a department change the cost center is realigned to that department's, if the
 * current one does not belong to it. Specified behaviour, not a choice. */
export async function resolveCostCenter(db, { departmentId, costCenterId }) {
  if (costCenterId) {
    const cc = await db.one(
      'SELECT id FROM cost_center WHERE id = $1 AND department_id = $2 AND active',
      [costCenterId, departmentId]
    );
    if (cc) return cc.id;
  }
  const fallback = await db.one(
    'SELECT id FROM cost_center WHERE department_id = $1 AND active ORDER BY code LIMIT 1',
    [departmentId]
  );
  if (!fallback) {
    throw new ValidationError(
      { departmentId: 'That department has no active cost center' },
      'That department has no active cost center.'
    );
  }
  return fallback.id;
}

export { GRADES, ROLES, EMAIL_RE };
