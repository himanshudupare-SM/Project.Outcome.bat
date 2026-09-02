-- 0003_rls.sql — row-level security as tenant-isolation defense-in-depth.
--
-- The application layer is the primary enforcement (every repository call is
-- org-scoped). RLS backstops it: content tables refuse to return rows unless
-- the transaction has set the current org:
--
--   SET LOCAL app.org_id = '<uuid>';
--
-- Policies are FAIL-CLOSED: with no app.org_id set, no rows match.
-- Identity/membership tables (users, sessions, organizations, org_members,
-- invitations, auth_tokens, api_keys) intentionally have NO RLS — they are
-- queried before an org context exists (login, org list) and are protected by
-- application checks.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'teams','team_members_skip','projects','project_members_skip','project_counters_skip',
    'statuses','epics','tasks','labels','task_labels_skip','task_dependencies','blockers',
    'comments','watchers_skip','attachments','notifications','notification_prefs_skip',
    'activity_events','braindumps','ai_conversations','ai_messages_skip','ai_actions',
    'integrations','import_runs','import_items_skip','webhooks'
  ] LOOP
    IF t LIKE '%_skip' THEN CONTINUE; END IF;
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY org_isolation ON %I USING (org_id = current_setting(''app.org_id'', true)::uuid) '
      || 'WITH CHECK (org_id = current_setting(''app.org_id'', true)::uuid)', t);
  END LOOP;
END $$;

-- Tables without org_id inherit isolation via their parent's FK; scope them
-- through membership of the parent row.
ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON team_members USING (
  EXISTS (SELECT 1 FROM teams tm WHERE tm.id = team_id
          AND tm.org_id = current_setting('app.org_id', true)::uuid));

ALTER TABLE project_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_members FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON project_members USING (
  EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id
          AND p.org_id = current_setting('app.org_id', true)::uuid));

ALTER TABLE project_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON project_counters USING (
  EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id
          AND p.org_id = current_setting('app.org_id', true)::uuid))
  WITH CHECK (
  EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id
          AND p.org_id = current_setting('app.org_id', true)::uuid));

ALTER TABLE task_labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_labels FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON task_labels USING (
  EXISTS (SELECT 1 FROM tasks t WHERE t.id = task_id
          AND t.org_id = current_setting('app.org_id', true)::uuid));

ALTER TABLE watchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE watchers FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON watchers USING (
  EXISTS (SELECT 1 FROM tasks t WHERE t.id = task_id
          AND t.org_id = current_setting('app.org_id', true)::uuid));

ALTER TABLE notification_prefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_prefs FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON notification_prefs
  USING (org_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);

ALTER TABLE ai_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON ai_messages USING (
  EXISTS (SELECT 1 FROM ai_conversations c WHERE c.id = conversation_id
          AND c.org_id = current_setting('app.org_id', true)::uuid));

ALTER TABLE import_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_items FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON import_items USING (
  EXISTS (SELECT 1 FROM import_runs r WHERE r.id = import_run_id
          AND r.org_id = current_setting('app.org_id', true)::uuid));
