/* Employee service — create, update, roles, status, list, read.
 *
 * Every write is audited inside its own transaction, and `employee.update` names the
 * changed fields (approved audit behaviour).
 */

import { randomInt } from 'node:crypto';
import { tx } from '../db.js';
import { audit, ACTIONS } from '../audit.js';
import { validateEmployee, resolveCostCenter } from './validate.js';
import { revokeAllForEmployee } from '../auth/session.js';
import { hashPassword } from '../auth/password-hash.js';
import { passwordProblem } from '../auth/password-policy.js';
import { ValidationError } from './validate.js';

/* Internal ids are opaque. `emp_` + 4 digits matches the approved dataset's shape
 * (emp_t04); collision is retried rather than assumed away. Business refs
 * (TRK-, EXP-) need gapless sequences — that is D-07 and belongs to the tables that
 * carry them, none of which exist yet. */
async function nextEmployeeId(db) {
  for (let i = 0; i < 20; i++) {
    const candidate = `emp_${randomInt(1000, 9999)}`;
    const clash = await db.one('SELECT 1 FROM employee WHERE id = $1', [candidate]);
    if (!clash) return candidate;
  }
  throw new Error('Could not allocate an employee id after 20 attempts');
}

const SELECT_EMPLOYEE = `
  SELECT e.id, e.employee_code, e.name, e.work_email, e.mobile, e.designation,
         e.grade, e.location, e.joining_date, e.status, e.roles,
         e.department_id, d.name AS department_name, d.code AS department_code,
         e.cost_center_id, cc.code AS cost_center_code,
         e.manager_id, m.name AS manager_name,
         (SELECT count(*)::int FROM employee r WHERE r.manager_id = e.id AND r.status = 'active')
           AS direct_reports,
         /* Derived, never stored. Exposed so Admin finds approval-route gaps before a
          * traveller does. Approval routes require an active manager. */
         (e.manager_id IS NOT NULL) AS has_approval_route
    FROM employee e
    JOIN department d   ON d.id = e.department_id
    JOIN cost_center cc ON cc.id = e.cost_center_id
    LEFT JOIN employee m ON m.id = e.manager_id`;

/**
 * @param {object} opts
 * @param {string} opts.scope        from the guard, NEVER from the query string
 * @param {Set<string>} [opts.team]  reporting tree, when scope === 'team'
 * @param {string} [opts.selfId]     when scope === 'own'
 */
export async function listEmployees(db, { scope, team, selfId, search, departmentId, status, limit = 50, cursor } = {}) {
  const where = [];
  const params = [];

  /* One helper, one placeholder per value. No regex rewriting of generated SQL. */
  const p = (val) => { params.push(val); return `$${params.length}`; };

  if (scope === 'own') {
    where.push(`e.id = ${p(selfId)}`);
  } else if (scope === 'team') {
    if (!team || team.size === 0) return { data: [], nextCursor: null };
    where.push(`e.id = ANY(${p([...team])})`);
  }
  // 'all' | 'finance' | 'travel' → company-wide, no id restriction.

  if (search) {
    const s = p(`%${search}%`);
    where.push(`(e.name ILIKE ${s} OR e.employee_code ILIKE ${s} OR e.work_email ILIKE ${s})`);
  }
  if (departmentId) where.push(`e.department_id = ${p(departmentId)}`);
  if (status) where.push(`e.status = ${p(status)}::employee_status`);
  if (cursor) where.push(`e.employee_code > ${p(cursor)}`);

  const capped = Math.min(Number(limit) || 50, 200);
  const sql = `${SELECT_EMPLOYEE}
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY e.employee_code
    LIMIT ${p(capped)}`;

  const rows = await db.many(sql, params);
  return {
    data: rows,
    nextCursor: rows.length === capped ? rows[rows.length - 1].employee_code : null,
  };
}

export async function readEmployee(db, id) {
  return db.one(`${SELECT_EMPLOYEE} WHERE e.id = $1`, [id]);
}

