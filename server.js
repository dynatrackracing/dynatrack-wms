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

// ── eBay Trading API ──────────────────────────────────────────────────────────
const https = require('https');

const EBAY_ENDPOINT = 'https://api.ebay.com/ws/api.dll';

function ebayHeaders(callName) {
  return {
    'X-EBAY-API-SITEID':       '0',    // US
    'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
    'X-EBAY-API-CALL-NAME':    callName,
    'X-EBAY-API-APP-NAME':     process.env.TRADING_API_APP_NAME  || '',
    'X-EBAY-API-CERT-NAME':    process.env.TRADING_API_CERT_NAME || '',
    'X-EBAY-API-DEV-NAME':     process.env.TRADING_API_DEV_NAME  || '',
    'Content-Type':            'text/xml',
  };
}

function ebayToken() {
  return process.env.TRADING_API_TOKEN || '';
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

async function ebayCall(callName, bodyXml) {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${ebayToken()}</eBayAuthToken>
  </RequesterCredentials>
  ${bodyXml}
</${callName}Request>`;

  return new Promise((resolve, reject) => {
    const url  = new URL(EBAY_ENDPOINT);
    const opts = {
      hostname: url.hostname,
      path:     url.pathname,
      method:   'POST',
      headers:  { ...ebayHeaders(callName), 'Content-Length': Buffer.byteLength(xml) },
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

// Health check — verifies credentials work
app.get('/api/ebay/health', requireAuth, async (req, res) => {
  const configured = !!(process.env.TRADING_API_TOKEN && process.env.TRADING_API_APP_NAME);
  if (!configured) {
    return res.json({ connected: false, message: 'TRADING_API_* environment variables not set in Railway.' });
  }
  try {
    const xml = await ebayCall('GeteBayOfficialTime', '');
    const ack = parseXmlValue(xml, 'Ack');
    if (ack === 'Success' || ack === 'Warning') {
      res.json({ connected: true, message: 'eBay Trading API connected · Australia site' });
    } else {
      const errMsg = parseXmlValue(xml, 'LongMessage') || parseXmlValue(xml, 'ShortMessage') || 'Unknown error';
      res.json({ connected: false, message: 'eBay API error: ' + errMsg });
    }
  } catch (e) {
    res.json({ connected: false, message: 'Connection failed: ' + e.message });
  }
});

// Orders — fetches last 90 days, paginates automatically
app.get('/api/ebay/orders', requireAuth, async (req, res) => {
  if (!process.env.TRADING_API_TOKEN) {
    return res.status(503).json({ error: 'eBay API not configured' });
  }
  try {
    const days    = parseInt(req.query.days || '90');
    const fromDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    let   page    = 1;
    const orders  = [];

    while (true) {
      const xml = await ebayCall('GetOrders', `
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
          title:    parseXmlValue(t, 'Title'),
          sku:      parseXmlValue(t, 'SKU') || parseXmlValue(t, 'SellerSKU'),
          qty:      parseInt(parseXmlValue(t, 'QuantityPurchased') || '1'),
          price:    parseFloat(parseXmlValue(t, 'TransactionPrice') || '0'),
        }));
        orders.push({
          id:       parseXmlValue(block, 'OrderID'),
          status:   parseXmlValue(block, 'OrderStatus'),
          buyer:    parseXmlValue(block, 'UserID') || parseXmlValue(block, 'BuyerUserID'),
          total:    parseFloat(parseXmlValue(block, 'Total') || '0'),
          date:     parseXmlValue(block, 'CreatedTime'),
          items,
        });
      }

      const totalPages = parseInt(parseXmlValue(xml, 'TotalNumberOfPages') || '1');
      if (page >= totalPages) break;
      page++;
    }

    res.json({ orders, count: orders.length, fetched: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Listings — fetches active listings with SKU and quantity
app.get('/api/ebay/listings', requireAuth, async (req, res) => {
  if (!process.env.TRADING_API_TOKEN) {
    return res.status(503).json({ error: 'eBay API not configured' });
  }
  try {
    let   page    = 1;
    const listings = [];

    while (true) {
      const xml = await ebayCall('GetMyeBaySelling', `
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

      const itemBlocks = parseXmlAll(xml, 'ItemID').length
        ? parseXmlAll(xml, 'Item')
        : [];

      for (const block of itemBlocks) {
        listings.push({
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

    res.json({ listings, count: listings.length, fetched: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Stats ─────────────────────────────────────────────────────────────────────
app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const [counts, locs, recentMoves] = await Promise.all([
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
    ]);
    res.json({
      items:       counts.rows[0],
      locations:   locs.rows[0],
      recentMoves: recentMoves.rows,
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