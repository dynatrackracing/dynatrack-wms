# Viewer login for an outside contractor: Phase 1 diagnosis

**Date:** 2026-10-23. **HEAD at diagnosis:** `7db7ec1` (sync stamp `66fc403`, 2026-07-10). The clone was even with `origin/main`.
**Scope:** read-only. No code, schema or data was changed. This file is the only thing committed.
**Verdict:** auth exists (one shared admin login, token sessions in Postgres), so this is buildable. Every write path can be blocked in one central middleware. No STOP condition applies. **Q5 still needs a re-run on the live DB** (see Q5).

---

## 1. Stack

| | Evidence |
|---|---|
| Language/runtime | Node.js ≥18 (`package.json` `engines`). |
| Framework | Express 4 in one file, `server.js` (1,364 lines). Only dependencies: `express`, `pg` (`package.json`). |
| Frontend | One static SPA, `public/index.html` (2,591 lines, inline JS, no build step). It is the only file in `public/`. |
| Database | PostgreSQL on **Railway** (`server.js:46-49`, `pg.Pool` on `DATABASE_URL`). Schema = `db/schema.sql` + `db/migrations/0001…0008`. |
| Deploy | Railway Nixpacks, auto-deploys on push to GitHub `main`. `railway.toml`: `startCommand = "node server.js"`, healthcheck `/api/health`. Prod URL `hawkerwms.up.railway.app` (CLAUDE.md). |
| Tests | None. No test runner and no `test` script in `package.json`. |

## 2. Auth today

- **One shared login, no users table, no roles.** Credentials come from env: `WMS_USERNAME` (default `admin`) and `WMS_PASSWORD` (no default, login returns 503 if unset) at `server.js:18-19`.
- **Login:** `POST /api/login` (`server.js:68-84`) compares both values as plain strings. On a match it creates a random 64-hex token (`crypto.randomBytes(32)`) and does `INSERT INTO sessions (token, username, expires_at=NOW()+12h)`.
- **Session store:** the `sessions` table (`db/migrations/0006-sessions.sql`) has columns `token PK, username, created_at, expires_at`. There is **no role column**.
- **Checking a request:** `requireAuth` (`server.js:36-43`) reads header **`x-wms-token`** and calls `touchSession` (`server.js:26-33`). `touchSession` does one `UPDATE sessions SET expires_at=NOW()+12h WHERE token=$1 AND expires_at>NOW() RETURNING username`, which is a 12h sliding expiry. `requireAuth` is attached **per route**. There is no global auth middleware.
- `GET /api/me` (`:92-99`) and `POST /api/logout` (`:86-90`) do their own token handling. An hourly sweep deletes expired sessions (`:59-61`).
- **Client side:** the token lives in `localStorage.wms_token` (`public/index.html:745`, `:775`). `api()` sends it as a header (`:801-813`). A 401 response shows the login screen (`:808`).
- **Not cookie-based.** HTML page loads carry no identity. `express.static` (`server.js:65`) and the SPA catch-all `GET *` (`:1358`) serve `index.html` to anyone, logged in or not. The shell holds no data; all data comes through `/api/*`.
- The tablet and office use the same single login. There is no PIN.

## 3. Every write path

"Auth" means the route uses `requireAuth`. All lines are in `server.js`.

