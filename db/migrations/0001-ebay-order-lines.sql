-- Migration 0001 — ebay_order_lines
-- HawkerWMS · 2026-05-29
--
-- Backbone table for the Pick List / Shipped Items rework. Persists eBay sold
-- order LINES (one row per OrderLineItemID = ItemID-TransactionID) so fulfilment
-- state survives page refresh and a sync can reconcile against it. Prior to this
-- table, eBay orders/listings lived only in the browser (ALL_LISTINGS / ORDERS).
--
-- Primary key is the eBay OrderLineItemID — the only stable per-line identifier.
-- NEVER key on OrderID (one order can hold many lines / combined-payment carts).
--
-- This migration is additive and idempotent:
--   * CREATE TABLE IF NOT EXISTS  (no effect if already present)
--   * the 'SHIPPED' location ensure is ON CONFLICT DO NOTHING (already exists in prod)
-- It does NOT modify locations/items/moves/sequences rows.
--
-- NOTE: this is a live-DB migration applied via scripts (see HAWKER_RULES rule 9).
-- db/schema.sql is the fresh-provision seed and is intentionally NOT edited in place.

BEGIN;

CREATE TABLE IF NOT EXISTS ebay_order_lines (
  order_line_item_id  TEXT PRIMARY KEY,             -- eBay OrderLineItemID = "<ItemID>-<TransactionID>"
  store               TEXT NOT NULL,                -- STORES registry key (dynatrack | autolumen | future)
  ebay_item_id        TEXT NOT NULL,                -- eBay ItemID
  ebay_transaction_id TEXT NOT NULL,                -- eBay TransactionID
  sku_raw             TEXT,                          -- as listed on eBay (may be NULL / suffixed, e.g. INT4306R)
  sku_norm            TEXT,                          -- normalized per rule 8 (trailing letters stripped); NULL if no SKU
  title               TEXT,                          -- listing title at time of sale
  paid                BOOLEAN NOT NULL DEFAULT FALSE,
  paid_time           TIMESTAMPTZ,                   -- nullable (unpaid until buyer pays)
  shipped             BOOLEAN NOT NULL DEFAULT FALSE,-- eBay's shipped flag (ShippedTime present)
  ebay_shipped_time   TIMESTAMPTZ,                   -- nullable
  matched_serial      TEXT,                          -- WMS items.serial this line resolved to (soft pointer, not FK); NULL if unmatched
  location_unknown    BOOLEAN NOT NULL DEFAULT FALSE,-- true when no WMS shelf location could be resolved
  disposition         TEXT NOT NULL DEFAULT 'NEEDS_PICK'
                        CHECK (disposition IN ('NEEDS_PICK','SHIPPED','CANCELLED','DISMISSED')),
  first_seen          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_synced         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ebay_last_modified  TIMESTAMPTZ                    -- nullable; eBay's last-modified for change detection
);

CREATE INDEX IF NOT EXISTS ebay_order_lines_store_idx       ON ebay_order_lines(store);
CREATE INDEX IF NOT EXISTS ebay_order_lines_disposition_idx ON ebay_order_lines(disposition);
CREATE INDEX IF NOT EXISTS ebay_order_lines_sku_norm_idx    ON ebay_order_lines(sku_norm);
CREATE INDEX IF NOT EXISTS ebay_order_lines_matched_serial_idx ON ebay_order_lines(matched_serial);
CREATE INDEX IF NOT EXISTS ebay_order_lines_ebay_item_id_idx ON ebay_order_lines(ebay_item_id);

-- Ensure the real 'SHIPPED' location exists (pick flow ships items INTO this location).
-- Already present in prod (created by the baseline import) — no-op there; included so a
-- fresh DB provisioned from migrations also has it.
INSERT INTO locations (name, type) VALUES ('SHIPPED', 'SHIPPED')
ON CONFLICT (name) DO NOTHING;

COMMIT;
