/* Employee + department + audit routes.
 *
 * Every handler authorises first, through the single guard, and passes the guard's
 * returned scope into the query. A handler never decides scope for itself.
 */

import { authorize, rejectServerDerived } from '../authz/guard.js';
import * as db from '../db.js';
import {
  listEmployees, readEmployee, createEmployee,
  updateEmployee, updateRoles, setStatus,
} from '../employees/service.js';
import { importEmployees } from '../employees/import.js';
import {
  listDepartments, readDepartment, createDepartment,
  updateDepartment, listCostCenters,
} from '../departments/service.js';
import { readAudit } from '../audit.js';

const notFound = { status: 404, body: { error: { code: 'not_found', message: 'Not found.' } } };

/* ---------------------------------------------------------------- employees */

/* GET /api/v1/employees */
export async function getEmployees(ctx) {
  const requested = ctx.query.get('scope') ?? undefined;

  /* Rule 5: a requested scope the caller lacks is 403, never a quietly empty list. */
  const { scope, team } = await authorize(
    ctx.db, ctx.principal, 'employee.list', { scope: requested }, ctx.requestId
  );

  const result = await listEmployees(ctx.db, {
    scope,
    team,
    selfId: ctx.principal.employeeId,
    search: ctx.query.get('search') ?? undefined,
    departmentId: ctx.query.get('departmentId') ?? undefined,
    status: ctx.query.get('status') ?? undefined,
    limit: Number(ctx.query.get('limit')) || 50,
    cursor: ctx.query.get('cursor') ?? undefined,
  });

  return { status: 200, body: result };
}

/* GET /api/v1/employees/:id
 *
 * Reads the record, then authorises against its owner. An out-of-scope record returns
 * 404 — byte-identical to a nonexistent one — so ids are not an enumeration oracle. */
export async function getEmployee(ctx) {
  const id = ctx.params.id;
  const row = await readEmployee(ctx.db, id);

  await authorize(
    ctx.db, ctx.principal, 'employee.read',
    { employeeId: row?.id ?? id, type: 'employee', id },
    ctx.requestId
  );

  if (!row) return notFound;
  return { status: 200, body: { employee: row } };
}

/* POST /api/v1/employees */
export async function postEmployee(ctx) {
  await authorize(ctx.db, ctx.principal, 'employee.create', {}, ctx.requestId);

  /* Roles and status are set through their own endpoints, so they are rejected here
   * rather than silently ignored. costCenterId is permitted — Admin may pick one
   * within the department — but is re-derived if it does not belong. */
  rejectServerDerived(ctx.body, ['costCenterId', 'departmentId']);

  const employee = await createEmployee({
    input: ctx.body,
    actor: ctx.principal,
    requestId: ctx.requestId,
    ip: ctx.ip,
  });

  return { status: 201, body: { employee } };
}

/* PATCH /api/v1/employees/:id */
export async function patchEmployee(ctx) {
  await authorize(ctx.db, ctx.principal, 'employee.update', { employeeId: ctx.params.id }, ctx.requestId);
  rejectServerDerived(ctx.body, ['costCenterId', 'departmentId']);

  const employee = await updateEmployee({
    id: ctx.params.id,
    input: ctx.body,
    actor: ctx.principal,
    requestId: ctx.requestId,
    ip: ctx.ip,
  });

  if (!employee) return notFound;
  return { status: 200, body: { employee } };
}

/* PATCH /api/v1/employees/:id/roles
 *
 * Separate operation, separate permission (role.manage), separate audit action
 * (role.assign). The guard refuses when the target is the caller — no self-escalation. */
export async function patchEmployeeRoles(ctx) {
  await authorize(
    ctx.db, ctx.principal, 'employee.updateRoles',
    { employeeId: ctx.params.id }, ctx.requestId
  );

  const roles = ctx.body?.roles;
  if (!Array.isArray(roles) || roles.length === 0) {
    return {
      status: 422,
      body: { error: { code: 'validation_failed', message: 'Pick at least one role.', fields: { roles: 'Pick at least one role.' } } },
    };
  }

  const employee = await updateRoles({
    id: ctx.params.id,
    roles,
    actor: ctx.principal,
    requestId: ctx.requestId,
    ip: ctx.ip,
  });

  if (!employee) return notFound;
  return { status: 200, body: { employee } };
}

