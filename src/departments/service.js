/* Department + cost center service.
 *
 * Creating a department creates its cost center in the same transaction — specified
 * behaviour. Deactivation is refused while active employees remain, with the approved
 * message "Move its active employees first".
 */

import { tx } from '../db.js';
import { audit, ACTIONS } from '../audit.js';
import { ValidationError } from '../employees/validate.js';

const SELECT_DEPT = `
  SELECT d.id, d.code, d.name, d.active, d.head_id,
         h.name AS head_name,
         (SELECT count(*)::int FROM employee e
           WHERE e.department_id = d.id AND e.status = 'active') AS active_employees,
         (SELECT json_agg(json_build_object('id', cc.id, 'code', cc.code, 'name', cc.name, 'active', cc.active)
                          ORDER BY cc.code)
            FROM cost_center cc WHERE cc.department_id = d.id) AS cost_centers
    FROM department d
    LEFT JOIN employee h ON h.id = d.head_id`;

export async function listDepartments(db) {
  return db.many(`${SELECT_DEPT} ORDER BY d.code`);
}

export async function readDepartment(db, id) {
  return db.one(`${SELECT_DEPT} WHERE d.id = $1`, [id]);
}

function slugId(code) {
  return `dep_${String(code).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12)}`;
}
function ccId(code) {
  return `cc_${String(code).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16)}`;
}

export async function createDepartment({ input, actor, requestId, ip }) {
  const code = String(input.code ?? '').trim().toUpperCase();
  const name = String(input.name ?? '').trim();

  const fields = {};
  if (!code) fields.code = 'Department code is required';
  if (!name) fields.name = 'Department name is required';
  if (Object.keys(fields).length) throw new ValidationError(fields);

  return tx(async (db) => {
    const codeClash = await db.one('SELECT name FROM department WHERE upper(code) = $1', [code]);
    if (codeClash) throw new ValidationError({ code: `Already used by ${codeClash.name}` });

    const nameClash = await db.one('SELECT code FROM department WHERE lower(name) = lower($1)', [name]);
    if (nameClash) throw new ValidationError({ name: `Already used by ${nameClash.code}` });

    const id = slugId(code);
    if (await db.one('SELECT 1 FROM department WHERE id = $1', [id])) {
      throw new ValidationError({ code: 'That code collides with an existing department' });
    }

    await db.query(
      `INSERT INTO department (id, company_id, code, name, active)
       VALUES ($1, 'co_trek', $2, $3, true)`,
      [id, code, name]
    );

    /* A department without a cost center cannot carry spend, so the two are created
     * together. Supplied code, or CC-<CODE>-01. */
    const costCode = String(input.costCenterCode ?? `CC-${code}-01`).trim().toUpperCase();
    const existingCc = await db.one('SELECT id FROM cost_center WHERE upper(code) = $1', [costCode]);
    if (existingCc) throw new ValidationError({ costCenterCode: 'That cost center code already exists' });

    await db.query(
      `INSERT INTO cost_center (id, company_id, department_id, code, name, active)
       VALUES ($1, 'co_trek', $2, $3, $4, true)`,
      [ccId(costCode), id, costCode, input.costCenterName ?? name]
    );

    await audit(db, {
      actorId: actor.employeeId,
      actorLabel: actor.name,
      action: ACTIONS.DEPARTMENT_CREATE,
      entityType: 'department',
      entityId: id,
      newState: 'active',
      detail: `${name} (${code}) created with cost center ${costCode}`,
      metadata: { code, costCenterCode: costCode },
      requestId,
      actorIp: ip,
    });

    return readDepartment(db, id);
  });
}

export async function updateDepartment({ id, input, actor, requestId, ip }) {
  return tx(async (db) => {
    const before = await readDepartment(db, id);
    if (!before) return null;

    const sets = [];
    const params = [id];
    const changed = [];

    if (input.name !== undefined && String(input.name).trim() !== before.name) {
      const name = String(input.name).trim();
      if (!name) throw new ValidationError({ name: 'Department name is required' });
      const clash = await db.one(
        'SELECT code FROM department WHERE lower(name) = lower($1) AND id <> $2',
        [name, id]
      );
      if (clash) throw new ValidationError({ name: `Already used by ${clash.code}` });
      params.push(name); sets.push(`name = $${params.length}`); changed.push('name');
    }

    if (input.headId !== undefined && input.headId !== before.head_id) {
      if (input.headId) {
        const head = await db.one(
          `SELECT id, status, department_id FROM employee WHERE id = $1`,
          [input.headId]
        );
        if (!head) throw new ValidationError({ headId: 'Unknown employee' });
        if (head.status !== 'active') throw new ValidationError({ headId: 'That employee is not active' });
        if (head.department_id !== id) {
          throw new ValidationError({ headId: 'The department head must belong to that department' });
        }
      }
      params.push(input.headId ?? null); sets.push(`head_id = $${params.length}`); changed.push('headId');
    }

    if (input.active !== undefined && input.active !== before.active) {
      /* Cannot deactivate while active employees remain. Approved message. */
      if (input.active === false && before.active_employees > 0) {
        throw new ValidationError(
          { active: 'Move its active employees first' },
          'Move its active employees first.'
        );
      }
      params.push(input.active); sets.push(`active = $${params.length}`); changed.push('active');
    }

    if (!sets.length) return before;

    await db.query(`UPDATE department SET ${sets.join(', ')} WHERE id = $1`, params);

    await audit(db, {
      actorId: actor.employeeId,
      actorLabel: actor.name,
      action: ACTIONS.DEPARTMENT_UPDATE,
      entityType: 'department',
      entityId: id,
      previousState: before.active ? 'active' : 'inactive',
      newState: (input.active ?? before.active) ? 'active' : 'inactive',
      detail: `${before.name} updated — ${changed.join(', ')}`,
      metadata: { fields: changed },
      requestId,
      actorIp: ip,
    });

    return readDepartment(db, id);
  });
}

export async function listCostCenters(db, { departmentId } = {}) {
  const params = [];
  let where = 'WHERE cc.active';
  if (departmentId) { params.push(departmentId); where += ` AND cc.department_id = $${params.length}`; }
  return db.many(
    `SELECT cc.id, cc.code, cc.name, cc.active, cc.department_id, d.name AS department_name
       FROM cost_center cc JOIN department d ON d.id = cc.department_id
       ${where} ORDER BY cc.code`,
    params
  );
}
