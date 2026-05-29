#!/usr/bin/env node
/*
 * import-baseline.mjs — ONE-OFF baseline import for HawkerWMS.
 * Clean reload of the old-WMS extract (wms-full-backup.json) as the new baseline (Option B).
 * NOT wired into the app runtime. Reused at the real cutover.
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
 * Locked decisions baked in:
 *  1. Clean reload, locations + items only (skip auth/ebayOrders/ebayListings/byLocation/reconciliation/stats).
 *  2. Collapse SHIPPED + SHIPPED-1 → ONE 'SHIPPED' location; those items → status SHIPPED, location 'SHIPPED'.
 *     All other items → status STORED (STAGED_UNLISTED dropped entirely).
 *  3. locationType → locations.type as-is (SHELF_BIN / UNLISTED_TOTE / SHIPPED). No schema change.
 *  4. Moves baseline: ONE synthetic move per item — from_location NULL, to_location=<location>,
 *     moved_by='import-baseline', moved_at=createdAt (preserve first-seen). Appends, not edits (Rule 13).
 *  5. Sequences: next_num per prefix = max imported serial# + 1, excluding the garbage outlier.
 *  6. Garbage serial (>=20 digits): imported but FLAGGED, and excluded from the sequence calc.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pkg from 'pg';
const { Pool } = pkg;

const COMMIT = process.argv.includes('--commit');
const OVERRIDE_GUARD = process.argv.includes('--override-abort-guard');
const SKIP_EXPORT = process.argv.includes('--skip-export');
const EXTRACT = process.env.EXTRACT_PATH || 'C:/Users/atenr/Downloads/wms-full-backup.json';

// moved_by markers considered safe (test/seed/import). A move outside this set is treated as a
// real human scan → the reload is REFUSED unless --override-abort-guard (protects against a
// catastrophic clean-reload after go-live).
const SAFE_MOVED_BY = new Set(['import-baseline', 'import', 'seed', 'dynatrack', 'system']);
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

  // Locations: collapse any SHIPPED-type location into a single 'SHIPPED'.
  const locByName = new Map();
  for (const l of ex.locations) {
    const type = l.locationType;
    const name = (type === 'SHIPPED') ? 'SHIPPED' : l.name;
    if (!locByName.has(name)) locByName.set(name, { name, type, created_at: l.createdAt || FALLBACK_TS });
  }

  // Items: derive status/location; flag garbage serials.
  const items = [];
  const flaggedGarbage = [];
  let nullLoc = 0;
  for (const it of ex.items) {
    const serial = String(it.serialId);
    const isShipped = it._locationType === 'SHIPPED';
    const location = isShipped ? 'SHIPPED' : (it._locationName || null);
    const status = isShipped ? 'SHIPPED' : 'STORED';   // STAGED_UNLISTED dropped
    if (GARBAGE_RE.test(serial)) flaggedGarbage.push(serial);
    if (location === null) nullLoc++;
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

    log('\n================ DRY-RUN DELTAS (per table) ================');
    log('DELETE  : locations -' + delL + ' | items -' + delI + ' | moves -' + delM);
    log('INSERT  : locations +' + insL + ' | items +' + insI + ' | moves +' + insMv + ' | sequences +' + insSeq);
    log('\n================ END-STATE (in-transaction) ================');
    log('locations = ' + cLoc + '  by type: ' + JSON.stringify(cLocType));
    log('items     = ' + cItem + '  by status: ' + JSON.stringify(cItemStatus));
    log('moves     = ' + cMove + '  (synthetic import-baseline; ' + nullLoc + ' item(s) had no location → no move)');
    log('sequences = ' + cSeq + '  -> ' + JSON.stringify(sequences));
    log('FK orphan item.location (must be 0) = ' + orphan);
    log('referenced-but-missing locations auto-added as GENERAL: ' + JSON.stringify(addedRefLocs));
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
