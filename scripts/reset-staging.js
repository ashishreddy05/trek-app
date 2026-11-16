#!/usr/bin/env node
/* Staging reset.
 *
 * Removes TRANSACTIONAL test data, recreates approved master data and the pilot
 * employees, and leaves the database in a known clean state.
 *
 * SAFETY — five independent guards, all of which must pass:
 *   1. APP_ENV must be exactly 'staging'
 *   2. TREK_ALLOW_STAGING_RESET must be 'yes'
 *   3. DATABASE_URL must not look like production
 *   4. The database must carry a staging marker row, planted by seed-staging
 *   5. --confirm must be passed on the command line
 *
 * This script is NOT a generic database wipe:
 *   · it never drops or truncates a table
 *   · it never touches schema_migrations
 *   · it deletes only from an explicit allowlist of transactional tables
 *   · it is not installed in production (see Dockerfile.prod and RUNBOOK)
 */

import pg from 'pg';

const APP_ENV = process.env.APP_ENV;
const ALLOW = process.env.TREK_ALLOW_STAGING_RESET;
const URL = process.env.DATABASE_URL;
const confirmed = process.argv.includes('--confirm');

function refuse(why) {
  console.error(`\n✗ REFUSING TO RESET\n\n  ${why}\n`);
  process.exit(1);
}

/* ---- guard 1: environment ---- */
if (APP_ENV !== 'staging') {
  refuse(
    `APP_ENV is "${APP_ENV ?? '(unset)'}". This script runs only when APP_ENV=staging.\n` +
    '  There is deliberately no production equivalent of this command.'
  );
}

/* ---- guard 2: explicit opt-in ---- */
if (ALLOW !== 'yes') {
  refuse(
    'TREK_ALLOW_STAGING_RESET is not "yes".\n' +
    '  The staging environment must opt in explicitly. Production never sets this.'
  );
}

/* ---- guard 3: connection string smell test ---- */
if (!URL) refuse('DATABASE_URL is not set.');
const looksProd = /prod|production|live/i.test(URL);
if (looksProd) {
  refuse(
    'DATABASE_URL contains "prod", "production" or "live".\n' +
    '  Refusing on the name alone, regardless of the other guards.'
  );
}

/* ---- guard 5: interactive confirmation ---- */
if (!confirmed) {
  console.error(
    '\nThis will delete all transactional data in the STAGING database.\n\n' +
    '  Re-run with --confirm to proceed:\n' +
    '    npm run reset:staging -- --confirm\n'
  );
  process.exit(1);
}

const client = new pg.Client({
  connectionString: URL,
  ssl: process.env.DATABASE_SSL_MODE === 'disable' ? false : { rejectUnauthorized: process.env.APP_ENV === 'prod' || process.env.APP_ENV === 'production' },
});

/* Master data + identity, rebuilt from migration 003's approved values. */
const MASTER = ['password_credential', 'account_identity', 'account', 'employee', 'cost_center', 'department', 'company'];

/* NEVER touched, at any point, by anything in this file. */
const PROTECTED = ['schema_migrations', 'audit_event'];

/* Also never touched: the currency registry and the rates the company
 * remembers. A reset clears the pilot's transactions, not the reference data
 * the money rules are built on. */
const REFERENCE = ['currency', 'exchange_rate'];

/* The transactional tables are read from the catalogue, not written by hand.
 *
 * A hand-maintained list has to be updated every time a table ships, and the
 * day it is not, that table survives the reset and poisons the next run — which
 * is exactly what happened: the tables that actually shipped
 * (trip_budget_line, trip_fx_plan, trip_fund, expense_bill,
 * trip_reconciliation) were never on the list. They happened to be deleted
 * anyway, because every one of them cascades from trip or expense, so the
 * guard was not what protected them. */
async function transactionalTables() {
  const { rows } = await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`
  );
  return rows
    .map((r) => r.table_name)
    .filter((t) => !PROTECTED.includes(t) && !REFERENCE.includes(t) && !MASTER.includes(t));
}

async function tableExists(name) {
  const { rows } = await client.query(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1
      LIMIT 1`,
    [name]
  );
  return rows.length > 0;
}

