-- 0008-section-a-rack-retype.sql (2026-06-05)
-- Re-type Section A's 20 rack locations from UNLISTED_TOTE to RACK. They were mis-typed at import
-- (named like rack shelves AR01S01..AR04S05 but carrying type UNLISTED_TOTE), so 0007's type-gated
-- grouping left them in "Other" instead of grouping under Section A. Names are UNCHANGED → the
-- items.location FK and every item/move row are untouched. Verified via dry-run (2026-06-05):
-- EXACTLY 20 match (racks AR01-AR04 x shelves S01-S05), all 0 items; the 21st UNLISTED_TOTE
-- ('RETURN-1') is a genuine tote and is LEFT ALONE (does not match the AR##S## pattern).
-- Additive migration per Rule 9; db/schema.sql (fresh-provision seed) not edited in place.
-- Reversible: UPDATE locations SET type='UNLISTED_TOTE' WHERE type='RACK' AND name ~ '^AR[0-9]{2}S[0-9]{2}$';
UPDATE locations SET type='RACK' WHERE type='UNLISTED_TOTE' AND name ~ '^AR[0-9]{2}S[0-9]{2}$';
