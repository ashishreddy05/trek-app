-- scripts/create-app-role.sql
-- Least-privilege application role for Trek (RUNBOOK §7 control #9).
--
-- WHY: the runtime DATABASE_URL must NOT be the owner role. An application
-- compromise would otherwise be able to rewrite schema and audit history.
-- The owner/direct URL is for migrations only.
--
-- HOW: run AS THE OWNER (neondb_owner), once, after migrations — e.g. in the
-- Neon SQL editor, with the branch's default database (neondb) selected.
-- Migration 002 already creates trek_app as NOLOGIN; replace the password
-- first, then enable that role and set Vercel's DATABASE_URL to a new string
-- using trek_app / that password (pooled). Leave the owner URL out of Vercel
-- entirely. Re-runnable: it only grants, never drops.
--
-- Verified against the table set of migrations 001–004. If a future migration
-- adds a table the app writes to, GRANT it here too (no default privileges —
-- an accidental blanket grant on append-only tables is exactly what this file
-- exists to prevent).

-- The role normally exists already (migration 002). Create it if this is a
-- database where migrations have not run yet.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trek_app') THEN
    CREATE ROLE trek_app NOLOGIN;
  END IF;
END $$;

ALTER ROLE trek_app LOGIN PASSWORD 'REPLACE_WITH_A_STRONG_PASSWORD';

-- Database name: the default Neon database is neondb; adjust if yours differs.
GRANT CONNECT ON DATABASE neondb TO trek_app;
GRANT USAGE ON SCHEMA public TO trek_app;

-- Baseline: read + write, no DELETE.
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO trek_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO trek_app;

-- Append-only audit: the app may write events, never alter them.
REVOKE UPDATE ON audit_event FROM trek_app;

-- Migration history is read-only for the app; the runner connects as owner.
REVOKE INSERT, UPDATE ON schema_migrations FROM trek_app;

-- DELETE is limited to the app's own ephemeral lifecycle rows.
GRANT DELETE ON session, password_reset_token, login_attempt TO trek_app;

-- ponytail: no ALTER DEFAULT PRIVILEGES on purpose — new tables get an explicit
-- GRANT here (or in the migration that creates them) instead of silently
-- inheriting write access.
