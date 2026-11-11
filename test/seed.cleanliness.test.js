/* The seed carries master data and the two administrators. Nothing else.
 *
 * A migration is permanent: it runs on every fresh database the team ever
 * creates. So a roster of illustrative employees in a seed file is not a
 * harmless placeholder — it is a set of people the company will eventually
 * have, or will have to explain.
 *
 * These assertions read the migration and the seed scripts, so the rule is
 * checked rather than remembered.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const read = (p) => readFile(join(ROOT, p), 'utf8');

describe('the seed carries no demo people', () => {
  test('migration 003 seeds exactly the two administrators', async () => {
    const sql = await read('migrations/003_seed_master_data.sql');
    const rows = sql.match(/^\s*\('emp_[^']+',\s*'co_trek'/gm) ?? [];
    assert.equal(rows.length, 2, '003 must seed two employees and no more');

    for (const email of ['ashishreddy@garageplug.com', 'abdul@garageplug.com']) {
      assert.ok(sql.includes(email), `003 must seed ${email}`);
    }
  });

  test('no migration seeds an employee on a domain other than the company\'s', async () => {
    const files = ['003_seed_master_data.sql', '005_remove_demo_employees.sql'];
    for (const f of files) {
      const sql = await read(`migrations/${f}`);
      const emails = sql.match(/[\w.+-]+@[\w.-]+/g) ?? [];
      for (const e of emails) {
        const domain = e.split('@')[1];
        assert.ok(
          domain === 'garageplug.com' || domain === 'garageplug.test',
          `${f} mentions ${e} — a seeded employee must be a real colleague or a fixture`
        );
      }
    }
  });

  test('the fixtures are clearly fixtures, on the reserved .test domain', async () => {
    const sql = await read('scripts/seed-test.js');
    const emails = sql.match(/[\w.+-]+@[\w.-]+/g) ?? [];
    assert.ok(emails.length > 0, 'the seed script must define fixture accounts');
    for (const e of emails) {
      assert.ok(e.endsWith('@garageplug.test'), `${e} must live in the reserved .test domain`);
    }
    assert.ok(/Test Manager/.test(sql), 'fixture names must announce themselves');
  });

  test('no source file names a person who is not a colleague or a fixture', async () => {
    /* Match the name column of an employee row, not prose — "Customer Success"
     * is a department, not a person. */
    const rowName = /'emp_[^']+',\s*'co_trek',\s*'[^']+',\s*'([^']+)'/g;

    const files = [
      'migrations/003_seed_master_data.sql',
      'scripts/seed-test.js',
      'scripts/seed-staging.js',
    ];
    const allowed = new Set([
      'Abdul Mastan', 'Ashish Reddy',
      'Test Manager', 'Test Finance', 'Test Travel Lead',
      'Test Traveller One', 'Test Traveller Two', 'Test Traveller Three',
      'Test Traveller Four', 'Test Traveller Five',
    ]);

    for (const f of files) {
      const src = await read(f);
      for (const [, name] of src.matchAll(rowName)) {
        assert.ok(
          allowed.has(name),
          `${f} names ${name} — the only people a seed may name are the two administrators`
        );
      }
    }
  });
});
