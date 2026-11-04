/* Recreate legacy fixtures ONLY in disposable test databases, never in the app DB. */
import pg from 'pg';
import { readFile } from 'node:fs/promises';

if (process.env.APP_ENV !== 'dev') throw new Error('Test fixtures require APP_ENV=dev.');
const client = new pg.Client({connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL_MODE === 'disable' ? false : { rejectUnauthorized: true }});
await client.connect();
try {
  const {rows} = await client.query('SELECT current_database() AS name');
  if (!rows[0].name.endsWith('_test')) throw new Error('Use a disposable database ending in _test. Never run tests on the app database.');
  await client.query('BEGIN');
  const seed = await readFile(new URL('../migrations/003_seed_master_data.sql', import.meta.url), 'utf8');
  for (const [sql] of seed.matchAll(/INSERT INTO employee\s[\s\S]*?;/g)) {
    await client.query(sql.replace(/;$/, ' ON CONFLICT (id) DO NOTHING;'));
  }
  await client.query(`INSERT INTO account (company_id, employee_id, status)
    SELECT company_id, id, 'active'::account_status FROM employee ON CONFLICT (employee_id) DO NOTHING`);
  await client.query(`INSERT INTO account_identity (account_id, provider, subject)
    SELECT a.id, 'password', lower(e.work_email) FROM account a JOIN employee e ON e.id=a.employee_id
    ON CONFLICT (provider, subject) DO NOTHING`);
  await client.query('DELETE FROM login_attempt');
  await client.query('DELETE FROM expense');
  await client.query('DELETE FROM trip');
  await client.query('COMMIT');
} catch (err) { await client.query('ROLLBACK'); throw err; }
finally { await client.end(); }
