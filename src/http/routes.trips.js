/* HTTP route handlers for Trips. */

import { authorize, rejectServerDerived } from '../authz/guard.js';
import {
  listTrips, readTrip, createTrip, updateTrip, submitTrip, decideTrip,
} from '../trips/service.js';

const notFound = { status: 404, body: { error: { code: 'not_found', message: 'Not found.' } } };

/* GET /api/v1/trips */
export async function getTrips(ctx) {
  const requested = ctx.query.get('scope') ?? undefined;

  const { scope, team } = await authorize(
    ctx.db, ctx.principal, 'trip.list', { scope: requested }, ctx.requestId
  );

  const result = await listTrips(ctx.db, {
    scope,
    team,
    employeeId: ctx.principal.employeeId,
    status: ctx.query.get('status') ?? undefined,
    limit: Number(ctx.query.get('limit')) || 50,
    cursor: ctx.query.get('cursor') ?? undefined,
  });

  return { status: 200, body: result };
}

/* GET /api/v1/trips/:id */
export async function getTrip(ctx) {
  const id = ctx.params.id;
  const row = await readTrip(ctx.db, id);

  await authorize(
    ctx.db, ctx.principal, 'trip.read',
    { employeeId: row?.employee_id, type: 'trip', id },
    ctx.requestId
  );

  if (!row) return notFound;
  return { status: 200, body: { trip: row } };
}

/* POST /api/v1/trips */
export async function postTrip(ctx) {
  await authorize(
    ctx.db, ctx.principal, 'trip.create',
    { employeeId: ctx.principal.employeeId },
    ctx.requestId
  );

  rejectServerDerived(ctx.body, []);

  const trip = await createTrip({
    input: ctx.body,
    actor: ctx.principal,
    requestId: ctx.requestId,
    ip: ctx.ip,
  });

  return { status: 201, body: { trip } };
}

/* PATCH /api/v1/trips/:id */
export async function patchTrip(ctx) {
  const id = ctx.params.id;
  const existing = await readTrip(ctx.db, id);

  await authorize(
    ctx.db, ctx.principal, 'trip.update',
    { employeeId: existing?.employee_id, type: 'trip', id },
    ctx.requestId
  );

  if (!existing) return notFound;
  rejectServerDerived(ctx.body, []);

  const trip = await updateTrip({
    id,
    input: ctx.body,
    actor: ctx.principal,
    requestId: ctx.requestId,
    ip: ctx.ip,
  });

  return { status: 200, body: { trip } };
}

/* POST /api/v1/trips/:id/submit */
export async function postSubmitTrip(ctx) {
  const id = ctx.params.id;
  const existing = await readTrip(ctx.db, id);

  await authorize(
    ctx.db, ctx.principal, 'trip.submit',
    { employeeId: existing?.employee_id, type: 'trip', id },
    ctx.requestId
  );

  if (!existing) return notFound;

  const trip = await submitTrip({
    id,
    actor: ctx.principal,
    requestId: ctx.requestId,
    ip: ctx.ip,
  });

  return { status: 200, body: { trip } };
}

/* POST /api/v1/trips/:id/decide */
export async function postDecideTrip(ctx) {
  const id = ctx.params.id;
  const existing = await readTrip(ctx.db, id);

  await authorize(
    ctx.db, ctx.principal, 'trip.decide',
    { employeeId: existing?.employee_id, type: 'trip', id },
    ctx.requestId
  );

  if (!existing) return notFound;

  const trip = await decideTrip({
    id,
    decision: ctx.body?.decision,
    reason: ctx.body?.reason,
    actor: ctx.principal,
    requestId: ctx.requestId,
    ip: ctx.ip,
  });

  return { status: 200, body: { trip } };
}
