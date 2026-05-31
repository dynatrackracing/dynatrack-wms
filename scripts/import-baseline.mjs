#!/usr/bin/env node
/*
 * import-baseline.mjs — baseline/cutover import for HawkerWMS.
 * Clean reload (Option B) of the old-WMS final extract as the new baseline. Reused at cutover.
 * NOT wired into the app runtime.
 *
 * Run via:  railway run --service Postgres node scripts/import-baseline.mjs            (DRY-RUN: BEGIN…compute…ROLLBACK)
 *           railway run --service Postgres node scripts/import-baseline.mjs --commit   (PERSISTENT WRITE — requires this flag)
 *   (--service Postgres injects DATABASE_PUBLIC_URL — the public TCP proxy — so it works from a dev machine;
 *    the app service only has the internal postgres.railway.internal host, which is unreachable locally.)
 * Flags:    --commit                 perform a real COMMIT (default is dry-run/rollback)
 *           --override-abort-guard    proceed even if non-safe moved_by markers exist (post-go-live guard)
 *           --skip-export             skip the read-only pre-export dump
 * Env:      DATABASE_URL (injected by `railway run`), EXTRACT_PATH (optional override)
 *
 * Locked decisions baked in (CUTOVER 2026-05-31 — live-inventory-only):
 *  1. Clean reload, locations + items + moves only; TRUNCATE ebay_order_lines (stale matched_serial
 *     pointers would dangle against dropped serials — it rebuilds on the next eBay sync).
 *  2. LIVE INVENTORY ONLY: import only items whose currentLocation.locationType !== 'SHIPPED'
 *     (3,390 of 5,161). Every shipped item is DROPPED — eBay + ShippingEasy are the source of truth
 *     for shipped going forward. Every imported item → status 'STORED' (remaps the 6 stray
 *     STAGED_UNLISTED; v1 live model is STORED-only).
 *  3. Locations: import the 547 non-SHIPPED locations (locationType → type, SHELF_BIN / UNLISTED_TOTE).
 *     Do NOT import the two historical SHIPPED locations ('SHIPPED','SHIPPED-1'); instead seed exactly
 *     ONE empty canonical 'SHIPPED' location (type SHIPPED) as the destination for forward ship-moves.
 *  4. intake_date: left NULL for every imported item — the old WMS rewrites scan dates on
 *     re-consolidations, so they aren't true intake. Age forward only (HawkerWMS stamps intake_date
 *     once at intake, never on moves). The items INSERT omits intake_date (NULL default, migration 0002).
 *  5. Moves baseline: ONE synthetic move per item — from_location NULL, to_location=<location>,
 *     moved_by='import-baseline', moved_at=createdAt. Appends, not edits (Rule 13).
 *  6. Sequences: next_num per prefix = max imported (live) serial# + 1.
 *  7. Dead branches neutralized: SHIPPED-collapse removed (nothing shipped is imported); garbage-serial
 *     and null-location flagging are kept as 0-assertions only (the live set has zero garbage/null-loc).
 * Extract field shape (wms-final-extract): items[].{serialId,status,notes,createdAt,updatedAt,
 *   currentLocation:{name,locationType}} ; locations[].{name,locationType,createdAt}.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pkg from 'pg';
const { Pool } = pkg;

const COMMIT = process.argv.includes('--commit');
const OVERRIDE_GUARD = process.argv.includes('--override-abort-guard');
const SKIP_EXPORT = process.argv.includes('--skip-export');
const EXTRACT = process.env.EXTRACT_PATH || 'C:/Users/atenr/Downloads/wms-final-extract-2026-05-30 (6).json';

// moved_by markers considered safe (test/seed/import). A move outside this set is treated as a
// real human scan → the reload is REFUSED unless --override-abort-guard (protects against a
// catastrophic clean-reload after go-live).
const SAFE_MOVED_BY = new Set(['import-baseline', 'import', 'seed', 'dynatrack', 'system', 'ebay-sync', 'intake', 'archive', 'unarchive']);
const GARBAGE_RE = /^\d{20,}$/;            // ~20+ digit numeric outlier
const FALLBACK_TS = '2026-05-27T20:00:00.000Z';

const log = (...a) => console.log(...a);

async function bulkInsert(client, table, cols, rows, conflict = '') {
  if (!rows.length) return 0;
  const CH = 400;
  let total = 0;
  for (let i = 0; i < rows.length; i += CH) {
    const chunk = rows.slice(i, i + CH);
    const params = [];
    const tuples = chunk.map((row, ri) => {
      const ph = cols.map((_, ci) => '$' + (ri * cols.length + ci + 1));
      cols.forEach(c => params.push(row[c]));
      return '(' + ph.join(',') + ')';
    });
    const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES ${tuples.join(',')} ${conflict}`;
    const r = await client.query(sql, params);
    total += r.rowCount;
  }
  return total;
}

(async () => {
  const CONN = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!CONN) { console.error('No DATABASE_PUBLIC_URL / DATABASE_URL — run via: railway run --service Postgres node scripts/import-baseline.mjs'); process.exit(2); }
  log('================ HawkerWMS baseline import ================');
  try { log('DB host: ' + new URL(CONN).hostname); } catch {}
  log('MODE: ' + (COMMIT ? '*** COMMIT (PERSISTENT WRITE) ***' : 'DRY-RUN (rollback only)') + (OVERRIDE_GUARD ? '  [abort-guard OVERRIDDEN]' : ''));
  log('extract: ' + EXTRACT);

  // ---- 1) Load + transform the extract (read-only file) -------------------------------------
  const ex = JSON.parse(fs.readFileSync(EXTRACT, 'utf8'));

  // Locations: import the non-SHIPPED locations (SHELF_BIN / UNLISTED_TOTE). The two historical
  // SHIPPED locations ('SHIPPED','SHIPPED-1') are NOT imported (live-only). We then seed exactly ONE
  // empty canonical 'SHIPPED' location as the destination for forward ship-moves (reconcile Phase 2).
  const locByName = new Map();
  for (const l of ex.locations) {
    if (l.locationType === 'SHIPPED') continue;                 // drop historical SHIPPED / SHIPPED-1
    if (!locByName.has(l.name)) locByName.set(l.name, { name: l.name, type: l.locationType, created_at: l.createdAt || FALLBACK_TS });
  }
  locByName.set('SHIPPED', { name: 'SHIPPED', type: 'SHIPPED', created_at: FALLBACK_TS });  // one empty canonical SHIPPED

  // Items: LIVE-ONLY — drop every shipped item; import the rest as STORED. intake_date left NULL.
  const items = [];
  const flaggedGarbage = [];
  let droppedShipped = 0;
  let nullLoc = 0;
  for (const it of ex.items) {
    const locType = it.currentLocation ? it.currentLocation.locationType : null;
    if (locType === 'SHIPPED') { droppedShipped++; continue; }   // drop shipped (eBay/ShippingEasy own these now)
    const serial = String(it.serialId);
    const location = (it.currentLocation && it.currentLocation.name) || null;
    const status = 'STORED';                                     // v1 live model is STORED-only (remaps the 6 STAGED_UNLISTED)
    if (GARBAGE_RE.test(serial)) flaggedGarbage.push(serial);    // expected EMPTY (garbage was all on shipped rows)
    if (location === null) nullLoc++;                            // expected 0 for the live set
    items.push({ serial, status, location, notes: it.notes || null,
                 created_at: it.createdAt || FALLBACK_TS, updated_at: it.updatedAt || it.createdAt || FALLBACK_TS });
  }

  // Any item.location referenced but missing from the locations set → auto-add as GENERAL (flagged).
  const addedRefLocs = [];
  for (const it of items) {
    if (it.location && !locByName.has(it.location)) {
      locByName.set(it.location, { name: it.location, type: 'GENERAL', created_at: FALLBACK_TS });
      addedRefLocs.push(it.location);
    }
  }
  const locations = [...locByName.values()];

  // Sequences: next_num per prefix = max(serial#) + 1, excluding garbage.
  const seqMax = {};
  for (const it of items) {
    if (GARBAGE_RE.test(it.serial)) continue;
    const m = /^([A-Za-z]+)0*(\d+)$/.exec(it.serial);
    if (!m) continue;
    const pre = m[1].toUpperCase(), num = parseInt(m[2], 10);
    if (Number.isFinite(num) && num > (seqMax[pre] || 0)) seqMax[pre] = num;
  }
  const sequences = Object.entries(seqMax).map(([prefix, mx]) => ({ prefix, next_num: mx + 1 }))
                          .sort((a, b) => a.prefix.localeCompare(b.prefix));

  // Synthetic baseline moves: one per item that has a location.
  const moves = items.filter(it => it.location)
                     .map(it => ({ serial: it.serial, from_location: null, to_location: it.location,
                                   moved_by: 'import-baseline', moved_at: it.created_at }));

  const pool = new Pool({ connectionString: CONN,
                          ssl: /localhost|127\.0\.0\.1/.test(CONN) ? false : { rejectUnauthorized: false } });
  const client = await pool.connect();
  try {
    // ---- 2) PRE-EXPORT (read-only) before any transaction --------------------------------
    if (!SKIP_EXPORT) {
      const pl = await client.query('SELECT * FROM locations ORDER BY name');   // sequential — one pg client
      const pi = await client.query('SELECT * FROM items ORDER BY serial');
      const pm = await client.query('SELECT * FROM moves ORDER BY id');
      const ps = await client.query('SELECT * FROM sequences ORDER BY prefix');
      const outPath = path.join(os.homedir(), 'hawker-preexport-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
      fs.writeFileSync(outPath, JSON.stringify({ exportedAt: new Date().toISOString(),
        counts: { locations: pl.rowCount, items: pi.rowCount, moves: pm.rowCount, sequences: ps.rowCount },
        locations: pl.rows, items: pi.rows, moves: pm.rows, sequences: ps.rows }));
      log('\nPRE-EXPORT (rollback artifact, gitignored): ' + outPath);
      log('  current prod: locations=' + pl.rowCount + ' items=' + pi.rowCount + ' moves=' + pm.rowCount + ' sequences=' + ps.rowCount);
      const mb = {}; for (const r of pm.rows) mb[r.moved_by] = (mb[r.moved_by] || 0) + 1;
      log('  moves.moved_by distinct: ' + JSON.stringify(mb));
      const unsafe = Object.keys(mb).filter(k => !SAFE_MOVED_BY.has(k));
      if (unsafe.length && !OVERRIDE_GUARD) {
        console.error('\n*** ABORT GUARD ***  non-safe moved_by markers found: ' + JSON.stringify(unsafe));
        console.error('Real human scans may exist — refusing the clean reload. Re-run with --override-abort-guard ONLY if certain this is still pre-cutover test data.');
        process.exit(3);
      }
      if (unsafe.length) log('  ⚠ abort guard OVERRIDDEN — proceeding despite ' + JSON.stringify(unsafe));
    }

    // ---- 3) Transactional clean reload (FK-safe order) -----------------------------------
    await client.query('BEGIN');
    const delM = (await client.query('DELETE FROM moves')).rowCount;
    const delI = (await client.query('DELETE FROM items')).rowCount;
    const delL = (await client.query('DELETE FROM locations')).rowCount;
    const delS = (await client.query('DELETE FROM sequences')).rowCount;   // clear → rebuild only the extract's computed prefixes
    const delE = (await client.query('DELETE FROM ebay_order_lines')).rowCount;  // truncate — stale matched_serial pointers; rebuilds on next eBay sync
    const insL = await bulkInsert(client, 'locations', ['name', 'type', 'created_at'], locations, 'ON CONFLICT (name) DO NOTHING');
    const insI = await bulkInsert(client, 'items', ['serial', 'status', 'location', 'notes', 'created_at', 'updated_at'], items, 'ON CONFLICT (serial) DO NOTHING');
    const insMv = await bulkInsert(client, 'moves', ['serial', 'from_location', 'to_location', 'moved_by', 'moved_at'], moves);
    const insSeq = await bulkInsert(client, 'sequences', ['prefix', 'next_num'], sequences, 'ON CONFLICT (prefix) DO UPDATE SET next_num = EXCLUDED.next_num');

    // ---- 4) In-transaction verification --------------------------------------------------
    const cLoc = (await client.query('SELECT count(*)::int c FROM locations')).rows[0].c;
    const cLocType = (await client.query('SELECT type, count(*)::int c FROM locations GROUP BY type ORDER BY type')).rows;
    const cItem = (await client.query('SELECT count(*)::int c FROM items')).rows[0].c;
    const cItemStatus = (await client.query('SELECT status, count(*)::int c FROM items GROUP BY status ORDER BY status')).rows;
    const cMove = (await client.query('SELECT count(*)::int c FROM moves')).rows[0].c;
    const cSeq = (await client.query('SELECT count(*)::int c FROM sequences')).rows[0].c;
    const orphan = (await client.query('SELECT count(*)::int c FROM items i WHERE i.location IS NOT NULL AND NOT EXISTS (SELECT 1 FROM locations l WHERE l.name = i.location)')).rows[0].c;
    const cShippedItems = (await client.query("SELECT count(*)::int c FROM items WHERE location = 'SHIPPED'")).rows[0].c;
    const cEbayLines = (await client.query('SELECT count(*)::int c FROM ebay_order_lines')).rows[0].c;
    const cIntakeSet = (await client.query('SELECT count(*)::int c FROM items WHERE intake_date IS NOT NULL')).rows[0].c;
    const cArchived = (await client.query('SELECT count(*)::int c FROM items WHERE archived_at IS NOT NULL')).rows[0].c;

    log('\n================ DRY-RUN DELTAS (per table) ================');
    log('DELETE  : locations -' + delL + ' | items -' + delI + ' | moves -' + delM + ' | sequences -' + delS + ' | ebay_order_lines -' + delE);
    log('INSERT  : locations +' + insL + ' | items +' + insI + ' | moves +' + insMv + ' | sequences +' + insSeq);
    log('dropped shipped items (not imported): ' + droppedShipped);
    log('\n================ END-STATE (in-transaction) ================');
    log('locations = ' + cLoc + '  by type: ' + JSON.stringify(cLocType));
    log('items     = ' + cItem + '  by status: ' + JSON.stringify(cItemStatus));
    log('moves     = ' + cMove + '  (synthetic import-baseline; ' + nullLoc + ' item(s) had no location → no move)');
    log('sequences = ' + cSeq + '  -> ' + JSON.stringify(sequences));
    log('items in SHIPPED location (must be 0) = ' + cShippedItems);
    log('ebay_order_lines (must be 0, repopulates on sync) = ' + cEbayLines);
    log('items with intake_date set (must be 0) = ' + cIntakeSet + '  | archived (must be 0) = ' + cArchived);
    log('FK orphan item.location (must be 0) = ' + orphan);
    log('referenced-but-missing locations auto-added as GENERAL (must be []): ' + JSON.stringify(addedRefLocs));
    log('FLAGGED garbage serial(s) [imported, excluded from sequences]: ' + JSON.stringify(flaggedGarbage));

    if (COMMIT) { await client.query('COMMIT'); log('\n*** COMMITTED — persistent write complete. ***'); }
    else { await client.query('ROLLBACK'); log('\nDRY-RUN complete — ROLLED BACK. No persistent change.'); }
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('\nERROR (rolled back, no change): ' + e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
