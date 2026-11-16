/* Query parameter validators and clamps.
 *
 * Ensures limits, enums, dates and cursors are properly bounded and formatted
 * before reaching database queries, preventing 500 crashes and unhandled exceptions.
 */

/* Schema ground truth for PostgreSQL ENUM types */
export const SCHEMA_ENUMS = {
  employee_status: ['active', 'inactive'],
  expense_status: ['draft', 'submitted', 'approved', 'rejected'],
  trip_status: [
    'draft', 'submitted', 'approved', 'rejected', 'changes_requested',
    'active', 'reconciliation_pending', 'reconciled', 'closed',
  ],
};

let dynamicEnums = null;

/**
 * Initialize or refresh dynamic enum values from pg_enum at boot or on demand.
 *
 * @param {import('pg').Pool|import('pg').Client} db
 */
export async function initEnums(db) {
  if (!db || typeof db.query !== 'function') return;
  try {
    const res = await db.query(`
      SELECT t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder) as values
      FROM pg_type t
      JOIN pg_enum e ON t.oid = e.enumtypid
      GROUP BY t.typname
    `);
    const map = {};
    for (const row of res.rows) {
      map[row.typname] = row.values;
    }
    dynamicEnums = map;
  } catch {
    /* Fall back safely to SCHEMA_ENUMS if DB is unreachable or during unit tests */
  }
}

/**
 * Get allowed enum values by type name.
 *
 * @param {string} enumName
 * @returns {string[]}
 */
export function getEnumValues(enumName) {
  return dynamicEnums?.[enumName] ?? SCHEMA_ENUMS[enumName] ?? [];
}

export function parseQueryLimit(query, defaultLimit = 50, maxLimit = 100) {
  if (!query.has('limit')) return { limit: defaultLimit };
  const raw = query.get('limit');
  const num = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(num) || num < 1 || num > maxLimit) {
    return { error: { status: 400, body: { error: { code: 'invalid_query', message: `limit must be an integer between 1 and ${maxLimit}.` } } } };
  }
  return { limit: num };
}

export function parseQueryStatus(query, allowedOrEnumName) {
  if (!query.has('status')) return { status: undefined };
  const allowed = Array.isArray(allowedOrEnumName)
    ? allowedOrEnumName
    : getEnumValues(allowedOrEnumName);
  const raw = query.get('status');
  if (!allowed.includes(raw)) {
    return { error: { status: 400, body: { error: { code: 'invalid_query', message: `Invalid status "${raw}". Allowed: ${allowed.join(', ')}.` } } } };
  }
  return { status: raw };
}

export function parseQueryCursor(query) {
  if (!query.has('cursor')) return { cursor: undefined };
  const raw = query.get('cursor');
  if (isNaN(Date.parse(raw))) {
    return { error: { status: 400, body: { error: { code: 'invalid_query', message: 'cursor must be a valid ISO date timestamp.' } } } };
  }
  return { cursor: raw };
}

export function parseQueryId(query, field = 'cursor') {
  if (!query.has(field)) return { [field]: undefined };
  const raw = query.get(field);
  if (!/^\d+$/.test(raw)) {
    return { error: { status: 400, body: { error: { code: 'invalid_query', message: `${field} must be a positive integer.` } } } };
  }
  return { [field]: raw };
}

export function parseQueryDate(query, field) {
  if (!query.has(field)) return { date: undefined };
  const raw = query.get(field);
  if (isNaN(Date.parse(raw))) {
    return { error: { status: 400, body: { error: { code: 'invalid_query', message: `${field} must be a valid date or timestamp.` } } } };
  }
  return { date: raw };
}
