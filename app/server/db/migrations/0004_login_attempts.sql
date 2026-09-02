-- 0004_login_attempts.sql — per-account login throttling (credential-stuffing
-- defense that is independent of the IP rate limiter).

CREATE TABLE login_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip text,
  succeeded boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_recent_idx ON login_attempts (user_id, created_at DESC);
