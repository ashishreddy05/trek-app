/* Auth + /me routes. Handlers are plain (ctx) => response functions. */

import { login, changePassword, requestReset, checkLink, completeLink } from '../auth/password.js';
import { revokeSession, cookieOptions } from '../auth/session.js';
import { authorize, assertOnlyFields, rejectServerDerived } from '../authz/guard.js';
import { tx } from '../db.js';
import { audit, ACTIONS } from '../audit.js';

/* POST /api/v1/auth/login */
export async function postLogin(ctx) {
  const { principal, token, expiresAt } = await login({
    email: ctx.body?.email,
    password: ctx.body?.password,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    requestId: ctx.requestId,
  });
  return {
    status: 200,
    cookie: { ...cookieOptions(), value: token },
    body: { principal, expiresAt },
  };
}

/* POST /api/v1/auth/logout */
export async function postLogout(ctx) {
  await authorize(ctx.db, ctx.principal, 'auth.logout', {}, ctx.requestId);
  await tx((db) => revokeSession(db, {
    sessionId: ctx.principal.sessionId, actor: ctx.principal, requestId: ctx.requestId, ip: ctx.ip,
  }));
  return { status: 204, cookie: { ...cookieOptions(), value: '', maxAge: 0 }, body: null };
}

/* POST /api/v1/auth/password/forgot — same response whether or not the account exists. */
export async function postForgotPassword(ctx) {
  await requestReset({ email: ctx.body?.email, ip: ctx.ip, requestId: ctx.requestId });
  return {
    status: 202,
    body: { ok: true, message: 'If that email belongs to an active Trek account, a reset link is on its way.' },
  };
}

/* POST /api/v1/auth/password/check — tells the set-password screen whether the link still works. */
export async function postCheckLink(ctx) {
  return { status: 200, body: await checkLink(ctx.body?.token) };
}

/* POST /api/v1/auth/password/reset — sets the password from an invite or reset link. */
export async function postResetPassword(ctx) {
  await completeLink({
    token: ctx.body?.token, password: ctx.body?.password, ip: ctx.ip, requestId: ctx.requestId,
  });
  return { status: 200, body: { ok: true } };
}

/* POST /api/v1/auth/password/change — signed in; needs the current password. */
export async function postChangePassword(ctx) {
  await authorize(ctx.db, ctx.principal, 'auth.changePassword', {}, ctx.requestId);
  await changePassword({
    principal: ctx.principal,
    currentPassword: ctx.body?.currentPassword,
    newPassword: ctx.body?.newPassword,
    ip: ctx.ip,
    requestId: ctx.requestId,
  });
  return { status: 200, body: { ok: true } };
}

/* GET /api/v1/me */
export async function getMe(ctx) {
  await authorize(ctx.db, ctx.principal, 'me.read', {}, ctx.requestId);
  const { sessionId, ...principal } = ctx.principal;
  return { status: 200, body: { principal } };
}

/* PATCH /api/v1/me — contact number only; everything else is an Admin operation. */
export async function patchMe(ctx) {
  await authorize(ctx.db, ctx.principal, 'me.update', {}, ctx.requestId);
  rejectServerDerived(ctx.body, []);
  assertOnlyFields('me.update', ctx.body ?? {});

  const row = await tx(async (db) => {
    const updated = await db.one('UPDATE employee SET mobile = $2 WHERE id = $1 RETURNING id, mobile',
      [ctx.principal.employeeId, ctx.body?.mobile ?? null]);
    await audit(db, {
      actorId: ctx.principal.employeeId,
      actorLabel: ctx.principal.name,
      action: ACTIONS.EMPLOYEE_UPDATE,
      entityType: 'employee',
      entityId: ctx.principal.employeeId,
      detail: 'Contact number updated',
      metadata: { fields: ['mobile'] },
      requestId: ctx.requestId,
      actorIp: ctx.ip,
    });
    return updated;
  });

  return { status: 200, body: { employee: row } };
}
