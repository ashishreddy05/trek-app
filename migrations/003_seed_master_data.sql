-- 003_seed_master_data.sql
-- Company, six departments + cost centers, pilot employees, accounts.
-- Seed data is a MIGRATION, not a script someone remembers to run.
--
-- Fresh-database pilot seed. The temporary admin uses test personnel values below.
-- Only Sales plus the four function roles
-- are active; the other five departments' staff are seeded inactive, which also
-- exercises the not-activated message on a real person during the pilot.

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

-- ---------------------------------------------------------------- function roles
-- Department heads: manager_id IS NULL by design. See BD-02 — they have no approval
-- route until the fallback is signed, and BD-01's guard will refuse their own trips.

INSERT INTO employee (id, company_id, employee_code, name, work_email, mobile,
                      department_id, designation, grade, manager_id, cost_center_id,
                      location, joining_date, status, roles) VALUES
  ('emp_1001', 'co_trek', 'GP-0007', 'Vikram Shetty', 'vikram.shetty@garageplug.com', NULL,
   'dep_sls', 'VP Sales', 'G6', NULL, 'cc_ccsls01',
   'Riyadh', '2021-03-15', 'active', ARRAY['employee','manager']),

  ('emp_1002', 'co_trek', 'GP-0002', 'Ravi Nambiar', 'ravi.nambiar@garageplug.com', NULL,
   'dep_fin', 'Finance Controller', 'G6', NULL, 'cc_ccfin01',
   'Riyadh', '2020-07-01', 'active', ARRAY['employee','finance']),

  ('emp_1004', 'co_trek', 'GP-0004', 'Sara Mansour', 'sara.mansour@garageplug.com', NULL,
   'dep_hrt', 'Travel Desk Lead', 'G4', NULL, 'cc_cchrt01',
   'Riyadh', '2022-01-10', 'active', ARRAY['employee','hr_travel']),

  -- Temporary bootstrap account: code, grade, location and joining date are TEST
  -- placeholders required by the schema, not real personnel details. Update them
  -- in Employees. After Abdul can sign in as admin, he removes this admin role.
  ('emp_1000', 'co_trek', 'TEST-ADMIN', 'Ashish Reddy', 'ashishreddy@garageplug.com', NULL,
   'dep_adm', 'Temporary test administrator', 'G1', NULL, 'cc_ccadm01',
   'Not configured', CURRENT_DATE, 'active', ARRAY['employee','admin']);

-- ---------------------------------------------------------------- Sales pilot users
-- Five travellers, all reporting to Vikram Shetty (emp_1001), all on CC-SLS-01.

INSERT INTO employee (id, company_id, employee_code, name, work_email, mobile,
                      department_id, designation, grade, manager_id, cost_center_id,
                      location, joining_date, status, roles) VALUES
  ('emp_1231', 'co_trek', 'GP-0231', 'Suresh Kumar', 'suresh.kumar@garageplug.com', NULL,
   'dep_sls', 'Senior Account Executive', 'G4', 'emp_1001', 'cc_ccsls01',
   'Riyadh', '2023-02-06', 'active', ARRAY['employee']),

  ('emp_1232', 'co_trek', 'GP-0232', 'Nadia Haddad', 'nadia.haddad@garageplug.com', NULL,
   'dep_sls', 'Account Executive', 'G3', 'emp_1001', 'cc_ccsls01',
   'Jeddah', '2023-09-11', 'active', ARRAY['employee']),

  ('emp_1233', 'co_trek', 'GP-0233', 'Omar Farouk', 'omar.farouk@garageplug.com', NULL,
   'dep_sls', 'Account Executive', 'G3', 'emp_1001', 'cc_ccsls01',
   'Riyadh', '2024-01-15', 'active', ARRAY['employee']),

  ('emp_1234', 'co_trek', 'GP-0234', 'Meera Iyer', 'meera.iyer@garageplug.com', NULL,
   'dep_sls', 'Enterprise Account Manager', 'G4', 'emp_1001', 'cc_ccsls01',
   'Riyadh', '2022-06-01', 'active', ARRAY['employee']),

  ('emp_1235', 'co_trek', 'GP-0235', 'Tom Whitfield', 'tom.whitfield@garageplug.com', NULL,
   'dep_sls', 'Regional Sales Manager', 'G3', 'emp_1001', 'cc_ccsls01',
   'London', '2023-04-18', 'active', ARRAY['employee']);

-- Department heads.
UPDATE department SET head_id = 'emp_1001' WHERE id = 'dep_sls';
UPDATE department SET head_id = 'emp_1002' WHERE id = 'dep_fin';
UPDATE department SET head_id = 'emp_1004' WHERE id = 'dep_hrt';
UPDATE department SET head_id = 'emp_1000' WHERE id = 'dep_adm';
-- dep_mkt and dep_csm heads are seeded with their departments' staff in a later
-- migration, when those departments are activated for wider rollout.

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
        'Pilot master data seeded — 6 departments, 6 cost centers, 9 employees',
        '{"migration":"003_seed_master_data","pilot":"sales"}'::jsonb);

-- ============================================================================
-- NOT SEEDED — gated. See GATED.md
--   destination_band, country_band   BD-06        (band master data)
--   policy                           BD-03, BD-04, ST-03 (money type)
--   workflow                         BD-02, BD-09 (approval chain resolution)
-- No trip, expense, advance or settlement tables exist yet.
-- ============================================================================
