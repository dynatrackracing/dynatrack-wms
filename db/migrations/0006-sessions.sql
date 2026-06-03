-- Migration 0006 — sessions (persistent auth tokens)
-- HawkerWMS · 2026-06-03
--
-- Auth tokens lived in an in-memory Map in server.js, so every deploy/restart wiped them and the
-- warehouse tablet dropped to the login screen. This table moves sessions into Postgres (the existing
-- pg.Pool on DATABASE_URL) so a restart no longer loses the login. Smallest-possible delta: same
-- random-hex token, same 12h sliding expiry, same x-wms-token header, same route contracts — just
-- persisted. (Stateless JWT/HMAC was considered and rejected — needs a signing secret and complicates
-- sliding expiry + revocation.) No new env var. Token stored raw (hashing is a future Rule-B option).
--
-- Additive + idempotent; starts empty. Live-DB migration (Rule 9); db/schema.sql NOT edited in place.

BEGIN;

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  username   TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at);

COMMIT;
