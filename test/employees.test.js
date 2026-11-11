/* Employee validation + bulk import.
 *
 * Every message asserted here is approved user-facing copy. If a test fails because
 * a message changed, the message is the bug — not the test.
 *
 * Run: npm test   (requires a migrated + seeded database)
 */

import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../src/db.js';
import { validateEmployee, resolveCostCenter } from '../src/employees/validate.js';
import { importEmployees } from '../src/employees/import.js';

after(async () => { await db.close(); });

const VALID = {
  employeeCode: 'GP-9001',
  name: 'Test Person',
  workEmail: 'test.person@garageplug.com',
  departmentId: 'dep_sls',
  designation: 'Account Executive',
  grade: 'G3',
  location: 'Riyadh',
  joiningDate: '2026-09-01',
};

async function fieldsFrom(input, existingId = null) {
  try {
    await validateEmployee(db, input, existingId);
    return null;
  } catch (err) {
    assert.equal(err.status, 422, 'validation must surface as 422');
    return err.fields;
  }
}

describe('required fields', () => {
  test('a fully valid employee passes', async () => {
    assert.equal(await fieldsFrom(VALID), null);
  });

  test('each required field is reported by name', async () => {
    const fields = await fieldsFrom({});
    for (const k of ['employeeCode', 'name', 'workEmail', 'departmentId', 'designation']) {
      assert.ok(fields[k], `${k} should be reported as required`);
    }
    assert.equal(fields.grade, undefined);
    assert.equal(fields.location, undefined);
    assert.equal(fields.joiningDate, undefined);
  });

  test('whitespace does not satisfy a required field', async () => {
    const fields = await fieldsFrom({ ...VALID, name: '   ' });
    assert.ok(fields.name);
  });
});

describe('uniqueness names the clashing employee', () => {
  test('employee code clash reads "Already used by Test Traveller One"', async () => {
    const fields = await fieldsFrom({ ...VALID, employeeCode: 'TST-0031' });
    assert.equal(fields.employeeCode, 'Already used by Test Traveller One');
  });

  test('employee code clash is case-insensitive', async () => {
    const fields = await fieldsFrom({ ...VALID, employeeCode: 'tst-0031' });
    assert.equal(fields.employeeCode, 'Already used by Test Traveller One');
  });

  test('work email clash names the holder', async () => {
    const fields = await fieldsFrom({ ...VALID, workEmail: 'TEST.TRAVELLER.ONE@garageplug.test' });
    assert.equal(fields.workEmail, 'Already used by Test Traveller One');
  });

  test('uniqueness excludes the record being updated', async () => {
    const fields = await fieldsFrom(
      { ...VALID, employeeCode: 'TST-0031', workEmail: 'test.traveller.one@garageplug.test' },
      'emp_t04'
    );
    assert.equal(fields, null, 'an employee may keep their own code and email');
  });
});

describe('email format', () => {
  for (const bad of ['not-an-email', 'missing@domain', 'two@@at.com', '@garageplug.com']) {
    test(`"${bad}" is rejected`, async () => {
      const fields = await fieldsFrom({ ...VALID, workEmail: bad });
      assert.equal(fields.workEmail, 'Enter a valid work email address');
    });
  }
});

describe('reporting relationships', () => {
  test('an employee cannot report to themselves', async () => {
    const fields = await fieldsFrom({ ...VALID, managerId: 'emp_t04' }, 'emp_t04');
    assert.equal(fields.managerId, 'An employee cannot report to themselves');
  });

  test('an unknown manager is a field error, not a 500', async () => {
    const fields = await fieldsFrom({ ...VALID, managerId: 'emp_nope' });
    assert.equal(fields.managerId, 'Unknown manager');
  });

  test('a deeper reporting loop is refused (D-13)', async () => {
    // the manager (emp_t01) manages the traveller (emp_t04). Making the manager report to the traveller
    // would close the loop.
    const fields = await fieldsFrom({ ...VALID, managerId: 'emp_t04' }, 'emp_t01');
    assert.equal(fields.managerId, 'That would create a reporting loop');
  });

  test('a valid manager passes', async () => {
    assert.equal(await fieldsFrom({ ...VALID, managerId: 'emp_t01' }), null);
  });
});

describe('grade and roles', () => {
  test('an unknown grade is rejected', async () => {
    const fields = await fieldsFrom({ ...VALID, grade: 'G9' });
    assert.ok(fields.grade);
  });

  test('an unknown role is named', async () => {
    const fields = await fieldsFrom({ ...VALID, roles: ['employee', 'wizard'] });
    assert.match(fields.roles, /wizard/);
  });

  test('the five approved roles are accepted', async () => {
    assert.equal(
      await fieldsFrom({ ...VALID, roles: ['employee', 'manager', 'hr_travel', 'finance', 'admin'] }),
      null
    );
  });
});

