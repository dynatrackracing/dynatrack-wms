-- Migration 0009 — viewer role + viewer login log
-- HawkerWMS · 2026-10-23
--
-- Phase 2 of the outside-contractor view-only login (spec: docs/VIEWER_LOGIN_DIAGNOSE.md).
-- Two additive changes, both safe on a live DB with the warehouse working:
--
-- 1. sessions.role — the existing single shared login has no roles. Adding the column with a
--    CONSTANT default 'admin' is metadata-only in PG11+ (no table rewrite, no lock held long),
--    and every EXISTING session row becomes 'admin', so NOBODY IS LOGGED OUT by this migration.
--    The tablet keeps its session. Viewer sessions are the only rows that will ever carry 'viewer'.
--
-- 2. viewer_logins — the owner-requested login log (time + IP). One row per successful viewer
--    login. Railway sits behind a proxy, so the app records the x-forwarded-for first hop and
--    falls back to the socket address. Starts empty.
--
-- Additive + idempotent; no data is modified; db/schema.sql NOT edited in place (Rule 9).
-- `items`, `locations`, `moves`, `sequences`, `ebay_order_lines` are NOT touched.
--
-- ORDERING NOTE: server.js probes for both of these at runtime and degrades gracefully, so the
-- deploy and this migration can land in EITHER order without breaking the warehouse:
--   * before this migration runs, admin login/sessions behave exactly as today, and viewer login
--     returns 503 ("viewer login not available") instead of erroring;
--   * after it runs, viewer login works. The probe caches a positive result, so if the service was
--     already running when this was applied, restart/redeploy it (or wait ~30s) to pick it up.

BEGIN;

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'admin';

CREATE TABLE IF NOT EXISTS viewer_logins (
  id serial PRIMARY KEY,
  at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip  TEXT
);
CREATE INDEX IF NOT EXISTS viewer_logins_at ON viewer_logins(at DESC);

COMMIT;

-- Rollback (if ever needed):
--   BEGIN;
--   DROP TABLE IF EXISTS viewer_logins;
--   ALTER TABLE sessions DROP COLUMN IF EXISTS role;   -- also drops any viewer sessions' role marker
--   COMMIT;
-- Dropping the column would make every session 'admin' again as far as the code is concerned, so
-- DELETE FROM sessions WHERE token LIKE 'v\_%' first if viewer tokens are live.
