-- 0001_init.sql — core schema for Outcome
-- Conventions:
--   * uuid PKs via gen_random_uuid() (PG >= 13 built-in)
--   * timestamptz everywhere; created_at/updated_at on mutable tables
--   * tenant tables carry org_id; composite indexes lead with org_id
--   * soft delete via deleted_at on user-facing entities
--   * enums as text + CHECK (easier to evolve than PG enums)

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------- identity

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text NOT NULL,
  email_verified_at timestamptz,
  avatar_url text,
  timezone text NOT NULL DEFAULT 'UTC',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,           -- sha256 of the opaque token
  ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- single-use tokens: email verification, password reset
CREATE TABLE auth_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('verify_email','reset_password')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_tokens_user_idx ON auth_tokens (user_id, purpose);

-- ---------------------------------------------------------------- tenancy

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug citext NOT NULL UNIQUE,
  created_by uuid NOT NULL REFERENCES users(id),
  settings jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE org_members (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','admin','member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX org_members_user_idx ON org_members (user_id);

CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email citext NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','member')),
  invited_by uuid NOT NULL REFERENCES users(id),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- one live invitation per (org,email)
CREATE UNIQUE INDEX invitations_live_uq ON invitations (org_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE TABLE teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX teams_org_name_uq ON teams (org_id, lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE team_members (
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);

-- ---------------------------------------------------------------- projects

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  team_id uuid REFERENCES teams(id) ON DELETE SET NULL,
  key text NOT NULL,                          -- e.g. ATLAS; used in task refs ATLAS-42
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  lead_id uuid REFERENCES users(id),
  target_date date,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','archived')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX projects_org_key_uq ON projects (org_id, upper(key)) WHERE deleted_at IS NULL;
CREATE INDEX projects_org_idx ON projects (org_id, state);

CREATE TABLE project_members (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('lead','member','viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX project_members_user_idx ON project_members (user_id);

-- per-project task numbering (ATLAS-1, ATLAS-2, ...)
CREATE TABLE project_counters (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  next_task_number integer NOT NULL DEFAULT 1
);

CREATE TABLE statuses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  category text NOT NULL CHECK (category IN ('backlog','todo','in_progress','in_review','blocked','done')),
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX statuses_project_name_uq ON statuses (project_id, lower(name));
CREATE INDEX statuses_project_idx ON statuses (project_id, position);

-- ---------------------------------------------------------------- work items

CREATE TABLE epics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  target_date date,
  position integer NOT NULL DEFAULT 0,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX epics_project_idx ON epics (project_id, position);

CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  epic_id uuid REFERENCES epics(id) ON DELETE SET NULL,
  parent_id uuid REFERENCES tasks(id) ON DELETE CASCADE,   -- non-null => subtask
  number integer NOT NULL,                                 -- per-project sequence
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  status_id uuid NOT NULL REFERENCES statuses(id),
  priority text NOT NULL DEFAULT 'none' CHECK (priority IN ('urgent','high','medium','low','none')),
  assignee_id uuid REFERENCES users(id) ON DELETE SET NULL,
  due_date date,
  estimate_days numeric(6,2),
  position double precision NOT NULL DEFAULT 0,            -- ordering within a column/list
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','ai','import')),
  braindump_id uuid,                                       -- provenance (FK added in 0004)
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  deleted_at timestamptz
);
CREATE UNIQUE INDEX tasks_project_number_uq ON tasks (project_id, number);
CREATE INDEX tasks_org_project_status_idx ON tasks (org_id, project_id, status_id) WHERE deleted_at IS NULL;
CREATE INDEX tasks_org_assignee_idx ON tasks (org_id, assignee_id) WHERE deleted_at IS NULL;
CREATE INDEX tasks_epic_idx ON tasks (epic_id) WHERE deleted_at IS NULL;
CREATE INDEX tasks_parent_idx ON tasks (parent_id) WHERE deleted_at IS NULL;
CREATE INDEX tasks_due_idx ON tasks (org_id, due_date) WHERE deleted_at IS NULL AND due_date IS NOT NULL;

CREATE TABLE labels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  color text NOT NULL DEFAULT '#6b7280',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX labels_org_name_uq ON labels (org_id, lower(name));

CREATE TABLE task_labels (
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  label_id uuid NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, label_id)
);
CREATE INDEX task_labels_label_idx ON task_labels (label_id);

-- typed dependency edge: blocking_task must finish before blocked_task
CREATE TABLE task_dependencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  blocking_task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  blocked_task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (blocking_task_id <> blocked_task_id)
);
CREATE UNIQUE INDEX task_deps_uq ON task_dependencies (blocking_task_id, blocked_task_id);
CREATE INDEX task_deps_blocked_idx ON task_dependencies (blocked_task_id);

-- explicit blocker record with a reason (richer than a status flag)
CREATE TABLE blockers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  reason text NOT NULL,
  expected_resolution_date date,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES users(id)
);
CREATE INDEX blockers_task_idx ON blockers (task_id) WHERE resolved_at IS NULL;
CREATE INDEX blockers_org_open_idx ON blockers (org_id, created_at) WHERE resolved_at IS NULL;

CREATE TABLE comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES users(id),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX comments_task_idx ON comments (task_id, created_at) WHERE deleted_at IS NULL;

CREATE TABLE watchers (
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, user_id)
);

