-- 0006_ai_usage.sql — atomic per-org daily AI call accounting.
--
-- The budget was previously enforced by counting rows and then writing one,
-- which is a check-then-act race: two simultaneous requests both read a count
-- below the limit and both proceed. Counting rows also cannot be made atomic
-- without holding a lock across the model call, which would serialize every
-- AI request in the org behind a network round trip.
--
-- A counter row per (org, day) can be incremented and read in a single
-- statement, so reservation is atomic and holds no lock across I/O.

CREATE TABLE ai_usage_daily (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  day date NOT NULL,
  calls integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, day),
  CONSTRAINT ai_usage_daily_calls_nonneg CHECK (calls >= 0)
);

COMMENT ON TABLE ai_usage_daily IS
  'One row per org per UTC day. Incremented before each AI provider call.';

-- Same fail-closed isolation as every other org-scoped table.
ALTER TABLE ai_usage_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage_daily FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON ai_usage_daily
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());
