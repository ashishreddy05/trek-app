/* Validation for Expenses.
 *
 * The category vocabulary is the SAME list the trip budget uses, so budget
 * versus actual compares like with like. The payment method records HOW the
 * money moved.
 */

import { normaliseAmount, normaliseCurrency, MoneyError } from '../money.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* One vocabulary, shared with trip_budget_line.category. */
export const EXPENSE_CATEGORIES = [
  'travel',
  'accommodation',
  'food',
  'visa',
  'sim_card',
  'other',
];

export const PAYMENT_METHODS = ['cash', 'forex_card', 'card', 'bank_transfer'];

export { ValidationError, WorkflowError } from '../trips/validate.js';

function isValidDate(dateStr) {
  if (!DATE_RE.test(dateStr)) return false;
  const d = new Date(dateStr + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === dateStr;
}

export function normaliseAmountInput(value, what = 'amount') {
  try {
    return normaliseAmount(value, { what });
  } catch (err) {
    if (err instanceof MoneyError) {
      const e = new Error(err.message);
      e.status = 422;
      e.code = 'validation_failed';
      e.fields = { [what]: err.message };
      throw e;
    }
    throw err;
  }
}

/**
 * Normalise an amount, or return null when it cannot be one.
 *
 * The null return is the caller's signal: "this is not a usable amount", not
 * "this raised". Validation turns it into a field error; a caller that wants
 * to know only whether the string is an amount uses this directly.
 */
export function normalizeAmount(value) {
  try {
    return normaliseAmount(value, { what: 'amount' });
  } catch {
    return null;
  }
}

export function validateExpense(input, { requireTrip = true } = {}) {
  const fields = {};

  let tripId = null;
  if (requireTrip) {
    tripId = input.tripId !== undefined && input.tripId !== null ? String(input.tripId).trim() : '';
    if (!tripId) fields.tripId = 'Trip is required';
  }

  const date = input.date !== undefined && input.date !== null ? String(input.date).trim() : '';
  if (!date) {
    fields.date = 'Expense date is required';
  } else if (!isValidDate(date)) {
    fields.date = 'Expense date must be a valid date (YYYY-MM-DD)';
  }

  const description = input.description !== undefined && input.description !== null
    ? String(input.description).trim() : '';
  if (!description) {
    fields.description = 'Description is required';
  } else if (description.length > 300) {
    fields.description = 'Description must be 300 characters or fewer';
  }

  const category = input.category !== undefined && input.category !== null
    ? String(input.category).trim().toLowerCase() : '';
  if (!category) {
    fields.category = 'Category is required';
  } else if (!EXPENSE_CATEGORIES.includes(category)) {
    fields.category = `Category must be one of: ${EXPENSE_CATEGORIES.join(', ')}`;
  }

  let amount = null;
  try {
    amount = normaliseAmount(input.amount, { what: 'amount' });
  } catch (err) {
    if (err instanceof MoneyError) fields.amount = err.message;
  }

  let currency = null;
  try {
    currency = normaliseCurrency(input.currency);
  } catch (err) {
    fields.currency = err.message;
  }

  const paymentMethod = input.paymentMethod !== undefined && input.paymentMethod !== null
    ? String(input.paymentMethod).trim().toLowerCase() : 'cash';
  if (!PAYMENT_METHODS.includes(paymentMethod)) {
    fields.paymentMethod = `Payment method must be one of: ${PAYMENT_METHODS.join(', ')}`;
  }

  if (Object.keys(fields).length > 0) {
    const e = new Error('Please correct the highlighted fields.');
    e.status = 422;
    e.code = 'validation_failed';
    e.fields = fields;
    throw e;
  }

  return {
    tripId: tripId || undefined,
    date,
    description,
    category,
    amount,
    currency,
    paymentMethod,
  };
}
