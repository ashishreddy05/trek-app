#!/usr/bin/env node
/* Staging seed — the standard pilot dataset, restorable without touching the database
 * by hand.
 *
 * Idempotent: ON CONFLICT DO NOTHING throughout, so running it twice is safe and
 * running it on a partially-seeded database completes it.
 *
 * Values are the APPROVED master data from migration 003. This script does not invent
 * employees, departments, cost centers or policies. If a value is not in the approved
 * dataset it is not here.
 *
 * Refuses to run against production.
 */

import pg from 'pg';

const COMPANY = { id: 'co_trek', name: 'GaragePlug', currency: 'SAR', domains: ['garageplug.com'] };

const DEPARTMENTS = [
  ['dep_sls', 'SLS', 'Sales'],
  ['dep_mkt', 'MKT', 'Marketing'],
  ['dep_csm', 'CSM', 'Customer Success'],
  ['dep_fin', 'FIN', 'Finance'],
  ['dep_hrt', 'HRT', 'HR / Travel'],
  ['dep_adm', 'ADM', 'Admin'],
];

const COST_CENTERS = [
  ['cc_ccsls01', 'dep_sls', 'CC-SLS-01', 'Sales — field'],
  ['cc_ccmkt01', 'dep_mkt', 'CC-MKT-01', 'Marketing — events'],
  ['cc_cccsm01', 'dep_csm', 'CC-CSM-01', 'Customer Success — onsite'],
  ['cc_ccfin01', 'dep_fin', 'CC-FIN-01', 'Finance'],
  ['cc_cchrt01', 'dep_hrt', 'CC-HRT-01', 'HR / Travel'],
  ['cc_ccadm01', 'dep_adm', 'CC-ADM-01', 'Admin'],
];

/* id, code, name, email, dept, designation, grade, managerId, costCenter, location, joined, roles */
const EMPLOYEES = [
  // Function roles. manager_id NULL by design — see BD-02.
  ['emp_1001', 'GP-0007', 'Vikram Shetty', 'vikram.shetty@garageplug.com', 'dep_sls', 'VP Sales',               'G6', null,       'cc_ccsls01', 'Riyadh', '2021-03-15', ['employee', 'manager']],
  ['emp_1002', 'GP-0002', 'Ravi Nambiar',  'ravi.nambiar@garageplug.com',  'dep_fin', 'Finance Controller',      'G6', null,       'cc_ccfin01', 'Riyadh', '2020-07-01', ['employee', 'finance']],
  ['emp_1004', 'GP-0004', 'Sara Mansour',  'sara.mansour@garageplug.com',  'dep_hrt', 'Travel Desk Lead',        'G4', null,       'cc_cchrt01', 'Riyadh', '2022-01-10', ['employee', 'hr_travel']],
  // Temporary bootstrap account; personnel fields are test placeholders (migration 003).
  ['emp_1000', 'TEST-ADMIN', 'Ashish Reddy', 'ashishreddy@garageplug.com', 'dep_adm', 'Temporary test administrator', 'G1', null, 'cc_ccadm01', 'Not configured', new Date().toISOString().slice(0, 10), ['employee', 'admin']],
  // Five Sales travellers.
  ['emp_1231', 'GP-0231', 'Suresh Kumar',  'suresh.kumar@garageplug.com',  'dep_sls', 'Senior Account Executive','G4', 'emp_1001', 'cc_ccsls01', 'Riyadh', '2023-02-06', ['employee']],
  ['emp_1232', 'GP-0232', 'Nadia Haddad',  'nadia.haddad@garageplug.com',  'dep_sls', 'Account Executive',       'G3', 'emp_1001', 'cc_ccsls01', 'Jeddah', '2023-09-11', ['employee']],
  ['emp_1233', 'GP-0233', 'Omar Farouk',   'omar.farouk@garageplug.com',   'dep_sls', 'Account Executive',       'G3', 'emp_1001', 'cc_ccsls01', 'Riyadh', '2024-01-15', ['employee']],
  ['emp_1234', 'GP-0234', 'Meera Iyer',    'meera.iyer@garageplug.com',    'dep_sls', 'Enterprise Account Manager','G4','emp_1001','cc_ccsls01', 'Riyadh', '2022-06-01', ['employee']],
  ['emp_1235', 'GP-0235', 'Tom Whitfield', 'tom.whitfield@garageplug.com', 'dep_sls', 'Regional Sales Manager',  'G3', 'emp_1001', 'cc_ccsls01', 'London', '2023-04-18', ['employee']],
];

const HEADS = [['dep_sls', 'emp_1001'], ['dep_fin', 'emp_1002'], ['dep_hrt', 'emp_1004'], ['dep_adm', 'emp_1000']];

