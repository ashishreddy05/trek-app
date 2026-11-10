/* The guard. The only place an authorization decision is made.
 *
 * Five rules, from TREK-PERMISSIONS-SPEC.md §3:
 *
 *  1. DENY BY DEFAULT. An operation with no explicit grant is denied. New endpoints
 *     start closed — an unknown operation name throws rather than passing.
 *  2. TWO-PART CHECK. Holds the permission AND target is in scope.
 *  3. `team` IS THE REPORTING TREE, resolved per request by recursive CTE. Not
 *     department_id. A Sales manager does not read a Sales colleague's trips because
 *     they happen to share a department.
 *  4. AUTHORIZE BEFORE YOU READ, and return 404 for out-of-scope records — 403 and
 *     404 must be indistinguishable, or ids become an enumeration oracle.
 *  5. A FILTER PARAMETER IS NOT AUTHORIZATION. Requesting a scope you lack is 403,
 *     never an empty result set.
 */

import { OPERATIONS, OPAQUE_ON_DENY } from './permissions.js';
import { log } from '../logging.js';

export class AuthzError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const FORBIDDEN = () => new AuthzError(403, 'forbidden', 'You do not have access to this.');
const NOT_FOUND = () => new AuthzError(404, 'not_found', 'Not found.');

/* Rule 3: the reporting tree. Transitive, active-only, excluding the manager.
 *
 * Cached per request (see makeScope) because a single handler may check it several
 * times; NOT cached across requests, because a manager_id change must take effect
 * immediately. */
export async function reportingTree(db, managerId) {
  const rows = await db.many(
    `WITH RECURSIVE tree AS (
       SELECT id FROM employee WHERE manager_id = $1 AND status = 'active'
       UNION
       SELECT e.id FROM employee e JOIN tree t ON e.manager_id = t.id
        WHERE e.status = 'active'
     )
     SELECT id FROM tree`,
    [managerId]
  );
  return new Set(rows.map((r) => r.id));
}

/**
 * Authorize an operation.
 *
 * @param {object} db          transaction client or module db
 * @param {object} principal   from principalFromToken()
 * @param {string} operation   key in OPERATIONS
 * @param {object} [target]
 * @param {string} [target.employeeId]  the record's owning employee
 * @param {string} [target.scope]       an explicitly REQUESTED scope ('own'|'team'|'all')
 * @param {string} [target.type]        for logging
 * @param {string} [target.id]          for logging
 * @param {string} [requestId]
 * @returns {Promise<{scope: string}>}  the scope granted — handlers filter with it
 */