export async function createEmployee({ input, actor, requestId, ip }) {
  return tx(async (db) => {
    await validateEmployee(db, input, null);

    const id = await nextEmployeeId(db);
    const costCenterId = await resolveCostCenter(db, {
      departmentId: input.departmentId,
      costCenterId: input.costCenterId,
    });

    const grade = input.grade ? String(input.grade).trim() : 'G3';
    const location = input.location ? String(input.location).trim() : 'Not specified';
    const joiningDate = input.joiningDate || new Date().toISOString().slice(0, 10);

    const row = await db.one(
      `INSERT INTO employee (id, company_id, employee_code, name, work_email, mobile,
                             department_id, designation, grade, manager_id, cost_center_id,
                             location, joining_date, status, roles)
       VALUES ($1,'co_trek',$2,$3,lower($4),$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id, employee_code, name, work_email, status`,
      [
        id, String(input.employeeCode).trim(), String(input.name).trim(),
        String(input.workEmail).trim(), input.mobile ?? null,
        input.departmentId, String(input.designation).trim(), grade,
        input.managerId ?? null, costCenterId, location,
        joiningDate, input.status ?? 'active',
        input.roles?.length ? input.roles : ['employee'],
      ]
    );

    /* An account is provisioned in the same transaction. No auto-provisioning happens
     * at login — an unknown email creates nothing — so the account must exist here or
     * the employee can never sign in. */
    const account = await db.one(
      `INSERT INTO account (company_id, employee_id, status)
       VALUES ('co_trek', $1, $2) RETURNING id`,
      [id, (input.status ?? 'active') === 'active' ? 'active' : 'suspended']
    );
    await db.query(
      `INSERT INTO account_identity (account_id, provider, subject)
       VALUES ($1, 'password', lower($2)) ON CONFLICT (provider, subject) DO NOTHING`,
      [account.id, String(input.workEmail).trim()]
    );

    if (input.password) {
      const hash = await hashPassword(input.password);
      await db.query(
        `INSERT INTO password_credential (account_id, hash)
         VALUES ($1, $2)
         ON CONFLICT (account_id) DO UPDATE SET hash = EXCLUDED.hash, changed_at = now()`,
        [account.id, hash]
      );
      await audit(db, {
        actorId: actor.employeeId,
        actorLabel: actor.name,
        action: ACTIONS.PASSWORD_SET,
        entityType: 'account',
        entityId: account.id,
        previousState: 'no_password',
        newState: 'password_set',
        detail: `Initial password set for ${row.name}`,
        requestId,
        actorIp: ip,
      });
    }

    const dept = await db.one('SELECT name FROM department WHERE id = $1', [input.departmentId]);

    await audit(db, {
      actorId: actor.employeeId,
      actorLabel: actor.name,
      action: ACTIONS.EMPLOYEE_CREATE,
      entityType: 'employee',
      entityId: id,
      newState: row.status,
      detail: `${row.name} (${row.employee_code}) added to ${dept.name}`,
      metadata: { departmentId: input.departmentId, costCenterId, roles: row.roles },
      requestId,
      actorIp: ip,
    });

    return readEmployee(db, id);
  });
}

const UPDATABLE = {
  employeeCode: 'employee_code',
  name: 'name',
  workEmail: 'work_email',
  mobile: 'mobile',
  departmentId: 'department_id',
  designation: 'designation',
  grade: 'grade',
  managerId: 'manager_id',
  costCenterId: 'cost_center_id',
  location: 'location',
  joiningDate: 'joining_date',
};

