/* The permission matrix, as data.
 *
 * This is the ONLY place grants are declared, and guard.js is the only place a
 * decision is made. Handlers that do their own inline role checks are how a
 * permission model rots.
 *
 * THE `all` SCOPE IS A DIFFERENT PERMISSION FROM THE `team` SCOPE.
 *
 * A company-wide grant must name a permission that only company-wide holders
 * hold. Mapping `all` to the same permission as `team` means every manager
 * satisfies the company-wide branch and can approve any record in the company,
 * not just their reporting tree. That is why there are separate permissions:
 *   trip.approve      — approve within my reporting tree
 *   trip.approve.all  — approve anywhere in the company (Admin, Finance)
 * The same split applies to expense.approve and to every read scope.
 *
 * test/authz.matrix.test.js walks this table adversarially.
 */

/* ---- role -> permissions ------------------------------------------------- */

export const PERMISSIONS_BY_ROLE = {
  employee: [
    'trip.create', 'trip.read.own',
    'expense.create', 'expense.read.own',
    'trip.budget.manage', 'trip.fx.manage',
    'bill.upload', 'bill.read.own',
    'trip.reconcile.submit',
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
    /* Finance approves budgets company-wide and issues the funds. It must
     * therefore be able to READ every trip — the company-wide approve
     * permission is useless if the trip cannot be opened. */
    'trip.read.all', 'trip.approve.all',
    'expense.approve.all',
    'trip.fund.manage', 'trip.reconcile.decide', 'trip.settle',
    'bill.read.all',
  ],
  admin: [
    'employee.manage', 'department.manage', 'costcenter.manage',
    'policy.manage', 'workflow.manage', 'role.manage',
    'audit.read', 'report.all',
    'trip.read.all', 'trip.approve.all',
    'expense.read.all', 'expense.approve.all',
    'trip.fund.manage', 'trip.reconcile.decide', 'trip.settle',
    'bill.read.all',
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
 *
 * `collection: true` marks a LIST operation. A list has no single target, so
 * the guard resolves it to the widest scope the caller actually holds instead of
 * failing with 403 — which is what "GET /trips" without an explicit ?scope= used
 * to do for every non-admin.
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
  'employee.list':          { collection: true, scopes: { team: 'trip.read.team', all: 'employee.manage', travel: 'trip.read.all', finance: 'expense.read.all' } },
  'employee.read':          { scopes: { own: null, team: 'trip.read.team', all: 'employee.manage', travel: 'trip.read.all', finance: 'expense.read.all' } },
  'employee.create':        { scopes: { all: 'employee.manage' } },
  'employee.update':        { scopes: { all: 'employee.manage' } },
  'employee.updateRoles':   { scopes: { all: 'role.manage' }, selfForbidden: true },
  'employee.updateStatus':  { scopes: { all: 'employee.manage' } },
  'employee.import':        { scopes: { all: 'employee.manage' } },
  'employee.invite':        { scopes: { all: 'employee.manage' } },

  // ---- departments / cost centers ----
  'department.list':   { collection: true, scopes: { all: null } },   // any authenticated user
  'department.create': { scopes: { all: 'department.manage' } },
  'department.update': { scopes: { all: 'department.manage' } },
  'costcenter.list':   { collection: true, scopes: { all: null } },   // any authenticated user
  'costcenter.create': { scopes: { all: 'costcenter.manage' } },

  // ---- audit ----
  'audit.read':    { collection: true, scopes: { all: 'audit.read' } },

  // ---- trips (pilot) ----
  'trip.list':   { collection: true, scopes: { own: 'trip.read.own', team: 'trip.read.team', all: 'trip.read.all' } },
  'trip.read':   { scopes: { own: 'trip.read.own', team: 'trip.read.team', all: 'trip.read.all' } },
  'trip.create': { scopes: { own: 'trip.create' } },
  'trip.update': { scopes: { own: 'trip.create' } },
  'trip.submit': { scopes: { own: 'trip.create' } },
  'trip.decide': { scopes: { team: 'trip.approve', all: 'trip.approve.all' }, selfForbidden: true },

  // ---- budget & forex plan ----
  'trip.budget.read':   { scopes: { own: 'trip.read.own', team: 'trip.read.team', all: 'trip.read.all' } },
  'trip.budget.manage': { scopes: { own: 'trip.budget.manage' } },
  'trip.fx.read':       { scopes: { own: 'trip.read.own', team: 'trip.read.team', all: 'trip.read.all' } },
  'trip.fx.manage':     { scopes: { own: 'trip.fx.manage' } },

  // ---- funds issued ----
  'trip.fund.list':   { scopes: { own: 'trip.read.own', team: 'trip.read.team', all: 'trip.read.all' } },
  'trip.fund.create': { scopes: { all: 'trip.fund.manage' } },

  // ---- expenses (pilot) ----
  'expense.list':   { collection: true, scopes: { own: 'expense.read.own', team: 'expense.read.team', all: 'expense.read.all', finance: 'expense.read.all' } },
  'expense.read':   { scopes: { own: 'expense.read.own', team: 'expense.read.team', all: 'expense.read.all', finance: 'expense.read.all' } },
  'expense.create': { scopes: { own: 'expense.create' } },
  'expense.update': { scopes: { own: 'expense.create' } },
  'expense.delete': { scopes: { own: 'expense.create' } },
  'expense.submit': { scopes: { own: 'expense.create' } },
  'expense.decide': { scopes: { team: 'expense.approve', all: 'expense.approve.all' }, selfForbidden: true },

  // ---- bills (receipts) ----
  'bill.create': { scopes: { own: 'bill.upload' } },
  'bill.read':   { scopes: { own: 'bill.read.own', team: 'trip.read.team', all: 'bill.read.all' } },
  'bill.delete': { scopes: { own: 'bill.upload' } },

  // ---- reconciliation & settlement ----
  'trip.reconciliation.read':   { scopes: { own: 'trip.read.own', team: 'trip.read.team', all: 'trip.read.all' } },
  'trip.reconciliation.submit': { scopes: { own: 'trip.reconcile.submit' } },
  'trip.reconciliation.decide': { scopes: { all: 'trip.reconcile.decide' } },
  'trip.settle':                { scopes: { all: 'trip.settle' } },

  // ---- reporting ----
  'dashboard.read': { collection: true, scopes: { team: 'report.team', finance: 'report.finance', all: 'report.all' } },
  'report.export':  { collection: true, scopes: { team: 'report.team', finance: 'report.finance', all: 'report.all' } },
};

/* Operations whose target is another employee's record and which must therefore
 * return 404 (not 403) when out of scope, so ids are not an enumeration oracle. */
export const OPAQUE_ON_DENY = new Set([
  'employee.read', 'trip.read', 'expense.read', 'bill.read',
]);

export function permissionsFor(roles) {
  return [...new Set((roles ?? []).flatMap((r) => PERMISSIONS_BY_ROLE[r] ?? []))];
}
