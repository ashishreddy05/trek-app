/* Password hashing, policy, and the sign-in flow against a real database.
 * Run: npm test   (needs a migrated + seeded database) */

import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../src/auth/password-hash.js';
import { passwordProblem } from '../src/auth/password-policy.js';
import { login } from '../src/auth/password.js';
import * as db from '../src/db.js';

after(async () => { await db.close(); });

const GOOD = 'amber kettle orbit';

describe('hashing', () => {
  test('the hash never contains the plaintext and records its parameters', async () => {
    const h = await hashPassword(GOOD);
    assert.ok(!h.includes(GOOD));
    assert.match(h, /^scrypt\$17\$8\$1\$/);
  });

  test('the same password hashes differently each time (salted)', async () => {
    assert.notEqual(await hashPassword(GOOD), await hashPassword(GOOD));
  });

  test('verify accepts the right password and rejects the wrong one', async () => {
    const h = await hashPassword(GOOD);
    assert.equal((await verifyPassword(h, GOOD)).ok, true);
    assert.equal((await verifyPassword(h, 'amber kettle orbiT')).ok, false);
  });

  test('a malformed or tampered hash never verifies', async () => {
    assert.equal((await verifyPassword('nonsense', GOOD)).ok, false);
    const h = await hashPassword(GOOD);
    assert.equal((await verifyPassword(h.slice(0, -4) + 'AAAA', GOOD)).ok, false);
  });
});

describe('policy (PROVISIONAL — BD-10)', () => {
  const who = { email: 'suresh.kumar@garageplug.com', name: 'Suresh Kumar' };
  test('too short', () => assert.match(passwordProblem('short', who), /at least 6/));
  test('six characters are accepted', () => assert.equal(passwordProblem('violet', who), null));
  test('contains the email address', () => assert.ok(passwordProblem('suresh.kumar-2026!', who)));
  test('contains the name', () => assert.ok(passwordProblem('kumar is travelling', who)));
  test('contains the company name', () => assert.ok(passwordProblem('garageplug travel!', who)));
  test('obvious', () => assert.ok(passwordProblem('Password12!!', who)));
  test('digits only', () => assert.ok(passwordProblem('20262026202620', who)));
  test('a passphrase passes', () => assert.equal(passwordProblem(GOOD, who), null));
});

describe('sign-in', () => {
  const email = 'nadia.haddad@garageplug.com';

  test('setup: give Nadia a password', async () => {
    await db.query(
      `INSERT INTO password_credential (account_id, hash)
       SELECT a.id, $2 FROM account a JOIN employee e ON e.id = a.employee_id WHERE e.work_email = $1
       ON CONFLICT (account_id) DO UPDATE SET hash = EXCLUDED.hash`,
      [email, await hashPassword(GOOD)]
    );
  });

  test('the right password signs in and returns a principal, never a hash', async () => {
    const r = await login({ email, password: GOOD, ip: '127.0.0.1', requestId: 't' });
    assert.equal(r.principal.email, email);
    assert.ok(r.token);
    assert.ok(!JSON.stringify(r.principal).includes('scrypt'));
  });

  test('a wrong password and an unknown email give the identical error', async () => {
    const a = await login({ email, password: 'wrong wrong wrong', ip: '127.0.0.2', requestId: 't' }).catch((e) => e);
    const b = await login({ email: 'nobody.here@garageplug.com', password: 'wrong wrong wrong', ip: '127.0.0.2', requestId: 't' }).catch((e) => e);
    assert.equal(a.status, 401);
    assert.equal(a.status, b.status);
    assert.equal(a.message, b.message);
  });

  test('an employee with no password set cannot sign in', async () => {
    const e = await login({ email: 'omar.farouk@garageplug.com', password: GOOD, ip: '127.0.0.3', requestId: 't' }).catch((x) => x);
    assert.equal(e.status, 401);
  });
});
