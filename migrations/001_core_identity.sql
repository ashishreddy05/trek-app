-- 001_core_identity.sql
-- Company, department, cost center, employee, account, otp_challenge, session.
--
-- Source: DATA-MODEL.md (approved). No pending corrections applied.
-- NO MONEY COLUMNS IN THIS MIGRATION — ST-03 (exact decimal type) is unsigned and
-- irreversible once data exists. Identity needs no money, so it goes first.
--
-- company_id is present on every table but NULLABLE with no scoping enforced.
-- That is the ST-04 hedge: single-tenant signed -> drop the column in one migration;
-- multi-tenant signed -> set NOT NULL and add a tenant clause to the guard.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- company

CREATE TABLE company (
  id             text PRIMARY KEY,
  name           text NOT NULL,
  base_currency  char(3) NOT NULL DEFAULT 'SAR',
  domains        text[] NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN company.domains IS 'Login email domain allowlist. An email outside these domains is refused before any employee lookup.';

-- ---------------------------------------------------------------- department

CREATE TABLE department (
  id          text PRIMARY KEY,
  company_id  text REFERENCES company(id),
  code        text NOT NULL,
  name        text NOT NULL,
  head_id     text,                          -- FK added after employee exists
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX department_code_key ON department (upper(code));
CREATE UNIQUE INDEX department_name_key ON department (lower(name));

COMMENT ON COLUMN department.head_id IS 'Department head. BD-09 unsigned: whether the department_head approval step resolves via this column or as the manager''s manager. This column is the recommended resolution.';

-- ---------------------------------------------------------------- cost_center

CREATE TABLE cost_center (
  id             text PRIMARY KEY,
  company_id     text REFERENCES company(id),
  department_id  text NOT NULL REFERENCES department(id),
  code           text NOT NULL,
  name           text NOT NULL,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX cost_center_code_key ON cost_center (upper(code));
CREATE INDEX cost_center_department_idx ON cost_center (department_id);

-- ---------------------------------------------------------------- employee
-- The identity record. Everything about a person's access derives from here.

CREATE TYPE employee_status AS ENUM ('active', 'inactive');

CREATE TABLE employee (
  id              text PRIMARY KEY,
  company_id      text REFERENCES company(id),
  employee_code   text NOT NULL,
  name            text NOT NULL,
  work_email      text NOT NULL,
  mobile          text,
  department_id   text NOT NULL REFERENCES department(id),
  designation     text NOT NULL,
  grade           text NOT NULL,
  manager_id      text REFERENCES employee(id),
  cost_center_id  text NOT NULL REFERENCES cost_center(id),
  location        text NOT NULL,
  joining_date    date NOT NULL,
  status          employee_status NOT NULL DEFAULT 'active',
  roles           text[] NOT NULL DEFAULT ARRAY['employee'],
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- "An employee cannot report to themselves" (approved message).
  -- Deeper cycles (A->B->A) are NOT catchable in a check constraint; enforced in
  -- application code per D-13, with a recursive CTE on manager_id change.
  CONSTRAINT employee_no_self_manager CHECK (manager_id IS NULL OR manager_id <> id),
  CONSTRAINT employee_grade_valid CHECK (grade IN ('G1','G2','G3','G4','G5','G6')),
  CONSTRAINT employee_roles_valid CHECK (
    roles <@ ARRAY['employee','manager','hr_travel','finance','admin']::text[]
  )
);

CREATE UNIQUE INDEX employee_code_key  ON employee (upper(employee_code));
CREATE UNIQUE INDEX employee_email_key ON employee (lower(work_email));
CREATE INDEX employee_department_idx   ON employee (department_id);
CREATE INDEX employee_manager_idx      ON employee (manager_id);

COMMENT ON COLUMN employee.id IS 'Internal primary key. employee_code and work_email are unique business keys but are NEVER the key. Email is never the identifier in a foreign key.';
COMMENT ON COLUMN employee.work_email IS 'Stored lowercased on write. Login identity.';
COMMENT ON COLUMN employee.grade IS 'Drives policy limits.';
COMMENT ON COLUMN employee.manager_id IS 'NULL for department heads. BD-02 unsigned: the fallback approver for a null-manager employee. Until signed, such an employee has no approval route and submission must be refused with 422 no_approval_route (BD-01).';
COMMENT ON COLUMN employee.roles IS 'Explicit roles. The manager role is ALSO implicit for anyone with >=1 direct report; that is computed per request, never stored here.';

ALTER TABLE department
  ADD CONSTRAINT department_head_fk FOREIGN KEY (head_id) REFERENCES employee(id);

-- ---------------------------------------------------------------- account
-- Auth record, deliberately separate from the employee.
-- SSO later is an append to identities + the same principal resolution. No model change.

CREATE TYPE account_status AS ENUM ('active', 'suspended');

CREATE TABLE account (
  id             text PRIMARY KEY DEFAULT 'acc_' || encode(gen_random_bytes(8), 'hex'),
  company_id     text REFERENCES company(id),
  employee_id    text NOT NULL UNIQUE REFERENCES employee(id),
  status         account_status NOT NULL DEFAULT 'active',
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE account_identity (
  id          bigserial PRIMARY KEY,
  account_id  text NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  provider    text NOT NULL,          -- 'email_otp' at pilot; 'google' / 'microsoft' later
  subject     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, subject)
);

COMMENT ON TABLE account_identity IS 'SSO is an append here plus the same principal resolution. Do not redesign auth for SSO — the model already supports it.';

-- ---------------------------------------------------------------- otp_challenge
-- Only ONE live challenge per email; issuing a new one discards the previous.

CREATE TABLE otp_challenge (
  id          text PRIMARY KEY DEFAULT 'otp_' || encode(gen_random_bytes(8), 'hex'),
  email       text NOT NULL,
  code_hash   text NOT NULL,
  expires_at  timestamptz NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  consumed    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_ip  inet
);

-- One live (unconsumed, unexpired) challenge per email is enforced in application code
-- by discarding prior challenges inside the same transaction as the insert.
CREATE INDEX otp_challenge_email_idx ON otp_challenge (lower(email), created_at DESC);
CREATE INDEX otp_challenge_expiry_idx ON otp_challenge (expires_at) WHERE NOT consumed;

COMMENT ON COLUMN otp_challenge.code_hash IS 'ARGON2 hash. The plaintext code is NEVER stored, NEVER logged, NEVER returned in an API response, NEVER rendered. It exists in one function scope and goes straight to the mail adapter.';

-- ---------------------------------------------------------------- session
-- ST-06 PROVISIONAL: opaque token + server-side session.
-- Chosen because deactivation must revoke sessions IMMEDIATELY (permissions spec §3.6),
-- which JWT cannot do without a denylist that reintroduces the lookup JWT avoids.

CREATE TABLE session (
  id           text PRIMARY KEY DEFAULT 'ses_' || encode(gen_random_bytes(8), 'hex'),
  account_id   text NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  employee_id  text NOT NULL REFERENCES employee(id),
  token_hash   text NOT NULL UNIQUE,
  method       text NOT NULL DEFAULT 'email_otp',
  user_agent   text,
  created_ip   inet,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz
);

CREATE INDEX session_employee_idx ON session (employee_id) WHERE revoked_at IS NULL;
CREATE INDEX session_expiry_idx   ON session (expires_at)  WHERE revoked_at IS NULL;

COMMENT ON COLUMN session.token_hash IS 'SHA-256 of the opaque token. The token itself is sent once, in an HttpOnly Secure cookie, and never stored.';
COMMENT ON TABLE session IS 'Multiple concurrent sessions per employee are permitted (spec requirement: travellers use phone + laptop) and are ALL revoked together on deactivation. The prototype allowed one; D-08 remains formally unsigned.';

-- ---------------------------------------------------------------- triggers

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER employee_updated_at   BEFORE UPDATE ON employee   FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER department_updated_at BEFORE UPDATE ON department FOR EACH ROW EXECUTE FUNCTION set_updated_at();
