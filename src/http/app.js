/* Request handler, shared by two entry points:
 *   src/http/server.js   long-running Node server (local dev)
 *   api/[...path].js     Vercel serverless function
 *
 * Lightweight vanilla HTTP dispatcher with zero external HTTP frameworks.
 */

import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { log, reportError } from '../logging.js';
import * as db from '../db.js';
import { principalFromToken } from '../auth/session.js';
import { AuthError } from '../auth/password.js';
import { AuthzError } from '../authz/guard.js';
import { ValidationError } from '../employees/validate.js';
import {
  postLogin, postLogout, postForgotPassword, postCheckLink, postResetPassword,
  postChangePassword, getMe, patchMe,
} from './routes.auth.js';
import {
  getEmployees, getEmployee, postEmployee, patchEmployee, patchEmployeeRoles,
  patchEmployeeStatus, postEmployeeImport, postEmployeeInvite,
  getDepartments, postDepartment, patchDepartment, getCostCenters, getAudit,
} from './routes.admin.js';
import {
  getTripBudget, postTripBudgetLine, deleteTripBudgetLine,
  getTripForex, putTripForex, deleteTripForex,
  getTripFunds, postTripFund,
  getExpenseBills, postExpenseBill, getBillContent, deleteBillRoute,
  getTripReconciliation, postTripReconciliation, postTripReconciliationDecision,
  postTripSettlement,
  getDashboard, getReportExport,
} from './routes.pilot.js';
import {
  getTrips, getTrip, postTrip, patchTrip, postSubmitTrip, postDecideTrip,
} from './routes.trips.js';
import {
  getExpenses, getExpense, postExpense, patchExpense, deleteExpense,
  postSubmitExpense, postDecideExpense,
} from './routes.expenses.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');

const ROUTES = [
  ['POST',  '/api/v1/auth/login',             postLogin,          { public: true }],
  ['POST',  '/api/v1/auth/logout',            postLogout],
  ['POST',  '/api/v1/auth/password/forgot',   postForgotPassword, { public: true }],
  ['POST',  '/api/v1/auth/password/check',    postCheckLink,      { public: true }],
  ['POST',  '/api/v1/auth/password/reset',    postResetPassword,  { public: true }],
  ['POST',  '/api/v1/auth/password/change',   postChangePassword],
  ['GET',   '/api/v1/me',                     getMe],
  ['PATCH', '/api/v1/me',                     patchMe],

  ['GET',   '/api/v1/employees',              getEmployees],
  ['POST',  '/api/v1/employees',              postEmployee],
  ['POST',  '/api/v1/employees/import',       postEmployeeImport],
  ['GET',   '/api/v1/employees/:id',          getEmployee],
  ['PATCH', '/api/v1/employees/:id',          patchEmployee],
  ['PATCH', '/api/v1/employees/:id/roles',    patchEmployeeRoles],
  ['PATCH', '/api/v1/employees/:id/status',   patchEmployeeStatus],
  ['POST',  '/api/v1/employees/:id/invite',   postEmployeeInvite],

  ['GET',   '/api/v1/departments',            getDepartments],
  ['POST',  '/api/v1/departments',            postDepartment],
  ['PATCH', '/api/v1/departments/:id',        patchDepartment],
  ['GET',   '/api/v1/cost-centers',           getCostCenters],

  ['GET',   '/api/v1/audit',                  getAudit],

  ['GET',    '/api/v1/trips',                 getTrips],
  ['POST',   '/api/v1/trips',                 postTrip],
  ['GET',    '/api/v1/trips/:id',             getTrip],
  ['PATCH',  '/api/v1/trips/:id',             patchTrip],
  ['POST',   '/api/v1/trips/:id/submit',      postSubmitTrip],
  ['POST',   '/api/v1/trips/:id/decide',      postDecideTrip],

  ['GET',    '/api/v1/expenses',              getExpenses],
  ['POST',   '/api/v1/expenses',              postExpense],
  ['GET',    '/api/v1/expenses/:id',          getExpense],
  ['PATCH',  '/api/v1/expenses/:id',          patchExpense],
  ['DELETE', '/api/v1/expenses/:id',          deleteExpense],
  ['POST',   '/api/v1/expenses/:id/submit',   postSubmitExpense],
  ['POST',   '/api/v1/expenses/:id/decide',   postDecideExpense],

  // ---- budget, currency plan, funds ----
  ['GET',    '/api/v1/trips/:id/budget',             getTripBudget],
  ['POST',   '/api/v1/trips/:id/budget',             postTripBudgetLine],
  ['DELETE', '/api/v1/trips/:id/budget/:lineId',     deleteTripBudgetLine],
  ['GET',    '/api/v1/trips/:id/forex',              getTripForex],
  ['PUT',    '/api/v1/trips/:id/forex',              putTripForex],
  ['DELETE', '/api/v1/trips/:id/forex/:planId',      deleteTripForex],
  ['GET',    '/api/v1/trips/:id/funds',              getTripFunds],
  ['POST',   '/api/v1/trips/:id/funds',              postTripFund],

  // ---- bills (receipts) ----
  ['GET',    '/api/v1/expenses/:id/bills',           getExpenseBills],
  ['POST',   '/api/v1/expenses/:id/bills',           postExpenseBill, { binary: true }],
  ['GET',    '/api/v1/bills/:id/content',            getBillContent],
  ['DELETE', '/api/v1/bills/:id',                    deleteBillRoute],

  // ---- reconciliation & settlement ----
  ['GET',    '/api/v1/trips/:id/reconciliation',            getTripReconciliation],
  ['POST',   '/api/v1/trips/:id/reconciliation',            postTripReconciliation],
  ['POST',   '/api/v1/trips/:id/reconciliation/decide',     postTripReconciliationDecision],
  ['POST',   '/api/v1/trips/:id/settle',                    postTripSettlement],

  // ---- reporting ----
  ['GET',    '/api/v1/dashboard',                   getDashboard],
  ['GET',    '/api/v1/reports/export.csv',         getReportExport],
];

