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
| GET | `/api/locations` (111) | yes | All locations, ordered by `name`. **Returns `item_count`** per location (LEFT JOIN items + GROUP BY; 0 for empty bins — added 2026-05-29). |
| POST | `/api/locations` (118) | yes | `{name,type=GENERAL}`; name upper/trimmed; `ON CONFLICT(name) DO NOTHING`. |
| DELETE | `/api/locations/:name` (130) | yes | Delete a location (items in it get `location=NULL` via FK `ON DELETE SET NULL`). |
| GET | `/api/items` (138) | yes | Query: `status`, `search` (ILIKE on serial/location), `limit=500`, ordered `updated_at DESC`. **`location` = EXACT match (per-bin detail, added 2026-05-29):** when present → `WHERE location=$1`, **ordered by serial ASC, UNCAPPED** (takes precedence over fuzzy `search`; a bin like SHIPPED holds ~1,724). Existing status/search/limit path unchanged. |
| GET | `/api/items/count` (161) | yes | Counts: total / STORED / STAGED_UNLISTED / SHIPPED. |
| GET | `/api/items/:serial` (175) | yes | Single item or 404. |
| POST | `/api/items` (183) | yes | `{serial,status=STAGED_UNLISTED,location,notes}`; `ON CONFLICT(serial) DO NOTHING`. |
| PATCH | `/api/items/:serial` (197) | yes | COALESCE update of status/location/notes. |
| POST | `/api/move` (214) | yes | **Core scan-and-move.** `{serial,to_location,moved_by=dynatrack}`. Atomic txn: upsert item → `STORED`@to_location, ensure location row exists, insert a `moves` audit row. |
| POST | `/api/intake` (~244) | yes | **New-item intake** (added 2026-05-29). `{serial, location?, intake_date?, moved_by='intake'}`. Atomic txn mirroring `/api/move` but **create-only**: if the serial exists → **409 `{alreadyExists:true}`** (no overwrite — caller falls back to move). Else INSERT item (`status='STORED'`, `location` or NULL, `intake_date`=given or `CURRENT_DATE`), ensure the location row if given, INSERT one `moves` row (first move = intake; `to_location`=shelf or `'INTAKE'` marker). Returns the created item. Read-only to eBay (Rule 25). |
| GET | `/api/moves` (244) | yes | Optional `serial`, `limit=50`. Ordered `moved_at DESC`. |
| GET | `/api/sequences` (258) | yes | All sequences, ordered `prefix`. |
| POST | `/api/sequences/next/:prefix` (265) | yes | **Atomic** increment (`next_num = next_num + 1 RETURNING`); returns `{prefix,issued}`. Never compute via MAX (rule 10). |
| PATCH | `/api/sequences/:prefix` (278) | yes | Set `next_num`. |
| POST | `/api/sequences` (291) | yes | `{prefix}` upper/trimmed; create `ON CONFLICT DO NOTHING`. |
| GET | `/api/print-log` (304) | yes | Last 100 prints, `printed_at DESC`. |
| POST | `/api/print-log` (311) | yes | `{value,type=serial,qty=1}`. |
| GET | `/api/ebay/health` (553) | yes | **Multi-store, fans out:** per-store `GetMyeBaySelling` probe → `{connected(any),message,stores:[{key,label,connected,message}]}`. Dashboard renders per-store from `stores`; top-level `connected`/`message` kept for back-compat. Honest non-XML handling (no "Unknown error"). |
| GET | `/api/ebay/orders` (579) | yes | **Multi-store:** `GetOrders` (`DetailLevel=ReturnAll`, last `days`=90) per configured store, each order **tagged `store` + `shipped`**, merged → `{orders,count,byStore,errors,reconcile,fetched}`. Per-store failures isolated. **Side-effect (2026-05-29): `reconcileOrderLines` UPSERTs `ebay_order_lines` AND ship-moves matched STORED items → SHIPPED** (`reconcile={upserts,skipped,moved}`; isolated — a failure surfaces in `errors.reconcile` but never breaks the sync). ⚠️ raw responses contain **buyer PII** — never log them. |
| GET | `/api/ebay/listings` (575) | yes | **Multi-store:** `GetMyeBaySelling` ActiveList (200/page, cap 50) per store, each listing **tagged `store`**, merged → `{listings,count,byStore,errors,fetched}`. Each listing carries `qty` **and `available`** (= `QuantityAvailable`, else `Quantity − SellingStatus.QuantitySold`; **0 for sold-out** one-of-ones eBay keeps in ActiveList — added 2026-05-29). **Not persisted** — no `ebay_listings` table. |
| GET | `/api/ebay/:store/health` (604) | yes | One store's health (`{key,label,connected,message}`); 404 unknown store. |
| GET | `/api/ebay/:store/listings` (609) | yes | One store's tagged listings; 404 unknown store, 503 if that store not configured. Used for the cross-contamination check (each store must return distinct ItemIDs). |
| GET | `/api/ebay/:store/orders` (625) | yes | One store's tagged orders (`?days`); 404 unknown, 503 if not configured. **Side-effect (2026-05-29): `reconcileOrderLines` for that store** — UPSERTs its `ebay_order_lines` (upsert-only → other stores intact) + ship-moves its matched STORED items; returns `reconcile`. |
| GET | `/api/picklist` (812) | yes | **Pick List — VIEW+PRINT, reads `ebay_order_lines`** (rebuilt 2026-05-29 S4). Flat list of `disposition='NEEDS_PICK'` lines (paid+unshipped). Each: `location` (matched STORED item's CURRENT `items.location` via `matched_serial`; null when `location_unknown`), `sku` (matched WMS serial — what's on the part; falls back to `sku_raw` only for location-unknown lines), `description` (=title), `locationUnknown`. Sorted location A–Z, **location-unknown LAST (never dropped)** → `{lines,count,fetched}`. **READ-ONLY — no eBay call, no mutation** (the reconcile does all writes). |
| GET | `/api/shipped` (834) | yes | **Shipped Items** (added 2026-05-29 S5). All `items` WHERE `status='SHIPPED'` LEFT JOIN `ebay_order_lines` (`disposition='SHIPPED'`) on `matched_serial`=serial; **DISTINCT ON (serial)** keeps one row/item (latest ship time). Each: `serial`, `sku` (eBay `sku_raw` where matched, else the serial), `description` (eBay title), `shippedTime` (`ebay_shipped_time`; **null for historical baseline-imported items — not backfilled**), `store`. Sorted `shippedTime` DESC NULLS LAST → `{items,count,fetched}`. **READ-ONLY, no eBay call, no mutation.** |
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

