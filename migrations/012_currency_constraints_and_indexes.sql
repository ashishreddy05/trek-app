-- 012_currency_constraints_and_indexes.sql
-- Enforce currency references to currency registry, set default company base currency to INR,
-- and add index on expense_bill(trip_id).

-- 1. Default company base currency to INR
ALTER TABLE company ALTER COLUMN base_currency SET DEFAULT 'INR';

-- 2. Foreign keys from money currency columns to currency(code)
ALTER TABLE company
  ADD CONSTRAINT company_base_currency_fkey FOREIGN KEY (base_currency) REFERENCES currency(code);

ALTER TABLE trip
  ADD CONSTRAINT trip_currency_fkey FOREIGN KEY (currency) REFERENCES currency(code),
  ADD CONSTRAINT trip_base_currency_fkey FOREIGN KEY (base_currency) REFERENCES currency(code);

ALTER TABLE expense
  ADD CONSTRAINT expense_currency_fkey FOREIGN KEY (currency) REFERENCES currency(code);

ALTER TABLE trip_budget_line
  ADD CONSTRAINT trip_budget_line_currency_fkey FOREIGN KEY (currency) REFERENCES currency(code);

ALTER TABLE trip_fx_plan
  ADD CONSTRAINT trip_fx_plan_currency_fkey FOREIGN KEY (currency) REFERENCES currency(code);

ALTER TABLE trip_fund
  ADD CONSTRAINT trip_fund_currency_fkey FOREIGN KEY (currency) REFERENCES currency(code);

-- 3. Index on expense_bill(trip_id) to eliminate sequential scans when aggregating per-trip bills
CREATE INDEX IF NOT EXISTS expense_bill_trip_id_idx ON expense_bill (trip_id);
