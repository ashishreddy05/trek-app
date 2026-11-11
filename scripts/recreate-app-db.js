#!/usr/bin/env node
/* Recreate the app database from the migrations in this repo.
 *
 * Why a full recreate rather than a cleanup: audit_event is append-only by
 * design, so the seed-era rows ("9 employees", "Removed original demo employee
 * accounts") cannot be deleted by any role. The only way to leave a database
 * whose every row is real is to build it again from the migrations.
 *
 * The two administrators' password hashes are carried across, so nobody's
 * password changes. Sessions are not carried across — they must sign in again.
 *
 * Usage: node scripts/recreate-app-db.js <database-name>
 */

import pg from 'pg';
import { readFile } from 'node:fs/promises';

const target = process.argv[2];
if (!target) {
  console.error('Usage: node scripts/recreate-app-db.js <database-name>');
  process.exit(1);
}
if (!process.env.DATABASE_URL_UNPOOLED) {
  console.error('DATABASE_URL_UNPOOLED must be set.');
  process.exit(1);
}

const url = new URL(process.env.DATABASE_URL_UNPOOLED);
const admin = new URL(url);
admin.pathname = '/postgres';

const conn = (target) => new pg.Client({
  connectionString: (() => { const u = new URL(url); u.pathname = `/${target}`; return u.toString(); })(),
  ssl: { rejectUnauthorized: true },
});

/* Password hashes are the only thing worth keeping across a rebuild. */
const hashes = await (async () => {
  const c = conn(target);
  await c.connect();
  const { rows } = await c.query(
    `SELECT e.work_email, pc.hash, pc.changed_at
       FROM password_credential pc
       JOIN account a ON a.id = pc.account_id
       JOIN employee e ON e.id = a.employee_id`
  );
  await c.end();
  return rows;
})();

console.log(`\nRecreating "${target}". Carrying over ${hashes.length} password hash(es).\n`);

const c = conn('postgres');
await c.connect();

await c.query(
  `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
    WHERE datname = $1 AND pid <> pg_backend_pid()`,
  [target]
);
await c.query(`DROP DATABASE IF EXISTS "${target}"`);
await c.query(`CREATE DATABASE "${target}" OWNER neondb_owner`);
console.log('  created');
await c.end();

/* Apply the migrations, exactly as scripts/migrate.js does. */
const { expectedMigrations } = await import('../src/migrations.js');
const m = conn(target);
await m.connect();
await m.query(
  `CREATE TABLE IF NOT EXISTS schema_migrations (
     filename text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz DEFAULT now())`
);
for (const f of await expectedMigrations()) {
  await m.query('BEGIN');
  try {
    await m.query(f.sql);
    await m.query(
      `INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)
       ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum`,
      [f.file, f.checksum]
    );
    await m.query('COMMIT');
    console.log(`  applied ${f.file}`);
  } catch (err) {
    await m.query('ROLLBACK');
    throw new Error(`${f.file}: ${err.message}`);
  }
}

/* Restore the passwords. The hash format is portable; the account ids are not,
 * so the rows are re-pointed by email. */
for (const h of hashes) {
  const { rows } = await m.query(
    `SELECT a.id FROM account a JOIN employee e ON e.id = a.employee_id
      WHERE lower(e.work_email) = lower($1)`,
    [h.work_email]
  );
  if (!rows.length) continue;
  await m.query(
    `INSERT INTO password_credential (account_id, hash, changed_at) VALUES ($1, $2, $3)
     ON CONFLICT (account_id) DO UPDATE SET hash = EXCLUDED.hash, changed_at = EXCLUDED.changed_at`,
    [rows[0].id, h.hash, h.changed_at]
  );
  console.log(`  password restored for ${h.work_email}`);
}

/* The restricted runtime role. It stays NOLOGIN — it exists so the app can be
 * switched to least-privilege without a schema change. */
await m.query(`
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trek_app') THEN
      CREATE ROLE trek_app NOLOGIN;
    END IF;
  END $$;
  GRANT USAGE ON SCHEMA public TO trek_app;
  GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO trek_app;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO trek_app;
  REVOKE UPDATE ON audit_event FROM trek_app;
  REVOKE INSERT, UPDATE ON schema_migrations FROM trek_app;
  GRANT DELETE ON session, password_reset_token, login_attempt TO trek_app;
`);
console.log('  grants applied to trek_app');
await m.end();

const grantUrl = new URL(url);
grantUrl.pathname = '/postgres';
const g = new pg.Client({ connectionString: grantUrl.toString(), ssl: { rejectUnauthorized: true } });
await g.connect();
await g.query(`GRANT CONNECT ON DATABASE "${target}" TO trek_app`);
await g.end();

console.log(`\n✓ "${target}" rebuilt from the migrations in this repo.\n`);
