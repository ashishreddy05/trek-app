/* Unit tests for HTTP query parameter validation and enum mapping.
 *
 * Proves that query limits, status enums, cursors, and dates are strictly
 * bounded and return 400 Bad Request on malformed inputs, never reaching
 * Postgres to trigger 500 errors.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseQueryLimit,
  parseQueryStatus,
  parseQueryCursor,
  parseQueryDate,
  SCHEMA_ENUMS,
  getEnumValues,
  initEnums,
} from '../src/http/validation.js';

describe('HTTP query parameter validation', () => {
  describe('parseQueryLimit', () => {
    test('returns default limit when query parameter is omitted', () => {
      const q = new URLSearchParams('');
      const res = parseQueryLimit(q);
      assert.deepEqual(res, { limit: 50 });
    });

    test('respects custom default limit', () => {
      const q = new URLSearchParams('');
      const res = parseQueryLimit(q, 25, 200);
      assert.deepEqual(res, { limit: 25 });
    });

    test('parses valid integer limits', () => {
      assert.deepEqual(parseQueryLimit(new URLSearchParams('limit=1')), { limit: 1 });
      assert.deepEqual(parseQueryLimit(new URLSearchParams('limit=42')), { limit: 42 });
      assert.deepEqual(parseQueryLimit(new URLSearchParams('limit=100')), { limit: 100 });
    });

    test('refuses non-numeric and negative values with 400', () => {
      const invalid = ['abc', '-1', '0', '1.5', 'NaN', '101', '999999999999999999999'];
      for (const val of invalid) {
        const res = parseQueryLimit(new URLSearchParams(`limit=${val}`));
        assert.equal(res.error?.status, 400, `expected 400 for limit=${val}`);
        assert.equal(res.error?.body?.error?.code, 'invalid_query');
      }
    });
  });

  describe('parseQueryStatus & enum ground truth', () => {
    test('SCHEMA_ENUMS matches PostgreSQL schema types exactly', () => {
      assert.deepEqual(SCHEMA_ENUMS.employee_status, ['active', 'inactive']);
      assert.deepEqual(SCHEMA_ENUMS.expense_status, ['draft', 'submitted', 'approved', 'rejected']);
      assert.deepEqual(SCHEMA_ENUMS.trip_status, [
        'draft', 'submitted', 'approved', 'rejected', 'changes_requested',
        'active', 'reconciliation_pending', 'reconciled', 'closed',
      ]);
    });

    test('returns undefined status when query parameter is omitted', () => {
      const res = parseQueryStatus(new URLSearchParams(''), 'employee_status');
      assert.deepEqual(res, { status: undefined });
    });

    test('accepts valid employee_status values', () => {
      assert.deepEqual(parseQueryStatus(new URLSearchParams('status=active'), 'employee_status'), { status: 'active' });
      assert.deepEqual(parseQueryStatus(new URLSearchParams('status=inactive'), 'employee_status'), { status: 'inactive' });
    });

    test('refuses invalid employee_status values with 400 (including old typo "deactivated")', () => {
      const res = parseQueryStatus(new URLSearchParams('status=deactivated'), 'employee_status');
      assert.equal(res.error?.status, 400);
      assert.equal(res.error?.body?.error?.code, 'invalid_query');
      assert.match(res.error?.body?.error?.message, /Allowed: active, inactive/);
    });

    test('accepts valid expense_status values', () => {
      for (const s of ['draft', 'submitted', 'approved', 'rejected']) {
        assert.deepEqual(parseQueryStatus(new URLSearchParams(`status=${s}`), 'expense_status'), { status: s });
      }
    });

    test('refuses changes_requested for expense_status with 400 (only trips have changes_requested)', () => {
      const res = parseQueryStatus(new URLSearchParams('status=changes_requested'), 'expense_status');
      assert.equal(res.error?.status, 400);
      assert.equal(res.error?.body?.error?.code, 'invalid_query');
      assert.match(res.error?.body?.error?.message, /Allowed: draft, submitted, approved, rejected/);
    });

    test('accepts changes_requested for trip_status', () => {
      const res = parseQueryStatus(new URLSearchParams('status=changes_requested'), 'trip_status');
      assert.deepEqual(res, { status: 'changes_requested' });
    });

    test('accepts explicit arrays as allowed values', () => {
      const res = parseQueryStatus(new URLSearchParams('status=foo'), ['foo', 'bar']);
      assert.deepEqual(res, { status: 'foo' });

      const bad = parseQueryStatus(new URLSearchParams('status=baz'), ['foo', 'bar']);
      assert.equal(bad.error?.status, 400);
    });

    test('initEnums dynamically queries pg_enum and updates cache', async () => {
      const mockDb = {
        query: async () => ({
          rows: [
            { typname: 'test_status', values: ['one', 'two'] },
          ],
        }),
      };
      await initEnums(mockDb);
      assert.deepEqual(getEnumValues('test_status'), ['one', 'two']);
      // Fallback for untouched schema enums still holds
      assert.deepEqual(getEnumValues('employee_status'), ['active', 'inactive']);
    });
  });

  describe('parseQueryCursor', () => {
    test('returns undefined when cursor is omitted', () => {
      assert.deepEqual(parseQueryCursor(new URLSearchParams('')), { cursor: undefined });
    });

    test('accepts valid ISO date timestamps', () => {
      const ts = '2026-11-13T10:00:00.000Z';
      assert.deepEqual(parseQueryCursor(new URLSearchParams(`cursor=${encodeURIComponent(ts)}`)), { cursor: ts });
    });

    test('refuses non-date strings with 400', () => {
      const res = parseQueryCursor(new URLSearchParams('cursor=not-a-timestamp'));
      assert.equal(res.error?.status, 400);
      assert.equal(res.error?.body?.error?.code, 'invalid_query');
    });
  });

  describe('parseQueryDate', () => {
    test('returns undefined when date field is omitted', () => {
      assert.deepEqual(parseQueryDate(new URLSearchParams(''), 'from'), { date: undefined });
    });

    test('accepts valid date values', () => {
      assert.deepEqual(parseQueryDate(new URLSearchParams('from=2026-11-01'), 'from'), { date: '2026-11-01' });
    });

    test('refuses invalid date string with 400', () => {
      const res = parseQueryDate(new URLSearchParams('from=not-a-date'), 'from');
      assert.equal(res.error?.status, 400);
      assert.equal(res.error?.body?.error?.code, 'invalid_query');
      assert.match(res.error?.body?.error?.message, /from must be a valid date/);
    });
  });
});
