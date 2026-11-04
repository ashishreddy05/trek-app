/* Validation for Trips. */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

export function validateTrip(input) {
  const fields = {};

  const dest = input.destination !== undefined && input.destination !== null
    ? String(input.destination).trim() : '';
  if (!dest) {
    fields.destination = 'Destination is required';
  } else if (dest.length > 200) {
    fields.destination = 'Destination must be 200 characters or fewer';
  }

  const purpose = input.purpose !== undefined && input.purpose !== null
    ? String(input.purpose).trim() : '';
  if (!purpose) {
    fields.purpose = 'Purpose is required';
  } else if (purpose.length > 500) {
    fields.purpose = 'Purpose must be 500 characters or fewer';
  }

  const start = input.startDate !== undefined && input.startDate !== null
    ? String(input.startDate).trim() : '';
  if (!start) {
    fields.startDate = 'Start date is required';
  } else if (!isValidDate(start)) {
    fields.startDate = 'Start date must be a valid date (YYYY-MM-DD)';
  }

  const end = input.endDate !== undefined && input.endDate !== null
    ? String(input.endDate).trim() : '';
  if (!end) {
    fields.endDate = 'End date is required';
  } else if (!isValidDate(end)) {
    fields.endDate = 'End date must be a valid date (YYYY-MM-DD)';
  }

  if (start && end && isValidDate(start) && isValidDate(end)) {
    if (end < start) {
      fields.endDate = 'End date cannot be earlier than start date';
    }
  }

  const CURRENCY_RE = /^[A-Z]{3}$/;
  let curr = input.currency !== undefined && input.currency !== null
    ? String(input.currency).trim().toUpperCase() : 'USD';
  if (!curr) curr = 'USD';
  if (!CURRENCY_RE.test(curr)) {
    fields.currency = 'Currency must be a 3-letter currency code (e.g. USD, EUR, GBP, SAR)';
  }

  if (Object.keys(fields).length > 0) {
    throw new ValidationError(fields);
  }

  return {
    destination: dest,
    purpose,
    startDate: start,
    endDate: end,
    currency: curr,
  };
}
