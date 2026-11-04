/* The permission matrix, as data.
 *
 * Transcribed from TREK-PERMISSIONS-SPEC.md. This is the ONLY place grants are
 * declared, and guard.js is the only place a decision is made. Sixty handlers each
 * doing their own check is how a permission model rots.
 *
 * test/authz.matrix.test.js walks this table adversarially.
 */

/* ---- role -> permissions ------------------------------------------------- */

export const PERMISSIONS_BY_ROLE = {
  employee: [
    'trip.create', 'trip.read.own',
    'expense.create', 'expense.read.own',
    'advance.request', 'settlement.read.own',
    'document.read.own', 'document.write.own',
  ],
  manager: [
    'trip.read.team', 'trip.approve',
    'expense.read.team', 'expense.approve',
    'report.team', 'delegate.manage',
  ],
  hr_travel: [
    'trip.read.all', 'booking.manage', 'document.manage',
  ],
  finance: [
    'expense.read.all', 'expense.review',
    'advance.manage', 'settlement.post', 'report.finance',
  ],
  admin: [
    'employee.manage', 'department.manage', 'costcenter.manage',
    'policy.manage', 'workflow.manage', 'role.manage',
    'audit.read', 'report.all',
    'trip.read.all', 'trip.approve',
    'expense.read.all', 'expense.approve',
  ],
};

/* ---- operation -> requirement -------------------------------------------- */
/* scope semantics:
 *   own   record.employee_id === principal.employeeId
 *   team  target employee is in the principal's REPORTING TREE (direct or transitive)
 *         — not their department, not their grade peers
 *   all   company-wide
 *   step  principal holds the currently `pending` approval chain step
 *   self  operates on the principal's own account/session
 */

export const OPERATIONS = {
  // ---- auth (unauthenticated or self) ----
  'auth.login':          { public: true },
  'auth.forgotPassword': { public: true },
  'auth.checkLink':      { public: true },
  'auth.resetPassword':  { public: true },
  'auth.changePassword': { scopes: { self: null } },
  'auth.logout':       { scopes: { self: null } },
  'me.read':           { scopes: { self: null } },
  'me.update':         { scopes: { self: null }, fields: ['mobile'] },
  'session.revokeOwn': { scopes: { self: null } },

  // ---- employees ----
  'employee.list':          { scopes: { team: 'trip.read.team', all: 'employee.manage', travel: 'trip.read.all', finance: 'expense.read.all' } },
  'employee.read':          { scopes: { own: null, team: 'trip.read.team', all: 'employee.manage', travel: 'trip.read.all', finance: 'expense.read.all' } },
  'employee.create':        { scopes: { all: 'employee.manage' } },
  'employee.update':        { scopes: { all: 'employee.manage' } },
  'employee.updateRoles':   { scopes: { all: 'role.manage' }, selfForbidden: true },
  'employee.updateStatus':  { scopes: { all: 'employee.manage' } },
  'employee.import':        { scopes: { all: 'employee.manage' } },
  'employee.invite':        { scopes: { all: 'employee.manage' } },

  // ---- departments / cost centers ----
  'department.list':   { scopes: { all: null } },          // any authenticated user, list only
  'department.create': { scopes: { all: 'department.manage' } },
  'department.update': { scopes: { all: 'department.manage' } },
  'costcenter.list':   { scopes: { all: 'trip.read.team' } },
  'costcenter.create': { scopes: { all: 'costcenter.manage' } },

  // ---- audit ----
  'audit.read':    { scopes: { all: 'audit.read' } },
  'activity.read': { scopes: { own: null, team: 'trip.read.team', all: 'trip.read.all' } },

  // ---- trips (pilot) ----
  'trip.list':   { scopes: { own: 'trip.read.own', team: 'trip.read.team', all: 'trip.read.all' } },
  'trip.read':   { scopes: { own: 'trip.read.own', team: 'trip.read.team', all: 'trip.read.all' } },
  'trip.create': { scopes: { own: 'trip.create' } },
  'trip.update': { scopes: { own: 'trip.create' } },
  'trip.submit': { scopes: { own: 'trip.create' } },
  'trip.decide': { scopes: { team: 'trip.approve', all: 'trip.approve' }, selfForbidden: true },

  // ---- expenses (pilot) ----
  'expense.list':   { scopes: { own: 'expense.read.own', team: 'expense.read.team', all: 'expense.read.all', finance: 'expense.read.all' } },
  'expense.read':   { scopes: { own: 'expense.read.own', team: 'expense.read.team', all: 'expense.read.all', finance: 'expense.read.all' } },
  'expense.create': { scopes: { own: 'expense.create' } },
  'expense.update': { scopes: { own: 'expense.create' } },
  'expense.delete': { scopes: { own: 'expense.create' } },
  'expense.submit': { scopes: { own: 'expense.create' } },
  'expense.decide': { scopes: { team: 'expense.approve', all: 'expense.approve' }, selfForbidden: true },

};

/* Operations whose target is another employee's record and which must therefore
 * return 404 (not 403) when out of scope, so ids are not an enumeration oracle. */
export const OPAQUE_ON_DENY = new Set([
  'employee.read', 'activity.read', 'trip.read', 'expense.read',
]);

export function permissionsFor(roles) {
  return [...new Set((roles ?? []).flatMap((r) => PERMISSIONS_BY_ROLE[r] ?? []))];
}
