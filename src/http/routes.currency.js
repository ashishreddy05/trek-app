/* Currencies and remembered exchange rates.
 *
 * Two read-only lists anybody may have — which currencies exist, and which
 * rates the company has remembered — and one write: recording a rate.
 *
 * Recording a rate changes no booked money. Every budget line, expense and
 * fund stores the rate it actually used, so a rate remembered today is a
 * default offered tomorrow, never a rewrite of what was already spent.
 */

import {
  listCurrencies, listRates, recordRate, syncLiveRates, baseCurrency, rateFor,
  fetchAndComputeEcbRates, applySyncRates,
} from '../currency/service.js';
import { normaliseCurrency } from '../money.js';
import { tx } from '../db.js';
import { audit, ACTIONS } from '../audit.js';
import { authorize } from '../authz/guard.js';

const bad = (message, fields) => ({
  status: 422,
  body: { error: { code: 'validation_failed', message, fields } },
});

/* GET /api/v1/currencies */
export async function getCurrencies(ctx) {
  await authorize(ctx.db, ctx.principal, 'currency.list', {}, ctx.requestId);
  const currencies = await listCurrencies(ctx.db);
  const base = await baseCurrency(ctx.db);
  return { status: 200, body: { currencies, baseCurrency: base } };
}

/* GET /api/v1/exchange-rates */
export async function getExchangeRates(ctx) {
  await authorize(ctx.db, ctx.principal, 'rate.list', {}, ctx.requestId);
  const rates = await listRates(ctx.db);
  const base = await baseCurrency(ctx.db);
  return { status: 200, body: { rates, baseCurrency: base } };
}

/* GET /api/v1/exchange-rates/:code — the latest remembered rate for one
 * currency against the base, in both directions. This is what the currency
 * drawer offers before someone has to remember a number. */
export async function getExchangeRateFor(ctx) {
  await authorize(ctx.db, ctx.principal, 'rate.list', {}, ctx.requestId);
  const base = await baseCurrency(ctx.db);
  let currency;
  try {
    currency = normaliseCurrency(ctx.params.code);
  } catch (err) {
    return bad(err.message, { currency: err.message });
  }

  const toBase = await rateFor(ctx.db, { currency, base, direction: 'to_base' });
  const fromBase = await rateFor(ctx.db, { currency, base, direction: 'from_base' });

  return {
    status: 200,
    body: {
      currency,
      baseCurrency: base,
      /* What a trip stores: how many base units one unit of this currency buys. */
      rateToBase: toBase?.rate ?? null,
      rateToBaseEffectiveOn: toBase?.effectiveOn ?? null,
      /* What a person reads: how many of this currency one base unit buys. */
      rateFromBase: fromBase?.rate ?? null,
      rateFromBaseEffectiveOn: fromBase?.effectiveOn ?? null,
    },
  };
}

