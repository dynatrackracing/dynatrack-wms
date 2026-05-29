# SNAPSHOT_ROUTES.md — `server.js` API surface

> Orientation map of the backend. Regenerate at session end if `server.js` changed (HAWKER_RULES rule 38).
> Generated 2026-05-29 from `server.js` (single Express file, ~878 lines). Line numbers are approximate anchors.

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
| GET | `/api/ebay/health` (553) | yes | **Multi-store, fans out:** per-store `GetMyeBaySelling` probe → `{connected(any),message,stores:[{key,label,connected,message}]}`. Dashboard renders per-store from `stores`; top-level `connected`/`message` kept for back-compat. Honest non-XML handling (no "Unknown error"). |
| GET | `/api/ebay/orders` (579) | yes | **Multi-store:** `GetOrders` (`DetailLevel=ReturnAll`, last `days`=90) per configured store, each order **tagged `store` + `shipped`**, merged → `{orders,count,byStore,errors,reconcile,fetched}`. Per-store failures isolated. **Side-effect (2026-05-29): `reconcileOrderLines` UPSERTs `ebay_order_lines` AND ship-moves matched STORED items → SHIPPED** (`reconcile={upserts,skipped,moved}`; isolated — a failure surfaces in `errors.reconcile` but never breaks the sync). ⚠️ raw responses contain **buyer PII** — never log them. |
| GET | `/api/ebay/listings` (575) | yes | **Multi-store:** `GetMyeBaySelling` ActiveList (200/page, cap 50) per store, each listing **tagged `store`**, merged → `{listings,count,byStore,errors,fetched}`. **Not persisted** — no `ebay_listings` table. |
| GET | `/api/ebay/:store/health` (604) | yes | One store's health (`{key,label,connected,message}`); 404 unknown store. |
| GET | `/api/ebay/:store/listings` (609) | yes | One store's tagged listings; 404 unknown store, 503 if that store not configured. Used for the cross-contamination check (each store must return distinct ItemIDs). |
| GET | `/api/ebay/:store/orders` (625) | yes | One store's tagged orders (`?days`); 404 unknown, 503 if not configured. **Side-effect (2026-05-29): `reconcileOrderLines` for that store** — UPSERTs its `ebay_order_lines` (upsert-only → other stores intact) + ship-moves its matched STORED items; returns `reconcile`. |
| GET | `/api/picklist` (812) | yes | **Pick List:** both stores' orders where `shipped=false && status!=Cancelled`, each line joined to its WMS item's shelf location via Rule-8 normalized serial. Lines with no WMS match → `locationUnknown:true` (**never dropped**); lines whose matched item is already SHIPPED → dropped. Grouped per order, lines sorted by location → `{orders:[{store,id,buyer,date,lines:[{sku,title,qty,serial,location,locationUnknown}]}],count,byStore,errors}`. Read-only. |
| POST | `/api/pick` (867) | yes | **Mark picked.** ⚠️ *Slated for removal* (view+print-only redesign); ship-moves now happen in the reconcile, not here. `{serial}`. Atomic txn (mirrors `/api/move`): `UPDATE items SET status='SHIPPED', location=NULL` + INSERT exactly ONE `moves` row (`from_location`=prior shelf, `to_location='SHIPPED'` **SENTINEL** — no FK, nothing joins it). 404 if serial unknown. READ-ONLY to eBay (Rule 25). |
| GET | `/api/stats` (705) | yes | Dashboard: item counts, location count, recent 10 moves, today's scan count. |
| GET | `*` (730) | public | Catch-all → serves `public/index.html` (SPA). |

