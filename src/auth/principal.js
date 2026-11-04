/* Principal resolution.
 *
 * The employee record is the sole source of identity. This module turns a session into
 * the principal the rest of the system authorises against.
 *
 * Survives an ST-05 change: if an auth provider is bought instead of built, otp.js and
 * session.js are replaced and this file is untouched.
 */

import { PERMISSIONS_BY_ROLE } from '../authz/permissions.js';

/* Landing surface precedence, per spec: admin -> finance -> hr_travel -> manager -> employee.
 * The client routes on this; it never computes it. */
function surfaceFor(roles, isImplicitManager) {
  if (roles.includes('admin')) return 'admin';
  if (roles.includes('finance')) return 'finance';
  if (roles.includes('hr_travel')) return 'hr_travel';
  if (roles.includes('manager') || isImplicitManager) return 'manager';
  return 'employee';
}

export async function resolvePrincipal(db, employeeId) {
  const row = await db.one(
    `SELECT e.id, e.employee_code, e.name, e.work_email, e.mobile, e.designation,
            e.grade, e.location, e.status, e.roles,
            e.department_id, d.name AS department_name, d.head_id AS department_head_id,
            e.cost_center_id, cc.code AS cost_center_code,
            e.manager_id, m.name AS manager_name,
            a.id AS account_id, a.status AS account_status,
            (SELECT count(*) FROM employee r
              WHERE r.manager_id = e.id AND r.status = 'active') AS direct_reports
       FROM employee e
       JOIN department d   ON d.id = e.department_id
       JOIN cost_center cc ON cc.id = e.cost_center_id
       JOIN account a      ON a.employee_id = e.id
       LEFT JOIN employee m ON m.id = e.manager_id
      WHERE e.id = $1`,
    [employeeId]
  );

  if (!row) return null;

  /* Access is gated on BOTH employee and account status, every time — not only at
   * login. A deactivation mid-session must take effect on the next request. */
  if (row.status !== 'active' || row.account_status !== 'active') return null;

  const explicitRoles = row.roles ?? ['employee'];

  /* The manager role is implicit for anyone with at least one direct report, computed
   * per request and never stored. A new direct report grants approval rights
   * immediately; losing the last one removes them. */
  const isImplicitManager = Number(row.direct_reports) > 0;
  const roles = isImplicitManager && !explicitRoles.includes('manager')
    ? [...explicitRoles, 'manager']
    : explicitRoles;

  const permissions = [...new Set(roles.flatMap((r) => PERMISSIONS_BY_ROLE[r] ?? []))];

  return {
    employeeId: row.id,
    accountId: row.account_id,
    employeeCode: row.employee_code,
    name: row.name,
    email: row.work_email,
    mobile: row.mobile,
    designation: row.designation,
    grade: row.grade,
    location: row.location,
    departmentId: row.department_id,
    departmentName: row.department_name,
    departmentHeadId: row.department_head_id,
    costCenterId: row.cost_center_id,
    costCenterCode: row.cost_center_code,
    managerId: row.manager_id,
    managerName: row.manager_name,
    roles,
    isImplicitManager,
    permissions,
    surface: surfaceFor(roles, isImplicitManager),
  };
}
