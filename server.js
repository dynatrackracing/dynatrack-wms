/**
 * Dynatrack WMS — Express + PostgreSQL Backend
 * Deploy to Railway: railway up
 */

const express = require('express');
const { Pool } = require('pg');
const crypto  = require('crypto');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Auth config ───────────────────────────────────────────────────────────────
// Set these in Railway → Variables:
//   WMS_USERNAME  (default: admin)
//   WMS_PASSWORD  (required — no default, app won't allow login without it)
const WMS_USERNAME = process.env.WMS_USERNAME || 'admin';
const WMS_PASSWORD = process.env.WMS_PASSWORD || '';

// In-memory token store: token → { username, expires }
const sessions = new Map();
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function createToken(username) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { username, expires: Date.now() + SESSION_TTL_MS });
  return token;
}

function validateToken(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expires) { sessions.delete(token); return null; }
  // Slide expiry on activity
  session.expires = Date.now() + SESSION_TTL_MS;
  return session;
}

// Clean up expired sessions every hour
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (now > session.expires) sessions.delete(token);
  }
}, 60 * 60 * 1000);

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers['x-wms-token'];
  if (!validateToken(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── Database ──────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false,
});

pool.query('SELECT 1').then(() => {
  console.log('✓ PostgreSQL connected');
}).catch(err => {
  console.error('✗ PostgreSQL connection failed:', err.message);
});

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Login ─────────────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!WMS_PASSWORD) {
    return res.status(503).json({ error: 'WMS_PASSWORD not configured. Add it in Railway Variables.' });
  }
  if (username === WMS_USERNAME && password === WMS_PASSWORD) {
    const token = createToken(username);
    return res.json({ ok: true, token, username });
  }
  res.status(401).json({ error: 'Invalid username or password' });
});

app.post('/api/logout', (req, res) => {
  const token = req.headers['x-wms-token'];
  if (token) sessions.delete(token);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const token = req.headers['x-wms-token'];
  const session = validateToken(token);
  if (!session) return res.status(401).json({ error: 'Not logged in' });
  res.json({ username: session.username });
});

// ── Health (public — Railway needs this) ─────────────────────────────────────
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: 'connected', ts: new Date().toISOString() });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

