-- Migration 0003 — items soft-archive (decommission / scrap)
-- HawkerWMS · 2026-05-30
--
-- Adds a REVERSIBLE soft-archive flag so a live item (typically STORED) can be
-- decommissioned/scrapped: it leaves active inventory and every active-inventory count
-- while its moves history is retained (Rule 13 — moves stay append-only). This closes the
-- SCRAP leak that was polluting Inventory Health (a scrapped part still matched eBay /
-- counted as on-shelf).
--
--   ACTIVE INVENTORY := archived_at IS NULL.
--
-- This does NOT add a status value — Rule 11 stays STORED | STAGED_UNLISTED | SHIPPED.
-- Archiving is orthogonal to status (the item keeps whatever status it had), which is why
-- a flag — not a 'SCRAPPED' location — is the right mechanism: every count in the app is
-- status-based (COUNT FILTER WHERE status='STORED'), so a single archived_at predicate
-- removes a part from all of them without touching status or smearing a location check.
--
-- Additive + idempotent (ADD COLUMN IF NOT EXISTS, both nullable, no default → existing
-- rows stay active/NULL, NOT backfilled). Live-DB migration applied via script (Rule 9);
-- db/schema.sql is the fresh-provision seed and is intentionally NOT edited in place.

BEGIN;

ALTER TABLE items ADD COLUMN IF NOT EXISTS archived_at    TIMESTAMPTZ;   -- NULL = active; set = archived/scrapped
ALTER TABLE items ADD COLUMN IF NOT EXISTS archive_reason TEXT;          -- free-text why (damaged, lost, scrapped…)

-- Partial index over archived rows only: active reads filter `archived_at IS NULL` (so they
-- don't need this index), and the small "Archived / Decommissioned" list filters IS NOT NULL.
CREATE INDEX IF NOT EXISTS items_archived_at_idx ON items(archived_at) WHERE archived_at IS NOT NULL;

COMMIT;
