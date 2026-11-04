-- 007_trip_currency.sql
-- Add currency to trip planning for multi-currency international travel.

ALTER TABLE trip ADD COLUMN IF NOT EXISTS currency char(3) NOT NULL DEFAULT 'USD';
