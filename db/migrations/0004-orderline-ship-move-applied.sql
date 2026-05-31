-- Migration 0004 — ebay_order_lines.ship_move_applied_at (Phase 2 ship-once guard)
-- HawkerWMS · 2026-05-31
--
-- reconcileOrderLines Phase 2 ship-moves a STORED item → SHIPPED whenever a matched order line is
-- disposition='SHIPPED'. A RETURNED item legitimately back on a shelf (STORED) was therefore
-- RE-shipped on every eBay sync, because its original order line stays SHIPPED inside eBay's ~90-day
-- GetOrders window (confirmed for ENG4911/ENG5036/ENG4987/ENG5004/ENG4367 — returned pre-cutover,
-- imported STORED, re-shipped by the first post-cutover sync, scanned back, would re-ship again).
--
-- This column makes the ship-move fire ONCE PER LINE: Phase 2 selects only lines with
-- ship_move_applied_at IS NULL, and stamps the line in the SAME txn that flips the item. A later
-- return to STORED is then left alone; a genuine re-sale is a new OrderLineItemID (a fresh,
-- unstamped line) and ships normally.
--
-- Additive + idempotent. Nullable, no default → existing rows stay NULL until the one-time backfill
-- marks every currently-SHIPPED line as already-applied (so no existing SHIPPED line re-clobbers a
-- STORED item after the fix deploys). Live-DB migration (Rule 9); db/schema.sql NOT edited in place.
-- Phase 1's ON CONFLICT does NOT list this column, so a sync never clears a stamp.

BEGIN;

ALTER TABLE ebay_order_lines ADD COLUMN IF NOT EXISTS ship_move_applied_at TIMESTAMPTZ;

-- Partial index over the Phase-2 candidate set (unapplied shipped lines) keeps the EXISTS subquery
-- cheap; after the backfill this indexes only genuinely-new ships (a handful).
CREATE INDEX IF NOT EXISTS ebay_order_lines_shipmove_pending_idx
  ON ebay_order_lines(matched_serial)
  WHERE disposition = 'SHIPPED' AND ship_move_applied_at IS NULL;

COMMIT;
