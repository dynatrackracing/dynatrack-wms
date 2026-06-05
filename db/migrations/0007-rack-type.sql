-- 0007-rack-type.sql (2026-06-05)
-- Scope the warehouse "shelf bins" into proper RACK locations so the Locations page can navigate
-- by section -> rack -> shelf. THREE ordered ops; additive migration per Rule 9 (db/schema.sql, the
-- fresh-provision seed, is intentionally NOT edited in place). All verified via BEGIN…ROLLBACK dry-run
-- (2026-06-05): bin had 0 items, all 9 spelled-out names are section O, 0 rename collisions,
-- 490 rack-pattern rows convert, 35 non-rack oddballs stay SHELF_BIN by design.
-- Apply inside a single transaction.

-- STEP 1 — delete the one malformed bin. Verified 0 items reference it (no FK SET NULL orphaning).
DELETE FROM locations WHERE name='Rack 01 shelf';

-- STEP 2 — rename the spelled-out section-O shelves to compact (section+R+rackNN+S+shelfNN).
-- items.location is ON UPDATE CASCADE, so items follow automatically; moves history is untouched (Rule 13).
-- No collisions with existing compact OR##S## names (dry-run verified).
UPDATE locations SET name='OR01S02' WHERE name='O Rack 01 Shelf 02';
UPDATE locations SET name='OR01S03' WHERE name='O Rack 01 Shelf 03';
UPDATE locations SET name='OR01S04' WHERE name='O Rack 01 Shelf 04';
UPDATE locations SET name='OR01S05' WHERE name='O Rack 01 Shelf 05';
UPDATE locations SET name='OR02S01' WHERE name='O Rack 02 Shelf 01';
UPDATE locations SET name='OR02S02' WHERE name='O Rack 02 Shelf 02';
UPDATE locations SET name='OR02S03' WHERE name='O Rack 02 Shelf 03';
UPDATE locations SET name='OR02S04' WHERE name='O Rack 02 Shelf 04';
UPDATE locations SET name='OR02S05' WHERE name='O Rack 02 Shelf 05';

-- STEP 3 — convert ONLY rack-pattern locations to RACK. Leaves the non-rack oddballs as SHELF_BIN
-- BY DESIGN (BIN 01-26, CR03A02, ESECTA/B/C, FAN, RYR0001-4 — their own sections, fine as-is).
UPDATE locations SET type='RACK' WHERE type='SHELF_BIN' AND name ~ '^[A-Z]R[0-9]{2}S[0-9]{2}$';

-- Reversible:
--   STEP 3: UPDATE locations SET type='SHELF_BIN' WHERE type='RACK';
--   STEP 2: UPDATE locations SET name='O Rack 01 Shelf 02' WHERE name='OR01S02';  (etc., 9 rows back)
--   STEP 1: INSERT INTO locations (name, type) VALUES ('Rack 01 shelf', 'SHELF_BIN');