export async function updateEmployee({ id, input, actor, requestId, ip }) {
  return tx(async (db) => {
    const before = await readEmployee(db, id);
    if (!before) return null;

    const merged = {
      employeeCode: before.employee_code, name: before.name, workEmail: before.work_email,
      mobile: before.mobile, departmentId: before.department_id, designation: before.designation,
      grade: before.grade, managerId: before.manager_id, costCenterId: before.cost_center_id,
      location: before.location, joiningDate: before.joining_date,
      ...Object.fromEntries(Object.entries(input).filter(([k]) => k in UPDATABLE)),
    };

    await validateEmployee(db, merged, id);

    /* Department change realigns the cost center if the current one no longer belongs. */
    if (merged.departmentId !== before.department_id) {
      merged.costCenterId = await resolveCostCenter(db, {
        departmentId: merged.departmentId,
        costCenterId: input.costCenterId ?? null,
      });
    }

    const sets = [];
    const params = [id];
    const changed = [];
    for (const [key, col] of Object.entries(UPDATABLE)) {
      const next = merged[key];
      const prev = before[col];
      const same = String(prev ?? '') === String(next ?? '');
      if (same) continue;
      params.push(key === 'workEmail' ? String(next).trim().toLowerCase() : next);
      sets.push(`${col} = $${params.length}`);
      changed.push(key);
    }

    if (sets.length) {
      await db.query(`UPDATE employee SET ${sets.join(', ')} WHERE id = $1`, params);

      await audit(db, {
        actorId: actor.employeeId,
        actorLabel: actor.name,
        action: ACTIONS.EMPLOYEE_UPDATE,
        entityType: 'employee',
        entityId: id,
        detail: `${before.name} updated — ${changed.join(', ')}`,
        metadata: { fields: changed },      // audit NAMES THE CHANGED FIELDS
        requestId,
        actorIp: ip,
      });
    }

    if (input.password) {
      const prob = passwordProblem(input.password, { email: merged.workEmail, name: merged.name });
      if (prob) throw new ValidationError({ password: prob });
      const hash = await hashPassword(input.password);
      const acc = await db.one('SELECT id FROM account WHERE employee_id = $1', [id]);
      if (acc) {
        await db.query(
          `INSERT INTO password_credential (account_id, hash)
           VALUES ($1, $2)
           ON CONFLICT (account_id) DO UPDATE SET hash = EXCLUDED.hash, changed_at = now()`,
          [acc.id, hash]
        );
        await audit(db, {
          actorId: actor.employeeId,
          actorLabel: actor.name,
          action: ACTIONS.PASSWORD_RESET,
          entityType: 'account',
          entityId: acc.id,
          previousState: 'password_set',
          newState: 'password_set',
          detail: `Password updated by administrator for ${before.name}`,
          requestId,
          actorIp: ip,
        });
      }
    }

    return readEmployee(db, id);
  });
}

/* Roles are a separate operation, separately permissioned (role.manage) and separately
 * audited (role.assign). An Admin cannot change their own — enforced in the guard. */
export async function updateRoles({ id, roles, actor, requestId, ip }) {
  return tx(async (db) => {
    const before = await readEmployee(db, id);
    if (!before) return null;

    await validateEmployee(db, {
      employeeCode: before.employee_code, name: before.name, workEmail: before.work_email,
      departmentId: before.department_id, designation: before.designation, grade: before.grade,
      location: before.location, joiningDate: before.joining_date, roles,
    }, id);

    await db.query('UPDATE employee SET roles = $2 WHERE id = $1', [id, roles]);

    await audit(db, {
      actorId: actor.employeeId,
      actorLabel: actor.name,
      action: ACTIONS.ROLE_ASSIGN,
      entityType: 'employee',
      entityId: id,
      previousState: (before.roles ?? []).join(','),
      newState: roles.join(','),
      detail: `${before.name}'s roles changed to ${roles.join(', ')}`,
      metadata: { from: before.roles, to: roles },
      requestId,
      actorIp: ip,
    });

    return readEmployee(db, id);
  });
}

/* Deactivation is immediate and total: employee inactive → account suspended →
 * all sessions revoked. This requirement is why sessions are opaque and server-side. */
export async function setStatus({ id, status, reason, actor, requestId, ip }) {
  if (!['active', 'inactive'].includes(status)) {
    const { ValidationError } = await import('./validate.js');
    throw new ValidationError({ status: 'Status must be active or inactive' });
  }

  return tx(async (db) => {
    const before = await readEmployee(db, id);
    if (!before) return null;
    if (before.status === status) return before;

    await db.query('UPDATE employee SET status = $2 WHERE id = $1', [id, status]);
    await db.query(
      `UPDATE account SET status = $2::account_status WHERE employee_id = $1`,
      [id, status === 'active' ? 'active' : 'suspended']
    );

    let revoked = 0;
    if (status === 'inactive') {
      revoked = await revokeAllForEmployee(db, { employeeId: id, actor, requestId, reason });

      /* Revoke all sessions for deactivated employee */
    }

    await audit(db, {
      actorId: actor.employeeId,
      actorLabel: actor.name,
      action: ACTIONS.EMPLOYEE_STATUS,
      entityType: 'employee',
      entityId: id,
      previousState: before.status,
      newState: status,
      detail: status === 'inactive'
        ? `${before.name} deactivated${revoked ? ` — ${revoked} session${revoked === 1 ? '' : 's'} revoked` : ''}`
        : `${before.name} reactivated`,
      reason: reason ?? null,
      metadata: { sessionsRevoked: revoked },
      requestId,
      actorIp: ip,
    });

    return readEmployee(db, id);
  });
}