/* Literal routes are matched before parameterised ones, so /employees/import is never
 * captured by /employees/:id. */
const COMPILED = ROUTES.map(([method, path, handler, opts = {}]) => {
  const keys = [];
  const pattern = path.split('/').map((seg) => {
    if (!seg.startsWith(':')) return seg;
    keys.push(seg.slice(1));
    return '([^/]+)';
  }).join('/');
  return { method, handler, opts, keys, literal: keys.length === 0, regex: new RegExp(`^${pattern}$`) };
}).sort((a, b) => Number(b.literal) - Number(a.literal));

function matchRoute(method, pathname) {
  for (const r of COMPILED) {
    if (r.method !== method) continue;
    const m = r.regex.exec(pathname);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    return { ...r, params };
  }
  return null;
}

/* ---- helpers ------------------------------------------------------------- */

/* JSON request bodies. */
async function readBody(req) {
  /* Vercel's Node runtime parses the body before the handler runs. */
  let pre;
  try { pre = req.body; } catch { throw new Error('bad_json'); }
  if (pre !== undefined) {
    if (pre === null || pre === '') return {};
    if (Buffer.isBuffer(pre)) pre = pre.toString('utf8');
    if (typeof pre === 'string') {
      try { return JSON.parse(pre); } catch { throw new Error('bad_json'); }
    }
    return pre;
  }

  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) { reject(new Error('payload_too_large')); req.destroy(); return; }
      raw += c;
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('bad_json')); }
    });
    req.on('error', reject);
  });
}

/* A receipt upload. Two shapes are accepted:
 *
 *   1. A JSON envelope — { filename, contentType, content: <base64> } — which is
 *      what the browser sends. It travels through the same body path as
 *      everything else, so no multipart parser is needed.
 *   2. Raw bytes, with the file's name in the `x-filename` header. Useful for
 *      curl and for any client that would rather not base64 a photo.
 */
async function readBinaryBody(req, { maxBytes = 5 * 1024 * 1024 } = {}) {
  let pre;
  try { pre = req.body; } catch { throw new Error('bad_json'); }

  /* Already parsed by the platform (Vercel) or by a framework. */
  if (pre !== undefined && pre !== null && pre !== '') {
    if (Buffer.isBuffer(pre)) {
      return { content: pre, filename: req.headers['x-filename'], contentType: pre.type || req.headers['content-type'] };
    }
    if (typeof pre === 'string') {
      try {
        const parsed = JSON.parse(pre);
        return {
          content: Buffer.from(parsed.content ?? '', 'base64'),
          filename: parsed.filename,
          contentType: parsed.contentType,
        };
      } catch { throw new Error('bad_json'); }
    }
    return {
      content: Buffer.from(pre.content ?? '', 'base64'),
      filename: pre.filename,
      contentType: pre.contentType,
    };
  }

  /* Nothing pre-parsed: read the raw bytes and decide afterwards. */
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(new Error('payload_too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      /* The JSON envelope arrives as text; raw bytes do not parse as JSON. */
      const text = raw.toString('utf8');
      if (text.startsWith('{')) {
        try {
          const parsed = JSON.parse(text);
          return resolve({
            content: Buffer.from(parsed.content ?? '', 'base64'),
            filename: parsed.filename,
            contentType: parsed.contentType,
          });
        } catch { /* not JSON after all — treat as bytes */ }
      }
      resolve({
        content: raw,
        filename: req.headers['x-filename'],
        contentType: req.headers['content-type'],
      });
    });
    req.on('error', reject);
  });
}

function parseCookies(header = '') {
  return Object.fromEntries(
    header.split(';').map((p) => p.trim().split('=')).filter((kv) => kv.length === 2)
      .map(([k, v]) => [k, decodeURIComponent(v)])
  );
}