describe('cost center inheritance', () => {
  test('a department resolves to its own cost center', async () => {
    assert.equal(await resolveCostCenter(db, { departmentId: 'dep_sls' }), 'cc_ccsls01');
  });

  test('a cost center from another department is not honoured', async () => {
    const resolved = await resolveCostCenter(db, {
      departmentId: 'dep_sls',
      costCenterId: 'cc_ccfin01',
    });
    assert.equal(resolved, 'cc_ccsls01', 'must realign to the department, not trust the input');
  });
});

/* ------------------------------------------------------------------ import */

describe('bulk import', () => {
  const header = 'Employee Code,Name,Work Email,Department';

  test('a header alone is refused with actionable copy', async () => {
    const r = await importEmployees({ text: header, dryRun: true, actor: { employeeId: 'emp_1000', name: 'Ashish Reddy' } });
    assert.match(r.error, /header row plus at least one employee/i);
  });

  test('a missing mandatory column is named', async () => {
    const r = await importEmployees({
      text: 'Name,Department\nX,Sales',
      dryRun: true,
      actor: { employeeId: 'emp_1000', name: 'Ashish Reddy' },
    });
    assert.match(r.error, /employeeCode/);
    assert.match(r.error, /workEmail/);
  });

  test('dry run validates without writing', async () => {
    const before = await db.one('SELECT count(*)::int n FROM employee');
    const r = await importEmployees({
      text: `${header}\nGP-9101,Aisha Noor,aisha.noor@garageplug.com,Sales`,
      dryRun: true,
      actor: { employeeId: 'emp_1000', name: 'Ashish Reddy' },
    });
    const after_ = await db.one('SELECT count(*)::int n FROM employee');

    assert.equal(r.dryRun, true);
    assert.equal(r.added, 0);
    assert.equal(after_.n, before.n, 'a dry run must write nothing');
    assert.equal(r.results[0].ok, true);
  });

  test('an unknown department fails only its own row', async () => {
    const r = await importEmployees({
      text: `${header}\n` +
            'GP-9102,Bad Row,bad.row@garageplug.com,Ops\n' +
            'GP-9103,Good Row,good.row@garageplug.com,Sales',
      dryRun: true,
      actor: { employeeId: 'emp_1000', name: 'Ashish Reddy' },
    });

    assert.equal(r.results[0].ok, false);
    assert.match(r.results[0].message, /Unknown department 'Ops' — create it first/);
    assert.equal(r.results[1].ok, true, 'a bad row must not block a good one');
  });

  test('an unresolvable manager fails the row with import-them-first', async () => {
    const r = await importEmployees({
      text: `${header},Manager\nGP-9104,Orphan,orphan@garageplug.com,Sales,ghost@garageplug.com`,
      dryRun: true,
      actor: { employeeId: 'emp_1000', name: 'Ashish Reddy' },
    });
    assert.equal(r.results[0].ok, false);
    assert.match(r.results[0].message, /not found — import them first/);
  });

  test('a manager resolves by email and by name', async () => {
    const byEmail = await importEmployees({
      text: `${header},Manager\nGP-9105,A,a@garageplug.com,Sales,test.manager@garageplug.test`,
      dryRun: true,
      actor: { employeeId: 'emp_1000', name: 'Ashish Reddy' },
    });
    const byName = await importEmployees({
      text: `${header},Manager\nGP-9106,B,b@garageplug.com,Sales,Test Manager`,
      dryRun: true,
      actor: { employeeId: 'emp_1000', name: 'Ashish Reddy' },
    });
    assert.equal(byEmail.results[0].ok, true);
    assert.match(byEmail.results[0].message, /reports to Test Manager/);
    assert.equal(byName.results[0].ok, true);
  });

  test('department resolves by code as well as name', async () => {
    const r = await importEmployees({
      text: `${header}\nGP-9107,C,c@garageplug.com,SLS`,
      dryRun: true,
      actor: { employeeId: 'emp_1000', name: 'Ashish Reddy' },
    });
    assert.equal(r.results[0].ok, true);
  });

  test('a tab-separated paste is detected', async () => {
    const r = await importEmployees({
      text: 'Employee Code\tName\tWork Email\tDepartment\n' +
            'GP-9108\tD\td@garageplug.com\tSales',
      dryRun: true,
      actor: { employeeId: 'emp_1000', name: 'Ashish Reddy' },
    });
    assert.equal(r.results[0].ok, true);
  });

  test('a duplicate email inside the paste is caught per row', async () => {
    const r = await importEmployees({
      text: `${header}\nGP-9109,Clash,test.traveller.one@garageplug.test,Sales`,
      dryRun: true,
      actor: { employeeId: 'emp_1000', name: 'Ashish Reddy' },
    });
    assert.equal(r.results[0].ok, false);
    assert.match(r.results[0].message, /Already used by Test Traveller One/);
  });
});
