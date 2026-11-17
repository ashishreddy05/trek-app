-- 013_trip_itinerary_and_funding.sql
-- Multi-city itineraries, the traveller's own contribution, and the amount
-- the company is asked to fund.
--
-- `origin` is the departure city. It is deliberately nullable and is never
-- defaulted by the server: an assumed origin quietly produces a flight search
-- to the wrong airport.
--
-- `trip_leg` records every leg of the journey in order. The first leg may be
-- the direct origin → destination trip, and a round trip is simply more legs
-- (A→B→C→D→B→A). Editing a draft replaces the set: legs have no independent
-- identity a user can update one at a time.
--
-- `own_funds_base` is money the traveller already has for this trip, in the
-- company base currency. `requested_funds_base` is frozen when the trip is
-- submitted as max(0, budget - own funds). Finance may issue any amount
-- afterwards; trip_fund remains the record of what was actually handed over.

ALTER TABLE trip ADD COLUMN origin text;
ALTER TABLE trip ADD COLUMN own_funds_base numeric(14, 2) NOT NULL DEFAULT 0;
ALTER TABLE trip ADD COLUMN requested_funds_base numeric(14, 2);

ALTER TABLE trip ADD CONSTRAINT trip_own_funds_non_negative CHECK (own_funds_base >= 0);

-- Trips approved or submitted before this migration had no own-funds field,
-- so the whole approved budget is the sensible request to carry forward.
UPDATE trip
   SET requested_funds_base = GREATEST(approved_budget_base - own_funds_base, 0)
 WHERE approved_budget_base IS NOT NULL;

CREATE TABLE trip_leg (
  id            text PRIMARY KEY DEFAULT 'tlg_' || encode(gen_random_bytes(8), 'hex'),
  trip_id       text NOT NULL REFERENCES trip(id) ON DELETE CASCADE,
  seq           integer NOT NULL,
  from_city     text NOT NULL,
  to_city       text NOT NULL,
  depart_date   date,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trip_leg_seq_positive CHECK (seq > 0),
  CONSTRAINT trip_leg_trip_seq_unique UNIQUE (trip_id, seq)
);

CREATE INDEX trip_leg_trip_idx ON trip_leg (trip_id, seq);

CREATE TRIGGER trip_leg_updated_at BEFORE UPDATE ON trip_leg
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trek_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON trip_leg TO trek_app;
  END IF;
END $$;