## eBay helper layer (322–535) — multi-store
- **`STORES` registry (331):** `[{key,label,prefix}]` for `dynatrack`/`autolumen`. **Adding a 3rd store = one more entry.** `getStore`, `storeCreds(key)` (reads `${prefix}_TRADING_API_*` — **no un-prefixed fallback**), `missingStoreVars`/`storeConfigured`.
- **`validateStoreEnv()` (360)** runs at boot: loud per-store `OK`/`[MISCONFIG]` log + an explicit "legacy un-prefixed TRADING_API_* detected but IGNORED" line. **Soft disable, never throws** — a fat-fingered eBay cred can't crash warehouse ops; a misconfigured store's routes fail loud on call instead.
- **`ebayHeaders(store, callName)` (376)** / **`ebayCall(store, callName, bodyXml)` (404):** `store` is **required, no default, no shared cred path** — calls can't silently use the wrong store. `ebayCall` throws `store '<k>' not configured: missing …` when creds absent.
- **Per-store fetch helpers:** `fetchStoreHealth` (439, never throws — returns tagged status), `fetchStoreListings` (463), `fetchStoreOrders` (504). Combined routes fan out over `STORES` via these; per-store routes call one.
  - **`fetchStoreOrders` (504)** now requests `DetailLevel=ReturnAll` and parses order-level fields from the **head** (everything before `<TransactionArray>`, so a transaction's own `<Status>`/`<ShippedTime>` can't be mistaken for the order's). Each order keeps its existing shape (`id,status,shipped,buyer,total,date,items[]`) **plus additive fields** — order-level `shippedTime,paidTime,checkoutStatus,paymentStatus,lastModified`; each `items[]` line gains `orderLineItemId,itemId,transactionId,lineShippedTime`. `/api/picklist` ignores the additions (shape preserved).
- `parseXmlValue` / `parseXmlAll` are regex-based minimal XML extractors.
- ⚠️ **`ebayCall` ignores `res.statusCode`** — non-200/HTML body resolves as data; `/api/ebay/health` guards via the no-`<Ack>` check, listings/orders surface it as a thrown "eBay API error".
- ✅ **Cross-contamination verified 2026-05-28:** dynatrack (3,272) vs autolumen (532) listings, disjoint ItemIDs, overlap 0 — per-store creds isolated.

## Pick List layer (643–910)
- **`normalizeSkuKey(s)` (643):** `(s||'').trim().toUpperCase().replace(/[A-Z]+$/,'')` — server-side Rule-8 normalization. ⚠️ **MUST stay byte-identical** to the frontend copy in `loadInventoryHealth` (public/index.html). (Centralize later.) Reused by both `/api/picklist` and `reconcileOrderLines`.
- `GET /api/picklist` (812) joins unshipped order lines to WMS `items` by normalized serial; `POST /api/pick` (867, *slated for removal*) ships one item (status=SHIPPED, location=NULL) + one `moves` audit row. **Note:** the live ship-move now happens in `reconcileOrderLines` Phase 2 (→ real `'SHIPPED'` location), not via `/api/pick`.
- **`moves.to_location='SHIPPED'` is a sentinel** for picks — `moves.to_location` is `NOT NULL` but has **no FK**, and nothing joins it to `locations`. ⚠️ **Update (2026-05-29):** a **real** `'SHIPPED'` location row now exists (created by the baseline import; id 2713). The pick sentinel string coincidentally matches it but `/api/pick` still just writes the literal — it does NOT move items into that location yet (backlog #5 will switch pick→real SHIPPED location). No schema change in `/api/pick`.
- ✅ **Verified 2026-05-28:** `/api/picklist` → 17 unshipped orders (dynatrack 15 / autolumen 2), 12 lines flagged location-unknown. `/api/pick` bogus serial → 404 (no mutation). Real mark-picked happy-path pending architect.

## Order-line reconcile (`reconcileOrderLines`, 668) — two phases (added 2026-05-29)
Runs as a **side-effect of the two order-sync routes** (`/api/ebay/orders`, `/api/ebay/:store/orders`). Pushes nothing to eBay (Rule 25). Returns `{upserts, skipped, moved}`.
- **PHASE 1 — populate.** Upserts fetched eBay order **lines** into **`ebay_order_lines`** keyed by `order_line_item_id` (eBay `OrderLineItemID`; falls back to `ItemID-TransactionID`, skips a line that has neither). Upsert-only (never deletes).
  - **Derived state:** `paid` = OrderStatus `Completed` ∧ CheckoutStatus.Status `Complete` ∧ eBayPaymentStatus `NoPaymentFailure` ∧ PaidTime present; `shipped` = order-level ShippedTime ∨ that line's `Transaction.ShippedTime`; `cancelled` = OrderStatus `Cancelled`/`CancelPending` ∨ (a refund flipping a paid order to `Incomplete`).
  - **`disposition`:** shipped→`SHIPPED`; else cancelled→`CANCELLED`; else paid→`NEEDS_PICK`; else the line is skipped (unpaid/open checkout — not actionable yet).
  - **Matching:** `sku_norm` → **STORED** `items.serial`. Exactly 1 → `matched_serial`; 0 or >1 → `location_unknown=true` + `matched_serial` NULL (>1 is ambiguous — do **not** guess). Lines are never dropped.
  - **MONOTONIC upsert (ON CONFLICT):** a row already `SHIPPED`/`CANCELLED`/`DISMISSED` is never pulled back to `NEEDS_PICK`; `DISMISSED` (a manual decision) is never overwritten by the sync. `shipped`/`paid` are sticky-true (`OR`); `ebay_shipped_time`/`paid_time`/`title`/`matched_serial`/`ebay_last_modified` use `COALESCE` (a later null never wipes a known value); `last_synced=NOW()` each pass. Chunked (500 rows) inside one txn.
- **PHASE 2 — ship-move (the only place the reconcile mutates `items`/`moves`).** For each item still `STORED` that has ≥1 `SHIPPED` line matched to it (one row per item), runs **ONE audited txn mirroring `/api/move`**: re-check `status='STORED'` `FOR UPDATE`, ensure the `'SHIPPED'` location row exists, `UPDATE items SET status='SHIPPED', location='SHIPPED'`, INSERT exactly one `moves` row (`from_location`=prior shelf → `to_location='SHIPPED'`, `moved_by='ebay-sync'`). **Idempotent + monotonic:** the STORED guard means a re-sync moves nothing already shipped (no double-move, no duplicate `moves` row); `location_unknown`/ambiguous lines never move (no `matched_serial`). Authoritative ship time stays on `ebay_order_lines.ebay_shipped_time`; the `moves` row keeps its own insert timestamp. **`/api/pick` is NOT involved** (it is slated for removal in the view+print-only redesign).
