-- Add nullable project_id UUID column to resources table
-- Self-referential FK: projects are resources with project_id = NULL
-- Child resources point to their parent project resource

ALTER TABLE resources
  ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES resources(id) ON DELETE SET NULL
    CHECK (project_id IS DISTINCT FROM id);

COMMENT ON COLUMN resources.project_id IS 'Optional project membership — FK to resources(id). Projects themselves have project_id = NULL. Set on child resources to scope them to a project.';

CREATE INDEX IF NOT EXISTS resources_project_id_idx ON resources (project_id);