async function main() {
  await client.connect();

  const { rows: dbRows } = await client.query('SELECT current_database() as db');
  const dbName = dbRows[0]?.db ?? '';
  if (/prod|production|live/i.test(dbName) || !(/staging|_test$/i.test(dbName))) {
    refuse(`current_database() is "${dbName}". Refusing to reset non-staging database.`);
  }

  /* ---- guard 4: staging marker ---- */
  const marker = await client.query(
    `SELECT 1 FROM audit_event
      WHERE action = 'staging.marker' AND entity_id = 'staging'
      LIMIT 1`
  ).catch(() => ({ rows: [] }));

  if (!marker.rows.length) {
    refuse(
      'This database carries no staging marker.\n' +
      '  Run `npm run seed:staging` on a freshly migrated staging database first —\n' +
      '  it plants the marker. A production database will never have one, so this\n' +
      '  guard holds even if APP_ENV is set wrongly.'
    );
  }

  console.log('\nAll five guards passed. Resetting staging.\n');

  /* Pilot users keep their passwords across a reset so the retest loop doesn't need
   * fresh links every time. --clear-passwords wipes them too. Hashes only. */
  const keepPasswords = !process.argv.includes('--clear-passwords') && (await tableExists('password_credential'));
  const kept = keepPasswords
    ? (await client.query(
        `SELECT a.employee_id, pc.hash, pc.changed_at
           FROM password_credential pc JOIN account a ON a.id = pc.account_id`
      )).rows
    : [];

  await client.query('BEGIN');
  try {
    /* Audit is append-only and permanent. It is NOT reset — a reset is itself an
     * event worth having a record of, and the immutability triggers would refuse
     * a delete anyway. */
    console.log('  audit_event         → PRESERVED (append-only, permanent)');
    console.log('  schema_migrations   → PRESERVED (migration history is never rewritten)');
    console.log('');

    let deleted = 0;
    for (const t of await transactionalTables()) {
      const r = await client.query(`DELETE FROM "${t}"`);
      deleted += r.rowCount;
      console.log(`  ${t.padEnd(20)}→ ${r.rowCount} row(s) deleted`);
    }

    /* First clear circular department head reference so employee deletes can succeed */
    if (await tableExists('department')) {
      await client.query('UPDATE department SET head_id = NULL');
    }

    console.log('');
    /* Clear non-pinned master data (preserving entities referenced by the permanent audit log) */
    const auditPinnedActors = `SELECT DISTINCT actor_id FROM audit_event WHERE actor_id IS NOT NULL
                               UNION SELECT DISTINCT entered_by FROM exchange_rate WHERE entered_by IS NOT NULL`;
    const auditPinnedCompanies = `SELECT DISTINCT company_id FROM audit_event WHERE company_id IS NOT NULL`;

    if (await tableExists('password_credential')) {
      const r = await client.query(`
        DELETE FROM password_credential
        WHERE account_id NOT IN (
          SELECT id FROM account WHERE employee_id IN (${auditPinnedActors})
        )
      `);
      console.log(`  password_credential → ${r.rowCount} row(s) cleared`);
    }

    if (await tableExists('account_identity')) {
      const r = await client.query(`
        DELETE FROM account_identity
        WHERE account_id NOT IN (
          SELECT id FROM account WHERE employee_id IN (${auditPinnedActors})
        )
      `);
      console.log(`  account_identity    → ${r.rowCount} row(s) cleared`);
    }

    if (await tableExists('account')) {
      const r = await client.query(`
        DELETE FROM account
        WHERE employee_id NOT IN (${auditPinnedActors})
      `);
      console.log(`  account             → ${r.rowCount} row(s) cleared`);
    }

    if (await tableExists('employee')) {
      const r = await client.query(`
        DELETE FROM employee
        WHERE id NOT IN (${auditPinnedActors})
      `);
      console.log(`  employee            → ${r.rowCount} row(s) cleared`);
    }

    if (await tableExists('cost_center')) {
      const r = await client.query(`
        DELETE FROM cost_center
        WHERE id NOT IN (SELECT cost_center_id FROM employee WHERE id IN (${auditPinnedActors}))
      `);
      console.log(`  cost_center         → ${r.rowCount} row(s) cleared`);
    }

    if (await tableExists('department')) {
      const r = await client.query(`
        DELETE FROM department
        WHERE id NOT IN (SELECT department_id FROM employee WHERE id IN (${auditPinnedActors}))
      `);
      console.log(`  department          → ${r.rowCount} row(s) cleared`);
    }

    if (await tableExists('company')) {
      const r = await client.query(`
        DELETE FROM company
        WHERE id NOT IN (${auditPinnedCompanies})
      `);
      console.log(`  company             → ${r.rowCount} row(s) cleared`);
    }

    await client.query('COMMIT');
    console.log(`\n  ${deleted} transactional row(s) removed.`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`\n✗ Reset failed and was rolled back:\n\n  ${err.message}\n`);
    process.exit(1);
  } finally {
    await client.end();
  }

  console.log('\nMaster data cleared. Rebuilding with the approved pilot dataset…\n');

  /* Delegate the rebuild rather than duplicating the values: one definition of the
   * approved dataset, in seed-staging.js. */
  const { seedStaging } = await import('./seed-staging.js');
  await seedStaging({ quiet: false, reason: 'reset:staging' });

  if (kept.length) {
    const c2 = new pg.Client({
      connectionString: URL,
      ssl: process.env.DATABASE_SSL_MODE === 'disable' ? false : { rejectUnauthorized: process.env.APP_ENV === 'prod' || process.env.APP_ENV === 'production' },
    });
    await c2.connect();
    let restored = 0;
    for (const k of kept) {
      const r = await c2.query(
        `INSERT INTO password_credential (account_id, hash, changed_at)
         SELECT a.id, $2, $3 FROM account a JOIN employee e ON e.id = a.employee_id
          WHERE e.id = $1 AND e.status = 'active'
         ON CONFLICT (account_id) DO NOTHING`,
        [k.employee_id, k.hash, k.changed_at]
      );
      restored += r.rowCount;
    }
    await c2.end();
    console.log(`\n  ${restored} pilot password(s) kept. Everyone is signed out. Use --clear-passwords to wipe them.`);
  } else {
    console.log('\n  No passwords kept. Issue links with scripts/issue-password-link.js --all-without-password.');
  }

  console.log(
    '\n✓ Staging is in a known clean state.\n' +
    '  Protected throughout: ' + PROTECTED.join(', ') + '\n'
  );
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}\n`);
  process.exit(1);
});
