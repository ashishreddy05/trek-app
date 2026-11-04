-- 002_audit.sql
-- The immutable record.
--
-- Audit is NOT monitoring. It is a first-class domain entity: permanent, immutable,
-- user-visible (console audit log, mobile activity feed), and legally significant.
-- It lives here, in PostgreSQL. It is never sampled, never aged out, NEVER TRUNCATED.
-- The prototype capped the log at 400 rows; production does not.
--
-- Shape is the superset agreed for implementation:
--   user (actor) · timestamp · action · previous state · new state · related entity
-- plus `detail`, the human-readable summary rendered verbatim in the console activity
-- panel and the mobile activity feed.

CREATE TABLE audit_event (
  id              bigserial PRIMARY KEY,
  company_id      text REFERENCES company(id),
  at              timestamptz NOT NULL DEFAULT now(),

  actor_id        text REFERENCES employee(id),   -- NULL for pre-auth events (denied login)
  actor_label     text,                           -- actor name AT THE TIME of the action

  action          text NOT NULL,                  -- 'trip.send_back', 'auth.login', ...
  entity_type     text NOT NULL,
  entity_id       text NOT NULL,

  previous_state  text,                           -- NULL when the entity is being created
  new_state       text,                           -- NULL for non-transition actions

  related_type    text,                           -- the other end, where an action spans two entities
  related_id      text,

  detail          text NOT NULL,                  -- human-readable, shown verbatim in the UI
  reason          text,                           -- send-back / waiver / exception reason, VERBATIM
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,

  request_id      text,                           -- correlates with the error-logging tool
  actor_ip        inet
);

CREATE INDEX audit_entity_idx     ON audit_event (entity_type, entity_id, at DESC);
CREATE INDEX audit_actor_idx      ON audit_event (actor_id, at DESC);
CREATE INDEX audit_action_idx     ON audit_event (action, at DESC);
CREATE INDEX audit_at_idx         ON audit_event (at DESC);
CREATE INDEX audit_related_idx    ON audit_event (related_type, related_id) WHERE related_type IS NOT NULL;

COMMENT ON COLUMN audit_event.actor_label IS 'The actor''s name at the time of the action. Denormalised on purpose: a decided action must stay attributable even if that person later leaves or is renamed.';
COMMENT ON COLUMN audit_event.reason IS 'Send-back reasons, missing-bill waivers and policy exceptions are stored VERBATIM. Never paraphrased, never summarised.';
COMMENT ON COLUMN audit_event.detail IS 'Rendered directly to users. Write it as a person would read it: "Report submitted for approval", not "STATE_CHANGE(trip,expense_review)".';

-- ============================================================================
-- IMMUTABILITY — enforced by the database, not by convention.
--
-- There is no write endpoint for audit at any privilege level. Events are written
-- by the operations that cause them, inside the same transaction as the write.
-- Nobody can update or delete: not Admin, not a superuser, not an operator with
-- application-level database access.
-- ============================================================================

-- The application role. Created here if absent so the grants below are self-contained;
-- in a managed environment the role usually exists already and this is a no-op.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trek_app') THEN
    CREATE ROLE trek_app NOLOGIN;
  END IF;
END $$;

GRANT INSERT, SELECT ON audit_event TO trek_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_event FROM trek_app;
GRANT USAGE, SELECT ON SEQUENCE audit_event_id_seq TO trek_app;

-- Belt and braces: a trigger that refuses mutation even if a future migration
-- accidentally re-grants the privilege.
CREATE OR REPLACE FUNCTION audit_event_is_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_event_no_update
  BEFORE UPDATE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_event_is_append_only();

CREATE TRIGGER audit_event_no_delete
  BEFORE DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_event_is_append_only();

-- Verify with: UPDATE audit_event SET detail = 'x' WHERE id = 1;  -- must raise.
-- test/audit.immutability.test.js asserts this rather than trusting the grant.
