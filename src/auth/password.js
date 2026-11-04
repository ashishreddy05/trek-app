/* Work-email + password authentication.
 *
 * AUTH-01 (directed by the product owner, 23 Sep 2026) replaces passwordless email OTP.
 * The employee record is still the only source of identity; only the credential changed.
 *
 * No bypass, no default password, no dev login. A password exists only as an scrypt
 * hash. The plaintext lives in one request scope and is never stored, logged or returned.
 */

import { randomBytes, createHash } from 'node:crypto';
import { config } from '../config.js';
import * as pool from '../db.js';
import { audit, ACTIONS } from '../audit.js';
import { hashPassword, verifyPassword, burnTime } from './password-hash.js';
import { passwordProblem } from './password-policy.js';
import { createSession, revokeAllForEmployee, revokeOtherSessions } from './session.js';
import { resolvePrincipal } from './principal.js';
import { sendPasswordLinkEmail, mailEnabled } from '../mail/index.js';
import { log } from '../logging.js';

export class AuthError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/* Approved copy for an inactive employee. Shown only AFTER a correct password, so it
 * reveals nothing to someone guessing. */
const NOT_ACTIVATED =
  "Your account hasn't been activated yet. Please contact your company administrator.";
/* Unknown email, no password set, and wrong password are indistinguishable. */
const BAD_CREDENTIALS = 'Email or password is incorrect.';
const LINK_EXPIRED = 'This link has expired or has already been used. Ask for a new one.';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const LOCKOUT = { windowMinutes: 15, perEmail: 5, perIp: 50 };
export const LINK_TTL_MINUTES = { reset: 60, invite: 72 * 60 };
const EXPIRES_TEXT = { reset: '60 minutes', invite: '3 days' };
const RESET_REQUESTS_PER_HOUR = 3;

const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
const norm = (e) => String(e ?? '').trim().toLowerCase();

/* ------------------------------------------------------------------ lockout */

async function lockedOut(email, ip) {
  const r = await pool.one(
    `SELECT
       (SELECT count(*)::int FROM login_attempt
         WHERE lower(email) = $1 AND NOT success
           AND at > now() - make_interval(mins => $3)
           AND at > coalesce((SELECT max(at) FROM login_attempt
                               WHERE lower(email) = $1 AND success), '-infinity'::timestamptz)
       ) AS by_email,
       (SELECT count(*)::int FROM login_attempt
         WHERE ip = $2::inet AND NOT success
           AND at > now() - make_interval(mins => $3)
       ) AS by_ip`,
    [email, ip ?? null, LOCKOUT.windowMinutes]
  );
  return r.by_email >= LOCKOUT.perEmail || r.by_ip >= LOCKOUT.perIp;
}

/* Recorded in its own transaction, so a failure is kept even though the request errors. */
async function recordFailure({ email, ip, requestId, reason, row }) {
  await pool.tx(async (db) => {
    await db.query('INSERT INTO login_attempt (email, ip, success) VALUES ($1, $2, false)', [email, ip ?? null]);
    await audit(db, {
      actorId: row?.id ?? null,
      actorLabel: row?.name ?? 'anonymous',
      action: ACTIONS.AUTH_LOGIN_FAILED,
      entityType: 'account',
      entityId: row?.account_id ?? email,
      detail: `Failed sign-in for ${email}`,
      metadata: { reason, ip },
      requestId,
      actorIp: ip,
    });
  });
}

/* -------------------------------------------------------------------- login */

