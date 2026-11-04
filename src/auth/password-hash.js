/* Password hashing — scrypt from node:crypto.
 *
 * Memory-hard, built into Node (no native module to fail on Vercel), and at the
 * OWASP-recommended parameters: N = 2^17, r = 8, p = 1.
 *
 * Parameters are stored inside each hash, so they can be raised later: a hash made with
 * weaker parameters is re-hashed on the next successful sign-in (needsRehash).
 */

import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';

const LOG2N = 17;
const R = 8;
const P = 1;
const KEYLEN = 32;
const MAXMEM = 256 * 1024 * 1024;

function derive(password, salt, log2n, r, p) {
  return new Promise((resolve, reject) => {
    scrypt(String(password).normalize('NFKC'), salt, KEYLEN, { N: 2 ** log2n, r, p, maxmem: MAXMEM },
      (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await derive(password, salt, LOG2N, R, P);
  return `scrypt$${LOG2N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(stored, password) {
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  if (parts.length !== 6 || parts[0] !== 'scrypt') return { ok: false, needsRehash: false };

  const [, n, r, p, saltB64, keyB64] = parts;
  const log2n = Number(n), rr = Number(r), pp = Number(p);
  if (![log2n, rr, pp].every(Number.isInteger)) return { ok: false, needsRehash: false };

  const expected = Buffer.from(keyB64, 'base64');
  const key = await derive(password, Buffer.from(saltB64, 'base64'), log2n, rr, pp);

  const ok = key.length === expected.length && timingSafeEqual(key, expected);
  return { ok, needsRehash: ok && (log2n < LOG2N || rr !== R || pp !== P) };
}

/* Unknown emails still pay the full hashing cost, so response time does not reveal
 * whether an account exists. */
let dummyHash = null;
export async function burnTime(password) {
  dummyHash ??= await hashPassword(randomBytes(16).toString('hex'));
  await verifyPassword(dummyHash, password ?? '');
}