export async function seedStaging({ quiet = false, reason = 'seed:staging', client: existing = null } = {}) {
  const log = quiet ? () => {} : (s) => console.log(s);

  const client = existing ?? new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL_MODE === 'disable' ? false : { rejectUnauthorized: false },
  });
  if (!existing) await client.connect();

  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO company (id, name, base_currency, domains)
       VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`,
      [COMPANY.id, COMPANY.name, COMPANY.currency, COMPANY.domains]
    );

    for (const [id, code, name] of DEPARTMENTS) {
      await client.query(
        `INSERT INTO department (id, company_id, code, name, active)
         VALUES ($1,'co_trek',$2,$3,true) ON CONFLICT (id) DO NOTHING`,
        [id, code, name]
      );
    }

    for (const [id, dept, code, name] of COST_CENTERS) {
      await client.query(
        `INSERT INTO cost_center (id, company_id, department_id, code, name, active)
         VALUES ($1,'co_trek',$2,$3,$4,true) ON CONFLICT (id) DO NOTHING`,
        [id, dept, code, name]
      );
    }

    /* Two passes: employees without managers first, so manager_id FKs resolve
     * regardless of array order. */
    for (const pass of [0, 1]) {
      for (const e of EMPLOYEES) {
        const hasManager = e[7] !== null;
        if ((pass === 0) === hasManager) continue;
        await client.query(
          `INSERT INTO employee (id, company_id, employee_code, name, work_email, department_id,
                                 designation, grade, manager_id, cost_center_id, location,
                                 joining_date, status, roles)
           VALUES ($1,'co_trek',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active',$12)
           ON CONFLICT (id) DO NOTHING`,
          [e[0], e[1], e[2], e[3], e[4], e[5], e[6], e[7], e[8], e[9], e[10], e[11]]
        );
      }
    }

    for (const [dept, head] of HEADS) {
      await client.query('UPDATE department SET head_id = $2 WHERE id = $1', [dept, head]);
    }

    await client.query(
      `INSERT INTO account (company_id, employee_id, status)
       SELECT company_id, id, 'active'::account_status FROM employee
       ON CONFLICT (employee_id) DO NOTHING`
    );

    await client.query(
      `INSERT INTO account_identity (account_id, provider, subject)
       SELECT a.id, 'password', lower(e.work_email)
         FROM account a JOIN employee e ON e.id = a.employee_id
       ON CONFLICT (provider, subject) DO NOTHING`
    );

    /* The staging marker. reset-staging.js refuses to run without it, which is the
     * guard that holds even if APP_ENV is set wrongly — a production database will
     * never have this row. */
    await client.query(
      `INSERT INTO audit_event (company_id, actor_id, actor_label, action, entity_type,
                                entity_id, new_state, detail, metadata)
       VALUES ('co_trek', NULL, 'system', 'staging.marker', 'environment', 'staging',
               'seeded', $1, $2)`,
      [
        `Staging pilot dataset seeded (${reason})`,
        JSON.stringify({ reason, at: new Date().toISOString(), employees: EMPLOYEES.length }),
      ]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    if (!existing) await client.end();
  }

  log(`  company          → ${COMPANY.name}`);
  log(`  departments      → ${DEPARTMENTS.length}`);
  log(`  cost centers     → ${COST_CENTERS.length}`);
  log(`  employees        → ${EMPLOYEES.length} (6 Sales active, incl. the manager)`);
  log(`  accounts         → ${EMPLOYEES.length}, email_otp identity each`);
  log('');
  log('  ⚠ 4 employees have no manager (BD-02 unsigned) — Vikram Shetty among them.');
  log('    Their own travel requests will be refused with 422 no_approval_route.');

  return { employees: EMPLOYEES.length };
}

/* ---- CLI ---- */
if (import.meta.url === `file://${process.argv[1]}`) {
  const APP_ENV = process.env.APP_ENV;

  if (APP_ENV === 'prod') {
    console.error(
      '\n✗ REFUSING\n\n' +
      '  APP_ENV=prod. Production is seeded once, by migration, with approved master\n' +
      '  data and real employee accounts — never by this script.\n'
    );
    process.exit(1);
  }
  if (/prod|production|live/i.test(process.env.DATABASE_URL ?? '')) {
    console.error('\n✗ REFUSING — DATABASE_URL looks like production.\n');
    process.exit(1);
  }

  console.log('\nSeeding the standard pilot dataset\n');
  seedStaging({ reason: 'seed:staging' })
    .then(() => { console.log('\n✓ Done.\n'); process.exit(0); })
    .catch((err) => { console.error(`\n✗ ${err.message}\n`); process.exit(1); });
}