/* PATCH /api/v1/employees/:id/status */
export async function patchEmployeeStatus(ctx) {
  await authorize(
    ctx.db, ctx.principal, 'employee.updateStatus',
    { employeeId: ctx.params.id }, ctx.requestId
  );

  const employee = await setStatus({
    id: ctx.params.id,
    status: ctx.body?.status,
    reason: ctx.body?.reason ?? null,
    actor: ctx.principal,
    requestId: ctx.requestId,
    ip: ctx.ip,
  });

  if (!employee) return notFound;
  return { status: 200, body: { employee } };
}

/* POST /api/v1/employees/import */
export async function postEmployeeImport(ctx) {
  await authorize(ctx.db, ctx.principal, 'employee.import', {}, ctx.requestId);

  const result = await importEmployees({
    text: ctx.body?.text,
    dryRun: ctx.body?.dryRun !== false,      // validate-first is the default
    actor: ctx.principal,
    requestId: ctx.requestId,
    ip: ctx.ip,
  });

  return { status: 200, body: result };
}

/* -------------------------------------------------------------- departments */

export async function getDepartments(ctx) {
  await authorize(ctx.db, ctx.principal, 'department.list', {}, ctx.requestId);
  const data = await listDepartments(ctx.db);
  return { status: 200, body: { data } };
}

export async function postDepartment(ctx) {
  await authorize(ctx.db, ctx.principal, 'department.create', {}, ctx.requestId);
  const department = await createDepartment({
    input: ctx.body, actor: ctx.principal, requestId: ctx.requestId, ip: ctx.ip,
  });
  return { status: 201, body: { department } };
}

export async function patchDepartment(ctx) {
  await authorize(ctx.db, ctx.principal, 'department.update', {}, ctx.requestId);
  const department = await updateDepartment({
    id: ctx.params.id, input: ctx.body, actor: ctx.principal,
    requestId: ctx.requestId, ip: ctx.ip,
  });
  if (!department) return notFound;
  return { status: 200, body: { department } };
}

export async function getCostCenters(ctx) {
  await authorize(ctx.db, ctx.principal, 'costcenter.list', {}, ctx.requestId);
  const data = await listCostCenters(ctx.db, { departmentId: ctx.query.get('departmentId') ?? undefined });
  return { status: 200, body: { data } };
}

/* -------------------------------------------------------------------- audit */

/* GET /api/v1/audit — Admin only.
 *
 * Read-only by definition. There is no POST, PATCH or DELETE for audit at any
 * privilege level, and no such function in src/audit.js. Paginated — never load the
 * whole log. */
export async function getAudit(ctx) {
  await authorize(ctx.db, ctx.principal, 'audit.read', {}, ctx.requestId);

  const result = await readAudit(ctx.db, {
    entityType: ctx.query.get('entityType') ?? undefined,
    entityId: ctx.query.get('entityId') ?? undefined,
    actorId: ctx.query.get('actorId') ?? undefined,
    action: ctx.query.get('action') ?? undefined,
    from: ctx.query.get('from') ?? undefined,
    to: ctx.query.get('to') ?? undefined,
    limit: Number(ctx.query.get('limit')) || 50,
    cursor: ctx.query.get('cursor') ?? undefined,
  });

  return { status: 200, body: result };
}

/* POST /api/v1/employees/:id/invite — emails a single-use set-password link to the
 * employee's own inbox. The link is never returned to the Admin. */
export async function postEmployeeInvite(ctx) {
  await authorize(ctx.db, ctx.principal, 'employee.invite', { employeeId: ctx.params.id }, ctx.requestId);
  const { sendInvite } = await import('../auth/password.js');
  const result = await sendInvite({ employeeId: ctx.params.id, actor: ctx.principal, requestId: ctx.requestId });
  if (!result) return notFound;
  return { status: 202, body: { sent: true, purpose: result.purpose } };
}

export { db };
