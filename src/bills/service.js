/* Bills — the receipts behind an expense.
 *
 * Storage: the bytes live in Postgres (bytea), not in object storage. Object
 * storage needs a region, an encryption posture and a retention policy, and
 * none of those are decided. A receipt is a few hundred kilobytes and the
 * pilot's bill volume is small, so the database is the honest answer for now.
 * The table is shaped so that moving to object storage later is a change of
 * where `content` comes from, not a change of the model.
 *
 * The size cap is enforced HERE, on the decoded bytes, before anything is
 * written. The route's own limit protects the request; this protects the table.
 */

import { createHash } from 'node:crypto';
import { tx } from '../db.js';
import { audit, ACTIONS } from '../audit.js';
import { WorkflowError } from '../trips/validate.js';

/* 5 MB of receipt per bill. A phone photo of a receipt is 1–3 MB; a scanned
 * PDF of a hotel folio is usually under 1 MB. */
export const MAX_BILL_BYTES = 5 * 1024 * 1024;

const ALLOWED_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
];

export function validateBill({ filename, contentType, buffer }) {
  if (!filename || !String(filename).trim()) {
    throw new WorkflowError(422, 'validation_failed', 'A filename is required.');
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new WorkflowError(422, 'validation_failed', 'The file is empty.');
  }
  if (buffer.length > MAX_BILL_BYTES) {
    throw new WorkflowError(413, 'payload_too_large',
      `A bill may be at most ${Math.floor(MAX_BILL_BYTES / (1024 * 1024))} MB.`);
  }
  const type = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_TYPES.includes(type)) {
    throw new WorkflowError(422, 'validation_failed',
      `Bills must be a photo or a PDF. Received "${type || 'unknown'}".`);
  }
  return {
    filename: String(filename).trim().slice(0, 200),
    contentType: type,
    buffer,
  };
}

export async function listBills(db, expenseId) {
  return db.many(
    `SELECT b.id, b.expense_id, b.trip_id, b.filename, b.content_type, b.byte_size,
            b.sha256, b.uploaded_by, b.uploaded_at, e.name AS uploaded_by_name
       FROM expense_bill b
       LEFT JOIN employee e ON e.id = b.uploaded_by
      WHERE b.expense_id = $1
      ORDER BY b.uploaded_at, b.id`,
    [expenseId]
  );
}

/** The bill's bytes, for download. */
export async function readBillContent(db, id) {
  return db.one(
    `SELECT b.id, b.expense_id, b.trip_id, b.filename, b.content_type, b.byte_size, b.content
       FROM expense_bill b WHERE b.id = $1`,
    [id]
  );
}

export async function createBill({ expenseId, filename, contentType, buffer, actor, requestId, ip }) {
  const valid = validateBill({ filename, contentType, buffer });

  return tx(async (client) => {
    const expense = await client.one(
      `SELECT x.id, x.trip_id, x.employee_id, x.description, x.amount, x.currency, x.status,
              t.destination, t.status AS trip_status
         FROM expense x JOIN trip t ON t.id = x.trip_id
        WHERE x.id = $1`,
      [expenseId]
    );
    if (!expense) return null;

    /* A receipt belongs to an expense that exists and belongs to the traveller. */
    if (expense.employee_id !== actor.employeeId) {
      throw new WorkflowError(404, 'not_found', 'Expense not found.');
    }

    const sha256 = createHash('sha256').update(valid.buffer).digest('hex');

    const row = await client.one(
      `INSERT INTO expense_bill (expense_id, trip_id, filename, content_type, byte_size, sha256, content, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, expense_id, trip_id, filename, content_type, byte_size, sha256, uploaded_by, uploaded_at`,
      [expenseId, expense.trip_id, valid.filename, valid.contentType, valid.buffer.length,
       sha256, valid.buffer, actor.employeeId]
    );

    await audit(client, {
      actorId: actor.employeeId,
      actorLabel: actor.name,
      action: ACTIONS.BILL_UPLOAD,
      entityType: 'expense_bill',
      entityId: row.id,
      relatedType: 'expense',
      relatedId: expenseId,
      newState: 'uploaded',
      detail: `Bill "${valid.filename}" (${valid.buffer.length} bytes) uploaded against expense "${expense.description}"`,
      metadata: { filename: valid.filename, contentType: valid.contentType, byteSize: valid.buffer.length, sha256 },
      requestId,
      actorIp: ip,
    });

    return row;
  });
}

export async function removeBill({ id, actor, requestId, ip }) {
  return tx(async (client) => {
    const bill = await client.one(
      `SELECT b.*, x.employee_id, x.description
         FROM expense_bill b JOIN expense x ON x.id = b.expense_id
        WHERE b.id = $1 FOR UPDATE OF b`,
      [id]
    );
    if (!bill) return null;

    if (bill.employee_id !== actor.employeeId) {
      throw new WorkflowError(404, 'not_found', 'Bill not found.');
    }

    await client.query('DELETE FROM expense_bill WHERE id = $1', [id]);

    await audit(client, {
      actorId: actor.employeeId,
      actorLabel: actor.name,
      action: ACTIONS.BILL_DELETE,
      entityType: 'expense_bill',
      entityId: id,
      relatedType: 'expense',
      relatedId: bill.expense_id,
      previousState: 'uploaded',
      newState: null,
      detail: `Bill "${bill.filename}" removed from expense "${bill.description}"`,
      metadata: { filename: bill.filename, byteSize: bill.byte_size },
      requestId,
      actorIp: ip,
    });

    return true;
  });
}
