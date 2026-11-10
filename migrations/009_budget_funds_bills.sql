-- 009_budget_funds_bills.sql
-- The pilot workflow in one migration: budget, forex plan, fund allocation,
-- receipt bills, and post-trip reconciliation.
--
-- WORKFLOW STAGES (trip.status):
--   draft                  employee is preparing the trip and its budget
--   submitted              budget is with an approver
--   changes_requested      approver asked for changes; the employee edits and resubmits
--   approved               budget approved; awaiting fund allocation
--   active                 funds issued; daily expenses and bills are being recorded
--   reconciliation_pending final reconciliation computed, waiting on Finance
--   reconciled             Finance approved the reconciliation; awaiting settlement
--   closed                 settled and closed
--
-- MONEY: every amount is NUMERIC(14,2) and every derived base amount is computed
-- with exact numeric arithmetic (round(amount * rate, 2)). Rates are NUMERIC(20,8).
-- Nothing is ever converted to a float. Postgres numeric arithmetic is exact, so
-- base_amount is computed in SQL and never in JavaScript.
--
-- base_amount is a SNAPSHOT taken when the row is written. Changing the rate on
-- the forex plan later never rewrites money that was already budgeted, spent or
-- issued — the rate used is stored on the row so the arithmetic stays auditable
-- without needing the plan's history.
--
-- The trip's base currency is INR (the company books in INR). A trip may spend in
-- several currencies; each one used needs a forex plan row carrying its rate.
--
-- CATEGORY VOCABULARY: one list, shared by budget lines and expenses, so
-- budget-versus-actual is a like-for-like comparison. The vocabulary is the one
-- the pilot asked for: travel, accommodation, food, visa, sim_card, other. The
-- earlier prototype values are folded into it below.
--
-- Note on ALTER TYPE ... ADD VALUE: in PostgreSQL a value added inside a
-- transaction cannot be used until that transaction commits. This file therefore
-- only adds values and never writes one; the code paths that use them run against
-- a committed schema.

ALTER TYPE trip_status ADD VALUE IF NOT EXISTS 'changes_requested';
ALTER TYPE trip_status ADD VALUE IF NOT EXISTS 'active';
ALTER TYPE trip_status ADD VALUE IF NOT EXISTS 'reconciliation_pending';
ALTER TYPE trip_status ADD VALUE IF NOT EXISTS 'reconciled';
ALTER TYPE trip_status ADD VALUE IF NOT EXISTS 'closed';

CREATE TYPE fund_kind AS ENUM ('cash', 'forex_card', 'additional');
CREATE TYPE payment_method AS ENUM ('cash', 'forex_card', 'card', 'bank_transfer');
CREATE TYPE reconciliation_status AS ENUM ('pending', 'approved', 'rejected');

-- ---------------------------------------------------------------- base currency

ALTER TABLE trip ADD COLUMN base_currency char(3) NOT NULL DEFAULT 'INR';

-- ---------------------------------------------------------------- category vocabulary
--
-- Both tables reference one vocabulary. The constraint is added to expense first,
-- after existing rows are folded into it.

ALTER TABLE expense DROP CONSTRAINT IF EXISTS expense_category_valid;
UPDATE expense SET category = CASE category
  WHEN 'meals'     THEN 'food'
  WHEN 'lodging'   THEN 'accommodation'
  WHEN 'transport' THEN 'travel'
  WHEN 'airfare'   THEN 'travel'
  WHEN 'supplies'  THEN 'other'
  ELSE category
END;
ALTER TABLE expense ADD CONSTRAINT expense_category_valid CHECK (category IN (
  'travel', 'accommodation', 'food', 'visa', 'sim_card', 'other'
));

-- ---------------------------------------------------------------- budget lines
--
-- The estimated expenses of a trip: travel, accommodation, food, visa, SIM card
-- and everything else, one row per line.

CREATE TABLE trip_budget_line (
  id            text PRIMARY KEY DEFAULT 'tbd_' || encode(gen_random_bytes(8), 'hex'),
  trip_id       text NOT NULL REFERENCES trip(id) ON DELETE CASCADE,
  category      text NOT NULL,
  description   text NOT NULL,
  amount        numeric(14, 2) NOT NULL,
  currency      char(3) NOT NULL,
  rate_to_base  numeric(20, 8) NOT NULL,
  base_amount   numeric(14, 2) NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trip_budget_line_amount_positive CHECK (amount > 0),
  CONSTRAINT trip_budget_line_rate_positive   CHECK (rate_to_base > 0),
  CONSTRAINT trip_budget_line_category_valid   CHECK (category IN (
    'travel', 'accommodation', 'food', 'visa', 'sim_card', 'other'
  ))
);

CREATE INDEX trip_budget_line_trip_idx ON trip_budget_line (trip_id, created_at);

-- ---------------------------------------------------------------- forex plan
--
-- What the traveller asked for, per currency: cash to be carried, forex card to
-- be loaded, the exchange rate to base, and the charges that come with it
-- (GST, forex top-up, other service fees). All charges are in base currency.

