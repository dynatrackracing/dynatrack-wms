# SNAPSHOT_ROUTES.md — `server.js` API surface

> Orientation map of the backend. Regenerate at session end if `server.js` changed (HAWKER_RULES rule 38).
> Generated 2026-05-28 from `server.js` (single Express file, ~646 lines). Line numbers are approximate anchors.

## Architecture
- Single-file Express app (`server.js`) + PostgreSQL (`pg.Pool`, `DATABASE_URL`). Serves the SPA from `public/` and all `/api/*` routes.
- **Auth:** token-based. `POST /api/login` checks `WMS_USERNAME`/`WMS_PASSWORD` (env) and returns a random hex token held in an **in-memory `Map`** (`sessions`), 12h sliding TTL, hourly cleanup. Protected routes use `requireAuth`, which reads the **`x-wms-token`** header. *In-memory means a server restart logs everyone out.*
- **Env vars:** `PORT`, `DATABASE_URL`, `WMS_USERNAME` (default `admin`), `WMS_PASSWORD` (required — login blocked if unset). **eBay is multi-store:** per-store creds via prefixed vars `DYNATRACK_TRADING_API_{APP_NAME,CERT_NAME,DEV_NAME,TOKEN}` and `AUTOLUMEN_TRADING_API_*`. The legacy un-prefixed `TRADING_API_*` set is **IGNORED** (no fallback) — kept only as a single-store rollback safety net.

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
| GET | `/api/ebay/health` (552) | yes | **Multi-store, fans out:** per-store `GetMyeBaySelling` probe → `{connected(any),message,stores:[{key,label,connected,message}]}`. Dashboard renders per-store from `stores`; top-level `connected`/`message` kept for back-compat. Honest non-XML handling (no "Unknown error"). |
| GET | `/api/ebay/orders` (561) | yes | **Multi-store:** `GetOrders` (last `days`=90) per configured store, each order **tagged `store`**, merged → `{orders,count,byStore,errors,fetched}`. Per-store failures isolated. ⚠️ raw responses contain **buyer PII** — never log them. |
| GET | `/api/ebay/listings` (574) | yes | **Multi-store:** `GetMyeBaySelling` ActiveList (200/page, cap 50) per store, each listing **tagged `store`**, merged → `{listings,count,byStore,errors,fetched}`. **Not persisted** — no `ebay_listings` table. |
| GET | `/api/ebay/:store/health` (587) | yes | One store's health (`{key,label,connected,message}`); 404 unknown store. |
| GET | `/api/ebay/:store/listings` (592) | yes | One store's tagged listings; 404 unknown store, 503 if that store not configured. Used for the cross-contamination check (each store must return distinct ItemIDs). |
| GET | `/api/ebay/:store/orders` (602) | yes | One store's tagged orders (`?days`); 404 unknown, 503 if not configured. |
| GET | `/api/stats` (614) | yes | Dashboard: item counts, location count, recent 10 moves, today's scan count. |
| GET | `*` (639) | public | Catch-all → serves `public/index.html` (SPA). |

## eBay helper layer (322–535) — multi-store
- **`STORES` registry (331):** `[{key,label,prefix}]` for `dynatrack`/`autolumen`. **Adding a 3rd store = one more entry.** `getStore`, `storeCreds(key)` (reads `${prefix}_TRADING_API_*` — **no un-prefixed fallback**), `missingStoreVars`/`storeConfigured`.
- **`validateStoreEnv()` (360)** runs at boot: loud per-store `OK`/`[MISCONFIG]` log + an explicit "legacy un-prefixed TRADING_API_* detected but IGNORED" line. **Soft disable, never throws** — a fat-fingered eBay cred can't crash warehouse ops; a misconfigured store's routes fail loud on call instead.
- **`ebayHeaders(store, callName)` (376)** / **`ebayCall(store, callName, bodyXml)` (404):** `store` is **required, no default, no shared cred path** — calls can't silently use the wrong store. `ebayCall` throws `store '<k>' not configured: missing …` when creds absent.
- **Per-store fetch helpers:** `fetchStoreHealth` (439, never throws — returns tagged status), `fetchStoreListings` (463), `fetchStoreOrders` (504). Combined routes fan out over `STORES` via these; per-store routes call one.
- `parseXmlValue` / `parseXmlAll` are regex-based minimal XML extractors.
- ⚠️ **`ebayCall` ignores `res.statusCode`** — non-200/HTML body resolves as data; `/api/ebay/health` guards via the no-`<Ack>` check, listings/orders surface it as a thrown "eBay API error".
- ✅ **Cross-contamination verified 2026-05-28:** dynatrack (3,272) vs autolumen (532) listings, disjoint ItemIDs, overlap 0 — per-store creds isolated.
