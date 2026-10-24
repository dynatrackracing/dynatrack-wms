/**
 * Viewer login (view-only contractor access) — tests.
 * Spec: docs/VIEWER_LOGIN_DIAGNOSE.md. Run with `npm test` (node:test, no new dependencies).
 *
 * No database and no network: a FAKE POOL is injected via __setPoolForTests, so every assertion
 * about "what SQL ran" is made against the real query the route built. The app is required (not
 * spawned), which is why server.js guards app.listen/the hourly sweep behind `require.main`.
 *
 * Covers, per the brief:
 *   1. role lands in the session on viewer login (and requireAuth refuses a viewer session)
 *   2. the allowlist denies a route that isn't on it, including a route that doesn't exist
 *   3. every write method is refused for the viewer
 *   4. the TZ prefix filter is applied — in SQL, not in the page
 *   5. viewer login is disabled when WMS_VIEWER_PASSWORD is unset
 */
'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const srv = require('../server.js');
const { app, requireAuth, buildViewerItemsQuery, escapeLike,
        VIEWER_GET_ALLOWLIST, VIEWER_POST_ALLOWLIST } = srv;

const VIEWER_TOKEN = 'v_' + 'a'.repeat(64);
const ADMIN_TOKEN  = 'b'.repeat(64);

// ── fake pool ────────────────────────────────────────────────────────────────
let calls = [];
const fakePool = {
  async query(text, values) {
    calls.push({ text: String(text), values: values || [] });
    const t = String(text);
    if (/UPDATE sessions SET expires_at/.test(t)) {
      // touchSession: resolve the token to a session row, the way the real table would.
      const token = (values || [])[0] || '';
      if (String(token).startsWith('v_')) return { rows: [{ username: 'viewer', role: 'viewer' }], rowCount: 1 };
      return { rows: [{ username: 'admin', role: 'admin' }], rowCount: 1 };
    }
    if (/SELECT serial, location, status, updated_at/.test(t)) {
      return { rows: [{ serial: 'TZ12345', location: 'AR05S03', status: 'STORED', updated_at: new Date().toISOString() }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  },
};
const sqlOf = re => calls.filter(c => re.test(c.text));

// ── harness ──────────────────────────────────────────────────────────────────
let server, base;
const savedEnv = {};

before(async () => {
  for (const k of ['WMS_VIEWER_PASSWORD', 'WMS_VIEWER_USERNAME', 'VIEWER_SKU_PREFIX']) savedEnv[k] = process.env[k];
  process.env.WMS_VIEWER_PASSWORD = 'test-viewer-pass';
  delete process.env.WMS_VIEWER_USERNAME;
  delete process.env.VIEWER_SKU_PREFIX;
  srv.__setPoolForTests(fakePool);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => { calls = []; });

const call = (path, opts = {}) => fetch(base + path, {
  method: opts.method || 'GET',
  headers: { 'Content-Type': 'application/json', ...(opts.token ? { 'x-wms-token': opts.token } : {}) },
  body: opts.body ? JSON.stringify(opts.body) : undefined,
});

// ═══ 1. role in session ══════════════════════════════════════════════════════

test('viewer login issues a v_ token and writes role=viewer into the session', async () => {
  const r = await call('/api/viewer/login', { method: 'POST', body: { username: 'viewer', password: 'test-viewer-pass' } });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.match(body.token, /^v_[0-9a-f]{64}$/);
  assert.equal(body.role, 'viewer');

  const insert = sqlOf(/INSERT INTO sessions/)[0];
  assert.ok(insert, 'a session row was inserted');
  assert.match(insert.text, /role/, 'the INSERT sets the role column');
  assert.ok(insert.values.includes('viewer'), 'the role value is viewer');
  assert.ok(String(insert.values[0]).startsWith('v_'), 'the stored token carries the v_ marker');
});

test('viewer login is logged to viewer_logins (time + IP)', async () => {
  await call('/api/viewer/login', { method: 'POST', body: { username: 'viewer', password: 'test-viewer-pass' } });
  await new Promise(r => setImmediate(r));          // the log insert is fire-and-forget
  assert.equal(sqlOf(/INSERT INTO viewer_logins/).length, 1);
});

test('viewer login refuses a wrong password and writes nothing', async () => {
  const r = await call('/api/viewer/login', { method: 'POST', body: { username: 'viewer', password: 'wrong' } });
  assert.equal(r.status, 401);
  assert.equal(sqlOf(/INSERT INTO/).length, 0);
});

test('requireAuth (the admin check) refuses a viewer session — second layer', async () => {
  let nexted = false, status = null;
  const res = { status(c) { status = c; return this; }, json() { return this; } };
  await requireAuth({ headers: { 'x-wms-token': VIEWER_TOKEN } }, res, () => { nexted = true; });
  assert.equal(status, 403);
  assert.equal(nexted, false, 'a viewer session never reaches an admin handler');
});

test('requireAuth still admits an admin session unchanged', async () => {
  let nexted = false, status = null;
  const req = { headers: { 'x-wms-token': ADMIN_TOKEN } };
  const res = { status(c) { status = c; return this; }, json() { return this; } };
  await requireAuth(req, res, () => { nexted = true; });
  assert.equal(status, null);
  assert.equal(nexted, true);
  assert.equal(req.wmsUser, 'admin');
  assert.equal(req.wmsRole, 'admin');
});

// ═══ 2. allowlist: deny by default ═══════════════════════════════════════════

test('the viewer is refused on every route that is not allowlisted', async () => {
  const denied = [
    '/api/items', '/api/items/count', '/api/items/TZ12345', '/api/locations', '/api/moves',
    '/api/stats', '/api/shipped', '/api/sequences', '/api/print-log', '/api/picklist',
    '/api/me', '/api/ebay/orders', '/api/ebay/listings', '/api/ebay/health', '/api/health/omissions',
  ];
  for (const path of denied) {
    const r = await call(path, { token: VIEWER_TOKEN });
    assert.equal(r.status, 403, `${path} must be 403 for the viewer`);
  }
  assert.equal(sqlOf(/FROM items|FROM locations|FROM moves/).length, 0, 'no data query ran for any denied route');
});

test('a route that does not exist yet is denied, not served (future routes are denied by default)', async () => {
  const r = await call('/api/some/route/added/next/year', { token: VIEWER_TOKEN });
  assert.equal(r.status, 403);
});

test('GET /api/ebay/orders — a GET that ships items — is refused for the viewer', async () => {
  const r = await call('/api/ebay/orders', { token: VIEWER_TOKEN });
  assert.equal(r.status, 403);
  assert.equal(sqlOf(/ebay_order_lines/).length, 0);
});

test('the allowlists are exactly the three GETs and two POSTs the viewer needs', () => {
  assert.deepEqual(VIEWER_GET_ALLOWLIST.slice().sort(), ['/api/health', '/api/viewer/items', '/api/viewer/me']);
  assert.deepEqual(VIEWER_POST_ALLOWLIST.slice().sort(), ['/api/viewer/login', '/api/viewer/logout']);
});

test('allowlist matching is not fooled by case or a trailing slash', async () => {
  assert.equal((await call('/api/items/', { token: VIEWER_TOKEN })).status, 403);
  assert.equal((await call('/API/items', { token: VIEWER_TOKEN })).status, 403);
  assert.equal((await call('/api/viewer/items/', { token: VIEWER_TOKEN })).status, 200, 'the real route still works with a trailing slash');
});

test('admin traffic is untouched by the gate (no v_ prefix ⇒ passes straight through)', async () => {
  const r = await call('/api/items?limit=1', { token: ADMIN_TOKEN });
  assert.equal(r.status, 200);
  assert.ok(sqlOf(/FROM items/).length >= 1, 'the admin query actually ran');
});

// ═══ 3. every write method is refused ════════════════════════════════════════

test('every write method on every write path is refused for the viewer', async () => {
  const paths = [
    '/api/move', '/api/move/batch', '/api/intake', '/api/items', '/api/items/TZ12345',
    '/api/items/TZ12345/archive', '/api/items/bulk-archive', '/api/items/TZ12345/unarchive',
    '/api/locations', '/api/locations/AR05S03', '/api/sequences', '/api/sequences/next/TZ',
    '/api/print-log', '/api/picklist/dismiss', '/api/picklist/restore',
    '/api/health/omissions', '/api/health/omissions/restore', '/api/login', '/api/logout',
    '/api/viewer/items', '/api/viewer/me',
  ];
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const path of paths) {
      const r = await call(path, { method, token: VIEWER_TOKEN, body: { serial: 'TZ12345', location: 'AR05S03' } });
      assert.equal(r.status, 403, `${method} ${path} must be 403 for the viewer`);
    }
  }
  assert.equal(sqlOf(/INSERT INTO|UPDATE items|UPDATE locations|DELETE FROM/).length, 0,
    'not one write statement reached the database');
});

test('the viewer may still end its own session (the one allowed POST beyond login)', async () => {
  const r = await call('/api/viewer/logout', { method: 'POST', token: VIEWER_TOKEN });
  assert.equal(r.status, 200);
  const del = sqlOf(/DELETE FROM sessions/)[0];
  assert.ok(del, 'it deletes a session row');
  assert.ok(del.values.includes(VIEWER_TOKEN), 'only its own token');
  assert.match(del.text, /role = \$2/, 'scoped to role=viewer, so it cannot delete an admin session');
});

// ═══ 4. the prefix filter runs in SQL ════════════════════════════════════════

test('GET /api/viewer/items filters by the TZ prefix in the database query', async () => {
  const r = await call('/api/viewer/items', { token: VIEWER_TOKEN });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.prefix, 'TZ');
  assert.equal(body.items.length, 1);

  const q = sqlOf(/FROM items/)[0];
  assert.ok(q, 'the item query ran');
  assert.match(q.text, /UPPER\(TRIM\(serial\)\) LIKE \$1 ESCAPE/, 'the prefix clause is in the SQL');
  assert.match(q.text, /archived_at IS NULL/, 'archived/scrapped units are excluded');
  assert.doesNotMatch(q.text, /status\s*=/, 'no status filter — every status is visible');
  assert.equal(q.values[0], 'TZ%');
});

test('the search box is ANDed onto the prefix, never replacing it', async () => {
  await call('/api/viewer/items?search=12345', { token: VIEWER_TOKEN });
  const q = sqlOf(/FROM items/)[0];
  assert.match(q.text, /UPPER\(TRIM\(serial\)\) LIKE \$1 ESCAPE/);
  assert.match(q.text, /serial ILIKE \$2 ESCAPE/);
  assert.equal(q.values[0], 'TZ%');
  assert.equal(q.values[1], '%12345%');
});

test('an empty or missing VIEWER_SKU_PREFIX still filters to TZ — it never means "everything"', async () => {
  process.env.VIEWER_SKU_PREFIX = '';
  await call('/api/viewer/items', { token: VIEWER_TOKEN });
  assert.equal(sqlOf(/FROM items/)[0].values[0], 'TZ%');

  calls = [];
  delete process.env.VIEWER_SKU_PREFIX;
  await call('/api/viewer/items', { token: VIEWER_TOKEN });
  assert.equal(sqlOf(/FROM items/)[0].values[0], 'TZ%');
});

test('a lowercase prefix is uppercased, so the filter is case-insensitive', () => {
  assert.equal(buildViewerItemsQuery({ prefix: 'tz' }).values[0], 'TZ%');
});

test('LIKE wildcards in the prefix or the search term are escaped, not honoured', () => {
  assert.equal(buildViewerItemsQuery({ prefix: '_' }).values[0], '\\_%');
  assert.equal(buildViewerItemsQuery({ prefix: '%' }).values[0], '\\%%');
  assert.equal(buildViewerItemsQuery({ prefix: 'TZ', search: '100%_x' }).values[1], '%100\\%\\_x%');
  assert.equal(escapeLike('a%b_c\\d'), 'a\\%b\\_c\\\\d');
});

test('the viewer query selects only the four read-only columns and is capped', () => {
  const q = buildViewerItemsQuery({ prefix: 'TZ', limit: 99999 });
  assert.match(q.text, /^SELECT serial, location, status, updated_at/);
  assert.doesNotMatch(q.text, /notes|intake_date|SELECT \*/);
  assert.equal(q.values[q.values.length - 1], 1000, 'the row cap cannot be raised by the caller');
});

// ═══ 5. disabled when the env var is unset ═══════════════════════════════════

test('viewer login is disabled (503) when WMS_VIEWER_PASSWORD is unset — there is no default', async () => {
  delete process.env.WMS_VIEWER_PASSWORD;
  try {
    for (const password of ['', 'test-viewer-pass', 'admin', undefined]) {
      const r = await call('/api/viewer/login', { method: 'POST', body: { username: 'viewer', password } });
      assert.equal(r.status, 503, 'no password at all can open a viewer session');
    }
    assert.equal(sqlOf(/INSERT INTO sessions/).length, 0, 'no session was created');
  } finally {
    process.env.WMS_VIEWER_PASSWORD = 'test-viewer-pass';
  }
});

test('viewer login is refused when the viewer username collides with the admin username', async () => {
  process.env.WMS_VIEWER_USERNAME = process.env.WMS_USERNAME || 'admin';
  try {
    const r = await call('/api/viewer/login', { method: 'POST', body: { username: 'admin', password: 'test-viewer-pass' } });
    assert.equal(r.status, 503);
    assert.equal(sqlOf(/INSERT INTO sessions/).length, 0);
  } finally {
    delete process.env.WMS_VIEWER_USERNAME;
  }
});
