-- 005_remove_demo_employees.sql
-- Removes the demo employees that the original pilot seed created.
--
-- REWRITTEN at pilot handover, when the demo roster was removed from 003
-- itself. A database that ran the earlier 003 already ran the earlier 005 and
-- is clean; this file remains as the cleanup for any database that has the
-- older seed without its cleanup, and it now records an event only when it
-- actually removed something.

CREATE TEMP TABLE trek_demo_cleanup ON COMMIT DROP AS
SELECT e.id FROM employee e
JOIN (VALUES
  ('emp_1001', 'GP-0007'), ('emp_1002', 'GP-0002'),
  ('emp_1004', 'GP-0004'), ('emp_1231', 'GP-0231'),
  ('emp_1232', 'GP-0232'), ('emp_1233', 'GP-0233'),
  ('emp_1234', 'GP-0234'), ('emp_1235', 'GP-0235')
) AS demo(id, code) ON e.id = demo.id AND e.employee_code = demo.code
WHERE e.company_id = 'co_trek';

-- Stop rather than delete an account that has since been used or assigned real reports.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM audit_event WHERE actor_id IN (SELECT id FROM trek_demo_cleanup))
     OR EXISTS (SELECT 1 FROM password_credential pc JOIN account a ON a.id = pc.account_id
                WHERE a.employee_id IN (SELECT id FROM trek_demo_cleanup))
     OR EXISTS (SELECT 1 FROM employee WHERE manager_id IN (SELECT id FROM trek_demo_cleanup)
                AND id NOT IN (SELECT id FROM trek_demo_cleanup))
     OR EXISTS (SELECT 1 FROM password_reset_token WHERE created_by IN (SELECT id FROM trek_demo_cleanup)) THEN
    RAISE EXCEPTION 'Demo accounts have real usage or references; inspect before removing them';
  END IF;
END $$;

UPDATE department SET head_id = NULL WHERE head_id IN (SELECT id FROM trek_demo_cleanup);
UPDATE employee SET manager_id = NULL WHERE id IN (SELECT id FROM trek_demo_cleanup);
-- Account deletion cascades to its sessions, identities and password-link tokens.
DELETE FROM account WHERE employee_id IN (SELECT id FROM trek_demo_cleanup);
DELETE FROM employee WHERE id IN (SELECT id FROM trek_demo_cleanup);

-- Recorded only when something was actually removed, so a clean database has a
-- clean audit log.
INSERT INTO audit_event (company_id, actor_label, action, entity_type, entity_id, detail, metadata)
SELECT 'co_trek', 'system', 'company.demo_cleanup', 'company', 'co_trek',
       'Removed original demo employee accounts',
       jsonb_build_object('removed', (SELECT count(*) FROM trek_demo_cleanup))
WHERE EXISTS (SELECT 1 FROM trek_demo_cleanup);
