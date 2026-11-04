/* Bulk employee import.
 *
 * Rules from TREK-DEVELOPER-HANDOFF.md §6 (Bulk employee import). Every row reports
 * its own outcome; a bad row never blocks a good one. Dry-run validates without
 * writing. Error messages are the approved actionable copy — "Unknown department
 * 'Ops' — create it first", not "invalid department".
 */

import { tx } from '../db.js';
import { audit, ACTIONS } from '../audit.js';
import { validateEmployee, resolveCostCenter, ROLES } from './validate.js';
import { randomInt } from 'node:crypto';

/* Column aliases, matched loosely against the header. */
const ALIASES = {
  employeeCode: ['employee code', 'code', 'staff id', 'employee id', 'emp code', 'emp id'],
  name: ['name', 'full name', 'employee name'],
  workEmail: ['work email', 'email', 'email address', 'official email'],
  mobile: ['mobile', 'phone', 'contact', 'mobile number'],
  department: ['department', 'dept', 'department name', 'department code'],
  designation: ['designation', 'title', 'job title', 'role title', 'position'],
  grade: ['grade', 'band', 'level'],
  manager: ['manager', 'reporting manager', 'manager email', 'reports to', 'supervisor'],
  costCenter: ['cost center', 'cost centre', 'cc', 'cost center code'],
  location: ['location', 'city', 'base', 'office'],
  joiningDate: ['joining date', 'date of joining', 'doj', 'start date', 'joined'],
  status: ['status', 'active'],
  roles: ['roles', 'role', 'permissions', 'access'],
};