function serialiseCookie({ name, value, httpOnly, secure, sameSite, path, maxAge }) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `Max-Age=${maxAge}`, `SameSite=${sameSite}`];
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/* Only a well-formed IP reaches the inet columns; anything else is recorded as null. */
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  const candidate = typeof fwd === 'string' && fwd.length
    ? fwd.split(',')[0].trim()
    : req.socket?.remoteAddress ?? null;
  return candidate && isIP(candidate) ? candidate : null;
}

/* Inline style ATTRIBUTES are allowed (style-src-attr) because the approved UI uses
 * them. Inline <script> and <style> elements are not. */
export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
};

function send(res, status, body, headers = {}, cookie = null) {
  const h = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...headers,
  };
  if (!config.isDev) h['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  if (cookie) h['Set-Cookie'] = serialiseCookie(cookie);
  res.writeHead(status, h);
  /* A handler may return raw bytes (a receipt download, a CSV export) instead
   * of a JSON body. */
  if (body === null) res.end();
  else if (Buffer.isBuffer(body)) res.end(body);
  else res.end(JSON.stringify(body));
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

/* Local / Docker only. On Vercel the platform serves public/ itself. */
async function serveStatic(res, pathname) {
  const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 404, { error: { code: 'not_found', message: 'Not found.' } });

  try {
    const s = await stat(filePath);
    if (!s.isFile()) throw new Error('not a file');
    const ext = extname(filePath);
    /* The app's own JS and CSS are NOT fingerprinted, so a cached copy would
     * outlive the deploy that replaced it — a stale script against a new API.
     * They must revalidate. Everything else (brand images) can be cached. */
    const cacheable = !['.html', '.js', '.css'].includes(ext);
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': cacheable ? 'public, max-age=3600' : 'no-cache, must-revalidate',
      ...SECURITY_HEADERS,
      ...(config.isDev ? {} : { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' }),
    });
    res.end(await readFile(filePath));
  } catch {
    if (!extname(rel)) return serveStatic(res, '/index.html');
    send(res, 404, { error: { code: 'not_found', message: 'Not found.' } });
  }
}

function errorResponse(err) {
  if (err instanceof ValidationError || (err.status === 422 && err.fields)) {
    return { status: 422, body: { error: { code: 'validation_failed', message: err.message, fields: err.fields } } };
  }
  if (err instanceof AuthError || err instanceof AuthzError || (err.status && err.code)) {
    return { status: err.status, body: { error: { code: err.code, message: err.message, ...(err.extra ?? {}) } } };
  }
  if (err.message === 'bad_json') {
    return { status: 400, body: { error: { code: 'bad_request', message: 'Malformed JSON body.' } } };
  }
  if (err.message === 'payload_too_large') {
    return { status: 413, body: { error: { code: 'bad_request', message: 'Payload too large.' } } };
  }
  return { status: 500, body: { error: { code: 'internal_error', message: 'Something went wrong on our side.' } } };
}

/* ---- handler ------------------------------------------------------------- */

export async function handle(req, res) {
  const requestId = randomUUID();
  const url = new URL(req.url, config.baseUrl);
  const path = url.pathname;
  const started = Date.now();

  if (path === '/healthz' || path === '/api/healthz') return send(res, 200, { ok: true });
  if (path === '/readyz' || path === '/api/readyz') {
    const [dbOk, migrated] = await Promise.all([db.healthy(), db.migrationsCurrent()]);
    return send(res, dbOk && migrated ? 200 : 503, { db: dbOk, migrations: migrated });
  }

  if (!path.startsWith('/api/')) return serveStatic(res, path);

  const route = matchRoute(req.method, path);
  if (!route) return send(res, 404, { error: { code: 'not_found', message: 'Not found.' } });

  try {
    /* A binary route (a receipt upload) gets its bytes rather than parsed JSON. */
    const body = ['POST', 'PATCH', 'PUT'].includes(req.method)
      ? (route.opts.binary ? await readBinaryBody(req) : await readBody(req))
      : {};
    const cookies = parseCookies(req.headers.cookie);

    /* The principal is re-resolved on every request, so deactivation and role changes
     * take effect immediately. */
    const principal = route.opts.public
      ? null
      : await principalFromToken(db, cookies[config.session.cookieName]);

    if (!route.opts.public && !principal) {
      return send(res, 401, { error: { code: 'unauthenticated', message: 'Sign in to continue.' } });
    }

    const ctx = {
      db, body, principal, requestId,
      params: route.params,
      ip: clientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
      query: url.searchParams,
    };

    const result = await route.handler(ctx);
    send(res, result.status, result.body ?? result.raw ?? null, result.headers, result.cookie);

    log.info('http', {
      requestId, method: req.method, path, status: result.status,
      ms: Date.now() - started, employeeId: principal?.employeeId,
    });
  } catch (err) {
    const { status, body } = errorResponse(err);
    if (status >= 500) reportError(err, { requestId, path, method: req.method });
    else log.warn('http.error', { requestId, path, status, code: body.error.code });
    send(res, status, body);
  }
}