## Pick List layer (643–835)
- **`normalizeSkuKey(s)` (643):** `(s||'').trim().toUpperCase().replace(/[A-Z]+$/,'')` — server-side Rule-8 normalization. ⚠️ **MUST stay byte-identical** to the frontend copy in `loadInventoryHealth` (public/index.html). (Centralize later.) Used by `reconcileOrderLines` (matching). *(No longer used by `/api/picklist`, which now reads the persisted `matched_serial`.)*
- `GET /api/picklist` (812) is now a **flat read of `ebay_order_lines` (NEEDS_PICK)** — no live eBay call, no item/order join at request time, no mutation. See the route table.
- **`POST /api/pick` was REMOVED (2026-05-29 S4).** The pick→ship action no longer exists as a route; shipping is done automatically by `reconcileOrderLines` Phase 2 when eBay reports a line shipped. The Pick List is **view+print only**. (Its sole caller, the frontend `markPicked`, was removed in the same session.)
- **`moves.to_location='SHIPPED'` + `items.location='SHIPPED'`** now reference the **real** `'SHIPPED'` location row (id 2713). The ship-move (reconcile Phase 2) writes both. `moves.to_location` still has no FK, but the value is now a real location.

## Order-line reconcile (`reconcileOrderLines`, 668) — two phases (added 2026-05-29)
Runs as a **side-effect of the two order-sync routes** (`/api/ebay/orders`, `/api/ebay/:store/orders`). Pushes nothing to eBay (Rule 25). Returns `{upserts, skipped, moved}`.
- **PHASE 1 — populate.** Upserts fetched eBay order **lines** into **`ebay_order_lines`** keyed by `order_line_item_id` (eBay `OrderLineItemID`; falls back to `ItemID-TransactionID`, skips a line that has neither). Upsert-only (never deletes).
  - **Derived state:** `paid` = OrderStatus `Completed` ∧ CheckoutStatus.Status `Complete` ∧ eBayPaymentStatus `NoPaymentFailure` ∧ PaidTime present; `shipped` = order-level ShippedTime ∨ that line's `Transaction.ShippedTime`; `cancelled` = OrderStatus `Cancelled`/`CancelPending` ∨ (a refund flipping a paid order to `Incomplete`).
  - **`disposition`:** shipped→`SHIPPED`; else cancelled→`CANCELLED`; else paid→`NEEDS_PICK`; else the line is skipped (unpaid/open checkout — not actionable yet).
  - **Matching:** `sku_norm` → **STORED** `items.serial`. Exactly 1 → `matched_serial`; 0 or >1 → `location_unknown=true` + `matched_serial` NULL (>1 is ambiguous — do **not** guess). Lines are never dropped.
  - **MONOTONIC upsert (ON CONFLICT):** a row already `SHIPPED`/`CANCELLED`/`DISMISSED` is never pulled back to `NEEDS_PICK`; `DISMISSED` (a manual decision) is never overwritten by the sync. `shipped`/`paid` are sticky-true (`OR`); `ebay_shipped_time`/`paid_time`/`title`/`matched_serial`/`ebay_last_modified` use `COALESCE` (a later null never wipes a known value); `last_synced=NOW()` each pass. Chunked (500 rows) inside one txn.
- **PHASE 2 — ship-move (the only place the reconcile mutates `items`/`moves`).** For each item still `STORED` that has ≥1 `SHIPPED` line matched to it (one row per item), runs **ONE audited txn mirroring `/api/move`**: re-check `status='STORED'` `FOR UPDATE`, ensure the `'SHIPPED'` location row exists, `UPDATE items SET status='SHIPPED', location='SHIPPED'`, INSERT exactly one `moves` row (`from_location`=prior shelf → `to_location='SHIPPED'`, `moved_by='ebay-sync'`). **Idempotent + monotonic:** the STORED guard means a re-sync moves nothing already shipped (no double-move, no duplicate `moves` row); `location_unknown`/ambiguous lines never move (no `matched_serial`). Authoritative ship time stays on `ebay_order_lines.ebay_shipped_time`; the `moves` row keeps its own insert timestamp. **This is the only ship path** — there is no `/api/pick` route (removed in S4).
