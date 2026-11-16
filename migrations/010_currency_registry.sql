-- 010_currency_registry.sql
-- The currencies Trek knows about, and the exchange rates it remembers.
--
-- WHY: rates were typed by hand into every trip's currency plan. Nobody
-- remembers them, and the same AED rate was retyped on every trip. The rate
-- now has ONE home — this table — and a trip's plan can look it up instead of
-- making someone remember it.
--
-- WHAT DOES NOT CHANGE: every money row still stores the rate it used
-- (rate_to_base) and the amount it produced (base_amount). A rate remembered
-- here is a DEFAULT to offer, never a rewrite. Changing a rate here never
-- touches money that was already budgeted, spent or issued — that snapshot is
-- what makes an old trip's arithmetic auditable.

-- ---------------------------------------------------------------- currencies
-- The registry the interface draws its currency lists from. The codes that
-- used to be hardcoded in two dropdowns live here now, so there is one list.

CREATE TABLE currency (
  code         char(3) PRIMARY KEY,
  name         text NOT NULL,
  symbol       text,
  -- Minor units: how many decimal places the currency has. INR, USD, AED have
  -- two (paise, cents, fils); JPY has none. Money is stored with two places
  -- everywhere in Trek today; this records the truth about the currency
  -- itself, so a currency that does not use minor units can be added later
  -- without a second migration.
  minor_units  smallint NOT NULL DEFAULT 2,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT currency_code_uppercase CHECK (code = upper(code)),
  CONSTRAINT currency_minor_units_valid CHECK (minor_units BETWEEN 0 AND 4)
);

INSERT INTO currency (code, name, symbol, minor_units) VALUES
  ('USD', 'US Dollar',        '$',  2),
  ('EUR', 'Euro',              '€',  2),
  ('GBP', 'British Pound',     '£',  2),
  ('SAR', 'Saudi Riyal',       'SAR', 2),
  ('AED', 'UAE Dirham',        'AED', 2),
  ('INR', 'Indian Rupee',      '₹',  2),
  ('SGD', 'Singapore Dollar',  'S$', 2),
  ('JPY', 'Japanese Yen',      '¥',  0),
  ('CAD', 'Canadian Dollar',   'C$', 2),
  ('AUD', 'Australian Dollar', 'A$', 2),
  ('CHF', 'Swiss Franc',       'CHF', 2);

-- ------------------------------------------------------------ exchange rates
-- The rates Trek remembers. One row per currency pair per day: entering a
-- rate for today does not erase last week's, so a trip can still show the
-- rate that was true when it was booked.
--
-- `rate` is how many units of `to_code` one unit of `from_code` buys.
-- The trip's currency plan stores the inverse (how many BASE one unit of the
-- foreign currency buys) — the same number, expressed the other way round.

CREATE TABLE exchange_rate (
  id           text PRIMARY KEY DEFAULT 'xr_' || encode(gen_random_bytes(8), 'hex'),
  from_code    char(3) NOT NULL REFERENCES currency(code),
  to_code      char(3) NOT NULL REFERENCES currency(code),
  rate         numeric(20, 8) NOT NULL,
  effective_on date NOT NULL DEFAULT CURRENT_DATE,
  entered_by   text REFERENCES employee(id),
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exchange_rate_positive CHECK (rate > 0),
  CONSTRAINT exchange_rate_distinct_pair CHECK (from_code <> to_code),
  CONSTRAINT exchange_rate_pair_day_unique UNIQUE (from_code, to_code, effective_on)
);

CREATE INDEX exchange_rate_lookup_idx
  ON exchange_rate (from_code, to_code, effective_on DESC);

-- ------------------------------------------------- one base currency, read
-- company.base_currency said SAR and nothing read it; trip.base_currency was
-- hardcoded INR at insert. Now there is ONE answer, stored on the company and
-- read from there, and the column that disagreed is corrected.
--
-- Every existing money row keeps its base_amount, which was already INR. So
-- moving the company to INR changes no booked money — it only makes the
-- stored value the one the code actually used.

UPDATE company SET base_currency = 'INR' WHERE base_currency IS DISTINCT FROM 'INR';

-- The trip's base currency already defaults to INR, which is now the
-- company's. This makes the default explicit rather than coincidental.
ALTER TABLE trip ALTER COLUMN base_currency SET DEFAULT 'INR';

COMMENT ON TABLE exchange_rate IS
  'Exchange rates Trek remembers, one row per currency pair per day. A rate is '
  'remembered here and offered as a default on a trip; it never rewrites money '
  'already booked, because every money row stores the rate it actually used.';

COMMENT ON TABLE currency IS
  'The currencies Trek knows about. One list, served to the interface, so the '
  'currency pickers cannot drift apart.';

-- Grant permissions to trek_app if the restricted runtime role exists.
-- Without this the app runs as the owner locally and fails with
-- "permission denied for table currency" in production — which is the whole
-- point of the restricted role.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trek_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON currency, exchange_rate TO trek_app;
  END IF;
END $$;
