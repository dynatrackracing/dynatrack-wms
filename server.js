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
    const { rows } = await pool.query('SELECT * FROM locations ORDER BY name');
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
  const { status, search, limit = 500 } = req.query;
  let q   = 'SELECT * FROM items';
  const p = [];
  const w = [];

  if (status) { p.push(status); w.push(`status = $${p.length}`); }
  if (search) {
    p.push(`%${search}%`);
    w.push(`(serial ILIKE $${p.length} OR location ILIKE $${p.length})`);
  }

  if (w.length) q += ' WHERE ' + w.join(' AND ');
  q += ' ORDER BY updated_at DESC';
  p.push(parseInt(limit));
  q += ` LIMIT $${p.length}`;

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
      listings.push({
        store:   key,
        itemId:  parseXmlValue(block, 'ItemID'),
        sku:     parseXmlValue(block, 'SKU') || parseXmlValue(block, 'SellerSKU'),
        title:   parseXmlValue(block, 'Title'),
        price:   parseFloat(parseXmlValue(block, 'CurrentPrice') || parseXmlValue(block, 'StartPrice') || '0'),
        qty:     parseInt(parseXmlValue(block, 'QuantityAvailable') || parseXmlValue(block, 'Quantity') || '0'),
        url:     parseXmlValue(block, 'ViewItemURL'),
      });
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
      const transBlocks = parseXmlAll(block, 'Transaction');
      const items = transBlocks.map(t => ({
        title: parseXmlValue(t, 'Title'),
        sku:   parseXmlValue(t, 'SKU') || parseXmlValue(t, 'SellerSKU'),
        qty:   parseInt(parseXmlValue(t, 'QuantityPurchased') || '1'),
        price: parseFloat(parseXmlValue(t, 'TransactionPrice') || '0'),
      }));
      orders.push({
        store:  key,
        id:     parseXmlValue(block, 'OrderID'),
        status: parseXmlValue(block, 'OrderStatus'),
        buyer:  parseXmlValue(block, 'UserID') || parseXmlValue(block, 'BuyerUserID'),
        total:  parseFloat(parseXmlValue(block, 'Total') || '0'),
        date:   parseXmlValue(block, 'CreatedTime'),
        items,
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
  res.json({ orders, count: orders.length, byStore, errors, fetched: new Date().toISOString() });
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
    res.json({ store: s.key, orders, count: orders.length, fetched: new Date().toISOString() });
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