| Method | Path | Line | What it writes |
|---|---|---|---|
| POST | `/api/login` | 68 | `sessions` INSERT |
| POST | `/api/logout` | 86 | `sessions` DELETE |
| POST | `/api/locations` | 126 | `locations` INSERT |
| DELETE | `/api/locations/:name` | 138 | `locations` DELETE (FK nulls `items.location`) |
| POST | `/api/items` | 231 | `items` INSERT |
| PATCH | `/api/items/:serial` | 245 | `items` UPDATE status/location/notes |
| POST | `/api/items/:serial/archive` | 267 | `items` UPDATE + `moves` INSERT |
| POST | `/api/items/bulk-archive` | 296 | `items` UPDATE + `moves` INSERT (bulk) |
| POST | `/api/items/:serial/unarchive` | 326 | `items` UPDATE + `moves` INSERT |
| POST | `/api/move` | 351 | `locations` upsert, `items` upsert, `moves` INSERT (**tablet scan**) |
| POST | `/api/intake` | 394 | `items` INSERT, `locations` upsert, `moves` INSERT |
| POST | `/api/move/batch` | 434 | same as `/move`, in bulk (**tablet Scan & Move wizard**, `index.html:1387`) |
| POST | `/api/sequences/next/:prefix` | 506 | `sequences` upsert/increment |
| PATCH | `/api/sequences/:prefix` | 519 | `sequences` UPDATE |
| POST | `/api/sequences` | 532 | `sequences` INSERT |
| POST | `/api/print-log` | 552 | `print_log` INSERT |
| POST | `/api/picklist/dismiss` | 1230 | `ebay_order_lines` UPDATE |
| POST | `/api/picklist/restore` | 1247 | `ebay_order_lines` UPDATE |
| POST | `/api/health/omissions` | 1274 | `health_omissions` INSERT |
| POST | `/api/health/omissions/restore` | 1289 | `health_omissions` DELETE |

**Writes triggered by GET requests. These are the dangerous ones.**

| Method | Path | Line | What it writes |
|---|---|---|---|
| GET | `/api/ebay/orders` | 839 | Calls `reconcileOrderLines` (`:939`): `ebay_order_lines` upsert (`:1007`). **Phase 2 ship-moves items**: `items` → SHIPPED, `locations` upsert, `moves` INSERT, `ship_move_applied_at` UPDATE (`:1077-1090`). It also spends eBay API quota. |
| GET | `/api/ebay/:store/orders` | 885 | Same reconcile, for one store. |
| GET | `/api/me` and **every** `requireAuth` GET | 26-33 | `sessions.expires_at` UPDATE (sliding expiry). This only touches the caller's own session row, not WMS data. |

**Background jobs:** only the hourly expired-session sweep (`:59-61`). There is no cron and no eBay auto-sync (Rule 24).
**Scanner/barcode:** scanners act as keyboards (Rule 22). Their writes go through `/api/move/batch` and `/api/move`, which are listed above. There is no separate scanner endpoint.

## 4. Every read view, and where SKU and location live

**Read APIs:** `GET /api/locations` (111), `/api/items` (146, filters `status`/`search`/`location`/`archived`), `/api/items/count` (182), `/api/items/:serial` (206, hyphen-tolerant), `/api/moves` (485), `/api/sequences` (499), `/api/print-log` (545), `/api/ebay/health` (830), `/api/ebay/listings` (857), `/api/ebay/:store/health` (870), `/api/ebay/:store/listings` (875), `/api/picklist` (1162), `/api/picklist/dismissed` (1203), `/api/health/omissions` (1264), `/api/shipped` (1305), `/api/stats` (1332), `/api/health` (101, public).

**SPA pages** (`index.html:199-211`, `data-page`): Dashboard, Scan & Move, Locations, Inventory, Orders, Pick List, Errors, Shipped, Listings, Inventory Health, Admin. They all run in one page, so the server cannot see which page is open.

**Columns. This differs from the brief's wording.**
- **There is no separate "SKU" column.** The unit identifier is **`items.serial`** (TEXT UNIQUE, `db/schema.sql`), e.g. `MOD18130`, `INT-4705`. The prefix filter has to run on `items.serial`.
- **Shelf location** = `items.location`, a FK to `locations.name`, e.g. `AR05S03`.
- **Status** = `items.status` (`STORED` | `STAGED_UNLISTED` | `SHIPPED`). `items.archived_at` IS NOT NULL means the unit is decommissioned.
- **Last updated** = `items.updated_at`, maintained by a trigger.
- **There is no part-number column.** `items.notes` is free text. eBay `sku_raw`/`title` exist only in `ebay_order_lines`, for sold lines. The viewer page will show serial, location, status and updated time, and leave out part number.
- **There is no owner/store column on `items`.** The serial prefix is the only way to tell Tanzil's units apart.

