-- 0005_rls_fix_empty_setting.sql
--
-- `SET LOCAL app.org_id` leaves the GUC defined-but-empty once the
-- transaction ends, so `current_setting('app.org_id', true)::uuid` raised
-- 22P02 (invalid uuid "") instead of matching no rows. Wrapping it in NULLIF
-- makes the policies fail CLOSED (NULL never equals org_id) rather than
-- erroring, which is the intended behaviour: a query that forgets its org
-- context returns nothing.

CREATE OR REPLACE FUNCTION app_current_org() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.org_id', true), '')::uuid $$;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname AS table_name
      FROM pg_policy pol
      JOIN pg_class c ON c.oid = pol.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE pol.polname = 'org_isolation' AND n.nspname = 'public'
  LOOP
    EXECUTE format('DROP POLICY org_isolation ON %I', r.table_name);
  END LOOP;
END $$;

-- Tables carrying org_id directly.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'teams','projects','statuses','epics','tasks','labels','task_dependencies','blockers',
    'comments','attachments','notifications','notification_prefs','activity_events',
    'braindumps','ai_conversations','ai_actions','integrations','import_runs','webhooks'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY org_isolation ON %I USING (org_id = app_current_org()) '
      || 'WITH CHECK (org_id = app_current_org())', t);
  END LOOP;
END $$;

-- Join/child tables scoped through their parent.
CREATE POLICY org_isolation ON team_members USING (
  EXISTS (SELECT 1 FROM teams tm WHERE tm.id = team_id AND tm.org_id = app_current_org()));

CREATE POLICY org_isolation ON project_members USING (
  EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.org_id = app_current_org()));

CREATE POLICY org_isolation ON project_counters USING (
  EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.org_id = app_current_org()))
  WITH CHECK (
  EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.org_id = app_current_org()));

CREATE POLICY org_isolation ON task_labels USING (
  EXISTS (SELECT 1 FROM tasks t WHERE t.id = task_id AND t.org_id = app_current_org()));

CREATE POLICY org_isolation ON watchers USING (
  EXISTS (SELECT 1 FROM tasks t WHERE t.id = task_id AND t.org_id = app_current_org()));

CREATE POLICY org_isolation ON ai_messages USING (
  EXISTS (SELECT 1 FROM ai_conversations c
           WHERE c.id = conversation_id AND c.org_id = app_current_org()));

CREATE POLICY org_isolation ON import_items USING (
  EXISTS (SELECT 1 FROM import_runs r
           WHERE r.id = import_run_id AND r.org_id = app_current_org()));
