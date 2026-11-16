/* Audit immutability is asserted, not trusted.
 *
 * 002_audit.sql revokes UPDATE/DELETE from the app role AND installs refusing
 * triggers. Both are belt and braces; this test proves at least one is working, on
 * the real database, with the real role.
 *
 * Run: npm test   (requires a migrated + seeded database)
 */

import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../src/db.js';
import { audit, ACTIONS } from '../src/audit.js';

after(async () => { await db.close(); });

describe('audit_event is append-only', () => {
  test('an event can be inserted', async () => {
    const before = await db.one('SELECT count(*)::int AS n FROM audit_event');
    await db.tx((t) =>
      audit(t, {
        actorId: 'emp_1000',
        actorLabel: 'Ashish Reddy',
        action: ACTIONS.EMPLOYEE_UPDATE,
        entityType: 'employee',
        entityId: 'emp_t04',
        previousState: 'active',
        newState: 'active',
        detail: 'Immutability test event',
        metadata: { test: true },
      })
    );
    const after_ = await db.one('SELECT count(*)::int AS n FROM audit_event');
    assert.equal(after_.n, before.n + 1);
  });

  test('UPDATE is refused', async () => {
    const row = await db.one('SELECT id FROM audit_event ORDER BY id DESC LIMIT 1');
    await assert.rejects(
      () => db.query('UPDATE audit_event SET detail = $2 WHERE id = $1', [row.id, 'tampered']),
      /append-only|permission denied/i,
      'the database must refuse an UPDATE on audit_event'
    );
  });

  test('DELETE is refused', async () => {
    const row = await db.one('SELECT id FROM audit_event ORDER BY id DESC LIMIT 1');
    await assert.rejects(
      () => db.query('DELETE FROM audit_event WHERE id = $1', [row.id]),
      /append-only|permission denied/i,
      'the database must refuse a DELETE on audit_event'
    );
  });

  test('role-level REVOKE is enforced for trek_app if role exists', async () => {
    const roleExists = await db.one("SELECT 1 FROM pg_roles WHERE rolname = 'trek_app'");
    assert.ok(roleExists, 'migration 002 must have created the trek_app role');

    /* The REVOKE is a property of the grants, so read it from the catalogue: this
     * holds on every connection, including one that may not assume the role. */
    const grants = await db.one(
      `SELECT has_table_privilege('trek_app', 'audit_event', 'INSERT') AS can_insert,
              has_table_privilege('trek_app', 'audit_event', 'SELECT') AS can_select,
              has_table_privilege('trek_app', 'audit_event', 'UPDATE') AS can_update,
              has_table_privilege('trek_app', 'audit_event', 'DELETE') AS can_delete,
              pg_has_role(current_user, 'trek_app', 'USAGE')            AS can_switch`
    );
    assert.ok(grants.can_insert, 'trek_app must be able to append to audit_event');
    assert.ok(grants.can_select, 'trek_app must be able to read audit_event');
    assert.equal(grants.can_update, false, 'trek_app must NOT be able to update audit_event');
    assert.equal(grants.can_delete, false, 'trek_app must NOT be able to delete audit_event');

    /* Behavioural proof, for a connection allowed to assume the role (CI's superuser). */
    if (!grants.can_switch) return;
    await db.tx(async (t) => {
      await t.query('SET LOCAL ROLE trek_app');
      const row = await t.one('SELECT id FROM audit_event LIMIT 1');
      await assert.rejects(
        () => t.query('DELETE FROM audit_event WHERE id = $1', [row.id]),
        /permission denied/i
      );
    });
  });

  test('the audit module exposes no update or delete function', async () => {
    const mod = await import('../src/audit.js');
    for (const name of Object.keys(mod)) {
      assert.ok(
        !/update|delete|remove|truncate|purge/i.test(name),
        `audit.js must not export "${name}" — there is no write endpoint for audit at any privilege level`
      );
    }
  });

  test('an audit event records previous and new state', async () => {
    const row = await db.one(
      `SELECT previous_state, new_state, detail, actor_label
         FROM audit_event
        WHERE detail = 'Immutability test event'
        ORDER BY id DESC LIMIT 1`
    );
    assert.ok(row, 'the test event should exist');
    assert.equal(row.previous_state, 'active');
    assert.equal(row.new_state, 'active');
    assert.equal(row.actor_label, 'Ashish Reddy');
  });
});

describe('auth events', () => {
  test('a denied login request is auditable with a null actor', async () => {
    await db.tx((t) =>
      audit(t, {
        actorId: null,
        actorLabel: 'anonymous',
        action: ACTIONS.AUTH_LOGIN_FAILED,
        entityType: 'account',
        entityId: 'nobody@garageplug.com',
        detail: 'Login code request denied for nobody@garageplug.com',
        metadata: { reason: 'unknown_email' },
      })
    );
    const row = await db.one(
      `SELECT actor_id, action FROM audit_event
        WHERE action = $1 ORDER BY id DESC LIMIT 1`,
      [ACTIONS.AUTH_LOGIN_FAILED]
    );
    assert.equal(row.actor_id, null, 'pre-auth events have no actor');
  });
});
