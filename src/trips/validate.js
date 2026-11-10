/* Validation for Trips, budget lines, the currency plan and fund issuance.
 *
 * Money arrives as an exact decimal string and is validated as one — never
 * parsed into a JavaScript number. See src/money.js.
 */

import { normaliseAmount, normaliseRate, normaliseCurrency, MoneyError } from '../money.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* One vocabulary, shared with expense.category, so budget-versus-actual is a
 * like-for-like comparison rather than a mapping table. */
export const BUDGET_CATEGORIES = [
  'travel',
  'accommodation',
  'food',
  'visa',
  'sim_card',
  'other',
];

export const FUND_KINDS = ['cash', 'forex_card', 'additional'];

export class ValidationError extends Error {
  constructor(fields, message = 'Please correct the highlighted fields.') {
    super(message);
    this.status = 422;
    this.code = 'validation_failed';
    this.fields = fields;
  }
}

export class WorkflowError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function isValidDate(dateStr) {
  if (!DATE_RE.test(dateStr)) return false;
  const d = new Date(dateStr + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === dateStr;
}

function text(value, { max, required, message, field }) {
  const s = value !== undefined && value !== null ? String(value).trim() : '';
  if (required && !s) throw new ValidationError({ [field]: message });
  if (max && s.length > max) throw new ValidationError({ [field]: `${field} must be ${max} characters or fewer` });
  return s;
}

/** Money input: exact decimal, positive, at most 2 places. */
function money(value, field) {
  try {
    return normaliseAmount(value, { what: field });
  } catch (err) {
    if (err instanceof MoneyError) throw new ValidationError({ [field]: err.message });
    throw err;
  }
}

/** Rate input: exact decimal, positive, at most 8 places. */
function rate(value, field) {
  try {
    return normaliseRate(value, { what: field });
  } catch (err) {
    if (err instanceof MoneyError) throw new ValidationError({ [field]: err.message });
    throw err;
  }
}

/** Non-negative money: zero is allowed (a fee that does not apply). */
function moneyOrZero(value, field) {
  if (value === undefined || value === null || value === '') return '0.00';
  try {
    const s = String(value).trim();
    if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new MoneyError(`${field} must be a number with at most 2 decimal places`);
    return normaliseAmount(s, { what: field });
  } catch (err) {
    if (err instanceof MoneyError) throw new ValidationError({ [field]: err.message });
    throw err;
  }
}

export function validateTrip(input) {
  const fields = {};

  const dest = text(input.destination, { max: 200, required: true, message: 'Destination is required', field: 'destination' });
  const purpose = text(input.purpose, { max: 500, required: true, message: 'Purpose is required', field: 'purpose' });

  const start = text(input.startDate, { required: true, message: 'Start date is required', field: 'startDate' });
  if (start && !isValidDate(start)) fields.startDate = 'Start date must be a valid date (YYYY-MM-DD)';

  const end = text(input.endDate, { required: true, message: 'End date is required', field: 'endDate' });
  if (end && !isValidDate(end)) fields.endDate = 'End date must be a valid date (YYYY-MM-DD)';

  if (start && end && isValidDate(start) && isValidDate(end) && end < start) {
    fields.endDate = 'End date cannot be earlier than start date';
  }

  let currency = 'INR';
  try {
    currency = normaliseCurrency(input.currency ?? 'INR');
  } catch (err) {
    fields.currency = err.message;
  }

  if (Object.keys(fields).length > 0) throw new ValidationError(fields);

  return { destination: dest, purpose, startDate: start, endDate: end, currency };
}

/** One estimated-expense line on the trip budget. */
export function validateBudgetLine(input) {
  const fields = {};

  const category = text(input.category, { required: true, message: 'Category is required', field: 'category' }).toLowerCase();
  if (category && !BUDGET_CATEGORIES.includes(category)) {
    fields.category = `Category must be one of: ${BUDGET_CATEGORIES.join(', ')}`;
  }

  const description = text(input.description, { max: 300, required: true, message: 'Description is required', field: 'description' });

  let amount = null;
  try {
    amount = money(input.amount, 'amount');
  } catch (err) {
    fields.amount = err.fields.amount;
  }

  let currency = null;
  try {
    currency = normaliseCurrency(input.currency ?? 'INR');
  } catch (err) {
    fields.currency = err.message;
  }

  if (Object.keys(fields).length > 0) throw new ValidationError(fields);

  return { category, description, amount, currency };
}

/** The currency plan: what cash and forex card is needed, at what rate, plus charges. */
export function validateFxPlan(input) {
  const fields = {};

  let currency = null;
  try {
    currency = normaliseCurrency(input.currency);
  } catch (err) {
    fields.currency = err.message;
  }

  let rateToBase = null;
  try {
    rateToBase = rate(input.rateToBase, 'rateToBase');
  } catch (err) {
    fields.rateToBase = err.fields.rateToBase;
  }

  const amounts = {};
  for (const [key, label] of [
    ['cashAmount', 'cashAmount'], ['cardAmount', 'cardAmount'],
    ['gstAmount', 'gstAmount'], ['topupFee', 'topupFee'], ['serviceFee', 'serviceFee'],
  ]) {
    try {
      amounts[key] = moneyOrZero(input[key], label);
    } catch (err) {
      fields[label] = err.fields[label];
    }
  }

  const note = text(input.note, { max: 500, field: 'note' }) || null;

  if (Object.keys(fields).length > 0) throw new ValidationError(fields);

  return { currency, rateToBase, ...amounts, note };
}

/** Funds handed over: cash, a forex card, or an additional tranche. */
export function validateFund(input) {
  const fields = {};

  const kind = text(input.kind, { required: true, message: 'Kind is required', field: 'kind' }).toLowerCase();
  if (kind && !FUND_KINDS.includes(kind)) {
    fields.kind = `Kind must be one of: ${FUND_KINDS.join(', ')}`;
  }

  let amount = null;
  try {
    amount = money(input.amount, 'amount');
  } catch (err) {
    fields.amount = err.fields.amount;
  }

  let currency = null;
  try {
    currency = normaliseCurrency(input.currency ?? 'INR');
  } catch (err) {
    fields.currency = err.message;
  }

  const note = text(input.note, { max: 500, field: 'note' }) || null;

  if (Object.keys(fields).length > 0) throw new ValidationError(fields);

  return { kind, amount, currency, note };
}