function normaliseHeader(h) {
  return String(h).trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

function mapColumns(headerCells) {
  const map = {};
  headerCells.forEach((cell, index) => {
    const n = normaliseHeader(cell);
    for (const [field, aliases] of Object.entries(ALIASES)) {
      if (aliases.includes(n)) { map[field] = index; return; }
    }
  });
  return map;
}

/* Delimiter is auto-detected from the header row: whichever of tab or comma appears
 * more often. A tab-separated paste out of a spreadsheet is the common case. */
function detectDelimiter(headerLine) {
  const tabs = (headerLine.match(/\t/g) ?? []).length;
  const commas = (headerLine.match(/,/g) ?? []).length;
  return tabs >= commas && tabs > 0 ? '\t' : ',';
}

/* Minimal CSV split honouring double quotes. Not a full RFC 4180 parser — it handles
 * quoted fields containing the delimiter, which is what HR exports produce. */
function splitLine(line, delimiter) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c === delimiter && !inQuotes) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parseRoles(raw) {
  if (!raw) return ['employee'];
  const parts = String(raw).split(/[;|/,]/).map((s) => s.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const mapped = parts
    .map((p) => (p === 'hr' || p === 'travel' || p === 'hr_travel' ? 'hr_travel'
      : p === 'company_admin' || p === 'admin' ? 'admin' : p))
    .filter((p) => ROLES.includes(p));                 // unknown roles are dropped
  return mapped.length ? [...new Set(mapped)] : ['employee'];
}

async function nextEmployeeId(db) {
  for (let i = 0; i < 20; i++) {
    const candidate = `emp_${randomInt(1000, 9999)}`;
    if (!(await db.one('SELECT 1 FROM employee WHERE id = $1', [candidate]))) return candidate;
  }
  throw new Error('Could not allocate an employee id after 20 attempts');
}

/**
 * @param {object} opts
 * @param {string} opts.text     pasted CSV/TSV with a header row
 * @param {boolean} opts.dryRun  validate without writing
 */
export async function importEmployees({ text, dryRun = true, actor, requestId, ip }) {
  const lines = String(text ?? '').split(/\r?\n/).filter((l) => l.trim() !== '');

  if (lines.length < 2) {
    return {
      dryRun,
      added: 0,
      total: 0,
      results: [],
      error: 'Paste a header row plus at least one employee.',
    };
  }

  const delimiter = detectDelimiter(lines[0]);
  const columns = mapColumns(splitLine(lines[0], delimiter));

  const missing = ['employeeCode', 'name', 'workEmail', 'department']
    .filter((f) => columns[f] === undefined);
  if (missing.length) {
    return {
      dryRun,
      added: 0,
      total: 0,
      results: [],
      error: `The header is missing: ${missing.join(', ')}. Employee code, name, work email and department are required.`,
    };
  }

  const dataLines = lines.slice(1);
  const results = [];
  let added = 0;

  /* One transaction for the whole import, but each row is validated and written
   * independently: a bad row is recorded and skipped, never a rollback of the good
   * ones. Dry-run rolls the whole thing back at the end. */
  await tx(async (db) => {
    for (let i = 0; i < dataLines.length; i++) {
      const rowNumber = i + 2;                       // 1-indexed, header is row 1
      const cells = splitLine(dataLines[i], delimiter);
      const get = (field) => {
        const idx = columns[field];
        return idx === undefined ? undefined : (cells[idx] ?? '').trim() || undefined;
      };

      const label = get('name') ?? get('employeeCode') ?? `Row ${rowNumber}`;

      try {
        /* Department resolved by name OR code. */
        const deptRaw = get('department');
        const dept = await db.one(
          `SELECT id, name FROM department
            WHERE (lower(name) = lower($1) OR upper(code) = upper($1)) AND active`,
          [deptRaw]
        );
        if (!dept) {
          results.push({ row: rowNumber, label, ok: false, message: `Unknown department '${deptRaw}' — create it first` });
          continue;
        }

        /* Manager resolved by email, then by name. Named but unresolvable fails the row. */
        let managerId = null;
        const managerRaw = get('manager');
        if (managerRaw) {
          const mgr = await db.one(
            `SELECT id, name FROM employee
              WHERE (lower(work_email) = lower($1) OR lower(name) = lower($1)) AND status = 'active'`,
            [managerRaw]
          );
          if (!mgr) {
            results.push({ row: rowNumber, label, ok: false, message: `Manager '${managerRaw}' not found — import them first` });
            continue;
          }
          managerId = mgr.id;
        }

        /* Defaults for absent optional columns, exactly as specified. */
        const input = {
          employeeCode: get('employeeCode'),
          name: get('name'),
          workEmail: get('workEmail'),
          mobile: get('mobile') ?? null,
          departmentId: dept.id,
          designation: get('designation') ?? 'Employee',
          grade: (get('grade') ?? 'G3').toUpperCase(),
          managerId,
          location: get('location') ?? '—',
          joiningDate: get('joiningDate') ?? new Date().toISOString().slice(0, 10),
          status: (get('status') ?? 'active').toLowerCase() === 'inactive' ? 'inactive' : 'active',
          roles: parseRoles(get('roles')),
        };

        await validateEmployee(db, input, null);

        const costCenterId = await resolveCostCenter(db, {
          departmentId: dept.id,
          costCenterId: null,
        });

        const id = await nextEmployeeId(db);
        await db.query(
          `INSERT INTO employee (id, company_id, employee_code, name, work_email, mobile,
                                 department_id, designation, grade, manager_id, cost_center_id,
                                 location, joining_date, status, roles)
           VALUES ($1,'co_trek',$2,$3,lower($4),$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [id, input.employeeCode, input.name, input.workEmail, input.mobile,
           input.departmentId, input.designation, input.grade, input.managerId,
           costCenterId, input.location, input.joiningDate, input.status, input.roles]
        );

        const account = await db.one(
          `INSERT INTO account (company_id, employee_id, status)
           VALUES ('co_trek', $1, $2::account_status) RETURNING id`,
          [id, input.status === 'active' ? 'active' : 'suspended']
        );
        await db.query(
          `INSERT INTO account_identity (account_id, provider, subject)
           VALUES ($1, 'password', lower($2)) ON CONFLICT (provider, subject) DO NOTHING`,
          [account.id, input.workEmail]
        );

        added++;
        results.push({
          row: rowNumber,
          label: input.name,
          ok: true,
          message: managerId
            ? `Ready — ${dept.name}, reports to ${(await db.one('SELECT name FROM employee WHERE id = $1', [managerId])).name}`
            : `Ready — ${dept.name}, no reporting manager`,
        });
      } catch (err) {
        const message = err.fields
          ? Object.entries(err.fields).map(([f, m]) => `${f}: ${m}`).join('; ')
          : err.message;
        results.push({ row: rowNumber, label, ok: false, message });
      }
    }

    if (!dryRun && added > 0) {
      await audit(db, {
        actorId: actor.employeeId,
        actorLabel: actor.name,
        action: ACTIONS.EMPLOYEE_IMPORT,
        entityType: 'company',
        entityId: 'co_trek',
        detail: `${added} of ${dataLines.length} rows imported`,
        metadata: { added, total: dataLines.length, failed: dataLines.length - added },
        requestId,
        actorIp: ip,
      });
    }

    /* Dry-run: everything above is discarded. Validation ran against real data —
     * uniqueness clashes and manager lookups included — without writing. */
    if (dryRun) throw new DryRunRollback();
  }).catch((err) => {
    if (!(err instanceof DryRunRollback)) throw err;
  });

  return { dryRun, added: dryRun ? 0 : added, total: dataLines.length, results };
}

class DryRunRollback extends Error {}
