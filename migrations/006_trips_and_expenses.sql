-- 006_trips_and_expenses.sql
-- Pilot schema for Trips and Expenses.
--
-- Forward-only migration. Preserves all earlier migrations (001-005).
-- Stores money exactly as NUMERIC(14,2) without floating-point conversions.

CREATE TYPE trip_status AS ENUM ('draft', 'submitted', 'approved', 'rejected');

CREATE TABLE trip (
  id                text PRIMARY KEY DEFAULT 'trp_' || encode(gen_random_bytes(8), 'hex'),
  company_id        text REFERENCES company(id) DEFAULT 'co_trek',
  employee_id       text NOT NULL REFERENCES employee(id),
  destination       text NOT NULL,
  purpose           text NOT NULL,
  start_date        date NOT NULL,
  end_date          date NOT NULL,
  status            trip_status NOT NULL DEFAULT 'draft',
  submitted_at      timestamptz,
  decided_at        timestamptz,
  decided_by        text REFERENCES employee(id),
  rejection_reason  text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trip_dates_valid CHECK (end_date >= start_date)
);

CREATE INDEX trip_employee_idx ON trip (employee_id, created_at DESC);
CREATE INDEX trip_status_idx   ON trip (status);

CREATE TYPE expense_status AS ENUM ('draft', 'submitted', 'approved', 'rejected');

CREATE TABLE expense (
  id                text PRIMARY KEY DEFAULT 'exp_' || encode(gen_random_bytes(8), 'hex'),
  company_id        text REFERENCES company(id) DEFAULT 'co_trek',
  trip_id           text NOT NULL REFERENCES trip(id) ON DELETE CASCADE,
  employee_id       text NOT NULL REFERENCES employee(id),
  expense_date      date NOT NULL,
  description       text NOT NULL,
  category          text NOT NULL,
  amount            numeric(14, 2) NOT NULL,
  currency          char(3) NOT NULL,
  status            expense_status NOT NULL DEFAULT 'draft',
  submitted_at      timestamptz,
  decided_at        timestamptz,
  decided_by        text REFERENCES employee(id),
  rejection_reason  text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT expense_amount_positive CHECK (amount > 0)
);

CREATE INDEX expense_trip_idx     ON expense (trip_id, created_at DESC);
CREATE INDEX expense_employee_idx ON expense (employee_id, created_at DESC);
CREATE INDEX expense_status_idx   ON expense (status);

CREATE TRIGGER trip_updated_at    BEFORE UPDATE ON trip    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER expense_updated_at BEFORE UPDATE ON expense FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Grant permissions to trek_app if the restricted runtime role exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trek_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON trip, expense TO trek_app;
  END IF;
END $$;
