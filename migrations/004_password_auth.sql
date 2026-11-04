-- 004_password_auth.sql
-- AUTH-01 (directed by the product owner, 23 Sep 2026): passwordless email OTP is
-- replaced by work email + password for the Sales pilot.
--
-- 001–003 are NOT edited. Forward-only, whether or not they have been applied anywhere.
--
--   DROP    otp_challenge                                  OTP-only, ephemeral data
--   UPDATE  account_identity.provider 'email_otp' → 'password'
--   ALTER   session.method default → 'password'
--   CREATE  password_credential                            one scrypt hash per account
--   CREATE  password_reset_token                           single-use invite / reset links
--   CREATE  login_attempt                                  lockout + throttling
--
-- Unchanged: company, department, cost_center, employee, account, session shape,
-- audit_event and its immutability. Historic auth.code_sent / auth.verify_failed audit
-- rows are history and stay.

DROP TABLE IF EXISTS otp_challenge;

UPDATE account_identity SET provider = 'password' WHERE provider = 'email_otp';

ALTER TABLE session ALTER COLUMN method SET DEFAULT 'password';

-- ---------------------------------------------------------------- password_credential

CREATE TABLE password_credential (
  account_id  text PRIMARY KEY REFERENCES account(id) ON DELETE CASCADE,
  hash        text NOT NULL,
  changed_at  timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE password_credential IS 'Absent row = no password set yet. There is no default password: an account without a row cannot sign in until its owner sets one through a single-use link.';
COMMENT ON COLUMN password_credential.hash IS 'scrypt$<log2N>$<r>$<p>$<salt>$<key>. The plaintext is never stored, logged or returned.';

-- ---------------------------------------------------------------- password_reset_token

CREATE TYPE password_link_purpose AS ENUM ('invite', 'reset');

CREATE TABLE password_reset_token (
  id          text PRIMARY KEY DEFAULT 'prt_' || encode(gen_random_bytes(8), 'hex'),
  account_id  text NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  purpose     password_link_purpose NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_by  text REFERENCES employee(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX password_reset_token_live_idx ON password_reset_token (account_id) WHERE used_at IS NULL;

COMMENT ON COLUMN password_reset_token.token_hash IS 'SHA-256 of the link token. The token itself exists only in the emailed (or operator-issued) link.';
COMMENT ON COLUMN password_reset_token.used_at IS 'Set on use, AND when a newer link is issued — only one live link per account.';

-- ---------------------------------------------------------------- login_attempt
-- In Postgres rather than memory: serverless instances share no memory, so an
-- in-process counter would make the lockout meaningless.

CREATE TABLE login_attempt (
  id       bigserial PRIMARY KEY,
  email    text NOT NULL,
  ip       inet,
  success  boolean NOT NULL,
  at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX login_attempt_email_idx ON login_attempt (lower(email), at DESC);
CREATE INDEX login_attempt_ip_idx    ON login_attempt (ip, at DESC) WHERE NOT success;

COMMENT ON TABLE login_attempt IS 'Operational throttling data, not audit. Failed and successful sign-ins are ALSO written to audit_event, which is permanent. This table may be pruned.';