## 5. Prefix check

**Live DB not queried.** This desktop has no `.env`, so there is no `DATABASE_URL_RO` (the same situation was noted in the 2026-07-10 session). See `SETUP_DB_ACCESS.md`. Run these two SELECTs from the laptop before Phase 2:

```sql
SELECT COUNT(*) FROM items WHERE UPPER(TRIM(serial)) LIKE 'AP-%';
SELECT COUNT(*) FROM items WHERE REPLACE(UPPER(TRIM(serial)),'-','') LIKE 'AP%';   -- hyphen-tolerant clash check
SELECT COALESCE(SUBSTRING(UPPER(TRIM(serial)) FROM '^[A-Z]+'), '(non-letter)') AS prefix, COUNT(*)
  FROM items GROUP BY 1 ORDER BY 2 DESC LIMIT 20;
```

**Proxy result** from the repo's seed dump `hawker-import.sql` (2026-04-02, 3,380 items). It is stale, but it's the same shape of data:
- `UPPER(TRIM(serial)) LIKE 'AP-%'` → **0**. Starts with `AP` in any form, hyphen-stripped included → **0**.
- Prefixes by count: MOD 1426, INT 479, ENG 394, FUS 238, ECU 161, EXT 114, CLU 61, PS 2, DMO 1, EOD 1, HTTPS 1 (a junk row), and **502 all-numeric serials**. 284 serials contain a hyphen (`MOD-`, `INT-`, `ENG-`, `FUS-`, `EXT-`, `CLU-`).
- **`AP` clashes with no existing item prefix.** Location names like `AR05S03` start with letters but live in `locations.name`, not `items.serial`, so they can't match.

## 6. Smallest safe design

**Principle:** the existing admin login path does not change at all. The viewer is a separate login that issues a recognizably different token. One `/api` middleware refuses viewer tokens everywhere except a short allowlist. Writes are refused before the allowlist is even checked.

1. **Migration `0009-viewer-role.sql`** (additive):
   - `ALTER TABLE sessions ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'`. Every existing session becomes `admin`, so **nobody is logged out**. A constant default is metadata-only in PG11+, so there's no table rewrite.
   - `CREATE TABLE viewer_logins (id serial PK, at timestamptz DEFAULT now(), ip text)` for the login log.
2. **Env:** `WMS_VIEWER_PASSWORD` (unset disables viewer login: 503, no default) and `VIEWER_SKU_PREFIX` (unset defaults to `AP-`; set-but-empty means all units). Optionally `WMS_VIEWER_USERNAME` (default `viewer`), refused if it equals `WMS_USERNAME`.
3. **Separate endpoint `POST /api/viewer/login`.** `/api/login` is not touched. Viewer tokens are `'v_' + 64 hex` with `role='viewer'`. Each login inserts a row into `viewer_logins` (time plus `x-forwarded-for` IP, because Railway sits behind a proxy).
4. **Central gate `app.use('/api', viewerGate)`**, registered after `express.json()` and before every route:
   - The token doesn't start with `v_` → `next()` immediately. Admin traffic gets no extra DB query and no behaviour change.
   - It's a viewer token and the method isn't `GET`/`HEAD` → **403**. The one exception is `POST /api/viewer/logout`, which only deletes the viewer's own session.
   - It's a viewer token and the GET path is not exactly in `{/api/viewer/items, /api/viewer/me, /api/health}` → **403**. Anything not on the list is denied, so **future routes are denied by default**.
