-- 003_seed_master_data.sql
-- Company, six departments + cost centers, and the two administrators.
--
-- Seed data is a MIGRATION, not a script someone remembers to run.
--
-- REWRITTEN at handover. The earlier version of this file seeded eight demo
-- employees — a fictional sales team — which migration 005 then had to delete
-- again. They were never employees of this company and their names were real
-- colleagues', so the roster is gone from the seed itself rather than created
-- and then removed.
--
-- What is left is master data plus the two people who can actually sign in, so
-- a fresh database is immediately usable. No password is set here: an
-- administrator signs in for the first time with a single-use link issued by an
-- operator (npm run issue-password-link <email>).

INSERT INTO company (id, name, base_currency, domains) VALUES
  ('co_trek', 'GaragePlug', 'SAR', ARRAY['garageplug.com']);

INSERT INTO department (id, company_id, code, name, active) VALUES
  ('dep_sls', 'co_trek', 'SLS', 'Sales',            true),
  ('dep_mkt', 'co_trek', 'MKT', 'Marketing',        true),
  ('dep_csm', 'co_trek', 'CSM', 'Customer Success', true),
  ('dep_fin', 'co_trek', 'FIN', 'Finance',          true),
  ('dep_hrt', 'co_trek', 'HRT', 'HR / Travel',      true),
  ('dep_adm', 'co_trek', 'ADM', 'Admin',            true);

INSERT INTO cost_center (id, company_id, department_id, code, name) VALUES
  ('cc_ccsls01', 'co_trek', 'dep_sls', 'CC-SLS-01', 'Sales — field'),
  ('cc_ccmkt01', 'co_trek', 'dep_mkt', 'CC-MKT-01', 'Marketing — events'),
  ('cc_cccsm01', 'co_trek', 'dep_csm', 'CC-CSM-01', 'Customer Success — onsite'),
  ('cc_ccfin01', 'co_trek', 'dep_fin', 'CC-FIN-01', 'Finance'),
  ('cc_cchrt01', 'co_trek', 'dep_hrt', 'CC-HRT-01', 'HR / Travel'),
  ('cc_ccadm01', 'co_trek', 'dep_adm', 'CC-ADM-01', 'Admin');

-- ---------------------------------------------------------------- administrators
-- The two people who run the pilot. Both report to nobody, so their own travel
-- requests are refused with 422 no_approval_route until the reporting lines
-- are configured (BD-01/BD-02). Everyone else is added through the app.

INSERT INTO employee (id, company_id, employee_code, name, work_email, mobile,
                      department_id, designation, grade, manager_id, cost_center_id,
                      location, joining_date, status, roles) VALUES
  ('emp_1692', 'co_trek', 'EMP-001', 'Abdul Mastan', 'abdul@garageplug.com', NULL,
   'dep_adm', 'System Administrator', 'G5', NULL, 'cc_ccadm01',
   'Not specified', '2026-11-03', 'active', ARRAY['employee','admin']),

  ('emp_1000', 'co_trek', 'EMP-002', 'Ashish Reddy', 'ashishreddy@garageplug.com', NULL,
   'dep_adm', 'Administrator', 'G5', NULL, 'cc_ccadm01',
   'Not specified', '2026-11-03', 'active', ARRAY['employee','admin']);

UPDATE department SET head_id = 'emp_1000' WHERE id = 'dep_adm';
-- The other five departments have no head yet. A head is appointed when the
-- department is activated for real use.

-- ---------------------------------------------------------------- accounts
-- One per employee, mirroring status. NO AUTO-PROVISIONING at login: an unknown or
-- inactive email creates nothing.

INSERT INTO account (company_id, employee_id, status)
SELECT company_id, id, CASE WHEN status = 'active' THEN 'active' ELSE 'suspended' END::account_status
FROM employee;

INSERT INTO account_identity (account_id, provider, subject)
SELECT a.id, 'email_otp', lower(e.work_email)
FROM account a JOIN employee e ON e.id = a.employee_id;

-- ---------------------------------------------------------------- audit

INSERT INTO audit_event (company_id, actor_id, actor_label, action, entity_type, entity_id,
                         previous_state, new_state, detail, metadata)
VALUES ('co_trek', NULL, 'system', 'company.seed', 'company', 'co_trek',
        NULL, 'active',
        'Pilot master data seeded — 6 departments, 6 cost centers, 2 administrators',
        '{"migration":"003_seed_master_data","administrators":2}'::jsonb);

-- ============================================================================
-- NOT SEEDED — gated. See GATED.md
--   destination_band, country_band   BD-06        (band master data)
--   policy                           BD-03, BD-04, ST-03 (money type)
--   workflow                         BD-02, BD-09 (approval chain resolution)
-- No trip, expense, advance or settlement tables exist yet.
-- ============================================================================
