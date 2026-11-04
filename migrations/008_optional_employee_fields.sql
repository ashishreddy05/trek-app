-- Migration 008: Make grade, location, and joining_date optional on employee table

ALTER TABLE employee ALTER COLUMN grade DROP NOT NULL;
ALTER TABLE employee ALTER COLUMN location DROP NOT NULL;
ALTER TABLE employee ALTER COLUMN joining_date DROP NOT NULL;

ALTER TABLE employee ALTER COLUMN grade SET DEFAULT 'G3';
ALTER TABLE employee ALTER COLUMN location SET DEFAULT 'Not specified';
ALTER TABLE employee ALTER COLUMN joining_date SET DEFAULT CURRENT_DATE;

ALTER TABLE employee DROP CONSTRAINT IF EXISTS employee_grade_valid;
ALTER TABLE employee ADD CONSTRAINT employee_grade_valid CHECK (
  grade IS NULL OR grade = ANY (ARRAY['G1'::text, 'G2'::text, 'G3'::text, 'G4'::text, 'G5'::text, 'G6'::text])
);