/* POST /api/v1/exchange-rates */
export async function postExchangeRate(ctx) {
  await authorize(ctx.db, ctx.principal, 'rate.record', {}, ctx.requestId);
  const base = await baseCurrency(ctx.db);

  let fromCode;
  let toCode;
  try {
    fromCode = normaliseCurrency(ctx.body?.fromCode, { what: 'fromCode' });
    toCode = normaliseCurrency(ctx.body?.toCode ?? base, { what: 'toCode' });
  } catch (err) {
    return bad(err.message, { [err.message.includes('fromCode') ? 'fromCode' : 'toCode']: err.message });
  }

  if (fromCode === toCode) {
    return bad('A currency cannot have a rate against itself.', { fromCode: 'A currency cannot have a rate against itself.' });
  }

  const rate = String(ctx.body?.rate ?? '').trim();
  if (!/^\d+(\.\d{1,8})?$/.test(rate)) {
    return bad('The rate must be a positive number with at most 8 decimal places.', { rate: 'The rate must be a positive number with at most 8 decimal places.' });
  }
  if (Number(rate) <= 0) {
    return bad('The rate must be greater than zero.', { rate: 'The rate must be greater than zero.' });
  }
  /* The column is NUMERIC(20,8) — twelve integer digits and eight decimals.
   * Without this bound an over-long number reaches Postgres and comes back as
   * a 500, which is a server fault wearing a validation failure's clothes. */
  if (rate.replace('.', '').replace(/^0+/, '').length > 12) {
    return bad('The rate is too large to store.', { rate: 'The rate is too large to store.' });
  }

  /* The day the rate takes effect. Unparseable text must be refused here,
   * not by the database — the same 422 for the same reason as everything
   * else in this handler. */
  let effectiveOn = null;
  if (ctx.body?.effectiveOn !== undefined && ctx.body?.effectiveOn !== null && ctx.body?.effectiveOn !== '') {
    const raw = String(ctx.body.effectiveOn).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
      return bad('The effective date must be a calendar date, written as YYYY-MM-DD.', { effectiveOn: 'The effective date must be a calendar date, written as YYYY-MM-DD.' });
    }
    effectiveOn = raw;
  }

  const known = await ctx.db.many('SELECT code FROM currency WHERE active');
  const codes = new Set(known.map((c) => c.code));
  for (const [field, code] of [['fromCode', fromCode], ['toCode', toCode]]) {
    if (!codes.has(code)) {
      return bad(`${code} is not a currency Trek knows about.`, { [field]: `${code} is not a currency Trek knows about.` });
    }
  }

  /* The rate and its audit event are written in the SAME transaction. A rate
   * that exists with no audit trail is an unauditable write, and the audit
   * log is only worth anything if it cannot be skipped. */
  const row = await tx(async (db) => {
    const recorded = await recordRate(db, {
      fromCode,
      toCode,
      rate,
      effectiveOn,
      enteredBy: ctx.principal.employeeId,
      note: ctx.body?.note ?? null,
    });

    await audit(db, {
      actorId: ctx.principal.employeeId,
      actorLabel: ctx.principal.name,
      action: ACTIONS.RATE_RECORD,
      entityType: 'exchange_rate',
      entityId: recorded.id,
      newState: 'recorded',
      detail: `Rate ${recorded.rate} remembered for ${recorded.from_code} → ${recorded.to_code} (effective ${recorded.effective_on})`,
      metadata: { fromCode, toCode, rate, effectiveOn: recorded.effective_on },
      requestId: ctx.requestId,
      actorIp: ctx.ip,
    });

    return recorded;
  });

  return { status: 201, body: { rate: row } };
}

/* POST /api/v1/exchange-rates/sync */
export async function postSyncRates(ctx) {
  await authorize(ctx.db, ctx.principal, 'rate.sync', {}, ctx.requestId);

  // 1. Outbound network fetch happens OUTSIDE any database transaction or pooled connection
  let feed;
  try {
    feed = await fetchAndComputeEcbRates();
  } catch (err) {
    return {
      status: 502,
      body: { error: { code: 'rates_sync_failed', message: err.message } },
    };
  }

  // 2. Short, atomic transaction ONLY for writing the records and audit event
  try {
    const result = await tx(async (db) => {
      const syncRes = await applySyncRates(db, {
        computedRates: feed.computedRates,
        effectiveOn: feed.effectiveOn,
        enteredBy: ctx.principal.employeeId,
        note: `Synced live from European Central Bank (${ctx.principal.name})`,
      });

      await audit(db, {
        actorId: ctx.principal.employeeId,
        actorLabel: ctx.principal.name,
        action: ACTIONS.RATE_RECORD,
        entityType: 'exchange_rate',
        entityId: `sync_${syncRes.effectiveOn}`,
        newState: 'synced',
        detail: `Synchronized ${syncRes.syncedCount} exchange rates from European Central Bank (effective ${syncRes.effectiveOn})`,
        metadata: { syncedCount: syncRes.syncedCount, effectiveOn: syncRes.effectiveOn },
        requestId: ctx.requestId,
        actorIp: ctx.ip,
      });

      return syncRes;
    });

    return { status: 200, body: result };
  } catch (err) {
    return {
      status: 502,
      body: { error: { code: 'rates_sync_failed', message: err.message } },
    };
  }
}
