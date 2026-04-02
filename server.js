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

// ── eBay ──────────────────────────────────────────────────────────────────────
app.get('/api/ebay/health', requireAuth, (req, res) => {
  const configured = !!(process.env.EBAY_APP_ID && process.env.EBAY_TOKEN);
  res.json({
    connected: configured,
    message: configured ? 'eBay API configured' : 'Add EBAY_APP_ID and EBAY_TOKEN env vars to enable live eBay data',
  });
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