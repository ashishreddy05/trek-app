/* Audit — the immutable record.
 *
 * One function. It is INSERT-only because the table is INSERT-only (see 002_audit.sql:
 * the app role has UPDATE/DELETE revoked and triggers refuse mutation regardless).
 *
 * Always call this with a transaction client, inside the transaction of the operation
 * being audited. An audit event that commits while its operation rolls back is a lie;
 * an operation that commits without its audit event is an unrecorded change. Both are
 * prevented by sharing the transaction.
 */

import { log } from './logging.js';

/* Actions are a closed vocabulary. Add here when a new business action ships — the
 * point of a closed list is that "what is auditable" is reviewable in one place.
 * TREK-DEVELOPER-HANDOFF.md §8 is the source. */
export const ACTIONS = {
  // auth (AUTH-01: email + password)
  AUTH_LOGIN: 'auth.login',
  AUTH_LOGIN_FAILED: 'auth.login_failed',
  AUTH_LOGOUT: 'auth.logout',
  SESSION_REVOKE: 'session.revoke',
  PASSWORD_LINK_ISSUED: 'password.link_issued',
  PASSWORD_SET: 'password.set',
  PASSWORD_RESET_REQUESTED: 'password.reset_requested',
  PASSWORD_RESET: 'password.reset',
  PASSWORD_CHANGE: 'password.change',
  // master data
  EMPLOYEE_CREATE: 'employee.create',
  EMPLOYEE_UPDATE: 'employee.update',
  EMPLOYEE_STATUS: 'employee.status',
  EMPLOYEE_IMPORT: 'employee.import',
  ROLE_ASSIGN: 'role.assign',
  DEPARTMENT_CREATE: 'department.create',
  DEPARTMENT_UPDATE: 'department.update',
  // trips
  TRIP_CREATE: 'trip.create',
  TRIP_UPDATE: 'trip.update',
  TRIP_SUBMIT: 'trip.submit',
  TRIP_APPROVE: 'trip.approve',
  TRIP_REJECT: 'trip.reject',
  TRIP_REQUEST_CHANGES: 'trip.request_changes',
  TRIP_RESUBMIT: 'trip.resubmit',
  // budget & forex plan
  TRIP_BUDGET_ADD: 'trip.budget.add',
  TRIP_BUDGET_UPDATE: 'trip.budget.update',
  TRIP_BUDGET_REMOVE: 'trip.budget.remove',
  TRIP_FX_SET: 'trip.fx.set',
  TRIP_FX_REMOVE: 'trip.fx.remove',
  // funds issued
  TRIP_FUND_ISSUE: 'trip.fund.issue',
  // expenses
  EXPENSE_CREATE: 'expense.create',
  EXPENSE_UPDATE: 'expense.update',
  EXPENSE_DELETE: 'expense.delete',
  EXPENSE_SUBMIT: 'expense.submit',
  EXPENSE_APPROVE: 'expense.approve',
  EXPENSE_REJECT: 'expense.reject',
  // bills (receipts)
  BILL_UPLOAD: 'bill.upload',
  BILL_DELETE: 'bill.delete',
  // reconciliation & settlement
  TRIP_RECONCILE_SUBMIT: 'trip.reconcile.submit',
  TRIP_RECONCILE_APPROVE: 'trip.reconcile.approve',
  TRIP_RECONCILE_REJECT: 'trip.reconcile.reject',
  TRIP_SETTLE: 'trip.settle',
  // authz
  AUTHZ_DENIED: 'authz.denied',
};

/**
 * @param {object} db      transaction client from tx(), or the module-level db
 * @param {object} event
 * @param {string|null} event.actorId      employee.id, or null for pre-auth events
 * @param {string|null} event.actorLabel   actor name AT THE TIME of the action
 * @param {string} event.action            from ACTIONS
 * @param {string} event.entityType
 * @param {string} event.entityId
 * @param {string|null} [event.previousState]
 * @param {string|null} [event.newState]
 * @param {string|null} [event.relatedType]
 * @param {string|null} [event.relatedId]
 * @param {string} event.detail            human-readable, rendered verbatim in the UI
 * @param {string|null} [event.reason]     send-back / waiver / exception reason, VERBATIM
 * @param {object} [event.metadata]
 * @param {string|null} [event.requestId]
 * @param {string|null} [event.actorIp]
 */
export async function audit(db, event) {
  const {
    actorId = null, actorLabel = null, action, entityType, entityId,
    previousState = null, newState = null,
    relatedType = null, relatedId = null,
    detail, reason = null, metadata = {}, requestId = null, actorIp = null,
  } = event;

  if (!action || !entityType || !entityId || !detail) {
    throw new Error('audit: action, entityType, entityId and detail are all required');
  }

  await db.query(
    `INSERT INTO audit_event
       (company_id, actor_id, actor_label, action, entity_type, entity_id,
        previous_state, new_state, related_type, related_id,
        detail, reason, metadata, request_id, actor_ip)
     VALUES ('co_trek', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [actorId, actorLabel, action, entityType, entityId,
     previousState, newState, relatedType, relatedId,
     detail, reason, metadata, requestId, actorIp]
  );

  log.debug('audit', { action, entityType, entityId, actorId });
}

/* Reading audit is Admin-only (audit.read) and paginated — never load the whole log.
 * There is deliberately no update or delete function in this module, at any
 * privilege level. */
export async function readAudit(db, { entityType, entityId, actorId, action, from, to, limit = 50, cursor } = {}) {
  const where = [];
  const params = [];
  const add = (sql, val) => { params.push(val); where.push(sql.replace('$?', `$${params.length}`)); };

  if (entityType) add('entity_type = $?', entityType);
  if (entityId)   add('entity_id = $?', entityId);
  if (actorId)    add('actor_id = $?', actorId);
  if (action)     add('action = $?', action);
  if (from)       add('at >= $?', from);
  if (to)         add('at <= $?', to);
  if (cursor)     add('id < $?', cursor);

  params.push(Math.min(limit, 200));

  const rows = await db.many(
    `SELECT * FROM audit_event
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY id DESC
     LIMIT $${params.length}`,
    params
  );

  return { data: rows, nextCursor: rows.length ? rows[rows.length - 1].id : null };
}