CREATE TABLE attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  task_id uuid REFERENCES tasks(id) ON DELETE CASCADE,
  comment_id uuid REFERENCES comments(id) ON DELETE CASCADE,
  uploader_id uuid NOT NULL REFERENCES users(id),
  file_name text NOT NULL,
  content_type text NOT NULL,
  size_bytes bigint NOT NULL,
  storage_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (task_id IS NOT NULL OR comment_id IS NOT NULL)
);
CREATE INDEX attachments_task_idx ON attachments (task_id);

-- ---------------------------------------------------------------- signal

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL,                          -- task.assigned, comment.mentioned, ...
  actor_id uuid REFERENCES users(id),
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  task_id uuid REFERENCES tasks(id) ON DELETE CASCADE,
  data jsonb NOT NULL DEFAULT '{}',
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_inbox_idx ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;

CREATE TABLE notification_prefs (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  in_app boolean NOT NULL DEFAULT true,
  email boolean NOT NULL DEFAULT true,
  PRIMARY KEY (user_id, org_id, event_type)
);

-- append-only audit + activity timeline (human AND ai actors)
CREATE TABLE activity_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_type text NOT NULL CHECK (actor_type IN ('user','ai','system')),
  actor_id uuid REFERENCES users(id),
  entity_type text NOT NULL,                   -- task, project, epic, comment, org, ...
  entity_id uuid NOT NULL,
  project_id uuid,
  task_id uuid,
  action text NOT NULL,                        -- created, updated, status_changed, ...
  data jsonb NOT NULL DEFAULT '{}',            -- {field, old, new} etc.
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_org_time_idx ON activity_events (org_id, created_at DESC);
CREATE INDEX activity_entity_idx ON activity_events (entity_type, entity_id, created_at DESC);
CREATE INDEX activity_task_idx ON activity_events (task_id, created_at DESC) WHERE task_id IS NOT NULL;

-- ---------------------------------------------------------------- AI

CREATE TABLE braindumps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  source text NOT NULL CHECK (source IN ('text','voice')),
  raw_input text NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','processing','ready','failed','approved','discarded')),
  proposal jsonb,                              -- validated extraction schema
  error text,
  model text,
  prompt_version text,
  input_tokens integer,
  output_tokens integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX braindumps_user_idx ON braindumps (org_id, user_id, created_at DESC);

ALTER TABLE tasks
  ADD CONSTRAINT tasks_braindump_fk FOREIGN KEY (braindump_id)
  REFERENCES braindumps(id) ON DELETE SET NULL;

CREATE TABLE ai_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  title text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_conversations_user_idx ON ai_conversations (org_id, user_id, updated_at DESC);

CREATE TABLE ai_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user','assistant','tool')),
  content jsonb NOT NULL,                      -- text blocks, tool calls, citations
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_messages_conv_idx ON ai_messages (conversation_id, created_at);

-- every AI-proposed mutation, with its human approval state
CREATE TABLE ai_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES ai_conversations(id) ON DELETE SET NULL,
  braindump_id uuid REFERENCES braindumps(id) ON DELETE SET NULL,
  user_id uuid NOT NULL REFERENCES users(id), -- the human in the loop
  tool text NOT NULL,                          -- create_task, update_task, ...
  input jsonb NOT NULL,
  result jsonb,
  status text NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed','approved','executed','rejected','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  executed_at timestamptz
);
CREATE INDEX ai_actions_org_idx ON ai_actions (org_id, created_at DESC);

-- ---------------------------------------------------------------- integrations

CREATE TABLE integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('jira')),
  config jsonb NOT NULL DEFAULT '{}',          -- base URL, project filters (non-secret)
  credentials_encrypted bytea,                 -- AES-256-GCM sealed API token
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX integrations_org_idx ON integrations (org_id, kind);

CREATE TABLE import_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  integration_id uuid REFERENCES integrations(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('jira')),
  status text NOT NULL DEFAULT 'mapping'
    CHECK (status IN ('mapping','dry_run','running','completed','completed_with_errors','failed','cancelled')),
  mapping jsonb NOT NULL DEFAULT '{}',         -- status/priority/user mappings
  stats jsonb NOT NULL DEFAULT '{}',           -- counts per entity/state
  started_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX import_runs_org_idx ON import_runs (org_id, created_at DESC);

CREATE TABLE import_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_run_id uuid NOT NULL REFERENCES import_runs(id) ON DELETE CASCADE,
  entity_type text NOT NULL,                   -- project, epic, task, subtask, comment, attachment, user
  external_id text NOT NULL,                   -- Jira key/id
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','imported','skipped','failed')),
  target_id uuid,                              -- created entity id
  error text,
  attempts integer NOT NULL DEFAULT 0,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX import_items_uq ON import_items (import_run_id, entity_type, external_id);
CREATE INDEX import_items_status_idx ON import_items (import_run_id, status);

-- ---------------------------------------------------------------- API access

CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  prefix text NOT NULL,                        -- outc_xxxx (display)
  token_hash text NOT NULL UNIQUE,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_keys_org_idx ON api_keys (org_id);

CREATE TABLE webhooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  url text NOT NULL,
  secret_encrypted bytea NOT NULL,
  events text[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX webhooks_org_idx ON webhooks (org_id) WHERE deleted_at IS NULL;
