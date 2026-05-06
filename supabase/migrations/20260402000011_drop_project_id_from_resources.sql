-- Project membership is resolved through parent links in the ontology,
-- not a column on the resources table. The project_id column enforced
-- one-to-one when the ontology supports many-to-many.

DROP INDEX IF EXISTS resources_project_id_idx;
ALTER TABLE resources DROP COLUMN IF EXISTS project_id;
