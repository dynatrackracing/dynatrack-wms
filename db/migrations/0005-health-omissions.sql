-- Migration 0005 — health_omissions (Inventory Health hide/restore)
-- HawkerWMS · 2026-05-31
--
-- Persisted per-row "Hide" for the Inventory Health eBay-Only and WMS-Only buckets, so an operator
-- can declutter the report down to actionable discrepancies and have it survive refresh / re-sync /
-- device (same spirit as the Pick List DISMISSED). It is a VIEW-SUPPRESSION record ONLY — it never
-- touches items / moves / listings, and eBay stays read-only (Rule 25).
--
--   omit_key: WMS_ONLY → items.serial ; EBAY_ONLY → normalizeSkuKey(listing SKU) (the render's row key).
--   bucket:   which list the row was hidden from (so the same key can't collide across buckets).
--
-- Additive + idempotent; starts EMPTY (no backfill). Live-DB migration (Rule 9); schema.sql not edited.

BEGIN;

CREATE TABLE IF NOT EXISTS health_omissions (
  omit_key   TEXT NOT NULL,
  bucket     TEXT NOT NULL CHECK (bucket IN ('WMS_ONLY','EBAY_ONLY')),
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (omit_key, bucket)
);

COMMIT;
