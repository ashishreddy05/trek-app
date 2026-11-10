/* PostgreSQL access. Direct SQL through `pg` connection pool and transactions. */

import pg from 'pg';
import { config } from './config.js';
import { log } from './logging.js';
import { expectedMigrations } from './migrations.js';

// Return Postgres DATE (OID 1082) as exact 'YYYY-MM-DD' string rather than local midnight Date.
pg.types.setTypeParser(1082, (val) => val);

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.db.url,
  max: config.db.poolMax,
  ssl: config.db.sslMode === 'disable' ? false : { rejectUnauthorized: config.isProd },
  application_name: `trek-${config.env}`,
  /* A pooled connection that has been idle can be closed by the pooler without
   * the client noticing. The pool discards such a client, but the query that
   * was waiting on it fails — and on a serverless instance that is the user's
   * request, not a background job. These bounds keep connections well inside
   * the pooler's own idle window. */
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  keepAlive: true,
});

pool.on('error', (err) => log.error('pg.pool', { err }));

/* Connection-level failures, as opposed to query failures. The query never ran,
 * so running it again on a fresh connection is safe and correct. */
const CONNECTION_ERRORS = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH',
  '57P01',  /* admin_shutdown */
  '08000', '08003', '08006', '08001', '08004',
]);

function isConnectionError(err) {
  if (!err) return false;
  if (CONNECTION_ERRORS.has(err.code)) return true;
  return /terminated|closed the connection|connection ended|server closed/i.test(err.message ?? '');
}

export async function query(text, params) {
  try {
    return await run(text, params);
  } catch (err) {
    /* One retry on a fresh connection. A dropped connection is a fact about the
     * wire, not about the query, and the first attempt never reached the
     * server. */
    if (!isConnectionError(err)) throw err;
    log.warn('pg.retry', { code: err.code, text: text.slice(0, 120) });
    return await run(text, params);
  }
}

async function run(text, params) {
  const started = Date.now();
  const result = await pool.query(text, params);
  const ms = Date.now() - started;
  if (ms > 500) log.warn('pg.slow', { ms, text: text.slice(0, 120) });
  return result;
}

export async function one(text, params) {
  const { rows } = await query(text, params);
  return rows[0] ?? null;
}

export async function many(text, params) {
  const { rows } = await query(text, params);
  return rows;
}

/* Transactions.
 *
 * Everything that writes an audit event writes it INSIDE the transaction of the
 * operation that caused it. Settlement posting later depends on this being the only
 * way transactions are opened: all four tables or none.
 */
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const scoped = {
      query: (t, p) => client.query(t, p),
      one: async (t, p) => (await client.query(t, p)).rows[0] ?? null,
      many: async (t, p) => (await client.query(t, p)).rows,
    };
    const result = await fn(scoped);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    /* A dead connection cannot roll back — it is already gone. Swallowing the
     * rollback error keeps the original failure, which is the one worth
     * reporting. */
    try { await client.query('ROLLBACK'); } catch { /* the connection is gone */ }
    throw err;
  } finally {
    client.release();
  }
}

export async function healthy() {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/* Readiness also checks migration state: a booted process against an un-migrated
 * database serves 500s that look like application bugs. Ready means every migration
 * shipped with THIS build is applied with an unchanged checksum — not merely that
 * some migration ran. A database ahead of the code (rollback after a new migration)
 * stays ready: schema only grows forward, and the missing files are not this build's. */
export async function migrationsCurrent() {
  try {
    const expected = await expectedMigrations();
    const { rows } = await pool.query('SELECT filename, checksum FROM schema_migrations');
    const applied = new Map(rows.map((r) => [r.filename, r.checksum]));
    return expected.every((m) => applied.get(m.file) === m.checksum);
  } catch {
    return false;
  }
}

export async function close() {
  await pool.end();
}