5. **Second layer in `requireAuth`:** `touchSession` also returns `role`, and `requireAuth` returns 403 for `role='viewer'`. If someone adds `/api/ebay/orders` (a GET that writes) to the allowlist by mistake, the viewer still can't run it. Viewer routes use their own `requireViewer`.
6. **Prefix filter in SQL.** `GET /api/viewer/items?search=` runs `SELECT serial, location, status, updated_at FROM items WHERE archived_at IS NULL AND UPPER(TRIM(serial)) LIKE $1 ESCAPE '\'`, with `$1` set to the escaped, uppercased prefix plus `%`. Search is ANDed on as an escaped `ILIKE` on serial. Escaping matters because `_` and `%` in a prefix or search would otherwise act as wildcards. If the prefix is empty, the prefix clause is dropped.
7. **Viewer page: new file `public/viewer.html`**, served at `/viewer`. It is phone-friendly with a SKU search box and a read-only list, and has no edit controls. Its token is kept in its own localStorage key (`wms_viewer_token`) so it never collides with the office/tablet `wms_token`.
8. **Tests: new `test/viewer.test.js`** using Node's built-in `node:test`, with no new dependencies. To make the gate and the prefix-SQL builder importable without starting the server, `server.js` needs `if (require.main === module) app.listen(...)` plus `module.exports`. That's a small change to the startup lines, flagged here so it isn't a surprise. Add `"test": "node --test"`.

### Deviations from the brief: owner, please note

- **"Redirect the viewer to the viewer page (HTML)" can't be done on the server.** Auth is a header token, not a cookie, so page loads carry no identity. Today `index.html` is served to anyone, logged in or not. Protection is enforced where the data is, at `/api/*`. If the contractor opens `/`, they get the office login screen. Their viewer token isn't in `wms_token` and wouldn't pass `requireAuth` anyway, so they see no data. Making the HTML itself gated would mean adding cookies, which is a much bigger change to how existing users log in. I don't recommend it.
- **A viewer causes two writes, both to auth bookkeeping only:** sliding expiry on its own `sessions` row, and the `viewer_logins` row the brief asks for. It never writes `items`, `locations`, `moves`, `sequences`, `ebay_order_lines`, `health_omissions` or `print_log`.
- **No part-number column exists** (see Q4). The viewer list shows serial, location, status and last updated.

### Decisions for the owner before Phase 2

1. **Which units does the viewer see?** My recommendation: non-archived units only, in all statuses (STORED, STAGED_UNLISTED, SHIPPED). Hide archived/scrapped units.
2. **Login log:** a `viewer_logins` table (recommended, durable) or just a line in the Railway logs (no schema change, but Railway rotates logs).
3. **Live-DB Q5** has to be re-run on the laptop, where `.env` exists, before build. The proxy says 0 clashes.
4. **The "one real scan as a normal user" verify step** writes to production. Ry or the office manager should do it on the tablet, or explicitly approve a test serial plus cleanup.

### Side effects outside this feature: flagged, not in scope

- Once AP units are scanned into the WMS, the office will see them everywhere: Dashboard counts, Inventory, Locations counts. Unless they're listed on the Dynatrack/Autolumen eBay stores, they'll also show up in Inventory Health's **WMS-Only** bucket. That bucket already has a Hide feature.
- Order reconcile matching uses `normalizeSkuKey`, which strips trailing letters. An eBay SKU from another store that normalizes to an `AP-…` serial could ship-move it. That's unlikely, but if Tanzil sells AP units on eBay, the owner should check which account they're listed under.

---

## Addendum (2026-10-23): owner decisions, TZ prefix, eBay order matching

**Owner approved** the design, including both deviations. Decisions:
- The prefix is **`TZ`**, not `AP-`.
- The viewer sees TZ units in every status except archived/scrapped.
- The login log is a DB table (`viewer_logins`).
- The live TZ check has to be run and reported **before** building.
- The final verify is the office manager's normal work, so there are **no test writes to prod**.
- **Push everything together after hours.** Don't push Phase 1 on its own.