CREATE TABLE trip_fx_plan (
  id            text PRIMARY KEY DEFAULT 'fxp_' || encode(gen_random_bytes(8), 'hex'),
  trip_id       text NOT NULL REFERENCES trip(id) ON DELETE CASCADE,
  currency      char(3) NOT NULL,
  cash_amount   numeric(14, 2) NOT NULL DEFAULT 0,
  card_amount   numeric(14, 2) NOT NULL DEFAULT 0,
  rate_to_base  numeric(20, 8) NOT NULL,
  gst_amount    numeric(14, 2) NOT NULL DEFAULT 0,
  topup_fee     numeric(14, 2) NOT NULL DEFAULT 0,
  service_fee   numeric(14, 2) NOT NULL DEFAULT 0,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trip_fx_plan_amounts_non_negative CHECK (
    cash_amount >= 0 AND card_amount >= 0 AND gst_amount >= 0 AND topup_fee >= 0 AND service_fee >= 0
  ),
  CONSTRAINT trip_fx_plan_rate_positive CHECK (rate_to_base > 0),
  CONSTRAINT trip_fx_plan_currency_unique UNIQUE (trip_id, currency)
);

-- ---------------------------------------------------------------- funds issued
--
-- What the company actually handed over: cash, a forex card, or an additional
-- tranche issued mid-trip. The sum of these is what reconciliation compares
-- against the money actually spent.

CREATE TABLE trip_fund (
  id            text PRIMARY KEY DEFAULT 'fnd_' || encode(gen_random_bytes(8), 'hex'),
  trip_id       text NOT NULL REFERENCES trip(id) ON DELETE CASCADE,
  kind          fund_kind NOT NULL,
  currency      char(3) NOT NULL,
  amount        numeric(14, 2) NOT NULL,
  rate_to_base  numeric(20, 8) NOT NULL,
  base_amount   numeric(14, 2) NOT NULL,
  note          text,
  issued_by     text REFERENCES employee(id),
  issued_at     timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trip_fund_amount_positive CHECK (amount > 0),
  CONSTRAINT trip_fund_rate_positive   CHECK (rate_to_base > 0)
);

CREATE INDEX trip_fund_trip_idx ON trip_fund (trip_id, issued_at);

-- ---------------------------------------------------------------- bills
--
-- Receipts against an expense. Stored in the database rather than object storage:
-- object storage (region, encryption, retention) is an open decision, and a
-- receipt is a few hundred kilobytes. Size is capped by the upload route.

CREATE TABLE expense_bill (
  id            text PRIMARY KEY DEFAULT 'bll_' || encode(gen_random_bytes(8), 'hex'),
  expense_id    text NOT NULL REFERENCES expense(id) ON DELETE CASCADE,
  trip_id       text NOT NULL REFERENCES trip(id) ON DELETE CASCADE,
  filename      text NOT NULL,
  content_type  text NOT NULL,
  byte_size     integer NOT NULL,
  sha256        char(64) NOT NULL,
  content       bytea NOT NULL,
  uploaded_by   text REFERENCES employee(id),
  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT expense_bill_size_positive CHECK (byte_size > 0)
);

CREATE INDEX expense_bill_expense_idx ON expense_bill (expense_id, uploaded_at);

-- ---------------------------------------------------------------- reconciliation
--
-- The end-of-trip arithmetic, snapshotted once so a decision is made against a
-- fixed set of numbers. balance_base > 0 means the traveller must hand money
-- back; < 0 means the company owes the traveller.

CREATE TABLE trip_reconciliation (
  id             text PRIMARY KEY DEFAULT 'rec_' || encode(gen_random_bytes(8), 'hex'),
  trip_id        text NOT NULL REFERENCES trip(id) ON DELETE CASCADE,
  funds_base     numeric(14, 2) NOT NULL,
  expenses_base  numeric(14, 2) NOT NULL,
  balance_base   numeric(14, 2) NOT NULL,
  status         reconciliation_status NOT NULL DEFAULT 'pending',
  computed_at    timestamptz NOT NULL DEFAULT now(),
  decided_by     text REFERENCES employee(id),
  decided_at     timestamptz,
  decision_note  text,
  settled_by     text REFERENCES employee(id),
  settled_at     timestamptz,
  settlement_note text,
  CONSTRAINT trip_reconciliation_trip_unique UNIQUE (trip_id)
);

-- ---------------------------------------------------------------- expenses
--
-- payment_method records HOW the money moved (cash, forex card, card, bank
-- transfer). base_amount and rate_to_base are the same snapshot idea as above.

ALTER TABLE expense ADD COLUMN payment_method payment_method NOT NULL DEFAULT 'cash';
ALTER TABLE expense ADD COLUMN rate_to_base numeric(20, 8);
ALTER TABLE expense ADD COLUMN base_amount numeric(14, 2);

-- Rows written before this migration had no currency conversion; book them at
-- their own amount (rate 1) so the columns can be NOT NULL afterwards.
UPDATE expense SET rate_to_base = 1, base_amount = amount WHERE base_amount IS NULL;
ALTER TABLE expense ALTER COLUMN rate_to_base SET NOT NULL;
ALTER TABLE expense ALTER COLUMN base_amount SET NOT NULL;

-- The approved budget is frozen on the trip at approval time, so later
-- reconciliation compares against what was approved, not what was later typed.
ALTER TABLE trip ADD COLUMN approved_budget_base numeric(14, 2);

CREATE TRIGGER trip_budget_line_updated_at BEFORE UPDATE ON trip_budget_line FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trip_fx_plan_updated_at      BEFORE UPDATE ON trip_fx_plan      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Grant permissions to trek_app if the restricted runtime role exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trek_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON trip_budget_line, trip_fx_plan, trip_fund, expense_bill, trip_reconciliation TO trek_app;
  END IF;
END $$;
