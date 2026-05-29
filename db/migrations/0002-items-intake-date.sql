-- Migration 0002 — items.intake_date
-- HawkerWMS · 2026-05-29
--
-- Foundation for the unlisted-aging view: when an item was taken into the warehouse.
-- DATE, NULLABLE, NO DEFAULT — existing baseline-imported rows stay NULL (= unknown/legacy
-- age, deliberately NOT backfilled); future new-item intake sets it explicitly. The index
-- supports the aging filter.
--
-- Additive + idempotent (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS); no app
-- behaviour change this session — purely schema, mirroring the 0001 pattern.
--
-- NOTE: live-DB migration applied via scripts (Rule 9). db/schema.sql is the fresh-provision
-- seed and is intentionally NOT edited in place; the live schema = schema.sql + migrations.

BEGIN;

ALTER TABLE items ADD COLUMN IF NOT EXISTS intake_date DATE;

CREATE INDEX IF NOT EXISTS items_intake_date_idx ON items(intake_date);

COMMIT;
