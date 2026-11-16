/* The permission matrix, for the manual.
 *
 * The manual has a table of "who can do what". If that table were written by
 * hand it would drift from the matrix the server actually enforces — and a
 * help system that lies is worse than none.
 *
 * So the table is DRAWN FROM THIS FILE: the manual asks for the matrix and
 * marks a capability against the roles that really hold the permissions
 * behind it. The permissions themselves are not a secret — the interface
 * already shows each person which screens they have — and nothing here
 * grants anything: the guard decides access, not this list.
 */

import { PERMISSIONS_BY_ROLE } from '../authz/permissions.js';
import { authorize } from '../authz/guard.js';

/* The names the manual shows for each role. The codes are the matrix's. */
const ROLE_NAMES = {
  employee: 'Traveller',
  manager: 'Manager',
  hr_travel: 'Travel desk',
  finance: 'Finance',
  admin: 'Admin',
};

/* GET /api/v1/permissions/matrix */
export async function getPermissionMatrix(ctx) {
  await authorize(ctx.db, ctx.principal, 'permission.matrix', {}, ctx.requestId);
  const roles = Object.entries(PERMISSIONS_BY_ROLE).map(([code, permissions]) => ({
    code,
    name: ROLE_NAMES[code] ?? code,
    permissions: [...permissions],
  }));

  return {
    status: 200,
    body: {
      roles,
      /* The permissions that exist at all, for reference. */
      permissions: [...new Set(Object.values(PERMISSIONS_BY_ROLE).flat())].sort(),
    },
  };
}
