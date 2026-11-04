/* Session management.
 *
 * Opaque token + server-side session. Deactivating an employee revokes their sessions
 * immediately. Multiple concurrent sessions per employee are permitted and all revoke
 * together on deactivation.
 */

import { randomBytes, createHash } from 'node:crypto';
import { config } from '../config.js';
import { audit, ACTIONS } from '../audit.js';
import { resolvePrincipal } from './principal.js';

function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

export async function createSession(db, { accountId, employeeId, ip, userAgent }) {
  /* 256 bits of entropy. The token is sent to the client once, in a cookie, and never
   * stored — only its SHA-256. A database dump does not yield usable sessions. */
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.session.ttlHours * 3_600_000);

  const row = await db.one(
    `INSERT INTO session (account_id, employee_id, token_hash, method, user_agent, created_ip, expires_at)
     VALUES ($1, $2, $3, 'password', $4, $5, $6)
     RETURNING id, expires_at`,
    [accountId, employeeId, sha256(token), userAgent ?? null, ip ?? null, expiresAt]
  );

  return { sessionId: row.id, token, expiresAt: row.expires_at };
}

/* Called on every authenticated request. Returns the principal or null.
 *
 * Re-resolving the principal per request is deliberate: it is what makes a role change,
 * a new direct report, or a deactivation take effect on the very next request rather
 * than at the next login. */
export async function principalFromToken(db, token) {
  if (!token) return null;

  const session = await db.one(
    `SELECT id, employee_id, expires_at, revoked_at
       FROM session
      WHERE token_hash = $1`,
    [sha256(token)]
  );

  if (!session) return null;
  if (session.revoked_at) return null;
  if (new Date(session.expires_at) <= new Date()) return null;

  const principal = await resolvePrincipal(db, session.employee_id);
  if (!principal) return null;                    // deactivated mid-session

  return { ...principal, sessionId: session.id };
}

export async function revokeSession(db, { sessionId, actor, requestId, ip }) {
  const row = await db.one(
    `UPDATE session SET revoked_at = now()
      WHERE id = $1 AND revoked_at IS NULL
      RETURNING id, employee_id, account_id`,
    [sessionId]
  );
  if (!row) return false;

  await audit(db, {
    actorId: actor?.employeeId ?? null,
    actorLabel: actor?.name ?? 'system',
    action: ACTIONS.AUTH_LOGOUT,
    entityType: 'account',
    entityId: row.account_id,
    previousState: 'session_active',
    newState: 'session_revoked',
    detail: `${actor?.name ?? 'System'} signed out`,
    metadata: { sessionId },
    requestId,
    actorIp: ip,
  });

  return true;
}

/* Password change: sign out every OTHER device, keep this one. */
export async function revokeOtherSessions(db, { employeeId, keepSessionId }) {
  const r = await db.query(
    `UPDATE session SET revoked_at = now()
      WHERE employee_id = $1 AND revoked_at IS NULL AND id <> $2`,
    [employeeId, keepSessionId ?? '']
  );
  return r.rowCount;
}

/* Deactivation cascade. Employee inactive -> account suspended -> ALL sessions revoked.
 * Employee deactivation calls this from the employee status endpoint; it lives here because session
 * revocation is this module's responsibility. */
export async function revokeAllForEmployee(db, { employeeId, actor, requestId, reason }) {
  const rows = await db.many(
    `UPDATE session SET revoked_at = now()
      WHERE employee_id = $1 AND revoked_at IS NULL
      RETURNING id, account_id`,
    [employeeId]
  );

  if (rows.length) {
    await audit(db, {
      actorId: actor?.employeeId ?? null,
      actorLabel: actor?.name ?? 'system',
      action: ACTIONS.SESSION_REVOKE,
      entityType: 'employee',
      entityId: employeeId,
      previousState: 'session_active',
      newState: 'session_revoked',
      detail: `${rows.length} session${rows.length === 1 ? '' : 's'} revoked`,
      reason: reason ?? null,
      metadata: { sessionCount: rows.length },
      requestId,
    });
  }

  return rows.length;
}

/* Expired sessions and consumed challenges are cleaned by a scheduled job (D-35).
 * No runner exists yet — this is exported ready for it, and is safe to call repeatedly. */
export async function purgeExpired(db) {
  const s = await db.query(`DELETE FROM session WHERE expires_at < now() - interval '30 days'`);
  const t = await db.query(`DELETE FROM password_reset_token WHERE expires_at < now() - interval '7 days'`);
  const a = await db.query(`DELETE FROM login_attempt WHERE at < now() - interval '30 days'`);
  return { sessions: s.rowCount, links: t.rowCount, attempts: a.rowCount };
}

export function cookieOptions() {
  return {
    name: config.session.cookieName,
    httpOnly: true,
    secure: !config.isDev,          // never issue an insecure cookie outside dev
    sameSite: 'Lax',
    path: '/',
    maxAge: config.session.ttlHours * 3600,
  };
}
