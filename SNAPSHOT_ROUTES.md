# SNAPSHOT_ROUTES.md — `server.js` API surface

> Orientation map of the backend. Regenerate at session end if `server.js` changed (CLAUDE_RULES rule 38).
> Generated 2026-05-28 from `server.js` (single Express file, ~551 lines). Line numbers are approximate anchors.

## Architecture
- Single-file Express app (`server.js`) + PostgreSQL (`pg.Pool`, `DATABASE_URL`). Serves the SPA from `public/` and all `/api/*` routes.
- **Auth:** token-based. `POST /api/login` checks `WMS_USERNAME`/`WMS_PASSWORD` (env) and returns a random hex token held in an **in-memory `Map`** (`sessions`), 12h sliding TTL, hourly cleanup. Protected routes use `requireAuth`, which reads the **`x-wms-token`** header. *In-memory means a server restart logs everyone out.*
- **Env vars:** `PORT`, `DATABASE_URL`, `WMS_USERNAME` (default `admin`), `WMS_PASSWORD` (required — login blocked if unset), `TRADING_API_APP_NAME`, `TRADING_API_CERT_NAME`, `TRADING_API_DEV_NAME`, `TRADING_API_TOKEN`.

## Route table

| Method | Path | Auth | Purpose / notes |
|---|---|---|---|
| POST | `/api/login` (75) | public | `{username,password}` → `{ok,token,username}`. 503 if `WMS_PASSWORD` unset; 401 on mismatch. |
| POST | `/api/logout` (87) | token | Deletes the session for the supplied token. |
| GET | `/api/me` (93) | token | `{username}` or 401. |
| GET | `/api/health` (101) | **public** | `SELECT 1` → `{ok,db,ts}`; 503 on DB failure. Railway health probe. No version stamp. |
| GET | `/api/locations` (111) | yes | All locations, ordered by `name`. |
| POST | `/api/locations` (118) | yes | `{name,type=GENERAL}`; name upper/trimmed; `ON CONFLICT(name) DO NOTHING`. |
| DELETE | `/api/locations/:name` (130) | yes | Delete a location (items in it get `location=NULL` via FK `ON DELETE SET NULL`). |
| GET | `/api/items` (138) | yes | Query: `status`, `search` (ILIKE on serial/location), `limit=500`. Ordered `updated_at DESC`. |
| GET | `/api/items/count` (161) | yes | Counts: total / STORED / STAGED_UNLISTED / SHIPPED. |
| GET | `/api/items/:serial` (175) | yes | Single item or 404. |
| POST | `/api/items` (183) | yes | `{serial,status=STAGED_UNLISTED,location,notes}`; `ON CONFLICT(serial) DO NOTHING`. |
| PATCH | `/api/items/:serial` (197) | yes | COALESCE update of status/location/notes. |
| POST | `/api/move` (214) | yes | **Core scan-and-move.** `{serial,to_location,moved_by=dynatrack}`. Atomic txn: upsert item → `STORED`@to_location, ensure location row exists, insert a `moves` audit row. |
| GET | `/api/moves` (244) | yes | Optional `serial`, `limit=50`. Ordered `moved_at DESC`. |
| GET | `/api/sequences` (258) | yes | All sequences, ordered `prefix`. |
| POST | `/api/sequences/next/:prefix` (265) | yes | **Atomic** increment (`next_num = next_num + 1 RETURNING`); returns `{prefix,issued}`. Never compute via MAX (rule 10). |
| PATCH | `/api/sequences/:prefix` (278) | yes | Set `next_num`. |
| POST | `/api/sequences` (291) | yes | `{prefix}` upper/trimmed; create `ON CONFLICT DO NOTHING`. |
| GET | `/api/print-log` (304) | yes | Last 100 prints, `printed_at DESC`. |
| POST | `/api/print-log` (311) | yes | `{value,type=serial,qty=1}`. |
| GET | `/api/ebay/health` (385) | yes | Calls `GeteBayOfficialTime`; `{connected,message}`. ⚠️ **Known bug (pending #4):** a 503/HTML response → "Unknown error". No server-side logging. |
| GET | `/api/ebay/orders` (405) | yes | `GetOrders`, last `days`(90), paginated 100/page → `{orders,count,fetched}`. 503 if no token. ⚠️ raw responses contain **buyer PII** — never log them. |
| GET | `/api/ebay/listings` (464) | yes | `GetMyeBaySelling` ActiveList, 200/page, cap 50 pages → `{listings,count,fetched}`. 503 if no token. **Not persisted** — there is no `ebay_listings` table. |
| GET | `/api/stats` (519) | yes | Dashboard: item counts, location count, recent 10 moves, today's scan count. |
| GET | `*` (544) | public | Catch-all → serves `public/index.html` (SPA). |

## eBay helper layer (322–382)
- `EBAY_ENDPOINT = https://api.ebay.com/ws/api.dll`; `ebayHeaders()` sets site ID `0` (US), compatibility level `967`, and the APP/CERT/DEV names. `ebayCall(callName, bodyXml)` wraps the XML request with `<eBayAuthToken>` from `TRADING_API_TOKEN`.
- `parseXmlValue` / `parseXmlAll` are regex-based minimal XML extractors.
- ⚠️ **`ebayCall` ignores `res.statusCode`** — any non-200/HTML body resolves as data, which is the root of the `/api/ebay/health` "Unknown error" bug (pending #4).
