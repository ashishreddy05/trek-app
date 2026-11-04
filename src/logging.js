/* Structured logging with redaction at the serializer.
 *
 * The redaction is not a convention for developers to remember — it happens on the
 * way out, so a stray log.info({ body }) cannot leak an OTP code or a session token.
 * That matters more than it sounds: the single most likely way a code escapes is
 * someone debugging a request body.
 */

import { config } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logging.level] ?? LEVELS.info;

/* Never logged, at any level, in any shape. */
const REDACT_KEYS = new Set([
  'code', 'codehash', 'code_hash', 'otp',
  'token', 'tokenhash', 'token_hash', 'sessiontoken',
  'password', 'currentpassword', 'newpassword', 'passwordhash', 'hash',
  'reseturl', 'inviteurl', 'url', 'link',
  'secret', 'apikey', 'api_key', 'authorization', 'cookie',
  'databaseurl', 'database_url',
]);

/* PII that must not land in an error payload. */
const REDACT_PII_KEYS = new Set([
  'mobile', 'passportnumber', 'passport_number', 'documentnumber', 'document_number',
]);

function redact(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack, code: undefined };
  }
  if (typeof value !== 'object') return value;

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const key = k.toLowerCase().replace(/[-_]/g, '');
    if (REDACT_KEYS.has(key) || REDACT_KEYS.has(k.toLowerCase())) { out[k] = '[REDACTED]'; continue; }
    if (REDACT_PII_KEYS.has(key)) { out[k] = '[PII]'; continue; }
    // Emails are identifying but necessary for debugging auth. Mask the local part.
    if (key === 'email' || key === 'workemail') { out[k] = maskEmail(v); continue; }
    out[k] = redact(v, depth + 1);
  }
  return out;
}

function maskEmail(email) {
  if (typeof email !== 'string' || !email.includes('@')) return '[email]';
  const [local, domain] = email.split('@');
  const head = local.slice(0, 2);
  return `${head}${'*'.repeat(Math.max(local.length - 2, 1))}@${domain}`;
}

function emit(level, msg, fields) {
  if (LEVELS[level] < threshold) return;
  const line = JSON.stringify({
    at: new Date().toISOString(),
    level,
    env: config.env,
    msg,
    ...redact(fields ?? {}),
  });
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const log = {
  debug: (msg, f) => emit('debug', msg, f),
  info:  (msg, f) => emit('info', msg, f),
  warn:  (msg, f) => emit('warn', msg, f),
  error: (msg, f) => emit('error', msg, f),

  /* A permission failure is a security signal, not noise. Every denial is logged
   * with actor, operation, target and outcome — permissions spec §3.7. */
  denied: ({ requestId, employeeId, operation, targetType, targetId, reason }) =>
    emit('warn', 'authz.denied', { requestId, employeeId, operation, targetType, targetId, reason }),

  child: (base) => ({
    debug: (m, f) => emit('debug', m, { ...base, ...f }),
    info:  (m, f) => emit('info',  m, { ...base, ...f }),
    warn:  (m, f) => emit('warn',  m, { ...base, ...f }),
    error: (m, f) => emit('error', m, { ...base, ...f }),
    denied: log.denied,
  }),
};

/* Error-tool wiring point (Slot 8). Deliberately not an SDK import — the provider is
 * unsigned, and audit logging is NOT this: audit is a product feature in PostgreSQL,
 * permanent and immutable. */
export function reportError(err, context = {}) {
  log.error('unhandled', { err, ...context });
  if (!config.logging.errorDsn) return;
  // TODO(Slot 8): forward to the signed error tool. PII already scrubbed by redact().
}
