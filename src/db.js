/* PostgreSQL access. Raw SQL through `pg`.
 *
 * No ORM: ST-02 is unsigned, and choosing one here would be a decision this repo is
 * not entitled to make. The SQL in each module's queries is the specification to port
 * if an ORM is signed later.
 */

import pg from 'pg';
import { config } from './config.js';
import { log } from './logging.js';
import { expectedMigrations } from './migrations.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.db.url,
  max: config.db.poolMax,
  ssl: config.db.sslMode === 'disable' ? false : { rejectUnauthorized: config.isProd },
  application_name: `trek-${config.env}`,
});

pool.on('error', (err) => log.error('pg.pool', { err }));

export async function query(text, params) {
  const started = Date.now();
  try {
    return await pool.query(text, params);
  } finally {
    const ms = Date.now() - started;
    if (ms > 500) log.warn('pg.slow', { ms, text: text.slice(0, 120) });
  }
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
    await client.query('ROLLBACK');
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