export async function authorize(db, principal, operation, target = {}, requestId = null) {
  const spec = OPERATIONS[operation];

  /* Rule 1: an operation not declared in the matrix is denied, loudly. A typo in a
   * handler must fail closed, not fall through to allowed. */
  if (!spec) {
    log.error('authz.unknown_operation', { operation, requestId });
    throw FORBIDDEN();
  }

  if (spec.public) return { scope: 'public' };

  if (!principal) throw new AuthzError(401, 'unauthenticated', 'Sign in to continue.');

  const held = new Set(principal.permissions);
  const deny = (reason) => {
    log.denied({
      requestId,
      employeeId: principal.employeeId,
      operation,
      targetType: target.type,
      targetId: target.id,
      reason,
    });
    throw OPAQUE_ON_DENY.has(operation) ? NOT_FOUND() : FORBIDDEN();
  };

  /* Self-scoped operations: /me, logout. Nothing to check beyond a live session. */
  if (spec.scopes?.self !== undefined && !target.employeeId) {
    return { scope: 'self' };
  }

  /* An Admin must not be able to escalate their own privileges by editing their own
   * record. Role changes are separately permissioned AND separately audited. */
  if (spec.selfForbidden && target.employeeId === principal.employeeId) {
    deny('self_forbidden');
  }

  /* Rule 5: if the caller explicitly REQUESTED a scope, they must hold it.
   * Do not quietly narrow to what they can see — that turns a permission error into
   * a confusing empty screen and hides client bugs. */
  if (target.scope) {
    const requiredPerm = spec.scopes?.[target.scope];
    if (requiredPerm === undefined) deny(`scope_not_available:${target.scope}`);
    if (requiredPerm !== null && !held.has(requiredPerm)) deny(`missing_permission:${requiredPerm}`);
    if (target.scope === 'own') return { scope: 'own' };
    if (target.scope === 'team') return { scope: 'team', team: await reportingTree(db, principal.employeeId) };
    return { scope: target.scope };
  }

  /* A LIST operation has no single target, so "the narrowest scope that covers
   * the target" is meaningless — there is no target. The caller's widest scope
   * they actually hold is the answer, and the handler filters by it.
   *
   * This is why GET /api/v1/trips without an explicit ?scope= used to return
   * 403 for employees and managers: there was no target to match `own` against
   * and no target to look up in the reporting tree. */
  if (spec.collection) {
    for (const wide of ['all', 'finance', 'travel']) {
      const perm = spec.scopes?.[wide];
      if (perm === undefined) continue;
      if (perm === null || held.has(perm)) return { scope: wide };
    }
    const teamPerm = spec.scopes?.team;
    if (teamPerm !== undefined && (teamPerm === null || held.has(teamPerm))) {
      return { scope: 'team', team: await reportingTree(db, principal.employeeId) };
    }
    const ownPerm = spec.scopes?.own;
    if (ownPerm !== undefined && (ownPerm === null || held.has(ownPerm))) {
      return { scope: 'own' };
    }
    deny('no_scope_matched');
  }

  /* Rule 2 + 4: no explicit scope, so derive the narrowest scope that covers the
   * target — checking permission and scope together. */

  // Company-wide grants first: all > finance/travel projections > team > own.
  for (const wide of ['all', 'finance', 'travel']) {
    const perm = spec.scopes?.[wide];
    if (perm === undefined) continue;
    if (perm === null || held.has(perm)) return { scope: wide };
  }

  // Own.
  if (spec.scopes?.own !== undefined && target.employeeId === principal.employeeId) {
    const perm = spec.scopes.own;
    if (perm === null || held.has(perm)) return { scope: 'own' };
  }

  // Team — the reporting tree, not the department.
  if (spec.scopes?.team !== undefined) {
    const perm = spec.scopes.team;
    if (perm === null || held.has(perm)) {
      const team = await reportingTree(db, principal.employeeId);
      if (target.employeeId && team.has(target.employeeId)) return { scope: 'team', team };
    }
  }

  deny('no_scope_matched');
}

/* Convenience: assert a bare permission with no target (config reads, etc). */
export function assertPermission(principal, permission) {
  if (!principal) throw new AuthzError(401, 'unauthenticated', 'Sign in to continue.');
  if (!principal.permissions.includes(permission)) throw FORBIDDEN();
}

/* Field-level restriction is part of authorization, not a client concern.
 * me.update accepts `mobile` only — everything structural is an Admin operation on a
 * different route, and must be REJECTED here rather than silently ignored, because
 * silent ignoring hides client bugs. */
export function assertOnlyFields(operation, payload) {
  const allowed = OPERATIONS[operation]?.fields;
  if (!allowed) return payload;
  const offending = Object.keys(payload).filter((k) => !allowed.includes(k));
  if (offending.length) {
    throw new AuthzError(
      422,
      'validation_failed',
      `These fields cannot be changed here: ${offending.join(', ')}.`
    );
  }
  return payload;
}

/* Server-derived values are never accepted from a client. Reject rather than ignore. */
export const SERVER_DERIVED = [
  'employeeId', 'employee_id', 'departmentId', 'department_id',
  'costCenterId', 'cost_center_id', 'bandId', 'band_id',
  'baseAmount', 'base_amount', 'takenBase', 'taken_base', 'spentBase', 'spent_base',
  'direction', 'amountBase', 'amount_base',
  'state', 'policyStatus', 'policy_status', 'policyFlag', 'policy_flag',
  'ref', 'code', 'roles', 'status',
];

export function rejectServerDerived(payload, except = []) {
  const offending = Object.keys(payload ?? {}).filter(
    (k) => SERVER_DERIVED.includes(k) && !except.includes(k)
  );
  if (offending.length) {
    throw new AuthzError(
      422,
      'validation_failed',
      `These values are set by the server and must not be sent: ${offending.join(', ')}.`
    );
  }
}