export async function login({ email, password, ip, userAgent, requestId }) {
  const e = norm(email);
  if (!EMAIL_RE.test(e) || typeof password !== 'string' || password === '') {
    throw new AuthError(422, 'validation_failed', 'Enter your work email and password.');
  }

  if (await lockedOut(e, ip)) {
    throw new AuthError(429, 'locked',
      `Too many failed attempts. Try again in ${LOCKOUT.windowMinutes} minutes, or reset your password.`);
  }

  const allowedDomain = config.loginEmailDomains.includes(e.split('@')[1]);
  const row = allowedDomain
    ? await pool.one(
        `SELECT e.id, e.name, e.status, a.id AS account_id, a.status AS account_status, pc.hash
           FROM employee e
           JOIN account a ON a.employee_id = e.id
           LEFT JOIN password_credential pc ON pc.account_id = a.id
          WHERE lower(e.work_email) = $1`,
        [e]
      )
    : null;

  if (!row || !row.hash) {
    await burnTime(password);
    await recordFailure({ email: e, ip, requestId, row, reason: !row ? 'unknown_email' : 'no_password_set' });
    throw new AuthError(401, 'invalid_credentials', BAD_CREDENTIALS);
  }

  const { ok, needsRehash } = await verifyPassword(row.hash, password);
  if (!ok) {
    await recordFailure({ email: e, ip, requestId, row, reason: 'wrong_password' });
    throw new AuthError(401, 'invalid_credentials', BAD_CREDENTIALS);
  }

  /* Inactive users are refused even with the right password. */
  if (row.status !== 'active' || row.account_status !== 'active') {
    await recordFailure({ email: e, ip, requestId, row, reason: 'inactive' });
    throw new AuthError(403, 'not_activated', NOT_ACTIVATED);
  }

  return pool.tx(async (db) => {
    if (needsRehash) {
      await db.query('UPDATE password_credential SET hash = $2 WHERE account_id = $1',
        [row.account_id, await hashPassword(password)]);
    }
    await db.query('INSERT INTO login_attempt (email, ip, success) VALUES ($1, $2, true)', [e, ip ?? null]);

    const session = await createSession(db, { accountId: row.account_id, employeeId: row.id, ip, userAgent });
    await db.query('UPDATE account SET last_login_at = now() WHERE id = $1', [row.account_id]);
    const principal = await resolvePrincipal(db, row.id);

    await audit(db, {
      actorId: row.id,
      actorLabel: row.name,
      action: ACTIONS.AUTH_LOGIN,
      entityType: 'account',
      entityId: row.account_id,
      newState: 'session_active',
      detail: `${row.name} signed in`,
      metadata: { ip, userAgent, method: 'password' },
      requestId,
      actorIp: ip,
    });

    log.info('auth.login', { employeeId: row.id, requestId });
    return { principal, token: session.token, expiresAt: session.expiresAt };
  });
}

/* ---------------------------------------------------------- change password */

export async function changePassword({ principal, currentPassword, newPassword, ip, requestId }) {
  const row = await pool.one(
    `SELECT pc.hash, e.work_email, e.name
       FROM password_credential pc
       JOIN account a ON a.id = pc.account_id
       JOIN employee e ON e.id = a.employee_id
      WHERE pc.account_id = $1`,
    [principal.accountId]
  );
  if (!row) throw new AuthError(409, 'no_password', 'No password is set on this account.');

  const { ok } = await verifyPassword(row.hash, currentPassword ?? '');
  if (!ok) {
    await recordFailure({ email: norm(row.work_email), ip, requestId, reason: 'change_wrong_current',
      row: { id: principal.employeeId, name: principal.name, account_id: principal.accountId } });
    throw new AuthError(422, 'validation_failed', "That isn't your current password.",
      { fields: { currentPassword: "That isn't your current password." } });
  }

  const problem = passwordProblem(newPassword, { email: row.work_email, name: row.name });
  if (problem) throw new AuthError(422, 'validation_failed', problem, { fields: { newPassword: problem } });
  if (newPassword === currentPassword) {
    const msg = 'Choose a password different from your current one.';
    throw new AuthError(422, 'validation_failed', msg, { fields: { newPassword: msg } });
  }

  const hash = await hashPassword(newPassword);

  await pool.tx(async (db) => {
    await db.query('UPDATE password_credential SET hash = $2, changed_at = now() WHERE account_id = $1',
      [principal.accountId, hash]);
    await db.query('UPDATE password_reset_token SET used_at = now() WHERE account_id = $1 AND used_at IS NULL',
      [principal.accountId]);
    /* Other devices are signed out; this one stays signed in. */
    const revoked = await revokeOtherSessions(db, {
      employeeId: principal.employeeId, keepSessionId: principal.sessionId,
    });
    await audit(db, {
      actorId: principal.employeeId,
      actorLabel: principal.name,
      action: ACTIONS.PASSWORD_CHANGE,
      entityType: 'account',
      entityId: principal.accountId,
      detail: `${principal.name} changed their password`,
      metadata: { otherSessionsRevoked: revoked },
      requestId,
      actorIp: ip,
    });
  });
}