// ── Locations ─────────────────────────────────────────────────────────────────
app.get('/api/locations', requireAuth, async (req, res) => {
  try {
    // All location columns + a per-location item count (LEFT JOIN so empty bins show 0).
    // Archived/scrapped items don't occupy a bin → excluded from the count (active inventory).
    const { rows } = await pool.query(`
      SELECT l.*, COUNT(i.serial)::int AS item_count
        FROM locations l
        LEFT JOIN items i ON i.location = l.name AND i.archived_at IS NULL
       GROUP BY l.id
       ORDER BY l.name
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/locations', requireAuth, async (req, res) => {
  const { name, type = 'GENERAL' } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO locations (name, type) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING RETURNING *',
      [name.toUpperCase().trim(), type]
    );
    res.status(201).json(rows[0] || { name, type });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/locations/:name', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM locations WHERE name = $1', [req.params.name]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Items ─────────────────────────────────────────────────────────────────────
app.get('/api/items', requireAuth, async (req, res) => {
  const { status, search, location, limit = 500, archived } = req.query;
  let q   = 'SELECT * FROM items';
  const p = [];
  const w = [];

  // Soft-archive gate: default returns ACTIVE inventory only (archived_at IS NULL). Pass
  // ?archived=1 for the Archived/Decommissioned list (archived_at IS NOT NULL). Every active
  // caller (Inventory, Inventory Health's /items?status=STORED, location detail) gets the gate.
  w.push(archived === '1' || archived === 'true' ? 'archived_at IS NOT NULL' : 'archived_at IS NULL');

  if (status) { p.push(status); w.push(`status = $${p.length}`); }
  if (location) {
    // EXACT location match (per-bin detail view) — takes precedence over the fuzzy search.
    p.push(location); w.push(`location = $${p.length}`);
  } else if (search) {
    p.push(`%${search}%`);
    w.push(`(serial ILIKE $${p.length} OR location ILIKE $${p.length})`);
  }

  if (w.length) q += ' WHERE ' + w.join(' AND ');
  if (location) {
    // Exact-location branch: ordered by serial, UNCAPPED (a bin like SHIPPED holds ~1,724).
    q += ' ORDER BY serial ASC';
  } else {
    q += ' ORDER BY updated_at DESC';
    p.push(parseInt(limit));
    q += ` LIMIT $${p.length}`;
  }

  try {
    const { rows } = await pool.query(q, p);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/items/count', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE TRUE)                        AS total,
        COUNT(*) FILTER (WHERE status = 'STORED')           AS stored,
        COUNT(*) FILTER (WHERE status = 'STAGED_UNLISTED')  AS staged,
        COUNT(*) FILTER (WHERE status = 'SHIPPED')          AS shipped
      FROM items
      WHERE archived_at IS NULL
    `);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/items/:serial', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM items WHERE serial = $1', [req.params.serial]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/items', requireAuth, async (req, res) => {
  const { serial, status = 'STAGED_UNLISTED', location, notes } = req.body;
  if (!serial) return res.status(400).json({ error: 'serial required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO items (serial, status, location, notes)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (serial) DO NOTHING RETURNING *`,
      [serial.trim(), status, location || null, notes || null]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/items/:serial', requireAuth, async (req, res) => {
  const { status, location, notes } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE items SET
         status   = COALESCE($1, status),
         location = COALESCE($2, location),
         notes    = COALESCE($3, notes)
       WHERE serial = $4 RETURNING *`,
      [status || null, location !== undefined ? location : undefined, notes || null, req.params.serial]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Soft-archive: decommission / scrap (reversible) ──────────────────────────
// Sets archived_at (+ reason) so the item leaves active inventory and every active count
// (archived_at IS NULL gate), and writes ONE moves row to 'ARCHIVED'. status is LEFT AS-IS
// (Rule 11 — no new status value); the item's location is retained so a restore returns it
// to the same shelf. Guarded to a LIVE (non-archived) item. No eBay (Rule 25); moves stays
// append-only (Rule 13). 200 with archived:0 on no-op (matches the dismiss/restore pattern).
app.post('/api/items/:serial/archive', requireAuth, async (req, res) => {
  const { reason, moved_by = 'archive' } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE items SET archived_at = NOW(), archive_reason = $2
         WHERE serial = $1 AND archived_at IS NULL
         RETURNING location`,
      [req.params.serial, reason || null]
    );
    if (!rows.length) { await client.query('ROLLBACK'); return res.json({ ok: true, archived: 0 }); }
    await client.query(
      `INSERT INTO moves (serial, from_location, to_location, moved_by) VALUES ($1, $2, 'ARCHIVED', $3)`,
      [req.params.serial, rows[0].location || null, moved_by]
    );
    await client.query('COMMIT');
    res.json({ ok: true, archived: 1, reason: reason || null });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// ── Un-archive: restore a decommissioned item (reverse of archive) ───────────
// Clears archived_at + reason and writes one moves row back FROM 'ARCHIVED' to the item's
// retained location (it never physically left, so it returns to its shelf). Guarded to an
// archived item. status untouched, no eBay. 200 with restored:0 on no-op.
app.post('/api/items/:serial/unarchive', requireAuth, async (req, res) => {
  const { moved_by = 'unarchive' } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE items SET archived_at = NULL, archive_reason = NULL
         WHERE serial = $1 AND archived_at IS NOT NULL
         RETURNING location`,
      [req.params.serial]
    );
    if (!rows.length) { await client.query('ROLLBACK'); return res.json({ ok: true, restored: 0 }); }
    await client.query(
      `INSERT INTO moves (serial, from_location, to_location, moved_by) VALUES ($1, 'ARCHIVED', $2, $3)`,
      [req.params.serial, rows[0].location || 'RESTORED', moved_by]
    );
    await client.query('COMMIT');
    res.json({ ok: true, restored: 1 });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// ── Move (scan-and-move core action) ─────────────────────────────────────────
app.post('/api/move', requireAuth, async (req, res) => {
  const { serial, to_location, moved_by = 'dynatrack' } = req.body;
  if (!serial || !to_location) return res.status(400).json({ error: 'serial and to_location required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: itemRows } = await client.query('SELECT * FROM items WHERE serial = $1', [serial]);
    const item = itemRows[0];
    if (!item) {
      await client.query('INSERT INTO items (serial, status, location) VALUES ($1, $2, $3)', [serial, 'STORED', to_location]);
    } else {
      await client.query('UPDATE items SET location = $1, status = $2 WHERE serial = $3', [to_location, 'STORED', serial]);
    }
    await client.query('INSERT INTO locations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [to_location]);
    const { rows: moveRows } = await client.query(
      `INSERT INTO moves (serial, from_location, to_location, moved_by) VALUES ($1, $2, $3, $4) RETURNING *`,
      [serial, item?.location || null, to_location, moved_by]
    );
    await client.query('COMMIT');
    res.json({ ok: true, move: moveRows[0], item: { serial, location: to_location } });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── New-item intake ─────────────────────────────────────────────────────────
// POST /api/intake {serial, location?, intake_date?, moved_by} — create a brand-new part
// (status=STORED) with an explicit intake_date. Mirrors /api/move's audited txn, but it is
// a CREATE, not an upsert: if the serial already exists it does NOT overwrite — returns 409
// {alreadyExists:true} so the caller falls back to the move flow (a re-scan can't clobber).
// The first moves row IS the intake event. Read-only to eBay (Rule 25).
app.post('/api/intake', requireAuth, async (req, res) => {
  const { serial, location, intake_date, moved_by = 'intake' } = req.body;
  if (!serial || !serial.trim()) return res.status(400).json({ error: 'serial required' });
  const s   = serial.trim();
  const loc = (location && location.trim()) ? location.trim() : null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query('SELECT serial, status, location FROM items WHERE serial = $1', [s]);
    if (existing.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'already in inventory', alreadyExists: true, existing: existing[0] });
    }
    if (loc) await client.query('INSERT INTO locations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [loc]);
    const { rows: itemRows } = await client.query(
      `INSERT INTO items (serial, status, location, intake_date)
       VALUES ($1, 'STORED', $2, COALESCE($3::date, CURRENT_DATE)) RETURNING *`,
      [s, loc, intake_date || null]
    );
    // First move = the intake event. to_location is the shelf, or the 'INTAKE' marker when none given.
    await client.query(
      `INSERT INTO moves (serial, from_location, to_location, moved_by) VALUES ($1, NULL, $2, $3)`,
      [s, loc || 'INTAKE', moved_by]
    );
    await client.query('COMMIT');
    res.status(201).json({ ok: true, item: itemRows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// POST /api/move/batch {to_location, serials:[], intake_date?} — bulk move/create MANY items to ONE
// location in a SINGLE transaction (all-or-nothing; rollback on any failure). Per serial: existing →
// UPDATE to STORED@to_location + one 'dynatrack' moves row (prior → to); unknown → INSERT (STORED,
// intake_date = working date or CURRENT_DATE) + one 'intake' moves row (NULL → to). Exactly one
// moves row each (Rule 13). The wizard's Confirm screen is the create gate, so new-item creation
// here is reviewed, not silent. De-dupes serials. Read-only to eBay (Rule 25).
app.post('/api/move/batch', requireAuth, async (req, res) => {
  const { to_location, serials, intake_date, moved_by = 'dynatrack' } = req.body;
  if (!to_location || !to_location.trim()) return res.status(400).json({ error: 'to_location required' });
  if (!Array.isArray(serials) || serials.length === 0) return res.status(400).json({ error: 'serials required' });
  const loc = to_location.trim();
  const seen = new Set();
  const list = [];
  for (const s of serials) { const t = (s || '').trim(); if (t && !seen.has(t)) { seen.add(t); list.push(t); } }
  if (!list.length) return res.status(400).json({ error: 'no valid serials' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO locations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [loc]);
    let moved = 0, created = 0;
    for (const serial of list) {
      const { rows } = await client.query('SELECT location FROM items WHERE serial = $1', [serial]);
      if (rows.length) {
        await client.query("UPDATE items SET status = 'STORED', location = $1 WHERE serial = $2", [loc, serial]);
        await client.query(
          "INSERT INTO moves (serial, from_location, to_location, moved_by) VALUES ($1, $2, $3, $4)",
          [serial, rows[0].location || null, loc, moved_by]
        );
        moved++;
      } else {
        await client.query(
          `INSERT INTO items (serial, status, location, intake_date) VALUES ($1, 'STORED', $2, COALESCE($3::date, CURRENT_DATE))`,
          [serial, loc, intake_date || null]
        );
        await client.query(
          "INSERT INTO moves (serial, from_location, to_location, moved_by) VALUES ($1, NULL, $2, 'intake')",
          [serial, loc]
        );
        created++;
      }
    }
    await client.query('COMMIT');
    res.json({ ok: true, moved, created, location: loc });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── Moves log ─────────────────────────────────────────────────────────────────
app.get('/api/moves', requireAuth, async (req, res) => {
  const { serial, limit = 50 } = req.query;
  try {
    let q = 'SELECT * FROM moves';
    const p = [];
    if (serial) { p.push(serial); q += ` WHERE serial = $1`; }
    p.push(parseInt(limit));
    q += ` ORDER BY moved_at DESC LIMIT $${p.length}`;
    const { rows } = await pool.query(q, p);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Sequences ─────────────────────────────────────────────────────────────────
app.get('/api/sequences', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM sequences ORDER BY prefix');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sequences/next/:prefix', requireAuth, async (req, res) => {
  const { prefix } = req.params;
  try {
    const { rows } = await pool.query(
      `INSERT INTO sequences (prefix, next_num) VALUES ($1, 2)
       ON CONFLICT (prefix) DO UPDATE SET next_num = sequences.next_num + 1
       RETURNING prefix, next_num - 1 AS issued`,
      [prefix]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/sequences/:prefix', requireAuth, async (req, res) => {
  const { next_num } = req.body;
  if (!next_num) return res.status(400).json({ error: 'next_num required' });
  try {
    const { rows } = await pool.query(
      'UPDATE sequences SET next_num = $1 WHERE prefix = $2 RETURNING *',
      [parseInt(next_num), req.params.prefix]
    );
    if (!rows.length) return res.status(404).json({ error: 'Prefix not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sequences', requireAuth, async (req, res) => {
  const { prefix } = req.body;
  if (!prefix) return res.status(400).json({ error: 'prefix required' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO sequences (prefix, next_num) VALUES ($1, 1) ON CONFLICT (prefix) DO NOTHING RETURNING *',
      [prefix.toUpperCase().trim()]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Print log ─────────────────────────────────────────────────────────────────
app.get('/api/print-log', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM print_log ORDER BY printed_at DESC LIMIT 100');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/print-log', requireAuth, async (req, res) => {
  const { value, type = 'serial', qty = 1 } = req.body;
  try {
    const { rows } = await pool.query(
      'INSERT INTO print_log (value, type, qty) VALUES ($1, $2, $3) RETURNING *',
      [value, type, qty]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── eBay Trading API (multi-store) ──────────────────────────────────────────────
const https = require('https');

const EBAY_ENDPOINT = 'https://api.ebay.com/ws/api.dll';

// Store registry. Adding a 3rd store later = ONE more entry here (key/label/prefix).
// Each store's credentials come from `${prefix}_TRADING_API_{APP_NAME,CERT_NAME,DEV_NAME,TOKEN}`.
// The legacy un-prefixed TRADING_API_* set is INTENTIONALLY IGNORED in multi-store mode —
// it is kept in Railway only as a single-store rollback safety net and is never read here.
const STORES = [
  { key: 'dynatrack', label: 'Dynatrack', prefix: 'DYNATRACK' },
  { key: 'autolumen', label: 'AutoLumen', prefix: 'AUTOLUMEN' },
];
const STORE_VARS = ['APP_NAME', 'CERT_NAME', 'DEV_NAME', 'TOKEN'];

function getStore(key)      { return STORES.find(s => s.key === key) || null; }
function missingStoreVars(key) {
  const s = getStore(key);
  if (!s) return STORE_VARS.map(n => `<unknown store '${key}'>`);
  return STORE_VARS.map(n => `${s.prefix}_TRADING_API_${n}`).filter(v => !process.env[v]);
}
function storeConfigured(key) { return getStore(key) && missingStoreVars(key).length === 0; }

// Read a store's credentials from ITS prefixed env vars only. No un-prefixed fallback, ever.
function storeCreds(key) {
  const s = getStore(key);
  if (!s) return null;
  return {
    appName:  process.env[`${s.prefix}_TRADING_API_APP_NAME`]  || '',
    certName: process.env[`${s.prefix}_TRADING_API_CERT_NAME`] || '',
    devName:  process.env[`${s.prefix}_TRADING_API_DEV_NAME`]  || '',
    token:    process.env[`${s.prefix}_TRADING_API_TOKEN`]     || '',
  };
}

// Startup guardrail — loud per-store log, SOFT disable (no throw): a fat-fingered eBay
// credential must never take down warehouse scan/move/label operations. A misconfigured
// store is simply disabled and its /api/ebay routes fail loud on call.
function validateStoreEnv() {
  for (const s of STORES) {
    const missing = missingStoreVars(s.key);
    if (missing.length === 0) {
      console.log(`[eBay] store '${s.key}' (${s.label}): credentials OK`);
    } else {
      console.error(`[eBay][MISCONFIG] store '${s.key}' (${s.label}): missing ${missing.join(', ')} — store DISABLED; its /api/ebay routes will fail loud on call. Other stores and the rest of the app keep running.`);
    }
  }
  const legacy = STORE_VARS.map(n => `TRADING_API_${n}`).filter(v => process.env[v]);
  if (legacy.length) {
    console.log(`[eBay] legacy un-prefixed TRADING_API_* env vars detected (${legacy.join(', ')}) but IGNORED — multi-store mode reads only ${STORES.map(s => s.prefix + '_*').join(' / ')}. (Kept only as a single-store rollback safety net.)`);
  }
}
validateStoreEnv();

function ebayHeaders(store, callName) {
  const c = storeCreds(store) || {};
  return {
    'X-EBAY-API-SITEID':       '0',    // US
    'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
    'X-EBAY-API-CALL-NAME':    callName,
    'X-EBAY-API-APP-NAME':     c.appName  || '',
    'X-EBAY-API-CERT-NAME':    c.certName || '',
    'X-EBAY-API-DEV-NAME':     c.devName  || '',
    'Content-Type':            'text/xml',
  };
}

// Minimal XML → JS parser for eBay responses
function parseXmlValue(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? m[1].trim() : '';
}
function parseXmlAll(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const results = [];
  let m;
  while ((m = re.exec(xml)) !== null) results.push(m[1].trim());
  return results;
}

// All eBay calls are store-scoped. `store` is REQUIRED — there is no default and no
// shared/un-prefixed credential path, so a call can never silently use the wrong store.
async function ebayCall(store, callName, bodyXml) {
  if (!storeConfigured(store)) {
    throw new Error(`store '${store}' not configured: missing ${missingStoreVars(store).join(', ')}`);
  }
  const creds = storeCreds(store);
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${creds.token}</eBayAuthToken>
  </RequesterCredentials>
  ${bodyXml}
</${callName}Request>`;

  return new Promise((resolve, reject) => {
    const url  = new URL(EBAY_ENDPOINT);
    const opts = {
      hostname: url.hostname,
      path:     url.pathname,
      method:   'POST',
      headers:  { ...ebayHeaders(store, callName), 'Content-Length': Buffer.byteLength(xml) },
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(xml);
    req.end();
  });
}

// ── Per-store fetch helpers (one store each) ────────────────────────────────────
// Health probe — exercises the same call live sync uses (GetMyeBaySelling) so the card
// reflects real sync capability. Returns a tagged status object; never throws.
async function fetchStoreHealth(key) {
  const s = getStore(key);
  if (!s) return { key, label: key, connected: false, message: `unknown store '${key}'` };
  if (!storeConfigured(key)) {
    return { key, label: s.label, connected: false, message: `${s.label} · not configured: missing ${missingStoreVars(key).join(', ')}` };
  }
  try {
    const xml = await ebayCall(key, 'GetMyeBaySelling',
      '<ActiveList><Pagination><EntriesPerPage>1</EntriesPerPage><PageNumber>1</PageNumber></Pagination></ActiveList>');
    const ack = parseXmlValue(xml, 'Ack');
    if (ack === 'Success' || ack === 'Warning') {
      return { key, label: s.label, connected: true, message: `${s.label} · eBay Trading API connected` };
    } else if (!ack) {
      // No <Ack> => not a Trading API XML response (e.g. eBay's HTTP 503 "Service Unavailable" HTML page).
      return { key, label: s.label, connected: false, message: `${s.label} · status probe got a non-API response (likely an HTTP 503/maintenance page). Live sync may still be working.` };
    }
    const errMsg = parseXmlValue(xml, 'LongMessage') || parseXmlValue(xml, 'ShortMessage') || 'eBay API error';
    return { key, label: s.label, connected: false, message: `${s.label} · eBay API error: ${errMsg}` };
  } catch (e) {
    return { key, label: s.label, connected: false, message: `${s.label} · connection failed: ${e.message}` };
  }
}

// Active listings for one store, each tagged with `store`. Throws on API/config error.
async function fetchStoreListings(key) {
  const listings = [];
  let page = 1;
  while (true) {
    const xml = await ebayCall(key, 'GetMyeBaySelling', `
      <ActiveList>
        <Include>true</Include>
        <IncludeNotes>false</IncludeNotes>
        <Pagination>
          <EntriesPerPage>200</EntriesPerPage>
          <PageNumber>${page}</PageNumber>
        </Pagination>
      </ActiveList>
      <HideVariations>false</HideVariations>
    `);
    const ack = parseXmlValue(xml, 'Ack');
    if (ack !== 'Success' && ack !== 'Warning') {
      const err = parseXmlValue(xml, 'LongMessage') || parseXmlValue(xml, 'ShortMessage');
      throw new Error(err || 'eBay API error');
    }
    const itemBlocks = parseXmlAll(xml, 'ItemID').length ? parseXmlAll(xml, 'Item') : [];
    for (const block of itemBlocks) {
      // Available-to-sell quantity. ActiveList returns <QuantityAvailable>; if a future detail
      // level omits it, fall back to Quantity − SellingStatus.QuantitySold. A sold one-of-one is
      // Quantity 1 / Sold 1 / available 0; a live one is Quantity 1 / Sold 0 / available 1.
      const quantity  = parseInt(parseXmlValue(block, 'Quantity') || '0');
      const sold      = parseInt(parseXmlValue(block, 'QuantitySold') || '0');  // SellingStatus.QuantitySold
      const qaRaw     = parseXmlValue(block, 'QuantityAvailable');
      const available = qaRaw !== '' ? parseInt(qaRaw || '0') : Math.max(0, quantity - sold);
      listings.push({
        store:     key,
        itemId:    parseXmlValue(block, 'ItemID'),
        sku:       parseXmlValue(block, 'SKU') || parseXmlValue(block, 'SellerSKU'),
        title:     parseXmlValue(block, 'Title'),
        price:     parseFloat(parseXmlValue(block, 'CurrentPrice') || parseXmlValue(block, 'StartPrice') || '0'),
        qty:       available,   // displayed quantity (= available-to-sell)
        available,              // explicit available-to-sell — Inventory Health excludes sold-out (<=0)
        startTime: parseXmlValue(block, 'StartTime') || null,  // ListingDetails.StartTime (when the listing went live)
        url:       parseXmlValue(block, 'ViewItemURL'),
      });
      // NOTE (2026-05-30): per-variation SKUs are NOT emitted here. GetMyeBaySelling ActiveList does
      // not return the <Variations> node (verified across all live listings, incl. DetailLevel=ReturnAll),
      // and there are currently zero variation listings in either store. When variation listings exist,
      // the matcher fix is to source listings from GetSellerList (IncludeVariations=true) and emit one
      // (sku, available, startTime) row per Variation. Deferred until there's real data to verify against.
    }
    const totalPages = parseInt(parseXmlValue(xml, 'TotalNumberOfPages') || '1');
    if (page >= totalPages || itemBlocks.length === 0) break;
    page++;
    if (page > 50) break; // safety cap — 10,000 listings max
  }
  return listings;
}

// Orders (last `days`) for one store, each tagged with `store`. Throws on API/config error.
async function fetchStoreOrders(key, days) {
  const fromDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const orders = [];
  let page = 1;
  while (true) {
    const xml = await ebayCall(key, 'GetOrders', `
      <DetailLevel>ReturnAll</DetailLevel>
      <CreateTimeFrom>${fromDate}</CreateTimeFrom>
      <CreateTimeTo>${new Date().toISOString()}</CreateTimeTo>
      <OrderRole>Seller</OrderRole>
      <OrderStatus>All</OrderStatus>
      <Pagination>
        <EntriesPerPage>100</EntriesPerPage>
        <PageNumber>${page}</PageNumber>
      </Pagination>
    `);
    const ack = parseXmlValue(xml, 'Ack');
    if (ack !== 'Success' && ack !== 'Warning') {
      const err = parseXmlValue(xml, 'LongMessage') || parseXmlValue(xml, 'ShortMessage');
      throw new Error(err || 'eBay API error');
    }
    const orderBlocks = parseXmlAll(xml, 'Order');
    for (const block of orderBlocks) {
      // <CheckoutStatus> sits BEFORE <TransactionArray>; isolate the head and read it there so a
      // transaction's own <Status> can't be mistaken for the order's checkout status.
      // (PaidTime/ShippedTime, by contrast, live AFTER <TransactionArray> — parsed from the whole block below.)
      const head     = block.split('<TransactionArray')[0];
      const checkout = parseXmlValue(head, 'CheckoutStatus');   // inner content of <CheckoutStatus>
      const transBlocks = parseXmlAll(block, 'Transaction');
      const items = transBlocks.map(t => ({
        title: parseXmlValue(t, 'Title'),
        sku:   parseXmlValue(t, 'SKU') || parseXmlValue(t, 'SellerSKU'),
        qty:   parseInt(parseXmlValue(t, 'QuantityPurchased') || '1'),
        price: parseFloat(parseXmlValue(t, 'TransactionPrice') || '0'),
        // Pick List / Shipped reconcile (added 2026-05-29) — additive; consumed by reconcileOrderLines.
        orderLineItemId: parseXmlValue(t, 'OrderLineItemID'),
        itemId:          parseXmlValue(t, 'ItemID'),
        transactionId:   parseXmlValue(t, 'TransactionID'),
        lineShippedTime: parseXmlValue(t, 'ShippedTime'),       // per-line ShippedTime (partial shipments)
      }));
      orders.push({
        store:  key,
        id:     parseXmlValue(block, 'OrderID'),
        status: parseXmlValue(block, 'OrderStatus'),
        shipped: parseXmlValue(block, 'ShippedTime') !== '',  // eBay ShippedTime present = order shipped
        buyer:  parseXmlValue(block, 'UserID') || parseXmlValue(block, 'BuyerUserID'),
        total:  parseFloat(parseXmlValue(block, 'Total') || '0'),
        date:   parseXmlValue(block, 'CreatedTime'),
        items,
        // reconcile-only order-level fields (added 2026-05-29) — additive.
        shippedTime:    parseXmlValue(block, 'ShippedTime') || null,   // after <TransactionArray> — read from whole block
        paidTime:       parseXmlValue(block, 'PaidTime') || null,      // after <TransactionArray> — read from whole block
        checkoutStatus: parseXmlValue(checkout, 'Status') || null,             // CheckoutStatus.Status (in head)
        paymentStatus:  parseXmlValue(checkout, 'eBayPaymentStatus') || null,  // CheckoutStatus.eBayPaymentStatus (in head)
        lastModified:   parseXmlValue(checkout, 'LastModifiedTime') || null,   // change-detection timestamp (in head)
        // Cancel/refund signals (added 2026-05-30) — a refund leaves OrderStatus=Completed, so the
        // cancel state lives ONLY here. cancelStatus = order CancelStatus (NotApplicable|CancelComplete|…);
        // refundStatus = MonetaryDetails → Refunds → Refund → RefundStatus ('Succeeded' = money returned).
        cancelStatus:   parseXmlValue(block, 'CancelStatus') || null,
        refundStatus:   parseXmlValue(block, 'RefundStatus') || null,
      });
    }
    const totalPages = parseInt(parseXmlValue(xml, 'TotalNumberOfPages') || '1');
    if (page >= totalPages) break;
    page++;
  }
  return orders;
}

// ── Combined eBay routes (fan out over configured stores, tag + merge) ──────────
// Each route isolates per-store failures: one store erroring never blanks the others.
app.get('/api/ebay/health', requireAuth, async (req, res) => {
  const stores = await Promise.all(STORES.map(s => fetchStoreHealth(s.key)));
  // Aggregate fields kept only for backward-compatibility (pre-multi-store frontends);
  // the multi-store dashboard renders per-store from `stores`.
  const connected = stores.some(s => s.connected);
  const message = stores.map(s => `${s.label}: ${s.connected ? 'connected' : 'not connected'}`).join(' · ');
  res.json({ connected, message, stores });
});

app.get('/api/ebay/orders', requireAuth, async (req, res) => {
  const days = parseInt(req.query.days || '90');
  const results = await Promise.all(STORES.map(async s => {
    if (!storeConfigured(s.key)) return { store: s.key, orders: [], error: `not configured: missing ${missingStoreVars(s.key).join(', ')}` };
    try { return { store: s.key, orders: await fetchStoreOrders(s.key, days) }; }
    catch (e) { return { store: s.key, orders: [], error: e.message }; }
  }));
  const orders = results.flatMap(r => r.orders);
  const byStore = {}, errors = {};
  results.forEach(r => { byStore[r.store] = r.orders.length; if (r.error) errors[r.store] = r.error; });
  // Populate ebay_order_lines as a side-effect of the sync (Rule 25 read-only to eBay; populate-only).
  // Isolated: a reconcile failure must never break the orders sync the warehouse depends on.
  let reconcile = null;
  try { reconcile = await reconcileOrderLines(orders); }
  catch (e) { errors.reconcile = e.message; console.error('[reconcile] /api/ebay/orders failed:', e.message); }
  res.json({ orders, count: orders.length, byStore, errors, reconcile, fetched: new Date().toISOString() });
});

app.get('/api/ebay/listings', requireAuth, async (req, res) => {
  const results = await Promise.all(STORES.map(async s => {
    if (!storeConfigured(s.key)) return { store: s.key, listings: [], error: `not configured: missing ${missingStoreVars(s.key).join(', ')}` };
    try { return { store: s.key, listings: await fetchStoreListings(s.key) }; }
    catch (e) { return { store: s.key, listings: [], error: e.message }; }
  }));
  const listings = results.flatMap(r => r.listings);
  const byStore = {}, errors = {};
  results.forEach(r => { byStore[r.store] = r.listings.length; if (r.error) errors[r.store] = r.error; });
  res.json({ listings, count: listings.length, byStore, errors, fetched: new Date().toISOString() });
});

// ── Per-store eBay routes (isolation + cross-contamination verification) ────────
app.get('/api/ebay/:store/health', requireAuth, async (req, res) => {
  if (!getStore(req.params.store)) return res.status(404).json({ error: `unknown store '${req.params.store}'` });
  res.json(await fetchStoreHealth(req.params.store));
});

app.get('/api/ebay/:store/listings', requireAuth, async (req, res) => {
  const s = getStore(req.params.store);
  if (!s) return res.status(404).json({ error: `unknown store '${req.params.store}'` });
  if (!storeConfigured(s.key)) return res.status(503).json({ error: `store '${s.key}' not configured: missing ${missingStoreVars(s.key).join(', ')}` });
  try {
    const listings = await fetchStoreListings(s.key);
    res.json({ store: s.key, listings, count: listings.length, fetched: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/ebay/:store/orders', requireAuth, async (req, res) => {
  const s = getStore(req.params.store);
  if (!s) return res.status(404).json({ error: `unknown store '${req.params.store}'` });
  if (!storeConfigured(s.key)) return res.status(503).json({ error: `store '${s.key}' not configured: missing ${missingStoreVars(s.key).join(', ')}` });
  try {
    const days = parseInt(req.query.days || '90');
    const orders = await fetchStoreOrders(s.key, days);
    // Populate ebay_order_lines for this store (upsert-only — leaves other stores' lines intact).
    let reconcile = null;
    try { reconcile = await reconcileOrderLines(orders); }
    catch (e) { console.error('[reconcile] /api/ebay/' + s.key + '/orders failed:', e.message); }
    res.json({ store: s.key, orders, count: orders.length, reconcile, fetched: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Pick List (sold-but-unshipped orders → WMS shelf locations) ─────────────────
// Rule 8 SKU↔serial normalization. MUST stay byte-identical to the canonical frontend copy
// (top-level normalizeSkuKey in public/index.html). Centralize later (#14; blocked by the
// no-build-step single-file frontend, Rule 18).
// ⚠️ The frontend also has a `listedSerialKeys` tokenizer (2026-05-31) that splits a multi-serial
// eBay SKU field ("MOD15959V 16367V 18936V Autolumen") into each component serial with prefix
// inheritance — used by the Inventory Health LISTED/UNLISTED matcher. The order-reconcile below
// still matches on the SINGLE `line.sku` (one OrderLineItem = one SKU string). When the PARKED
// multi-serial pick/ship work lands (a sold unit of a multi-serial listing can't be attributed to
// one physical serial without scan-verify, #21), mirror `listedSerialKeys` here byte-identical.
function normalizeSkuKey(s) {
  return (s || '').trim().toUpperCase().replace(/[A-Z]+$/, '');
}

// ── eBay order-line reconcile ───────────────────────────────────────────────────
// Two phases, both as a side-effect of an orders sync (see the /api/ebay/orders routes).
// Pushes NOTHING to eBay (Rule 25).
//   PHASE 1 (populate): upsert fetched eBay order LINES into ebay_order_lines, keyed by
//     OrderLineItemID. Upsert-only (never deletes) — a per-store sync only updates that
//     store's lines; an order outside the fetch window is left intact.
//   PHASE 2 (ship-move, added Session 3): for each line now SHIPPED whose matched_serial is
//     a currently-STORED item, run ONE audited txn mirroring /api/move — items→SHIPPED@'SHIPPED'
//     location + exactly one moves row (moved_by='ebay-sync'). This is the ONLY place the
//     reconcile mutates items/moves (no separate pick route exists). Idempotent + monotonic: the
//     STORED guard means a re-sync re-moves nothing (no double-move, no duplicate moves row).
//
//   paid      = OrderStatus=Completed AND CheckoutStatus.Status=Complete
//               AND eBayPaymentStatus=NoPaymentFailure AND PaidTime present.
//   shipped   = order-level ShippedTime present OR this line's Transaction.ShippedTime present.
//   cancelled = OrderStatus Cancelled/CancelPending, OR CancelStatus=CancelComplete, OR a SUCCEEDED
//               refund (MonetaryDetails RefundStatus='Succeeded' — eBay leaves OrderStatus=Completed
//               on a refund, so this is the only signal), OR a refund flipping checkout to Incomplete.
//               (A refund only cancels an UNshipped line — shipped wins below, so a post-ship return
//               stays SHIPPED; its item is handled by the returns flow, not un-shipped here.)
//   disposition: shipped→SHIPPED; else cancelled→CANCELLED; else paid→NEEDS_PICK; else skip (unpaid/open).
//     MONOTONIC on conflict: a row already SHIPPED/CANCELLED/DISMISSED is never pulled back to
//     NEEDS_PICK, and DISMISSED (a manual decision) is never overwritten by the sync.
//   match: sku_norm → STORED items.serial. Exactly 1 → matched_serial; 0 → location_unknown;
//     >1 → location_unknown AND matched_serial NULL (ambiguous — do NOT guess). Lines are never dropped.
async function reconcileOrderLines(orderList) {
  if (!Array.isArray(orderList) || orderList.length === 0) return { upserts: 0, skipped: 0, moved: 0 };

  // Match candidates: active STORED items only, keyed by normalized serial (Rule 8).
  // Archived/scrapped items are NOT pick candidates — they must not match an eBay sale.
  const storedByKey = {};
  const { rows: storedRows } = await pool.query("SELECT serial FROM items WHERE status = 'STORED' AND archived_at IS NULL");
  for (const r of storedRows) {
    const k = normalizeSkuKey(r.serial);
    (storedByKey[k] = storedByKey[k] || []).push(r.serial);
  }

  const rows = [];
  let skipped = 0;
  for (const o of orderList) {
    const orderStatus = o.status || '';
    const paidTimePresent = !!o.paidTime;
    const paid = orderStatus === 'Completed'
              && o.checkoutStatus === 'Complete'
              && o.paymentStatus === 'NoPaymentFailure'
              && paidTimePresent;
    const cancelledOrder = orderStatus === 'Cancelled' || orderStatus === 'CancelPending'
              || o.cancelStatus === 'CancelComplete'                        // cancellation completed (OrderStatus may stay Completed)
              || o.refundStatus === 'Succeeded'                             // a succeeded refund undid the sale (eBay keeps OrderStatus=Completed)
              || (o.checkoutStatus === 'Incomplete' && paidTimePresent);    // refund flipped a paid order back to Incomplete

    for (const line of (o.items || [])) {
      const oli = line.orderLineItemId
        || (line.itemId && line.transactionId ? `${line.itemId}-${line.transactionId}` : '');
      if (!oli) { skipped++; continue; }  // no stable per-line key → skip (never invent a PK)

      const lineShipped  = (o.shipped === true) || !!line.lineShippedTime;
      const shippedTime  = line.lineShippedTime || o.shippedTime || null;

      let disposition;
      if (lineShipped)         disposition = 'SHIPPED';
      else if (cancelledOrder) disposition = 'CANCELLED';
      else if (paid)           disposition = 'NEEDS_PICK';
      else { skipped++; continue; }  // unpaid/open checkout, not shipped, not cancelled → not actionable yet

      const skuNorm = normalizeSkuKey(line.sku) || null;
      const cands   = skuNorm ? (storedByKey[skuNorm] || []) : [];
      let matchedSerial = null, locationUnknown;
      if (cands.length === 1) { matchedSerial = cands[0]; locationUnknown = false; }
      else                    { matchedSerial = null;     locationUnknown = true;  }  // 0 or >1 → flag, don't guess

      rows.push([
        oli, o.store, line.itemId || '', line.transactionId || '',
        line.sku || null, skuNorm, line.title || null,
        paid, o.paidTime || null, lineShipped, shippedTime,
        matchedSerial, locationUnknown, disposition, o.lastModified || null,
      ]);
    }
  }

  if (rows.length === 0) return { upserts: 0, skipped, moved: 0 };

  const COLS = ['order_line_item_id','store','ebay_item_id','ebay_transaction_id','sku_raw','sku_norm','title','paid','paid_time','shipped','ebay_shipped_time','matched_serial','location_unknown','disposition','ebay_last_modified'];
  const N = COLS.length;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const tuples = chunk.map((_, idx) => '(' + Array.from({ length: N }, (_, j) => `$${idx * N + j + 1}`).join(',') + ')');
      const params = chunk.flat();
      await client.query(
        `INSERT INTO ebay_order_lines (${COLS.join(',')})
         VALUES ${tuples.join(',')}
         ON CONFLICT (order_line_item_id) DO UPDATE SET
           store               = EXCLUDED.store,
           ebay_item_id        = EXCLUDED.ebay_item_id,
           ebay_transaction_id = EXCLUDED.ebay_transaction_id,
           sku_raw             = EXCLUDED.sku_raw,
           sku_norm            = EXCLUDED.sku_norm,
           title               = COALESCE(EXCLUDED.title, ebay_order_lines.title),
           paid                = ebay_order_lines.paid OR EXCLUDED.paid,
           paid_time           = COALESCE(EXCLUDED.paid_time, ebay_order_lines.paid_time),
           shipped             = ebay_order_lines.shipped OR EXCLUDED.shipped,
           ebay_shipped_time   = COALESCE(EXCLUDED.ebay_shipped_time, ebay_order_lines.ebay_shipped_time),
           matched_serial      = COALESCE(EXCLUDED.matched_serial, ebay_order_lines.matched_serial),
           location_unknown    = (COALESCE(EXCLUDED.matched_serial, ebay_order_lines.matched_serial) IS NULL),
           disposition         = CASE
             WHEN ebay_order_lines.disposition = 'DISMISSED' THEN 'DISMISSED'
             WHEN ebay_order_lines.disposition IN ('SHIPPED','CANCELLED') AND EXCLUDED.disposition = 'NEEDS_PICK'
               THEN ebay_order_lines.disposition
             ELSE EXCLUDED.disposition
           END,
           ebay_last_modified  = COALESCE(EXCLUDED.ebay_last_modified, ebay_order_lines.ebay_last_modified),
           last_synced         = NOW()`,
        params
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  // ── PHASE 2: ship-move (mirrors /api/move's audited txn) ──────────────────────
  // SHIP-ONCE PER LINE (2026-05-31, migration 0004): candidates = items still STORED with a matched
  // SHIPPED line that has NOT yet had its ship-move applied (ship_move_applied_at IS NULL). The same
  // txn that flips the item ALSO stamps the line, so a RETURNED item scanned back to STORED is NOT
  // re-shipped on the next sync (its line stays SHIPPED in eBay's 90-day window, but is now applied).
  // A genuine re-sale is a new OrderLineItemID → a fresh unstamped line → ships once. Each move is its
  // own BEGIN…COMMIT; the FOR UPDATE re-check of status='STORED' keeps it idempotent within a sync.
  let moved = 0;
  const { rows: toMove } = await pool.query(
    `SELECT i.serial FROM items i
      WHERE i.status = 'STORED'
        AND i.archived_at IS NULL
        AND EXISTS (SELECT 1 FROM ebay_order_lines e
                     WHERE e.matched_serial = i.serial AND e.disposition = 'SHIPPED'
                       AND e.ship_move_applied_at IS NULL)`
  );
  if (toMove.length) {
    const mc = await pool.connect();
    try {
      for (const it of toMove) {
        try {
          await mc.query('BEGIN');
          const { rows: lk } = await mc.query("SELECT location, status FROM items WHERE serial = $1 FOR UPDATE", [it.serial]);
          const cur = lk[0];
          if (!cur || cur.status !== 'STORED') { await mc.query('ROLLBACK'); continue; }  // guard: only STORED moves
          // Ensure the destination location row exists (FK target) — mirrors /api/move; no-op in prod.
          await mc.query("INSERT INTO locations (name, type) VALUES ('SHIPPED','SHIPPED') ON CONFLICT (name) DO NOTHING");
          await mc.query("UPDATE items SET status = 'SHIPPED', location = 'SHIPPED' WHERE serial = $1", [it.serial]);
          await mc.query(
            "INSERT INTO moves (serial, from_location, to_location, moved_by) VALUES ($1, $2, 'SHIPPED', 'ebay-sync')",
            [it.serial, cur.location || null]
          );
          // Ship-once stamp (migration 0004): mark the matched SHIPPED line(s) as applied IN THE SAME
          // txn — atomic with the item flip. If this txn rolls back, the stamp is not set (re-tried next sync).
          await mc.query(
            "UPDATE ebay_order_lines SET ship_move_applied_at = NOW() WHERE matched_serial = $1 AND disposition = 'SHIPPED' AND ship_move_applied_at IS NULL",
            [it.serial]
          );
          await mc.query('COMMIT');
          moved++;
        } catch (e) {
          await mc.query('ROLLBACK');
          console.error('[reconcile][ship-move] failed for', it.serial, ':', e.message);
        }
      }
    } finally {
      mc.release();
    }
  }

  return { upserts: rows.length, skipped, moved };
}

// ── Pick List business-day aging ────────────────────────────────────────────────
// HawkerWMS sells on eBay US and ships from a US warehouse, so a line's "age" is counted
// in US business days (Mon–Fri), skipping the holidays below. EDIT THIS LIST as needed —
// observed US federal holiday dates, 'YYYY-MM-DD' (the day the warehouse is actually closed).
const HOLIDAYS = new Set([
  // 2026
  '2026-01-01', // New Year's Day
  '2026-01-19', // Martin Luther King Jr. Day
  '2026-02-16', // Washington's Birthday (Presidents' Day)
  '2026-05-25', // Memorial Day
  '2026-06-19', // Juneteenth
  '2026-07-03', // Independence Day (observed — Jul 4 is a Saturday)
  '2026-09-07', // Labor Day
  '2026-10-12', // Columbus Day
  '2026-11-11', // Veterans Day
  '2026-11-26', // Thanksgiving Day
  '2026-12-25', // Christmas Day
  // 2027
  '2027-01-01', // New Year's Day
  '2027-01-18', // Martin Luther King Jr. Day
  '2027-02-15', // Washington's Birthday (Presidents' Day)
  '2027-05-31', // Memorial Day
  '2027-06-18', // Juneteenth (observed — Jun 19 is a Saturday)
  '2027-07-05', // Independence Day (observed — Jul 4 is a Sunday)
  '2027-09-06', // Labor Day
  '2027-10-11', // Columbus Day
  '2027-11-11', // Veterans Day
  '2027-11-25', // Thanksgiving Day
  '2027-12-24', // Christmas Day (observed — Dec 25 is a Saturday)
]);

// Whole US-Eastern business days elapsed from `from` (a paid/seen timestamp) up to `now`.
// Both ends are reduced to their America/New_York calendar date, then we count weekdays
// (Mon–Fri) that aren't HOLIDAYS in the half-open interval (fromDay, today]. Paid today → 0;
// paid one business day ago → 1. Weekends and holidays never age an order.
function businessDaysSince(from, now) {
  const ymd = d => d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // 'YYYY-MM-DD'
  let cur   = new Date(ymd(from) + 'T12:00:00Z');   // noon-UTC anchor avoids any DST day-shift
  const end = new Date(ymd(now)  + 'T12:00:00Z');
  let count = 0;
  while (cur < end) {
    cur = new Date(cur.getTime() + 24 * 60 * 60 * 1000);
    const dow = cur.getUTCDay();                     // 0=Sun … 6=Sat
    if (dow >= 1 && dow <= 5 && !HOLIDAYS.has(cur.toISOString().slice(0, 10))) count++;
  }
  return count;
}

// GET /api/picklist — VIEW+PRINT pick list read from ebay_order_lines (NEEDS_PICK), split by age.
// Each line keeps location/sku/description/locationUnknown and adds businessDaysSincePaid (from
// paid_time, falling back to first_seen) + paid_time + orderLineItemId. Returns TWO groups:
//   active = businessDaysSincePaid <= 3  → location A–Z, location-unknown LAST (the daily flow)
//   errors = businessDaysSincePaid >  3  → most-stale first (the hidden Errors tab)
// READ-ONLY — no eBay call, no mutation here (the reconcile writes; dismiss/restore mutate).
app.get('/api/picklist', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT e.order_line_item_id, e.matched_serial, e.sku_raw, e.title, e.location_unknown,
              e.paid_time, e.first_seen, i.location AS item_location
         FROM ebay_order_lines e
         LEFT JOIN items i ON i.serial = e.matched_serial
        WHERE e.disposition = 'NEEDS_PICK'`
    );
    const now = new Date();
    const mapped = rows.map(r => {
      const agingFrom = r.paid_time || r.first_seen;   // NEEDS_PICK is paid, but fall back defensively
      return {
        orderLineItemId: r.order_line_item_id,
        location:        r.location_unknown ? null : (r.item_location || null),
        sku:             r.location_unknown ? (r.sku_raw || null) : (r.matched_serial || r.sku_raw || null),
        description:     r.title || null,
        locationUnknown: r.location_unknown,
        paid_time:       r.paid_time || null,
        businessDaysSincePaid: agingFrom ? businessDaysSince(new Date(agingFrom), now) : 0,
      };
    });
    const active = mapped.filter(l => l.businessDaysSincePaid <= 3);
    const errors = mapped.filter(l => l.businessDaysSincePaid >  3);
    active.sort((a, b) => {                             // current daily sort — UNCHANGED
      if (a.locationUnknown !== b.locationUnknown) return a.locationUnknown ? 1 : -1;  // unknowns last
      return (a.location || '~~~').localeCompare(b.location || '~~~');                 // then location A–Z
    });
    errors.sort((a, b) =>                               // oldest first
      (b.businessDaysSincePaid - a.businessDaysSincePaid)                              // most stale on top
      || (new Date(a.paid_time || 0) - new Date(b.paid_time || 0)));                   // tie → oldest paid
    res.json({
      active, errors,
      activeCount: active.length, errorsCount: errors.length,
      fetched: new Date().toISOString(),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/picklist/dismissed — retained archive of manually-dismissed lines (disposition='DISMISSED').
// Read-only; same shape as a pick line + last_synced. Newest-synced first. Never auto-deleted.
app.get('/api/picklist/dismissed', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT e.order_line_item_id, e.matched_serial, e.sku_raw, e.title, e.location_unknown,
              e.paid_time, e.last_synced, i.location AS item_location
         FROM ebay_order_lines e
         LEFT JOIN items i ON i.serial = e.matched_serial
        WHERE e.disposition = 'DISMISSED'
        ORDER BY e.last_synced DESC`
    );
    const lines = rows.map(r => ({
      orderLineItemId: r.order_line_item_id,
      location:        r.location_unknown ? null : (r.item_location || null),
      sku:             r.location_unknown ? (r.sku_raw || null) : (r.matched_serial || r.sku_raw || null),
      description:     r.title || null,
      locationUnknown: r.location_unknown,
      paid_time:       r.paid_time || null,
      lastSynced:      r.last_synced || null,
    }));
    res.json({ lines, count: lines.length, fetched: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/picklist/dismiss { orderLineItemId } — manually move a NEEDS_PICK line into the
// retained DISMISSED archive. Guarded to NEEDS_PICK only (never touches SHIPPED/CANCELLED).
// No eBay call, no moves row, no items mutation (Rule 25). The reconcile's ON CONFLICT keeps
// DISMISSED untouched, so the line stays dismissed across every future sync.
app.post('/api/picklist/dismiss', requireAuth, async (req, res) => {
  const { orderLineItemId } = req.body;
  if (!orderLineItemId) return res.status(400).json({ error: 'orderLineItemId required' });
  try {
    const { rows } = await pool.query(
      `UPDATE ebay_order_lines SET disposition = 'DISMISSED'
        WHERE order_line_item_id = $1 AND disposition = 'NEEDS_PICK'
        RETURNING order_line_item_id`,
      [orderLineItemId]
    );
    res.json({ ok: true, dismissed: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/picklist/restore { orderLineItemId } — undo a dismiss: DISMISSED → NEEDS_PICK.
// Guarded to DISMISSED only. The line re-enters the active/errors split on the next /api/picklist
// read (its age decides which group). No eBay call, no items mutation.
app.post('/api/picklist/restore', requireAuth, async (req, res) => {
  const { orderLineItemId } = req.body;
  if (!orderLineItemId) return res.status(400).json({ error: 'orderLineItemId required' });
  try {
    const { rows } = await pool.query(
      `UPDATE ebay_order_lines SET disposition = 'NEEDS_PICK'
        WHERE order_line_item_id = $1 AND disposition = 'DISMISSED'
        RETURNING order_line_item_id`,
      [orderLineItemId]
    );
    res.json({ ok: true, restored: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Inventory Health omissions (hide/restore for the eBay-Only + WMS-Only buckets) ──────────────
// Persisted view-suppression record ONLY (migration 0005) — never touches items/moves/listings,
// no eBay call (Rule 25). omit_key: WMS_ONLY → items.serial ; EBAY_ONLY → normalizeSkuKey(SKU).
app.get('/api/health/omissions', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT omit_key, bucket FROM health_omissions');
    const out = { wmsOnly: [], ebayOnly: [] };
    for (const r of rows) (r.bucket === 'WMS_ONLY' ? out.wmsOnly : out.ebayOnly).push(r.omit_key);
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/health/omissions { key, bucket, note? } — hide a row. Guarded bucket; idempotent.
app.post('/api/health/omissions', requireAuth, async (req, res) => {
  const { key, bucket, note } = req.body || {};
  if (!key || (bucket !== 'WMS_ONLY' && bucket !== 'EBAY_ONLY')) {
    return res.status(400).json({ error: 'key and bucket (WMS_ONLY|EBAY_ONLY) required' });
  }
  try {
    await pool.query(
      `INSERT INTO health_omissions (omit_key, bucket, note) VALUES ($1, $2, $3) ON CONFLICT (omit_key, bucket) DO NOTHING`,
      [key, bucket, note || null]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/health/omissions/restore { key, bucket } — un-hide a row.
app.post('/api/health/omissions/restore', requireAuth, async (req, res) => {
  const { key, bucket } = req.body || {};
  if (!key || (bucket !== 'WMS_ONLY' && bucket !== 'EBAY_ONLY')) {
    return res.status(400).json({ error: 'key and bucket (WMS_ONLY|EBAY_ONLY) required' });
  }
  try {
    const { rowCount } = await pool.query('DELETE FROM health_omissions WHERE omit_key = $1 AND bucket = $2', [key, bucket]);
    res.json({ ok: true, restored: rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/shipped — every SHIPPED item + its eBay ship info where matched. Read-only.
// LEFT JOIN ebay_order_lines (disposition='SHIPPED') by matched_serial: recently-sold items
// carry sku_raw/title/ebay_shipped_time/store; the historical baseline-imported shipped items
// have no eBay line → those fields are null (NOT backfilled — the past is the past). DISTINCT ON
// keeps one row per item (a serial with several shipped lines → its latest ship time).
app.get('/api/shipped', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT s.serial, s.sku_raw, s.title, s.ebay_shipped_time, s.store
        FROM (
          SELECT DISTINCT ON (i.serial)
                 i.serial, e.sku_raw, e.title, e.ebay_shipped_time, e.store
            FROM items i
            LEFT JOIN ebay_order_lines e
              ON e.matched_serial = i.serial AND e.disposition = 'SHIPPED'
           WHERE i.status = 'SHIPPED'
           ORDER BY i.serial, e.ebay_shipped_time DESC NULLS LAST
        ) s
       ORDER BY s.ebay_shipped_time DESC NULLS LAST, s.serial
    `);
    const items = rows.map(r => ({
      serial:      r.serial,
      sku:         r.sku_raw || r.serial,            // eBay SKU where matched, else the serial
      description: r.title || null,                  // eBay title where matched
      shippedTime: r.ebay_shipped_time,              // null for historical baseline-imported items
      store:       r.store || null,
    }));
    res.json({ items, count: items.length, fetched: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Stats ─────────────────────────────────────────────────────────────────────
app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const [counts, locs, recentMoves, todayScans] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE TRUE)                        AS total,
          COUNT(*) FILTER (WHERE status = 'STORED')           AS stored,
          COUNT(*) FILTER (WHERE status = 'STAGED_UNLISTED')  AS staged,
          COUNT(*) FILTER (WHERE status = 'SHIPPED')          AS shipped
        FROM items
        WHERE archived_at IS NULL
      `),
      pool.query('SELECT COUNT(*) AS total FROM locations'),
      pool.query('SELECT * FROM moves ORDER BY moved_at DESC LIMIT 10'),
      pool.query(`SELECT COUNT(*) AS count FROM moves WHERE moved_at >= CURRENT_DATE`),
    ]);
    res.json({
      items:       counts.rows[0],
      locations:   locs.rows[0],
      recentMoves: recentMoves.rows,
      todayScans:  parseInt(todayScans.rows[0].count),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Catch-all → SPA ───────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`HawkerWMS running on port ${PORT}`);
  if (!WMS_PASSWORD) console.warn('⚠️  WMS_PASSWORD not set — login will be blocked. Add it in Railway Variables.');
});