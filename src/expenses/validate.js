/* Validation for Expenses. */

import { ValidationError, WorkflowError } from '../trips/validate.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

export const EXPENSE_CATEGORIES = [
  'meals',
  'lodging',
  'transport',
  'airfare',
  'supplies',
  'other',
];

function isValidDate(dateStr) {
  if (!DATE_RE.test(dateStr)) return false;
  const d = new Date(dateStr + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === dateStr;
}

export function normalizeAmount(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (!AMOUNT_RE.test(s)) return null;
  const parts = s.split('.');
  const intPart = parts[0];
  const decPart = (parts[1] || '').padEnd(2, '0');
  // Disallow leading zeros unless "0.xx", and ensure value > 0
  if (intPart.length > 1 && intPart.startsWith('0')) return null;
  if (intPart.length > 12) return null; // Fits in NUMERIC(14,2)
  const normalized = `${intPart}.${decPart}`;
  if (normalized === '0.00') return null;
  return normalized;
}

export function validateExpense(input, { requireTrip = true } = {}) {
  const fields = {};

  if (requireTrip) {
    const tripId = input.tripId !== undefined && input.tripId !== null ? String(input.tripId).trim() : '';
    if (!tripId) fields.tripId = 'Trip is required';
  }

  const date = input.date !== undefined && input.date !== null ? String(input.date).trim() : '';
  if (!date) {
    fields.date = 'Expense date is required';
  } else if (!isValidDate(date)) {
    fields.date = 'Expense date must be a valid date (YYYY-MM-DD)';
  }

  const desc = input.description !== undefined && input.description !== null
    ? String(input.description).trim() : '';
  if (!desc) {
    fields.description = 'Description is required';
  } else if (desc.length > 300) {
    fields.description = 'Description must be 300 characters or fewer';
  }

  const cat = input.category !== undefined && input.category !== null
    ? String(input.category).trim().toLowerCase() : '';
  if (!cat) {
    fields.category = 'Category is required';
  } else if (!EXPENSE_CATEGORIES.includes(cat)) {
    fields.category = `Category must be one of: ${EXPENSE_CATEGORIES.join(', ')}`;
  }

  const normAmount = normalizeAmount(input.amount);
  if (normAmount === null) {
    fields.amount = 'Amount must be a positive number with up to 2 decimal places';
  }

  const curr = input.currency !== undefined && input.currency !== null
    ? String(input.currency).trim().toUpperCase() : '';
  if (!curr) {
    fields.currency = 'Currency is required';
  } else if (!CURRENCY_RE.test(curr)) {
    fields.currency = 'Currency must be a 3-letter currency code (e.g. SAR, USD, EUR)';
  }

  if (Object.keys(fields).length > 0) {
    throw new ValidationError(fields);
  }

  return {
    tripId: input.tripId ? String(input.tripId).trim() : undefined,
    date,
    description: desc,
    category: cat,
    amount: normAmount,
    currency: curr,
  };
}
