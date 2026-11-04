/* Boot-time configuration. Read once, validated once, and throws on a missing required
 * key instead of starting half-configured.
 *
 * Nothing here reaches a client except `publicConfig`.
 */

const env = process.env;

function required(key) {
  const v = env[key];
  if (v === undefined || v === '') {
    throw new Error(`Missing required environment variable: ${key}. See .env.example.`);
  }
  return v;
}

function int(key, fallback) {
  const v = env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`${key} must be an integer, got "${v}"`);
  return n;
}

const APP_ENV = env.APP_ENV ?? 'dev';
const isProd = APP_ENV === 'prod';
const isStaging = APP_ENV === 'staging';
const isDev = APP_ENV === 'dev';
const onVercel = Boolean(env.VERCEL);

export const config = {
  env: APP_ENV,
  isProd,
  isStaging,
  isDev,
  onVercel,
  port: int('PORT', 3000),
  baseUrl: required('APP_BASE_URL').replace(/\/+$/, ''),

  db: {
    url: required('DATABASE_URL'),
    sslMode: env.DATABASE_SSL_MODE ?? 'require',
    /* Serverless: many short-lived instances, so keep each pool small and connect
     * through the provider's pooled URL. */
    poolMax: int('DATABASE_POOL_MAX', onVercel ? 3 : 10),
  },

  session: {
    cookieName: env.SESSION_COOKIE_NAME ?? 'trek_session',
    ttlHours: int('SESSION_TTL_HOURS', 12),
  },

  mail: {
    driver: env.MAIL_DRIVER ?? (isDev ? 'console' : 'disabled'),
    apiKey: env.MAIL_API_KEY,
    fromAddress: env.MAIL_FROM_ADDRESS,
    fromName: env.MAIL_FROM_NAME ?? 'Trek',
    stream: env.MAIL_STREAM,
  },

  logging: {
    level: env.LOG_LEVEL ?? 'info',
    errorDsn: env.ERROR_LOGGING_DSN,
  },

  loginEmailDomains: (env.LOGIN_EMAIL_DOMAINS ?? 'garageplug.com')
    .split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),
};

/* ---------------------------------------------------------------- boot guards */

const DRIVERS = ['resend', 'postmark', 'console', 'disabled'];
if (!DRIVERS.includes(config.mail.driver)) {
  throw new Error(`MAIL_DRIVER must be one of ${DRIVERS.join(', ')}; got "${config.mail.driver}".`);
}
if (config.mail.driver === 'console' && !isDev) {
  throw new Error(`MAIL_DRIVER=console is refused when APP_ENV=${APP_ENV}. Use resend, postmark or disabled.`);
}
if (['resend', 'postmark'].includes(config.mail.driver)) {
  required('MAIL_API_KEY');
  required('MAIL_FROM_ADDRESS');
}
if (config.mail.driver === 'disabled' && !isDev) {
  process.stderr.write(JSON.stringify({
    level: 'warn', msg: 'mail.disabled',
    detail: 'Forgot-password and sign-in-link emails cannot be sent. Operators must issue links from the command line.',
  }) + '\n');
}
if (isProd && config.db.sslMode === 'disable') {
  throw new Error('DATABASE_SSL_MODE=disable is refused in prod.');
}
if ((isProd || isStaging) && !config.baseUrl.startsWith('https://')) {
  throw new Error(`APP_BASE_URL must be https outside dev, got "${config.baseUrl}".`);
}
if (config.session.ttlHours > 12 && isProd) {
  throw new Error('SESSION_TTL_HOURS may not exceed 12 in prod (spec).');
}

export const publicConfig = { env: config.env, baseUrl: config.baseUrl };