/* ------------------------------------------------------------ link issuing */

/* One live link per account: issuing a new one voids the previous. Returns the URL to
 * the CALLER only — the API never returns it; the CLI prints it to the operator. */
export async function issuePasswordLink(db, { accountId, employee, purpose, actor = null, via = 'app', requestId = null }) {
  await db.query('UPDATE password_reset_token SET used_at = now() WHERE account_id = $1 AND used_at IS NULL', [accountId]);

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + LINK_TTL_MINUTES[purpose] * 60_000);

  await db.query(
    `INSERT INTO password_reset_token (account_id, purpose, token_hash, expires_at, created_by)
     VALUES ($1, $2::password_link_purpose, $3, $4, $5)`,
    [accountId, purpose, sha256(token), expiresAt, actor?.employeeId ?? null]
  );

  await audit(db, {
    actorId: actor?.employeeId ?? null,
    actorLabel: actor?.name ?? (via === 'cli' ? 'operator (command line)' : 'system'),
    action: ACTIONS.PASSWORD_LINK_ISSUED,
    entityType: 'account',
    entityId: accountId,
    relatedType: 'employee',
    relatedId: employee.id,
    detail: `${purpose === 'invite' ? 'Sign-in invite' : 'Password reset link'} issued for ${employee.name}`,
    metadata: { purpose, via, expiresAt },
    requestId,
  });

  return { url: `${config.baseUrl}/set-password?token=${token}`, expiresAt, expiresText: EXPIRES_TEXT[purpose] };
}

/* Admin → "Email sign-in link". The link goes only to the employee's own inbox. */
export async function sendInvite({ employeeId, actor, requestId }) {
  const row = await pool.one(
    `SELECT e.id, e.name, e.work_email, e.status, a.id AS account_id, a.status AS account_status,
            (pc.account_id IS NOT NULL) AS has_password
       FROM employee e
       JOIN account a ON a.employee_id = e.id
       LEFT JOIN password_credential pc ON pc.account_id = a.id
      WHERE e.id = $1`,
    [employeeId]
  );
  if (!row) return null;
  if (row.status !== 'active' || row.account_status !== 'active') {
    throw new AuthError(409, 'inactive', 'That employee is inactive. Reactivate them first.');
  }
  if (!mailEnabled()) {
    throw new AuthError(409, 'mail_disabled',
      "Email delivery isn't set up yet, so Trek can't send this link. Ask your technical administrator to issue one from the command line.");
  }

  const purpose = row.has_password ? 'reset' : 'invite';
  await pool.tx(async (db) => {
    const link = await issuePasswordLink(db, {
      accountId: row.account_id, employee: row, purpose, actor, via: 'app', requestId,
    });
    await sendPasswordLinkEmail({ to: row.work_email, name: row.name, url: link.url, purpose, expiresText: link.expiresText });
  });
  return { purpose };
}

/* ---------------------------------------------------------- forgot password */

