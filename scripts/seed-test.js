/* Test fixtures — disposable databases only.
 *
 * These rows exist so the suite has a manager, a finance user, a travel desk and
 * five travellers to exercise reporting lines, approvals and the money paths
 * against. They are fixtures, not people: the names say so, and the addresses sit
 * in the reserved .test domain (RFC 2606), which can never belong to a real
 * colleague and can never sign in to a real deployment.
 *
 * The two guards below are why this file can never touch company data: the
 * database must end in _test, and the environment must not be production.
 */

import pg from 'pg';

if (process.env.APP_ENV !== 'dev') throw new Error('Test fixtures require APP_ENV=dev.');

const FIXTURE_DOMAIN = 'garageplug.test';

if (!String(process.env.LOGIN_EMAIL_DOMAINS ?? '').split(',')
  .map((d) => d.trim().toLowerCase()).includes(FIXTURE_DOMAIN)) {
  throw new Error(
    `Test fixtures need ${FIXTURE_DOMAIN} in LOGIN_EMAIL_DOMAINS so the fixture accounts can sign in.`
  );
}

/* id, code, name, email, dept, designation, grade, manager, cost center, roles */
const EMPLOYEES = [
  ['emp_t01', 'TST-0001', 'Test Manager', 'test.manager@garageplug.test', 'dep_sls', 'Sales Manager', 'G6', null, 'cc_ccsls01', ['employee', 'manager']],
  ['emp_t02', 'TST-0002', 'Test Finance', 'test.finance@garageplug.test', 'dep_fin', 'Finance Controller', 'G6', null, 'cc_ccfin01', ['employee', 'finance']],
  ['emp_t03', 'TST-0004', 'Test Travel Lead', 'test.travel@garageplug.test', 'dep_hrt', 'Travel Desk Lead', 'G4', null, 'cc_cchrt01', ['employee', 'hr_travel']],

  ['emp_t04', 'TST-0031', 'Test Traveller One', 'test.traveller.one@garageplug.test', 'dep_sls', 'Account Executive', 'G4', 'emp_t01', 'cc_ccsls01', ['employee']],
  ['emp_t05', 'TST-0032', 'Test Traveller Two', 'test.traveller.two@garageplug.test', 'dep_sls', 'Account Executive', 'G3', 'emp_t01', 'cc_ccsls01', ['employee']],
  ['emp_t06', 'TST-0033', 'Test Traveller Three', 'test.traveller.three@garageplug.test', 'dep_sls', 'Account Executive', 'G3', 'emp_t01', 'cc_ccsls01', ['employee']],
  ['emp_t07', 'TST-0034', 'Test Traveller Four', 'test.traveller.four@garageplug.test', 'dep_sls', 'Account Executive', 'G4', 'emp_t01', 'cc_ccsls01', ['employee']],
  ['emp_t08', 'TST-0035', 'Test Traveller Five', 'test.traveller.five@garageplug.test', 'dep_sls', 'Account Executive', 'G3', 'emp_t01', 'cc_ccsls01', ['employee']],
];

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL_MODE === 'disable' ? false : { rejectUnauthorized: true },
});
await client.connect();
try {
  const { rows } = await client.query('SELECT current_database() AS name');
  if (!rows[0].name.endsWith('_test')) {
    throw new Error('Use a disposable database ending in _test. Never run tests on the app database.');
  }

  await client.query('BEGIN');

  /* Two passes, employees without managers first, so manager_id resolves. */
  for (const pass of [0, 1]) {
    for (const e of EMPLOYEES) {
      const hasManager = e[7] !== null;
      if ((pass === 0) === hasManager) continue;
      await client.query(
        `INSERT INTO employee (id, company_id, employee_code, name, work_email, mobile,
                               department_id, designation, grade, manager_id, cost_center_id,
                               location, joining_date, status, roles)
         VALUES ($1,'co_trek',$2,$3,$4,NULL,$5,$6,$7,$8,$9,'Not specified',CURRENT_DATE,'active',$10)
         ON CONFLICT (id) DO UPDATE SET
           employee_code = EXCLUDED.employee_code, name = EXCLUDED.name,
           work_email = EXCLUDED.work_email, department_id = EXCLUDED.department_id,
           designation = EXCLUDED.designation, grade = EXCLUDED.grade,
           manager_id = EXCLUDED.manager_id, cost_center_id = EXCLUDED.cost_center_id,
           location = EXCLUDED.location, roles = EXCLUDED.roles`,
        e
      );
    }
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

  await client.query('DELETE FROM login_attempt');
  await client.query('DELETE FROM expense');
  await client.query('DELETE FROM trip');

  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  await client.end();
}