### Separator format: undashed, so `VIEWER_SKU_PREFIX=TZ`
The standard is prefix plus digits with **no dash**. In the 2026-05-29 prod export (3,380 items): **2,593 undashed** (`MOD20177`, `FUS2980`), **284 dashed**, which are legacy. The 2026-06 hyphen-dedup was retiring those, and its comment says the remaining labels are "still-dashed" (`server.js:197`). TZ units should be labelled `TZ1234`, so the prefix is **`TZ`**. `LIKE 'TZ%'` also catches a stray `TZ-1234`.
**TZ clash (proxy only):** 0 serials start with `TZ`, dash-stripped included, in the 2026-04-02 seed or the 2026-05-29 export. The live re-check is still pending (see Q5; swap `AP` for `TZ` in those queries).

### How `/api/ebay/orders` and `/api/ebay/:store/orders` match orders to items (report only, sync not changed)
- **Which stores are fetched:** only the stores in the `STORES` registry, Dynatrack and Autolumen. Each one's `GetOrders` is called with that store's own credentials. **If TZ units are listed on an eBay account other than those two, this sync never sees those orders and can't touch TZ items at all.** Owner, please confirm which account the TZ listings are on.
- **Key:** each order line's eBay `SKU` (the listing's Custom Label), from `line.sku`. It is normalized by `normalizeSkuKey` (`server.js:910`): trim, uppercase, then strip any **trailing run of letters and `*`**.
- **Candidates:** all items with `status='STORED' AND archived_at IS NULL`, keyed by the same normalization of `serial` (`server.js:945-950`).
- **Rule:** an **exact equality** of the two normalized keys. **Exactly 1** candidate → `matched_serial`. **0 or more than 1** → no match (`location_unknown`), so nothing ever ships (`server.js:979-983`). The Inventory Health multi-serial tokenizer (`listedSerialKeys`, `index.html:2152`) is **not** used by the sync.
- **Ship:** Phase 2 (`server.js:1059-1103`) moves to SHIPPED **only** a STORED item whose `matched_serial` sits on a SHIPPED line that has not been applied yet.

**Can a group Custom Label (up to 10 units) ship the wrong TZ item?** It depends on the label text:

| Label vs. unit serials | Outcome |
|---|---|
| Label is **not** equal to any unit serial once both are normalized (e.g. label `TZ-GROUP-07` or `TZLOT07`, units `TZ1001`…`TZ1010`) | **Safe.** 0 candidates, so lines appear in the Pick List as location-unknown and nothing is ever auto-shipped. |
| Label **equals one unit's serial** (e.g. label `TZ1001`, units `TZ1001`…`TZ1010`) | **Wrong-item risk.** Every sale of the group matches `TZ1001` while it's STORED, and the first sync ships `TZ1001` whatever unit actually left. Later sales find `TZ1001` no longer STORED → 0 candidates → no further moves. |
| Units **share a base and differ only by trailing letters** (e.g. `TZ1001A`…`TZ1001J`, label `TZ1001`) | **Wrong-item risk, and it's delayed.** All the units normalize to `TZ1001`. While 2 or more are STORED, sales are ambiguous and nothing moves. **Once only one is left STORED, every SHIPPED line still in eBay's 90-day window is re-matched on the next sync** (Phase 1 recomputes `matched_serial` for previously unmatched lines, `server.js:1018`). That ships the last unit even though it hasn't sold. Manual ship-scans of the other units bring that moment closer. |

**Bottom line:** the sync can only mark a TZ item shipped when a group label normalizes to exactly one STORED TZ serial. Safe conditions are: (a) the TZ listings are on a third eBay account, or (b) no group Custom Label equals any TZ unit serial after stripping trailing letters, and TZ serials **don't end in letters**. If neither can be guaranteed, the code fix is a later, separate change: exclude `TZ%` serials from the reconcile candidate pool, or apply the `listedSerialKeys` multi-serial rule. **Not changed here, per instruction.**