/* The response is identical whether or not the account exists. */
export async function requestReset({ email, ip, requestId }) {
  const e = norm(email);
  if (!EMAIL_RE.test(e)) {
    throw new AuthError(422, 'validation_failed', 'Enter a valid work email address.',
      { fields: { email: 'Enter a valid work email address.' } });
  }

  const row = await pool.one(
    `SELECT e.id, e.name, e.work_email, e.status, a.id AS account_id, a.status AS account_status,
            (SELECT count(*)::int FROM password_reset_token t
              WHERE t.account_id = a.id AND t.purpose = 'reset'
                AND t.created_at > now() - interval '1 hour') AS recent
       FROM employee e JOIN account a ON a.employee_id = e.id
      WHERE lower(e.work_email) = $1`,
    [e]
  );

  if (!row || row.status !== 'active' || row.account_status !== 'active') return;
  if (row.recent >= RESET_REQUESTS_PER_HOUR) return;
  if (!mailEnabled()) {
    log.warn('password.reset_mail_disabled', { employeeId: row.id, requestId });
    return;
  }

  await pool.tx(async (db) => {
    const link = await issuePasswordLink(db, {
      accountId: row.account_id, employee: row, purpose: 'reset', via: 'self_service', requestId,
    });
    await sendPasswordLinkEmail({ to: row.work_email, name: row.name, url: link.url, purpose: 'reset', expiresText: link.expiresText });
    await audit(db, {
      actorId: row.id,
      actorLabel: row.name,
      action: ACTIONS.PASSWORD_RESET_REQUESTED,
      entityType: 'account',
      entityId: row.account_id,
      detail: `${row.name} requested a password reset`,
      metadata: { ip },
      requestId,
      actorIp: ip,
    });
  });
}

/* ------------------------------------------------------- set / reset password */

async function loadLink(db, token, lock = false) {
  return db.one(
    `SELECT t.id, t.account_id, t.purpose, t.expires_at, t.used_at,
            e.id AS employee_id, e.name, e.work_email, e.status, a.status AS account_status
       FROM password_reset_token t
       JOIN account a  ON a.id = t.account_id
       JOIN employee e ON e.id = a.employee_id
      WHERE t.token_hash = $1
      ${lock ? 'FOR UPDATE OF t' : ''}`,
    [sha256(token ?? '')]
  );
}

function linkUsable(row) {
  return row && !row.used_at && new Date(row.expires_at) > new Date()
    && row.status === 'active' && row.account_status === 'active';
}

export async function checkLink(token) {
  const row = await loadLink(pool, token);
  if (!linkUsable(row)) throw new AuthError(410, 'link_expired', LINK_EXPIRED);
  return { valid: true, purpose: row.purpose, firstName: row.name.split(' ')[0] };
}

export async function completeLink({ token, password, ip, requestId }) {
  const hash = typeof password === 'string' ? await hashPassword(password) : null;

  await pool.tx(async (db) => {
    const row = await loadLink(db, token, true);
    if (!linkUsable(row)) throw new AuthError(410, 'link_expired', LINK_EXPIRED);

    const problem = passwordProblem(password, { email: row.work_email, name: row.name });
    if (problem) throw new AuthError(422, 'validation_failed', problem, { fields: { password: problem } });

    await db.query(
      `INSERT INTO password_credential (account_id, hash) VALUES ($1, $2)
       ON CONFLICT (account_id) DO UPDATE SET hash = EXCLUDED.hash, changed_at = now()`,
      [row.account_id, hash]
    );
    await db.query('UPDATE password_reset_token SET used_at = now() WHERE account_id = $1 AND used_at IS NULL',
      [row.account_id]);

    /* A reset signs out every device. */
    await revokeAllForEmployee(db, {
      employeeId: row.employee_id,
      actor: { employeeId: row.employee_id, name: row.name },
      requestId,
      reason: row.purpose === 'invite' ? 'password_set' : 'password_reset',
    });

    await audit(db, {
      actorId: row.employee_id,
      actorLabel: row.name,
      action: row.purpose === 'invite' ? ACTIONS.PASSWORD_SET : ACTIONS.PASSWORD_RESET,
      entityType: 'account',
      entityId: row.account_id,
      previousState: row.purpose === 'invite' ? 'no_password' : 'password_set',
      newState: 'password_set',
      detail: row.purpose === 'invite' ? `${row.name} set their password` : `${row.name} reset their password`,
      metadata: { ip },
      requestId,
      actorIp: ip,
    });
  });
}
