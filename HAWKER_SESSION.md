<!-- SYNC STAMP -->
LAST PUSHED COMMIT: ee41bab @ 2026-05-29 16:37 UTC
STAMP UPDATED BY: Claude Code, session 16:36 UTC
<!-- END SYNC STAMP -->

# HAWKER_SESSION.md

Append-only log of every session. Newest entries go at the TOP. Each session header: `## HH:MM UTC — Description`. Each day gets a `# YYYY-MM-DD` header.

---

# 2026-05-29

## 16:41 UTC — Migration 0002: `items.intake_date DATE` (additive; no app behaviour change)

**Single deliverable:** added `items.intake_date` (DATE, nullable) — the foundation for the unlisted-aging view. **Additive schema only, mirroring the S1 `ebay_order_lines` pattern; no app/route/UI change.**

### Diagnose-first (read-only, Rule 1)
Live `items` columns = id, serial, status, location, notes, created_at, updated_at — **no `intake_date`** (confirmed via information_schema). `db/migrations/` had only `0001` → next is `0002`. Counts 544 loc / 5061 items / 5167 moves / 14 seq. (`db/schema.sql` read, not edited — Rule 9.)

### Built + applied
- **New `db/migrations/0002-items-intake-date.sql`:** `ALTER TABLE items ADD COLUMN IF NOT EXISTS intake_date DATE;` + `CREATE INDEX IF NOT EXISTS items_intake_date_idx ON items(intake_date);` — idempotent/additive, in one txn. **Nullable, no default** so existing baseline rows stay NULL (= unknown/legacy age, deliberately **not** backfilled); future intake sets it explicitly.
- Applied to live prod via `railway run --service Postgres`. `db/schema.sql` NOT edited in place.

### Verified (read-only)
`intake_date` present: `date`, nullable=YES, default=null. **All 5061 rows NULL** (set_rows 0). Index `items_intake_date_idx` present. **Row counts unchanged** (544/5061/5167/14). `/api/health` 200.

**Files touched:** `db/migrations/0002-items-intake-date.sql` (new), `SNAPSHOT_SCHEMA.md` (regenerated — column + index + migrations list), `HAWKER_SESSION.md`, `HAWKER_CHANGELOG.md`. **DB state changed:** new empty column only. No app code/frontend/route change; no `schema.sql` edit. Throwaway diag/apply scripts deleted (Anti-rogue C).

**Production status:** `hawkerwms.up.railway.app` healthy; behaviour unchanged (column dormant). 544 loc / 5061 items / 5167 moves / 14 seq.

### ⏭ Not this session (folds into existing backlog)
Intake-flow stamping of `intake_date` (→ new-item intake #7), the batch-date override UI, the unlisted-aging view itself, and any legacy backfill.

## 16:36 UTC — Fix: exclude sold-out (available-0) eBay listings from Inventory Health

**Single deliverable:** sold-out listings were counted as live inventory in Inventory Health — inflating "eBay Inventory" and dumping phantom rows into "eBay Only." Now excluded from the reconciliation and the count. eBay read-only (Rule 25 — ActiveList only). Server + frontend.

### Diagnose-first (read-only, Rule 1)
- Server `fetchStoreListings` parsed `qty = QuantityAvailable || Quantity`. Raw ActiveList pull (both stores, read-only) confirmed: **`QuantityAvailable` is present on 100% of listings** (3280/3280 + 532/532) and `available = Quantity − QuantitySold` holds (e.g. Qty 6/Sold 3 → Avail 3). Sold-out (available ≤ 0): **dynatrack 1267 + autolumen 197 = 1464** of 3812. (Because `'0'` is a non-empty string the old `qty` already came out 0 for sold-out — so the inflation was the **frontend reconcile not filtering on qty**, but the `|| Quantity` fallback would be wrong if QA were ever absent.)
- Frontend `loadInventoryHealth`: `ebayByKey` was built from **all** `ALL_LISTINGS`; `h-ebay-total` = `ALL_LISTINGS.length`; Cross-listed keyed off per-store presence. The Listings page already flags sold-out (`qty 0` muted + a zero-stock filter).

### Built
- **Server (`fetchStoreListings`):** compute robust `available` = `QuantityAvailable` (present) else `Quantity − QuantitySold`; carry **`available`** on each listing (and `qty` = same value). eBay still read-only.
- **`mapListing`:** carries `available` through to `ALL_LISTINGS`.
- **`loadInventoryHealth`:** builds `liveListings = ALL_LISTINGS.filter(available>0)` and reconciles **only** that set — eBay Inventory count, all buckets, and Cross-listed/oversell all on the live set. **`ALL_LISTINGS` left intact** so the eBay Listings page still shows sold-out items. Summary now notes the sold-out count excluded.

### Verified live (Rule 17) — before/after via faithful replication of the bucket math over live data
| | BEFORE (all) | AFTER (available>0) |
|---|---|---|
| **eBay Inventory** | 3812 | **2348** |
| eBay Only | 1679 | **353** |
| Matched | 2020 | 1990 |
| WMS Only | 1207 | 1240 |
| Duplicate | 0 | 0 |
| Cross-listed | 3 | **0** |

- 1464 sold-out excluded; **1326 phantom eBay-Only rows removed** (1679→353). The residual **353** are *genuinely live* listings whose SKU matches no STORED serial (uncaptured/staged items + real listing-without-WMS-record) — real signal, not phantoms (the brief's "single/low-double digits" was optimistic; honest result is 353).
- Matched/WMS-Only shifted only ~1.5%/2.7% ("roughly unchanged"); the ~30 that moved were sold-out listings that had matched a still-STORED item → correctly become WMS Only. Cross-listed 3→0 = false oversell alarms removed (each had a sold-out side).
- Spot-checks: sold-out `INT3927V` (qty 0/available 0) excluded; live `MOD19325R` (avail 1) → STORED serial `MOD19325` Matched.
- Post-deploy: served HTML has the `liveListings` filter; `/api/ebay/dynatrack/listings` returns the `available` field (1267 sold-out); `node --check` + inline JS OK; `/api/health` 200.

**Files touched:** `server.js` (listing builder + `available`), `public/index.html` (`mapListing` + Health reconcile filter + summary), `SNAPSHOT_ROUTES.md`, `SNAPSHOT_FRONTEND.md`, `HAWKER_SESSION.md`, `HAWKER_CHANGELOG.md`. No DB change. Independent of the (un-built) `ebay_listings` persistence table. Commit `aa74c66`. Throwaway peek/recon/verify scripts deleted.

**Production status:** `hawkerwms.up.railway.app` healthy. Inventory Health now reflects live sellable inventory only.

## 15:39 UTC — Fix: Inventory Health blank page (mis-nested `#page-health` inside `#page-admin`)

**Single deliverable:** Inventory Health rendered blank because `#page-health` was **nested inside `#page-admin`** (whose `display:none` when Admin isn't active hid Health too). Frontend only (`public/index.html`); inner content of neither section touched.

### Diagnose-first (read-only)
DOM page order is …`#page-admin` (390) → `#page-health` (431) → `</main>`. Balanced the admin section: `.ph` + a `.g2` holding two column `<div>`s; the `.g2` closes but **the outer `<div class="page" id="page-admin">` (390) had no closing `</div>`** before the Inventory Health comment/`#page-health`. So `#page-health` was swallowed as admin's child; whole-file div count was **268 open / 267 close** (off by one). Confirmed at runtime by the architect's parent-chain probe (health → admin(display:none) → main).

### Fix
Inserted the **one missing `</div>`** at the admin/health boundary (after `.g2` closes, before the `<!-- INVENTORY HEALTH -->` comment), so `#page-admin` closes after its own content and `#page-health` becomes a direct child of `<main>`. **+1 line, no content moved.**

### Verified (no runtime band-aid)
Static parent-chain probe on the **live served HTML** captured the before/after across the deploy:
- **Before (old deploy):** div balance 268/**267**, `#page-health` at **depth 1** (inside admin) — the bug.
- **After (new deploy):** div balance **268/268**, **all 10 `.page` divs at depth 0** (direct children of `<main>`), `#page-health` depth 0 = sibling of `#page-admin`, final depth at `</main>` = 0. `node --check` inline JS OK; `/api/health` 200. (Browser render-on-navigate is the architect's eyeball, but the structural cause is definitively gone — every page div is now an independent sibling that `navigate()` can show/hide.)

**Files touched:** `public/index.html` (+1 `</div>`), `SNAPSHOT_FRONTEND.md`, `HAWKER_SESSION.md`, `HAWKER_CHANGELOG.md`. No server/DB change. Commit `7178b8c`. Throwaway probe script deleted.

**Production status:** `hawkerwms.up.railway.app` healthy; Inventory Health now shows when navigated to. (Note: prior 2026-05-28 "blank Inventory Health" work added a defensive render guard but didn't catch this DOM mis-nesting — the real root cause was structural, fixed now.)

## 14:42 UTC — Pick List / Shipped rework, Session 5 of 5 (FINAL): Shipped Items page

**Single deliverable:** a new **Shipped Items** page — a searchable, read-only list of shipped items with eBay ship timestamps. Backend route + frontend page + nav entry. No mutation, no eBay call. **This completes the 5-part Pick List / Shipped Items rework.**

### Diagnose-first (Rule 1)
Matched house style off the **Inventory** page: `.phr` header (h1 + count `<p>`), `.sb` search box with `oninput`, `.card > .tw > table` with `<thead>` + `<tbody id>`; client-side render from a cached array. Confirmed `items`/`ebay_order_lines` columns. Nav = `.ni[data-page]` buttons + `navigate(p)` dispatch.

### Built
1. **`GET /api/shipped`** (read-only): `items` WHERE `status='SHIPPED'` LEFT JOIN `ebay_order_lines` (`disposition='SHIPPED'`) on `matched_serial`=serial, **DISTINCT ON (serial)** (one row/item, latest ship time). Row = `serial`, `sku` (eBay `sku_raw` where matched, else the serial), `description` (eBay title), `shippedTime` (`ebay_shipped_time`; **null for historical baseline-imported items — NOT backfilled**), `store`. Sorted `shippedTime` DESC NULLS LAST → `{items,count,fetched}`.
2. **Frontend:** new **"Shipped"** nav entry (after Pick List) + `#page-shipped` — 4-column table **SERIAL · SKU · DESCRIPTION · SHIPPED** (`loadShipped`→`renderShipped`; "—" when no timestamp). Search box (`filterShipped`) filters the cached `SHIPPED_ROWS` **client-side, case-insensitively across serial + sku + description**. `navigate` wires `loadShipped` on open.
3. No mutation, no eBay call; Pick List + reconcile untouched.

### Verified live (deployed app, read-only)
- `/api/shipped`: **count=1830** — **106 carry `ebay_shipped_time` + description** (the S3 ship-moved items), **1724 historical show "—"** (sku falls back to serial). Row shape `{serial,sku,description,shippedTime,store}`.
- Newest rows dated 2026-05-29 (e.g. `FUS3267`, `MOD20660`); SKU shows the eBay suffix variant where it differs (`MOD19300R`, `ECU0245V`). Oldest tail = historical (`RYN00xx`, "—").
- **Sort:** non-null DESC = true · nulls-last = true. **Case-insensitive search:** `"radio"`→3 description matches; `"mod"`→698; lowercase serials match (`"fus3267"`→FUS3267, `"ecu0245"`→ECU0245V, `"mod20660"`→MOD20660).
- Note on the brief's `"fus3205"` example: it returns **none — correctly**, because `FUS3205` is a NEEDS_PICK item (confirmed still in `/api/picklist`, absent from `/api/shipped`). The search mechanism is sound; that serial simply isn't shipped.
- `node --check` server.js OK, inline JS OK, served HTML has the Shipped page + `loadShipped`, `/api/health` 200.

**Files touched:** `server.js` (+`GET /api/shipped`), `public/index.html` (nav + `#page-shipped` + `loadShipped`/`renderShipped`/`filterShipped` + navigate hook), `SNAPSHOT_ROUTES.md`, `SNAPSHOT_FRONTEND.md`, `HAWKER_SESSION.md`, `HAWKER_CHANGELOG.md`. **No DB change** (read-only route + UI; +78 LOC). Commit `1f4d118`. Throwaway verify scripts deleted. Deploy was slow (~4 min) but landed healthy.

### ✅ Rework COMPLETE (all 5 sessions)
S1 `ebay_order_lines` table · S2 sync populates it · S3 sync ship-moves matched STORED items → SHIPPED@'SHIPPED' · S4 Pick List = view+print off the table (`/api/pick` removed) · **S5 Shipped Items page.** The eBay orders sync is now the single source: it records lines, ships sold items, and feeds both the Pick List (NEEDS_PICK) and Shipped Items (SHIPPED) views. **Production status:** `hawkerwms.up.railway.app` healthy; 544 loc / 5061 items (3231 STORED + 1830 SHIPPED) / 5167 moves / 14 seq. Warehouse still on the old WMS (cutover pending a final same-day extract+import).

## 14:28 UTC — Pick List / Shipped rework, Session 4 of 5: Pick List rebuilt as VIEW+PRINT (reads `ebay_order_lines`); `/api/pick` removed

**Single deliverable:** the Pick List is now a clean **view+print** screen backed by `ebay_order_lines` — no item mutation from this page (the eBay sync ships items). Backend route reshape + frontend. eBay read-only (Rule 25).

### Step 0 diagnosis (Rule 1)
Read the old `GET /api/picklist` (live order↔WMS join), `#page-picklist` (`loadPickList`/`markPicked`/`printPickList` + the `@media print` block), and **grepped every caller of `POST /api/pick`** — sole caller was the frontend `markPicked`. Confirmed safe to remove.

### Built
1. **`GET /api/picklist` rewritten** → flat read of `ebay_order_lines` WHERE `disposition='NEEDS_PICK'` (LEFT JOIN items for the CURRENT shelf). Each line: `location` (matched item's current `items.location` via `matched_serial`; null when `location_unknown`), `sku` (= the matched WMS serial — what's printed on the part; falls back to `sku_raw` only for location-unknown lines), `description` (=title), `locationUnknown`. Sorted location **A–Z, location-unknown LAST**. No eBay call, no `days`, no mutation → `{lines,count,fetched}`.
2. **Frontend `#page-picklist`** → ONE 3-column table **LOCATION · SKU · ITEM DESCRIPTION**, one row per item (new `pickRow` helper). No qty, no buttons, no scan field. location-unknown items grouped at the BOTTOM under a "Location unknown — N item(s)" heading row (never dropped). Refresh + Print buttons stay on-screen but `.no-print`.
3. **`@media print` cleaned** → prints just the 3-column sheet (`#page-picklist` card chrome stripped, `.tw` overflow visible, table full-width with row borders; nav/aside/other pages/`.no-print` hidden as before). Removed the dead `.pick-order` rule.
4. **Removed the dead pick action:** deleted `markPicked` + the Mark-picked button + **`POST /api/pick`** (sole caller confirmed in Step 0). Items are shipped automatically by `reconcileOrderLines` Phase 2 now.

### Verified live (deployed app)
- `/api/picklist`: **count=6 · located=5 · location_unknown=1**; line shape `{location,sku,description,locationUnknown}`. Located lines **sorted A–Z** (BR04S04, DR01S02, ESECTC, HR01S04, HR06S05; sku = bare matched serials FUS3205/ECU0165/EXT869/MOD12549/MOD18509). The 1 unknown (autolumen `MOD19995R`, raw-SKU fallback, location `—`) is **last**. Assertions: `sorted A–Z = true`, `unknown-after-located = true`.
- **`POST /api/pick` → HTTP 404** (route gone). Served HTML has "Item Description", **no "Mark picked"**. `node --check` server.js OK, inline JS OK, `/api/health` 200.
- ⚠️ Print *visual* is structurally correct (CSS + table verified) but the final on-paper look is an architect eyeball — I can't render a print preview headlessly.

**Files touched:** `server.js` (picklist rewrite − pick route; 2 stale comments fixed), `public/index.html` (page markup, `loadPickList`/`pickRow`, removed `markPicked`, print CSS, header text), `SNAPSHOT_ROUTES.md`, `SNAPSHOT_FRONTEND.md`, `HAWKER_SESSION.md`, `HAWKER_CHANGELOG.md`. **No DB change** (read-only route + UI). Net −66 lines of code. Commit `e9de57f`. Throwaway verify scripts deleted. Deploy was slow (~3½ min) but landed healthy.

**Production status:** `hawkerwms.up.railway.app` healthy. Pick List is view+print only; the only ship path is the eBay sync. Counts unchanged (544 loc / 5061 items [3231 STORED + 1830 SHIPPED] / 5167 moves / 14 seq).

### ⏭ Next (rework session 5, final)
**S5:** Shipped Items page — reads `ebay_order_lines` WHERE `disposition='SHIPPED'` (+ `ebay_shipped_time`, store, sku/serial, title). Then the rework is complete.

## 13:53 UTC — Pick List / Shipped rework, Session 3 of 5: ship-move wired INTO the reconcile (the S2-deferred item mutation)

**Single deliverable:** when the reconcile detects an order line is SHIPPED and its matched WMS item is still STORED, it now moves that item STORED→SHIPPED. **Backend only. Triggered by the reconcile, NOT `/api/pick`** (which was left completely untouched — it's slated for removal in the view+print redesign). No Pick List UI work this session. eBay read-only (Rule 25).

### Diagnose-first (Rule 1)
Re-read `reconcileOrderLines` and `POST /api/move` (mirrored its exact audited `BEGIN…COMMIT`: select item → ensure destination location → update item → insert ONE `moves` row).

### STEP 1 — read-only preview (reported before any write)
Listed exactly the items that would move on first activation: **106 distinct STORED items** (driven by 109 SHIPPED lines; 3 serials had 2 driving lines each — each moves once). Every row had a real shelf location, correct SKU→serial normalization (e.g. `CLU0864R`→`CLU0864`, `ECU0245V`→`ECU0245`), a valid `OrderLineItemID`, and a real `ebay_shipped_time` (Mar–May 2026). These are items that sold+shipped on eBay but were still STORED from the 2026-05-27 baseline import. Bounded + sane → proceeded.

### STEP 2 — built (server.js only): `reconcileOrderLines` Phase 2
After the Phase-1 upsert commits, a **ship-move pass**: candidates = items still `STORED` that have ≥1 `SHIPPED` line matched to them (one row per item). For each, ONE audited txn mirroring `/api/move`: `SELECT … FOR UPDATE` re-check `status='STORED'` (guard); ensure `'SHIPPED'` location row exists (FK target, no-op in prod); `UPDATE items SET status='SHIPPED', location='SHIPPED'`; INSERT one `moves` row (`from_location`=prior shelf → `to_location='SHIPPED'`, `moved_by='ebay-sync'`). Authoritative ship time stays on `ebay_order_lines.ebay_shipped_time`; the `moves` row keeps its own insert timestamp. **Idempotent + monotonic:** the STORED guard means a re-sync moves nothing already shipped (no double-move, no dup `moves` row); `location_unknown`/ambiguous lines never move (no `matched_serial`). Reconcile now returns `{upserts, skipped, moved}`.

### Verified live (real syncs against the deployed app, then read-only DB)
- **SYNC 1 (activation): `moved`=106**; **SYNC 2: `moved`=0** (idempotent — no double-move).
- items-by-status: **STORED 3337→3231 (−106), SHIPPED 1724→1830 (+106)**.
- moves: **5061→5167 (+106)**; `moved_by='ebay-sync'` = **106**, **distinct serials = 106** (one row per item; dup-check found **0** serials with >1 ebay-sync row); all 106 `to_location='SHIPPED'`. Moved items now `SHIPPED`@`'SHIPPED'`.
- Sanity: **0** items left STORED-with-a-SHIPPED-matched-line. `node --check` OK; `/api/health` 200.

**Files touched:** `server.js` (reconcileOrderLines Phase 2 + doc comment; the function is no longer "populate-only"), `SNAPSHOT_ROUTES.md`, `HAWKER_SESSION.md`, `HAWKER_CHANGELOG.md`. **DB state changed:** 106 items STORED→SHIPPED@SHIPPED + 106 `ebay-sync` moves rows; `ebay_order_lines` re-affirmed (no structural change). Commit `b8f5c6a`. Throwaway preview/sync/read scripts deleted (Anti-rogue C). **`/api/pick`, `/api/picklist`, frontend — untouched.**

**Production status:** `hawkerwms.up.railway.app` healthy. The eBay orders sync now self-heals WMS inventory: anything sold+shipped on eBay gets marked SHIPPED@SHIPPED in WMS automatically. Counts now 544 loc / 5061 items (3231 STORED + 1830 SHIPPED) / 5167 moves / 14 seq. Warehouse still on the old WMS (cutover pending).

### ⏭ Next (rework sessions 4–5)
**S4:** rebuild the Pick List UI to READ `ebay_order_lines` (disposition=NEEDS_PICK) instead of live-joining; view+print. **S5:** Shipped Items page (reads disposition=SHIPPED + `ebay_shipped_time`). Then **remove `/api/pick`** (its job — shipping items — is now done by the reconcile).

## 13:40 UTC — Pick List / Shipped rework, Session 2 of 5: sync reconcile POPULATES `ebay_order_lines` (populate-only)

**Single deliverable:** the eBay orders sync now UPSERTs `ebay_order_lines`. **POPULATE-ONLY — no `items.status`/`items.location` mutation, no `moves` rows, no `/api/picklist` or `/api/pick` change.** The live Pick List still renders from live orders exactly as before. eBay stays read-only (Rule 25).

### Diagnose-first (read, Rule 1)
Read `fetchStoreOrders`, the order-sync paths (frontend `syncEbayOrders`→`/api/ebay/orders`, `syncStore`→`/api/ebay/:store/orders`; there is **no** server-side scheduled sync), `/api/picklist`, `/api/move`+`/api/pick` (audited-txn pattern to mirror in Session 3), and both `normalizeSkuKey` copies (server `s` / frontend `sku` — bodies functionally identical; reused the server one, changed neither).

### What was built (server.js only)
- **`fetchStoreOrders` extended, additively:** `GetOrders` now sends `DetailLevel=ReturnAll`; each order keeps its existing shape **plus** order-level `paidTime,shippedTime,checkoutStatus,paymentStatus,lastModified` and per-line `orderLineItemId,itemId,transactionId,lineShippedTime`. `/api/picklist`'s consumed shape is untouched.
- **New `reconcileOrderLines(orders)`** UPSERTs by `order_line_item_id` (falls back to `ItemID-TransactionID`; skips a line with neither). Derives: **paid** = OrderStatus Completed ∧ CheckoutStatus.Status Complete ∧ eBayPaymentStatus NoPaymentFailure ∧ PaidTime; **shipped** = order-level ∨ per-line ShippedTime; **cancelled** = OrderStatus Cancelled/CancelPending ∨ (refund flipping a paid order to Incomplete). **disposition**: shipped→SHIPPED; else cancelled→CANCELLED; else paid→NEEDS_PICK; else skip. **Match** `sku_norm`→STORED serial: 1→`matched_serial`; 0/>1→`location_unknown` (>1 ambiguous, never guesses); never drops lines. **Monotonic ON CONFLICT**: never pulls a SHIPPED/CANCELLED/DISMISSED row back to NEEDS_PICK; DISMISSED never overwritten; `shipped`/`paid` sticky-true; times/title/match COALESCE'd; `last_synced=NOW()`. Chunked (500) in one txn.
- **Hooked** into `/api/ebay/orders` (all stores) and `/api/ebay/:store/orders` (upsert-only → other stores untouched). Reconcile failure is isolated (`errors.reconcile`) and never breaks the sync.

### Bug found in verification + fixed (honest record)
First live sync wrote 1922 rows but **`paid=false` on every row → 0 NEEDS_PICK**. Diagnosis (raw-XML peek): I'd parsed order-level fields from the "head" (before `<TransactionArray>`) to avoid transaction contamination — correct for `CheckoutStatus` (which IS in the head) but **`PaidTime`/`ShippedTime` live AFTER `<TransactionArray>`**, so both came back null. Fix: parse those two from the whole block; keep `CheckoutStatus.*` from the head. (`shipped` had been fine — it already read the whole block.)

### Verified live (real sync against the deployed app, then read-only DB)
Logged into prod, triggered `/api/ebay/orders?days=90`: **1929 orders fetched** (dynatrack 1637 / autolumen 292), no errors, **1928 lines upserted, 1 skipped**. `ebay_order_lines` now:
- **disposition: NEEDS_PICK 6 · SHIPPED 1849 · CANCELLED 73** (total 1928). paid 1850 · shipped 1849.
- **NEEDS_PICK (the actionable bucket): 6 — all paid+unshipped; 5 matched to a STORED serial, 1 `location_unknown`** (autolumen MOD19995R, flagged not dropped).
- **location_unknown 1790** (SHIPPED lines match nothing because their items are no longer STORED — expected); **ambiguous (>1) = 0** (no normalized-serial collisions currently; the path is implemented). null-sku 2. matched 138.
- Spot-checked rows against eBay item IDs (e.g. `ECU0245V`→serial `ECU0245`); `node --check` OK; `/api/health` 200.

**Files touched:** `server.js` (fetchStoreOrders + reconcileOrderLines + 2 route hooks; +PaidTime fix), `SNAPSHOT_ROUTES.md`, `SNAPSHOT_SCHEMA.md` (table now written, still not read), `HAWKER_SESSION.md`, `HAWKER_CHANGELOG.md`. **DB state changed = `ebay_order_lines` rows only** (no items/moves). Commits: `f39a22b` (reconcile) → `19402dd` (PaidTime fix). Throwaway sync/read/peek scripts deleted (Anti-rogue C). No frontend change.

**Production status:** `hawkerwms.up.railway.app` healthy; existing behavior unchanged (reconcile is a transparent side-effect of the orders sync). Items/locations/moves untouched (544/5061/5061/14).

### ⏭ Next (rework sessions 3–5)
**S3:** rebuild `/api/picklist` (and add a Shipped read) to READ `ebay_order_lines` instead of live-joining; mirror the `/api/move` audited txn so `/api/pick` updates the line's disposition→SHIPPED and (backlog #5) moves the item into the real `'SHIPPED'` location. **S4:** view+print Pick List off the table. **S5:** Shipped Items page.

## 13:17 UTC — Pick List / Shipped rework, Session 1 of 5: `ebay_order_lines` schema migration (additive; no app-code change)

**Single deliverable:** added the backbone table for the Pick List / Shipped Items rework via a new migration and applied it to live prod. **No `server.js` / `public/index.html` / `/api/picklist` / `/api/pick` changes this session** — the sync that populates this table and the view/print/Shipped-page reads are later sessions (2–5).

### Diagnose-first (read-only, Rule 1) — live prod before writing
- Counts: **544 loc / 5061 items / 5061 moves / 14 seq** (matches the import baseline).
- `items.status` in use: **`STORED` (3337) + `SHIPPED` (1724)** — no `STAGED_UNLISTED` rows (staging already empty; formal removal still backlog #4).
- **`'SHIPPED'` location row already exists** (id 2713, type `SHIPPED`, created by the baseline import) → the migration's ensure-row is a no-op; nothing created.
- `ebay_order_lines` did not exist → safe to create.

### What was built
- **New file `db/migrations/0001-ebay-order-lines.sql`** (first entry in `db/migrations/`, which didn't exist before). Per Rule 9 the change is a migration file; **`db/schema.sql` was NOT edited in place.**
- Table **`ebay_order_lines`**, **PK = `order_line_item_id`** (eBay `OrderLineItemID` = `<ItemID>-<TransactionID>` — never keyed on `OrderID`). 17 columns per the brief: `store`, `ebay_item_id`, `ebay_transaction_id`, `sku_raw`/`sku_norm` (nullable), `title` (nullable), `paid`+`paid_time`, `shipped`+`ebay_shipped_time`, `matched_serial` (nullable soft pointer — **not** an FK, like `moves.serial`), `location_unknown`, `disposition` (**CHECK** ∈ NEEDS_PICK/SHIPPED/CANCELLED/DISMISSED, default NEEDS_PICK), `first_seen`, `last_synced`, `ebay_last_modified` (nullable). 5 secondary indexes (store, disposition, sku_norm, matched_serial, ebay_item_id).
- Migration is **idempotent/additive**: `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, and `INSERT … 'SHIPPED' … ON CONFLICT (name) DO NOTHING`.

### Applied to live prod + verified
Run via the public TCP proxy (`railway run --service Postgres`, same plumbing as the import). Post-apply independent read: table present with all 17 columns/types/nullability/defaults as specified; CHECK constraint present; 6 indexes (pkey + 5); `'SHIPPED'` location still 1; **row counts UNCHANGED 544/5061/5061/14**; `/api/health` **200** `db:connected`. Table is **created empty — not populated or wired to any route yet.**

**Files touched:** `db/migrations/0001-ebay-order-lines.sql` (new), `SNAPSHOT_SCHEMA.md` (regenerated — added the `ebay_order_lines` section + migrations note + revised the "no eBay tables" absence), `HAWKER_SESSION.md`, `HAWKER_CHANGELOG.md`. DB state changed (new empty table only). No app code/frontend/route change; no `schema.sql` edit. Throwaway diagnostic/apply scripts were used and deleted (no new committed scripts — Anti-rogue C).

**Production status:** `hawkerwms.up.railway.app` healthy; behavior unchanged (new table is dormant). Build baseline still 544/5061/5061/14; warehouse still on the old WMS (cutover pending).

### ⏭ Next (rework sessions 2–5, NOT this session)
Sync that reconciles eBay sold lines into `ebay_order_lines` (upsert on `order_line_item_id`, set `sku_norm`/`matched_serial`/`location_unknown`/`disposition`); rebuild `/api/picklist` to read this table; view+print Pick List; new Shipped Items page. The pick flow moving items into the real `'SHIPPED'` location (backlog #5) ties in here.

## 12:34 UTC — Research-report gap analysis folded into the Build Plan (documentation only)

**Single deliverable:** appended a **"Research-Report Gap Analysis & Open Questions"** subsection to the Confirmed Workflow & Build Plan (the 01:37 entry below) and folded the enhancement candidates into its prioritized backlog as **#20–#25** (reconciled with existing items — cross-referenced, not duplicated). **No code/schema/DB/new files.**

- **🔴 Open question recorded (needs Ry):** does the business **dismantle donor vehicles** or **source individual parts**? If individual parts, the report's donor-vehicle/VIN/Hollander/core-charge model is OUT — **gates the condition-grade/fitment item (#24).**
- **Enhancement candidates (NOT cutover blockers), prioritized:** [HIGHEST] **double-sell prevention across the two stores** (extends the existing read-only Cross-listed detection) · **scan-to-verify at pick** (bolt-on to the built Pick List) · **returns/RMA** (folds into #10 soft-archive) · **photo-at-intake** (folds into #7 new-item intake) · **condition-grade/fitment** (gated on the donor-vehicle question) · [lowest] **ABC cycle counting + aging report**.
- **Deliberate divergences recorded (conscious, NOT gaps):** eBay stays read-only (vs the report's WMS-writes-listings); one shared login (vs per-user roles — the `moves.moved_by` audit log can't attribute actions to individuals).

**Files touched:** `HAWKER_SESSION.md` (this entry + the Build-Plan subsection/backlog edits), `HAWKER_CHANGELOG.md`. No app code/schema/DB/new files; no SNAPSHOT regen. Cutover status unchanged (build baseline live; final same-day extract+import still pending).

**Production status:** unchanged — documentation only; `hawkerwms.up.railway.app` healthy.

## 07:39 UTC — Final import (#3) Phase 2: REAL import COMMITTED ✅ (build baseline; NOT cutover)

**Single deliverable:** ran the real baseline import (`scripts/import-baseline.mjs --commit`) — clean reload of `wms-full-backup.json` into live prod. **This is the BUILD baseline so we develop against true data; it is NOT the cutover** (warehouse still on the old WMS; a final same-day extract+import is still required at go-live — re-run this same script).

### Gate honored
The approval was conditional on a Railway Postgres **snapshot**. The approval message didn't include the confirmation, so I asked and **Ry confirmed the snapshot was taken (UI)** before I ran `--commit`. (Belt-and-suspenders: the script also wrote its own commit-time pre-export rollback artifact.)

### FLAG decisions applied
- **FLAG 1:** the 59 tracking-number serials imported **as-is, flagged, excluded from the sequence calc** (not fixed — real serials unknown, all already SHIPPED). They are flagged records in the SHIPPED location.
- **FLAG 2 (b):** added `DELETE FROM sequences` to the reload so sequences rebuild to **exactly the 14** computed prefixes (not the 17 union). The ~5 typo prefixes (M/MFD/MOMD/EOD/RYN) were NOT hand-curated — the table is vestigial, slated for removal in the dead-serial-infra cleanup.

### The --commit run
Fresh **pre-export** written (`~/hawker-preexport-2026-05-29T07-37-32-150Z.json`, gitignored — the rollback artifact). **Abort-guard re-checked and PASSED** (all 3969 prior prod moves were `moved_by='dynatrack'` test). Transactional FK-safe reload → **COMMITTED**. Deltas: −537/−3380/−3969/−12 → +544/+5061/+5061/+14.

### Post-import verification (independent fresh read — Rule 27) ✅
- **locations = 544** (522 SHELF_BIN + 21 UNLISTED_TOTE + 1 SHIPPED)
- **items = 5061** (3337 STORED + 1724 SHIPPED)
- **moves = 5061**, all `moved_by='import-baseline'`
- **sequences = 14** · **FK orphan item.location = 0**
- 59 garbage (≥20-digit tracking-number) serials present + flagged; 1724 items in the SHIPPED location · `/api/health` 200 (app healthy).

**Files touched:** `scripts/import-baseline.mjs` (FLAG-2 one-line change: clear sequences before rebuild), `HAWKER_SESSION.md`, `HAWKER_CHANGELOG.md`. **DB state changed (the import).** No app code/schema change (locations.type column already existed); no SNAPSHOT regen.

### ⏭ Follow-ups (delta from the 01:37 Confirmed Workflow entry)
- **#3 evolves:** the **build baseline is imported (2026-05-29)**; the **final cutover extract+import is still required at go-live** — take a fresh same-day extract, re-run `import-baseline.mjs --commit` (idempotent clean reload; abort-guard will protect once real non-test scans exist), then stop using the old WMS.
- **Rollback path:** restore the confirmed Railway snapshot, or re-load `~/hawker-preexport-2026-05-29T07-37-32-150Z.json` (it's just another clean reload of the prior state). Artifact is local + gitignored.
- All other follow-ups unchanged (Fix Locations detail [HIGH], staging removal, pick→SHIPPED-location, Scan&Move dual+Zebra, intake, unlisted, totes dashboard split, soft-archive, per-part history, persistent session store [top hardening], centralize normalizeSkuKey, dead serial-infra cleanup incl. the now-vestigial sequences/typo-prefixes, etc.).

**Production status:** `hawkerwms.up.railway.app` — DB is now the **2026-05-27 extract baseline** (544 loc / 5061 items / 5061 moves / 14 seq); app healthy. Build/test data is realistic. **Not live to the warehouse yet** (cutover pending).

## 07:23 UTC — Final import (#3) Phase 1: import script + pre-export + DRY-RUN (NO commit) → awaiting approval

**Single deliverable (Phase 1):** wrote the one-off `scripts/import-baseline.mjs`, ran the read-only **PRE-EXPORT**, and ran the **DRY-RUN** (`BEGIN…compute…ROLLBACK`). **No real COMMIT / no persistent DB write.** All locked decisions baked in (Option B clean reload; SHIPPED collapse; `locationType`→`type`; synthetic `import-baseline` moves; sequences recompute; flag garbage serials; skip auth/ebay/derived).

### Plumbing (important for cutover)
`railway run` on the app service injects only the **internal** `DATABASE_URL` (`postgres.railway.internal`) — unreachable from a dev box. The script connects via the **public TCP proxy**: run with **`railway run --service Postgres node scripts/import-baseline.mjs`** (injects `DATABASE_PUBLIC_URL` = `interchange.proxy.rlwy.net:13701`). Baked into the script (`DATABASE_PUBLIC_URL || DATABASE_URL`) + header. SSL `{rejectUnauthorized:false}`.

### Safety guards (all verified working)
- **DRY-RUN by default** (rollback); real write requires `--commit`.
- **ABORT GUARD passed:** all 3969 current prod moves are `moved_by='dynatrack'` (test) — in the safe set → confirms prod is pure test/seed (nothing real). The guard REFUSES a clean-reload if any non-safe (real human) marker appears, unless `--override-abort-guard` — protects against a post-go-live wipe.
- **PRE-EXPORT** rollback artifact → `~/hawker-preexport-<ts>.json` (gitignored, NOT committed). Fixed a pre-export pg parallel-query bug (now sequential).
- Transactional FK-safe reload (delete moves→items→locations; bulk-insert locations→items→moves→sequences, chunked).

### DRY-RUN result (rolled back — no change)
- Current prod: 537 loc / 3380 items / 3969 moves / 12 seq.
- DELETE 537 loc / 3380 items / 3969 moves → INSERT 544 loc / 5061 items / 5061 moves / 14 seq.
- **End-state EXACTLY as predicted (Rule 27): 544 locations** (522 SHELF_BIN + 21 UNLISTED_TOTE + 1 SHIPPED), **5061 items = 3337 STORED + 1724 SHIPPED**, 5061 synthetic baseline moves, **FK orphans = 0**, 0 referenced-missing locations.

### ⚠ Flags for approval (decide before Phase 2 `--commit`)
1. **59 "garbage" serials (not 1), ALL in SHIPPED locations** — 22–30-digit USPS/UPS tracking-number format (9405…/9434…/9400…/4202…): ~59 shipped items were scanned with the **shipping-label barcode** as their serial. Imported + flagged + excluded from sequences (decision #6). Low stakes (already shipped) but **recommend reviewing/cleaning**; not real part serials.
2. **Sequences end at 17, not 14** — the reload clears moves/items/locations but **not `sequences`**, so prod's 12 prefixes ∪ 14 computed = 17; and the 14 computed include ~5 likely-typo prefixes (`M`, `MFD`, `MOMD`, `EOD`, `RYN` from malformed serials). Sequences are **vestigial** (serials minted externally), so harmless — but for Phase 2 choose: (a) leave as-is, (b) `DELETE FROM sequences` first (clean = only the 14), or (c) restrict to a known prefix allow-list. Recommend (b) or (c).

**Files:** `scripts/import-baseline.mjs` (new, committed — NOT app-wired), `.gitignore` (new — guards node_modules/lockfile/.env/pre-export), `HAWKER_SESSION.md`, `HAWKER_CHANGELOG.md`. Reverted an accidental `pg` version bump in package.json from `npm install`. No app code/schema/DB writes; no SNAPSHOT regen (app surface unchanged). Open follow-ups unchanged from the 01:37 Confirmed Workflow entry + the two flags above.

**NEXT (Phase 2 — awaiting approval):** (1) architect takes a Railway Postgres snapshot (UI); (2) real run `railway run --service Postgres node scripts/import-baseline.mjs --commit`; (3) post-import verification (Rule 27 counts). Plus your calls on flags 1 & 2.

**Production status:** unchanged — DRY-RUN only, rolled back; `hawkerwms.up.railway.app` healthy (537 loc / 3380 items still live).

## 01:37 UTC — Confirmed Workflow & Build Plan (documentation only — no code/schema/DB)

**Single deliverable:** persist the confirmed daily workflow, device/scanner requirement, locked decisions, build backlog, and parked to-dos as the durable reference for the build sessions ahead. **No code, schema, DB writes, or new files this session.** Reconciled with prior follow-up snapshots (this entry's PENDING list supersedes them; old entries left as historical record).

### Confirmed daily workflow
clean part → photograph it with its SKU → put on a shelf or in a tote (**STORED**) → list on eBay (**done in eBay, not HawkerWMS**) → it sells → **print the pick list** → ship via **ShippingEasy** (separate/manual). **HawkerWMS does NOT integrate with ShippingEasy and does NOT write to eBay** (read-only, Rule 25).

### Device & scanner (cross-cutting requirement for EVERY scan field)
- Ops run on an **11" HOTWAV R9 Pro rugged Android 14 tablet (1200×1920)**. Existing tablet UI fits — **no handheld/small-screen responsive rework needed**.
- Input is a **Bluetooth Zebra handheld scanner paired as an HID keyboard** (configured with a **CR/Enter suffix**). Every scan field (Scan & Move both modes, intake, pick, locations) must: capture rapid keystrokes, **fire on the Enter/CR terminator**, **auto-refocus** the field after each scan (batch mode depends on it), and **suppress the Android soft keyboard while keeping focus**.

### Locked decisions
1. **Staging removed entirely.** Remap existing `STAGED_UNLISTED` → `STORED`, then drop the value from the status set + all UI. **Rule 11 becomes: statuses = `STORED` and `SHIPPED` only.** Remove the Inventory Health "Staging excluded" line + Staging stat card.
2. **"Shipped" is a LOCATION, not a status** (mirrors old WMS SHIPPED/SHIPPED-1). Use ONE location named **`'SHIPPED'`**. **Revise `POST /api/pick`:** instead of `location=NULL` + sentinel, move the item INTO the `'SHIPPED'` location (status `SHIPPED`, `location='SHIPPED'`, one moves row `to_location='SHIPPED'` — now a REAL location). Ensure the `'SHIPPED'` location row exists. *(Supersedes the sentinel implementation shipped 2026-05-28.)*
3. **Totes are real and distinct from shelves.** Locations need a **TYPE** (tote vs shelf); dashboard splits **"Items in Totes" vs "Items Stored"** (like old WMS). **Schema change — design AFTER the import diagnosis** reveals how the old data tags totes/shelves.
4. **Scan & Move needs BOTH** a batch mode (scan many → one destination → confirm) and a single-item mode.
5. **New-item intake:** scanning an **unknown serial CREATES** the item; **location is OPTIONAL** (a part may be scanned in with no location).
6. **"Unlisted" section** = a dedicated view of the Inventory Health **WMS-Only** set (on shelf, not on eBay). Caveat: can't distinguish "deliberately unlisted" from "never listed".
7. **One shared login** (no per-user accounts). **No offline mode.** eBay stays **read-only**.

### New features to build (none built yet)
- **[HIGH] Fix Locations detail view** — clicking a location must reveal the parts scanned into it (currently broken). Makes the SHIPPED-location "abyss" + tote/shelf browsing usable.
- **New-item intake** (decision 5). · **Unlisted section** (decision 6).
- **Scan & Move dual modes + Zebra/BT robustness** (decision 4 + device requirement).
- **Totes location-type + dashboard split** (decision 3 — post-import). · **Revise pick flow → SHIPPED location** (decision 2).
- **Soft-archive** (existing Briefs 3a/3b) for removing non-shipped items (damaged/scrapped), history retained — complements the SHIPPED location.

### Parked to-dos
- Every part needs full **"when + where scanned" history** (esp. imported/uncaptured items).
- **"More intelligence around sold parts"** (firms up after SHIPPED-location + history land).
- Centralize the duplicated `normalizeSkuKey`. · Dead serial-infra cleanup. · Hardening (see follow-ups).

### Cutover note
Warehouse is **STILL on the old WMS**. Prod = the 2026-04-02 seed + test scans only. **Real cutover needs a FINAL same-day extract + import, then stop using the old system.** The upcoming import loads realistic data so we build against the true data shape.

### Research-Report Gap Analysis & Open Questions (appended 2026-05-29 12:34 UTC)
WMS research report vs HawkerWMS's confirmed scope. **None of these are cutover blockers.**

**🔴 OPEN QUESTION (UNRESOLVED — needs Ry):** Does the business **dismantle donor vehicles** or **source individual parts**? If individual parts, the report's largest section — **donor-vehicle/VIN parent model, Hollander interchange, VIN decode, core charges** — **does NOT apply**, and the condition-grade/fitment work below is dropped. **This gates the grading/fitment items.**

**Enhancement candidates (prioritized; NOT cutover blockers):**
- **[HIGHEST VALUE] Double-sell prevention across the two stores (Dynatrack + AutoLumen)** — the report's single most important rule for one-of-one items. Today Inventory Health only *surfaces* the risk (read-only Cross-listed bucket); *actively preventing* a double-sale is the future feature. Builds on existing Cross-listed detection.
- **Scan-to-verify at pick** — a "scan to confirm" step on the Pick List before it flips to SHIPPED (biggest single shipping-error catcher). Cheap bolt-on to the existing pick flow.
- **Returns / RMA flow** — log return → re-inspect → relist or scrap. Dovetails with soft-archive.
- **Photo-at-intake** — basic photo step in the new-item intake screen (tablet has a 64MP camera). eBay listing photos still done in eBay.
- **Condition grade + fitment fields per item** — only if it maps to how they sell; **gated on the donor-vehicle question above.**
- **[LOWEST] ABC cycle counting + inventory-aging report.**

**Deliberate divergences from the report (conscious choices, NOT gaps):**
- **eBay stays read-only** — the report assumes the WMS creates/updates listings; here ShippingEasy + eBay handle fulfillment, and HawkerWMS never writes to eBay (Rule 25).
- **One shared login** — the report assumes per-user roles; accepted tradeoff that the audit log (`moves.moved_by`) can't attribute actions to individuals.

**Files touched:** `HAWKER_SESSION.md` (this entry), `HAWKER_CHANGELOG.md`. No app code, schema, or DB writes.

### ⏭ PENDING FOLLOW-UPS (reconciled — supersedes prior snapshots)
**Cutover blockers (architect tasks):**
1. **#2 Hands-on testing** — incl. the 2026-05-28 Pick List mark-picked happy-path + print, on the HOTWAV tablet + Zebra scanner.
2. **#3 Final same-day extract + import** from the old WMS, then stop using it (cutover).

**Build backlog (rough priority):**
3. **[HIGH] Fix Locations detail view** (parts-in-location).
4. **Staging removal** (remap STAGED_UNLISTED→STORED; Rule 11 → STORED/SHIPPED only; drop Staging UI) — decision 1.
5. **Pick flow → SHIPPED location** (revise POST /api/pick; ensure 'SHIPPED' location) — decision 2; supersedes the current sentinel.
6. **Scan & Move dual modes + Zebra/BT HID robustness** (all scan fields) — decision 4 + device.
7. **New-item intake** (create on unknown serial; optional location) — decision 5.
8. **Unlisted section** (WMS-Only view) — decision 6.
9. **Totes location-type + dashboard tote/shelf split** — decision 3 (post-import; schema change).
10. **Soft-archive** non-shipped removals (damaged/scrapped), history retained (Briefs 3a/3b).
11. **Per-part full scan history** (when + where), esp. imported items.
12. **"More intelligence around sold parts"** (after SHIPPED-location + history).

**Tech-debt / hardening:**
13. **Persistent (Postgres) session store** — TOP hardening priority (in-memory Map logs everyone out on each deploy).
14. **Centralize `normalizeSkuKey`** (server.js + frontend copies must stay byte-identical until then).
15. **Dead serial-infra cleanup** — orphaned `POST /api/sequences/next/:prefix` + `GET`/`POST /api/print-log`; reconsider the Admin Serial Sequences view (serials minted externally).
16. **Persist eBay listings server-side** (`ebay_listings`; replaces in-memory `ALL_LISTINGS`).
17. **Remove the `[Inventory Health]` DIAGNOSTIC console.log** once the blank-page bug is confirmed via real use.
18. **Retire legacy un-prefixed `TRADING_API_*`** env vars once multi-store is proven stable.
19. **eBay token-expiry calendar** (two tokens).

**Enhancement candidates (post-cutover — WMS research report; NOT blockers; see the Gap Analysis subsection above):**
20. **[HIGHEST] Double-sell prevention across stores** — extend the existing Cross-listed detection from surface-only → actively prevent a double-sale of a one-of-one item.
21. **Scan-to-verify at pick** — "scan to confirm" before SHIPPED; bolt-on to the built Pick List.
22. **Returns / RMA flow** — log → re-inspect → relist/scrap; **folds into #10 (soft-archive)**.
23. **Photo-at-intake** — **folds into #7 (new-item intake)**; tablet 64MP camera (eBay photos still in eBay).
24. **Condition grade + fitment fields** — **GATED on the donor-vehicle question** (dropped entirely if "individual parts").
25. **[LOWEST] ABC cycle counting + inventory-aging report.**

*(Folded: the 2026-05-28 "12 location-unknown pick lines" observation → #11/#2; it reflects sold SKUs with no WMS item, expected until the final import. #8 broader Drive cleanup remains open but is low priority post-rename. The report's donor-vehicle/VIN/Hollander/core-charge model is OUT unless Ry confirms vehicle dismantling (gates #24); eBay-read-only and one-shared-login are deliberate divergences, not gaps.)*

**Production status:** unchanged — `hawkerwms.up.railway.app` healthy; docs-only, nothing deployed (Railway redeploys on push, no code delta).

# 2026-05-28

## 23:12 UTC — Build Print & Pick List (sold-but-unshipped → WMS locations, mark-picked → SHIPPED) ✅

**Single deliverable:** the Print & Pick List feature, per the prior session's approved proposal. Backend (server.js) + frontend (public/index.html). **No schema migration** (none needed). READ-ONLY to eBay (Rule 25).

### Pre-build safety checks (decision #4) — passed
- No location named `'SHIPPED'` (verified live: 537 locations, 0 match). `moves.to_location` is `NOT NULL` but **has no FK** and **nothing joins it to `locations`** (grepped) → using `'SHIPPED'` as a sentinel in `moves.to_location` is safe and won't break any query.

### Backend (server.js)
- **`fetchStoreOrders` (504):** now parses eBay **`ShippedTime` → `shipped` boolean** (present = shipped); keeps `OrderStatus`. (Harmlessly also surfaces on `/api/ebay/orders`.)
- **`GET /api/picklist` (623):** both stores' orders where **`shipped=false && status!=Cancelled`**, each line joined to its WMS item's shelf location via **server-side `normalizeSkuKey` (617)** (Rule 8 — byte-identical to the frontend copy, commented). No-WMS-match lines → **`locationUnknown:true`, NEVER dropped**; already-SHIPPED matches → dropped. Grouped one order/package, lines sorted by location. Per-store failures isolated.
- **`POST /api/pick {serial}` (678):** one `BEGIN…COMMIT` mirroring `/api/move` — `UPDATE items SET status='SHIPPED', location=NULL` + INSERT exactly **one** `moves` row (`from_location`=prior shelf, `to_location='SHIPPED'` SENTINEL, `moved_by='dynatrack'`). 404 if serial unknown.

### Frontend (public/index.html, single file, no libraries)
- New **"Pick List" nav** entry (eBay group, after Orders) + **`#page-picklist`**: one card per order, lines sorted by location; each line shows location (or **"location unknown"** badge) / serial / SKU / qty + a **Mark picked** button (`markPicked` → `POST /api/pick` → re-render so the line drops off). A **Print** button (`printPickList` → `window.print()`).
- **`@media print`** block hides `nav`/`aside`/other pages/`.no-print` and shows only the active sheet (`.pick-order` avoids page breaks).

### Verification (Rule 17)
- `node --check server.js` OK; inline `<script>` compiles clean (`vm`, 0 errors). Pushed `f54b01b`; live ~20s; `/api/health` 200. Pick List strings present in served HTML; 9 nav targets == 9 `.page` divs.
- Authed (via Railway-injected creds): **`/api/picklist` → 17 unshipped orders** (dynatrack 15 / autolumen 2), no errors; **12 lines flagged `location-unknown`** (≈ the ~424 uncaptured-items tech debt — correctly surfaced, not dropped). **`/api/pick` bogus serial → 404** (route wired, **no mutation**).
- ⚠️ **NOT done by me (flag for architect):** the real **mark-picked happy-path** (a genuine matched line → SHIPPED + moves row + drop-off) and the **visual print** — I deliberately did **not** mutate real inventory / write a permanent (append-only, Rule 13) moves row on prod for a test. Code mirrors `/api/move`'s audited txn + the 404 path is verified; please confirm the live happy-path + print on a real matched order.

**Files touched:** `server.js`, `public/index.html`, `SNAPSHOT_ROUTES.md`, `SNAPSHOT_FRONTEND.md`. No schema/`db/`.

**⏭ PENDING FOLLOW-UPS:** #2 hands-on testing (now incl. the mark-picked happy-path + print) · #3 final data extract · #5 eBay token expiry · #8 broader Drive cleanup · retire legacy un-prefixed `TRADING_API_*` · persist eBay listings server-side (`ebay_listings`) · remove `[Inventory Health]` DIAGNOSTIC log · persistent (Postgres-backed) session store · delete orphaned `POST /api/sequences/next/:prefix` + `GET`/`POST /api/print-log` · **NEW: centralize `normalizeSkuKey` (now duplicated in server.js + the frontend `loadInventoryHealth` — must stay byte-identical until then)** · **NEW (data quality): the 12 location-unknown pick lines** reflect sold SKUs with no WMS item — expected per tech debt, but worth a pass during hands-on testing.

**Cutover context (unchanged):** remaining blockers are **#2 hands-on testing** and **#3 final data extract** — architect tasks.

**Production status:** `hawkerwms.up.railway.app` healthy — `/api/health` 200; Pick List live (read + route-wiring verified).

## 22:56 UTC — Remove Import CSV from Dashboard / eBay Orders / eBay Listings (CSV upload retired) — frontend only ✅

**Single deliverable:** remove the "Import CSV" controls from the three pages. CSV upload is retired entirely. **Frontend only** (`public/index.html`); no server/db/schema changes. **Export CSV left entirely alone.**

### Diagnosis (Rule 1)
- **Controls removed:** Dashboard **"Quick Import" card** (promoted CSV import); eBay Orders + eBay Listings **`<label>Import CSV<input type="file" accept=".csv">`** buttons.
- **JS removed (import-only):** `importOrdersCSV`, `importListingsCSV`, and their shared helper **`parseCSV`** (no other callers — confirmed). Kept the shared `ORDERS`/`ALL_LISTINGS` state + `renderOrders`/`renderListings`/`syncEbay*`.
- **No orphaned backend route:** CSV import was **fully client-side** (`FileReader` → in-memory arrays); the importers never POSTed to the server, so **no upload route exists** to orphan. (Export routes untouched.)
- **Copy reworded** so no import-CSV strings remain: Orders/Listings empty-table messages + the `renderOrders` fallback ("…import a CSV from eBay Seller Hub" → "…click Sync Live Orders/Listings"), the Inventory Health summary default (dropped the "Import …CSV first" sentence), and the section comment.
- Minor: de-gridded the Dashboard eBay block (`g2`→plain div) so the per-store status card isn't left half-width after the card removal. Export CSV (Admin items/locations/moves + Inventory Health Export CSV) verified intact.

### Verification (Rule 17)
- Pushed `de4d92f` (1 file, **83 deletions / 6 insertions**). Live by ~30s. `/api/health` 200. Served HTML: **all import-CSV strings gone** (`Import CSV`, `importOrdersCSV`, `importListingsCSV`, `function parseCSV`, `accept=".csv"`, `Quick Import`); **Export CSV still present** (`Export Items CSV`, `exportCSV(`, `exportHealthCSV(`, "Export CSV" ×1). Other pages intact; inline `<script>` compiles clean (`vm`, 0 errors).

**Files touched:** `public/index.html`, `SNAPSHOT_FRONTEND.md`. No backend.

**⏭ PENDING FOLLOW-UPS:** #2 hands-on testing · #3 final data extract · #5 eBay token expiry (two tokens) · #8 broader Drive cleanup · retire legacy un-prefixed `TRADING_API_*` once multi-store stable · persist eBay listings server-side (`ebay_listings` table) · remove `[Inventory Health]` DIAGNOSTIC log after blank-page confirmed fixed · persistent (Postgres-backed) session store · decide whether to delete the orphaned `POST /api/sequences/next/:prefix` + `GET`/`POST /api/print-log` routes (from the Labels removal).

**Cutover context (unchanged):** remaining blockers are **#2 hands-on testing** and **#3 final data extract** — architect tasks. Next session ideally focuses on those, not more code.

**Production status:** `hawkerwms.up.railway.app` healthy — `/api/health` 200; Import CSV gone from all three pages, Export CSV working, all pages load.

## 22:31 UTC — Remove the Labels page (dead UI) — frontend only ✅

**Single deliverable:** remove the Labels page. Locked context: serials/barcode labels are minted/printed in a **separate external system** and scanned in (intake = the Scan flow), so the HawkerWMS Labels page was never used. **Frontend only** (`public/index.html`); no server/db/schema changes.

### Diagnosis (Rule 1)
- **Removed:** nav entry (`data-page="labels"`), the `#page-labels` section, the `navigate('labels')` hook, and the **5 Labels-only functions** — `loadLabels`, `renderSeqDisplay`, `updateLabel`, `autoSerial`, `printLabel`.
- **Two cross-deps cleaned (would otherwise dangle/throw):** (1) the **init top-level line set `#lp-date`** (lived inside page-labels) → would throw at load → removed it; (2) **Admin's `editSeq`/`addSeq` each called `loadLabels()`** (to refresh the Labels prefix dropdown) → removed just those calls, `loadAdmin()` kept.
- **Kept (shared):** `var seqData` (used by Admin's Serial Sequences section). Left the now-dead `.lp*` label-preview CSS (harmless).

### Orphaned backend routes (REPORTED ONLY — server.js untouched, per brief; for a separate later decision)
With Labels gone, **`POST /api/sequences/next/:prefix`** (only `autoSerial` called it) and **`GET`+`POST /api/print-log`** (only `loadLabels`/`printLabel`) have no remaining frontend caller. **`GET/POST/PATCH /api/sequences`** are still used by Admin's Serial Sequences section — NOT orphaned.

### Verification (Rule 17)
- Pushed `477de6b` (1 file, **106 deletions**). Live by ~30s. `/api/health` 200. Served HTML: all Labels strings **gone** (`data-page="labels"`, `id="page-labels"`, `function loadLabels`, `>Labels<`, `p === 'labels'`). Other pages intact (8 nav targets == 8 `.page` divs: dashboard/scan/locations/inventory/ebay/listings/admin/health). Inline `<script>` compiles clean (`vm`, 0 errors).

**Files touched:** `public/index.html`, `SNAPSHOT_FRONTEND.md`. No backend.

**⏭ PENDING FOLLOW-UPS:** #2 hands-on testing · #3 final data extract · #5 eBay token expiry (two tokens) · #8 broader Drive cleanup · retire legacy un-prefixed `TRADING_API_*` once multi-store stable · persist eBay listings server-side (`ebay_listings` table) · remove `[Inventory Health]` DIAGNOSTIC log after blank-page confirmed fixed · persistent (Postgres-backed) session store · **NEW: decide whether to delete the now-orphaned backend routes** `POST /api/sequences/next/:prefix` + `GET`/`POST /api/print-log` (and the print-log table / "sequences" minting if truly unused) — frontend no longer calls them after the Labels removal. *(Open — separate decision.)*

**Cutover context (unchanged):** remaining blockers are **#2 hands-on testing** and **#3 final data extract** — architect tasks. Next session ideally focuses on the testing checklist + extract plan, not more code.

**Production status:** `hawkerwms.up.railway.app` healthy — `/api/health` 200; Labels page gone, all other pages load.

## 21:59 UTC — Fix false "DB Error" status indicator (honest DB-health dot) + admin moves 401 — frontend only ✅

**Single deliverable:** the top status dot showed red "DB Error" on load/sign-in even when the DB was healthy (`/api/health` → `db:"connected"`), clearing only after an eBay sync. **Frontend only** (`public/index.html`); no server/db/schema changes (confirmed none needed — no auth race).

### Diagnosis (reported + approved before patching)
- **Root cause (Part A, indicator logic):** the top dot is global shared state. **`setSyncErr()` hardcoded the text to "DB Error"** and was called from **9 generic `catch` blocks** (dashboard, the 3 eBay sync funcs, inventory health, locations, move, …) — so **any** failure (eBay hiccup, 401, network) showed as "DB Error" though the DB was fine. The dot **never consulted `/api/health.db`**. Last-write-wins + a later successful eBay sync (`setSynced`) flipped it green → exactly the "clears after Listings/Orders" behaviour.
- **The 401s:** (1) **CONFIRMED bug** — `loadAdmin`'s `fetch('/api/moves?limit=10000')` was a **bare fetch with no `x-wms-token`** → always 401 + blank move-count (its `catch` was empty, so not the indicator cause, but a real bug + one of the observed 401s). (2) The `/api/items` 401s = a **stale in-memory-session token** (server `sessions` Map is wiped on every restart/deploy — and we deployed many times today); `requireAuth` correctly 401s an unknown token. **No auth race:** `createToken` commits to the Map *before* returning the token (server.js:27); `validateToken` is synchronous. So no race fix was warranted.

### Fix
- **Part A — honest indicator:** new **`refreshDbStatus()`** hits `/api/health` (public, never 401) and drives the dot from the `db` field → **Live / DB Error (only when `db≠connected`) / Offline**; called on init + after sign-in. **`setSyncErr(err)`** now classifies: 401/"session expired" → amber **"Session expired"** (`.sync-dot.warn`); any other failure → defers to `refreshDbStatus()` (a failed eBay sync with a healthy DB stays "Live" — surfaced via toast + per-store cards, not the DB dot). All **9 catch sites pass the error**; the Inventory Health empty-state now calls `refreshDbStatus()` (empty listings ≠ DB error); `loadDashboard` toast reworded "DB error"→"Dashboard error".
- **Part B —** `loadAdmin` move-count routed through `api()` (sends the token header). Removes the stray 401, populates the count.
- Kept `setSyncing`/`setSynced` (benign activity feedback) and the `[Inventory Health]` diagnostic log (per constraint). No retries, no refresh logic, no server changes.

### Verification (Rule 17)
- Pushed `d097c88`; live by ~30s. `/api/health` 200 (`db:connected`). Served HTML contains `refreshDbStatus`, "Session expired", `.sync-dot.warn`, `api('/moves?limit=10000')`, and the diagnostic log. Inline `<script>` compiles clean (`vm`, 0 errors).
- ⚠️ **REAL verification needs the architect:** sign in fresh and confirm the dot shows **"Live"** (or "Session expired" if a token actually lapsed) — **never "DB Error"** — when `/api/health.db == connected`; Inventory Health renders without first clicking Listings/Orders; and the dot still goes red if the DB is genuinely killed.

**Files touched:** `public/index.html`, `SNAPSHOT_FRONTEND.md`. No backend.

**⏭ PENDING FOLLOW-UPS:** #2 hands-on testing · #3 final data extract · #5 eBay token expiry (two tokens) · #8 broader Drive cleanup · retire legacy un-prefixed `TRADING_API_*` once multi-store stable · persist eBay listings server-side (`ebay_listings` table) · remove `[Inventory Health]` DIAGNOSTIC log after blank-page confirmed fixed · **NEW: Persistent session store** — sessions live in an in-memory Map that wipes on every server restart, logging everyone out on each deploy. Tolerable during dev; should be Postgres-backed before cutover hands the system to warehouse workers who'd be disrupted by mid-shift logouts. *(Open.)*

**Cutover context (per web architect):** after this fix, the remaining cutover blockers are **#2 hands-on testing** and **#3 final data extract from the paid WMS** — both **architect tasks, not Claude Code tasks**. Next session should ideally focus on the testing checklist + data-extract plan rather than more code fixes, unless something else breaks.

**Production status:** `hawkerwms.up.railway.app` healthy — `/api/health` 200; status dot now reflects real DB health.

## 21:28 UTC — Inventory Health blank-page bug: defensive render guard + diagnostic (frontend only) ✅

**Single deliverable:** diagnose (from code — no live repro) + fix the Inventory Health blank-page bug attributed to last session's UI rebuild (`a8e2319`). **Frontend only** (`public/index.html`); server/db/schema untouched. Confirmed `/api/items?status=STAGED_UNLISTED` is a real endpoint returning an array (server.js:138; valid status filter, Rule 11) — NOT a missing endpoint, so no STOP-and-report.

### Diagnostic findings (ranked) — reported before patching
1. **The `a8e2319` Health render path is already fully guarded; no reproducible blank-causing throw found.** `loadInventoryHealth`'s data section was entirely inside `try/catch` (data-shape throw → caught → toast, never blank), and the page-health markup is structurally sound (8 balanced cards; `health-summary`/`health-showing` present). All of the brief's suspected failure modes are *already handled*: missing `store` → `l.store||'unknown'`; cross-listed access guarded by `r.status==='Cross-listed' && r.ebayByStore`; `listingBlock` null-guards; `r.wms` always an array; staging from `api()` (array or throws→caught). No `setInterval`/re-render loop (the ~8 paired `/api/items` calls = repeated navigations/syncs, noise).
2. **Most likely trigger of the observed blank: a transient 401 / session-expiry mid-render** (the architect's "one 401"). `api()` on 401 calls `showLogin()` (full-screen overlay) **and** throws (index.html:658) → overlay covers the app (reads as blank), caught throw aborts populate, the 401 + in-flight `/api/items` show as the "24 console errors" (browser logs failed requests regardless), and it's **not reproducible after re-auth**. This is general auth-layer behaviour, **not an `a8e2319` logic bug**.
3. **The one real code gap:** the empty-state branch + all `getElementById().innerHTML/textContent` writes had **no top-level guard and no visible error state** — so *any* throw left the user with **no signal**. That silent-blank mode is itself the worst part of the bug.

### Fix (frontend only)
- **Wrapped the ENTIRE `loadInventoryHealth()` body (incl. the empty-state branch) in `try/catch`.** On error: `console.error('[Inventory Health] render failed:', e)` + a **visible** error state rendered into the Health section ("⚠ failed to render — check Console" + **Reload Page** button) + the table shows "Could not render — see Console." → the section is **never truly blank again**. No auto-retry/refetch (per constraint).
- **`// DIAGNOSTIC` `console.log` at top** printing input **shapes only** (`ALL_LISTINGS.length`, whether the first listing has a `store` tag, active status/store filters) — **no PII**. Marked for removal.
- I did NOT fabricate a single "root cause fix" — the path was already guarded; the defensive layer IS the substantive fix for the no-signal blank, plus the empty-state is now inside the guard.

### Verification (Rule 17)
- Pushed `c8f05cc`; live by ~30s. `/api/health` 200. Served HTML contains all defensive markers (render start/failed logs, "Inventory Health failed to render", Reload button, DIAGNOSTIC comment). Inline `<script>` compiles clean (`vm`, 0 errors).
- ⚠️ **REAL verification still needs the architect:** load the page **logged in**, exercise Health (sync + navigate), watch Console for the `[Inventory Health] render start` breadcrumb, and confirm no blank. If the blank recurs, the Console now carries the error + input shapes to pin it.

**Files touched:** `public/index.html`, `SNAPSHOT_FRONTEND.md`. No backend.

**⏭ PENDING FOLLOW-UPS:** #2 hands-on testing · #3 final data extract · #5 eBay token expiry (two tokens) · #8 broader Drive cleanup · retire legacy un-prefixed `TRADING_API_*` once multi-store stable · **NEW: Persist eBay listings server-side (new `ebay_listings` table)** so syncs are truly manual/scheduled and listings don't reset on page refresh — architectural fix replacing the in-memory `ALL_LISTINGS`; today every page load re-fetches live, against the spirit of Rule 24. *(Open.)* · **NEW: Remove the `DIAGNOSTIC` `console.log` from `loadInventoryHealth()`** once the blank-page bug is confirmed resolved via real user testing. *(Open.)*

**Production status:** `hawkerwms.up.railway.app` healthy — `/api/health` 200; Health page now fails safe (visible error + Reload) instead of blank.

## 21:05 UTC — Rebuild Inventory Health UI to old-WMS layout (multi-store-aware) — frontend only ✅

**Single deliverable:** rebuild the Inventory Health page front-end to the old WMS layout (visual reference `Warehouse_WMS4.html` lives in claude.ai project knowledge — NOT in the repo, reference-only per CLAUDE.md; built from the brief's spec), adapted for HawkerWMS multi-store. **Frontend only** — `public/index.html` only; no `server.js`/`db/`/route changes (the multi-store data layer shipped last session).

### Diagnostic results (Rule 1, reported before building)
- **Item-detail page: NONE.** `server.js` has `GET /api/items/:serial` (API), but the frontend has **no item-detail page/route** — `/items/:serial` is used only by the scan flow (`handleScan`). → WMS serials render as **plain monospace text, NOT links** (and never to `wms-prod` — the old paid WMS we're replacing).
- **`store` tag confirmed** present on every `ALL_LISTINGS` entry (from last session's multi-store work).
- Current page already had (from last session): 4-col table, store badges, filter chips w/ counts, store filter, empty-state Sync button. This session refined it to the full old-WMS layout.

### What was built (UX choices worth noting)
- **8 stat cards** in a responsive `auto-fit` grid: added **WMS Items** (active shelf count) + **eBay Inventory** (total live listings) in front of Matched / eBay Only / WMS Only / Duplicate / **Cross-listed** / Staging. No per-bucket CSV download icons (architect skipped); the pre-existing single header "Export CSV" button was left untouched.
- **Header** reworded to spec: "Comparing N eBay listings with SKUs against M active shelf items. Staging items (S) are excluded from health buckets."
- **Table** (SKU / Status / eBay / WMS), **rows sorted by SKU ascending**:
  - SKU = normalized key (mono, semibold); Status = colored pill.
  - eBay col = per-listing block with **inline store badge**, raw eBay SKU, qty, green price, title truncated (full title in `title` attr), View-on-eBay link.
  - **Cross-listed rows show BOTH stores' listings stacked** (one `listingBlock` per store, each with its own store badge) — the oversell risk is now visually obvious (the whole point of the bucket).
  - WMS col = plain serial; raw form in parens when it differs from the normalized key; location in small muted text below; **all items stacked for Duplicate**; em-dash for eBay Only.
- Kept the empty-state Sync button (commit 1838259) and the store filter dropdown. Light theme / existing CSS tokens (translated the old WMS *layout*, not its dark colors — Rule 21).

### Verification (Rule 17)
- Pushed `a8e2319`; Railway live by ~50s. `/api/health` 200. Served `index.html` contains all new strings: **WMS Items, eBay Inventory, "eBay listings with SKUs", Cross-listed**, the store filter, the empty-state button, and all 6 filter chips. Inline `<script>` compiles clean (`vm`, 0 errors).
- *(Markup + JS confirmed live; the fully-rendered table is data-driven — Ry can eyeball the Cross-listed two-store rows on a logged-in load. The underlying multi-store data was proven distinct last session.)*

**Files touched:** `public/index.html`, `SNAPSHOT_FRONTEND.md`. No backend.

**⏭ PENDING FOLLOW-UPS:** #2 hands-on testing · #3 final data extract · #5 eBay token expiry (two tokens) · #8 broader Drive cleanup · retire legacy un-prefixed `TRADING_API_*` once multi-store proven stable. **Inventory Health UI rebuild: DONE.**

**Production status:** `hawkerwms.up.railway.app` healthy — `/api/health` 200; new Health UI live.

## 20:41 UTC — Wire AutoLumen as 2nd eBay store (multi-store layer) — Phase 1 proposal + Phase 2 build, deployed & cross-contamination verified ✅

**Single deliverable:** add AutoLumen as a second eBay store (shared inventory). Two-phase: proposal → architect approval → build. **Touched only `server.js` + `public/index.html` + both snapshots.** No schema, no `db/`, no other routes (Ry's locked decision: store is a property of eBay listings/orders only, never of the physical item).

### Phase 1 — approved design decisions
- **Data model:** every listing/order carries a `store` tag; single merged `ALL_LISTINGS`/`ORDERS` arrays (not per-store arrays) — makes the Inventory Health union natural. No persistence (Rule 9, still in-memory).
- **Creds:** `STORES` registry (`dynatrack`/`autolumen`, +1 entry per future store); per-store `${PREFIX}_TRADING_API_*`. **Legacy un-prefixed `TRADING_API_*` IGNORED — no fallback** (kept only as rollback safety net).
- **`ebayCall(store, callName, xml)`** — `store` required, no default, no shared cred path.
- **Routes:** the 3 existing routes fan out over configured stores (tag + merge + per-store error isolation + `byStore`); added `/api/ebay/:store/{health,listings,orders}` for isolation + the cross-contamination test.
- **Inventory Health:** union compare; **NEW dedicated "Cross-listed" 6th bucket** (SKU active on ≥2 stores = oversell risk) — does NOT overload "Duplicate" (which stays WMS-side multiplicity); per-row store badges + store filter.
- **Dashboard:** two independent per-store status cards, each with its own `syncStore` button.
- **Env guardrail (Ry's choice):** **soft per-store disable** — loud per-store startup log (`OK`/`[MISCONFIG]`) + explicit "legacy vars ignored" line; a misconfigured store's routes fail loud on call; **no hard-throw** so warehouse scan/move/label keeps running.

### Phase 2 — build
- **server.js:** replaced the whole eBay block with `STORES` registry, `storeCreds`/`missingStoreVars`/`storeConfigured`, `validateStoreEnv()` (runs at boot), store-scoped `ebayHeaders`/`ebayCall`, per-store `fetchStoreHealth/Listings/Orders`, 3 fan-out routes + 3 per-store routes.
- **public/index.html:** two dashboard cards from `stores[]`; `storeLabel/storeBadge/storeCountLabel/mapOrder/mapListing` helpers; `syncStore(key)` replaces only that store's slice via **`filter(x=>x.store!==key).concat(...)` — never reassigns the array** (flagged with a comment, per architect's correctness requirement); Store columns on Orders + Listings; Inventory Health union + Cross-listed card/tab + per-row store badges + store filter; CSV export gains a Stores column.
- Validated: `node --check server.js` OK; inline `<script>` compiled clean via `vm` (0 errors).

### Verification (post-deploy, authed via Railway-injected creds — no secrets/PII logged) — commit `533f83d`
- `/api/health` 200. Per-store health: **both `connected:true`** (Dynatrack + AutoLumen).
- **CROSS-CONTAMINATION GATE (#3) — PASS:** `/api/ebay/dynatrack/listings` = **3,272** (ItemIDs `286…/287…`) vs `/api/ebay/autolumen/listings` = **532** (ItemIDs `397…`), **overlap 0, disjoint sets** → per-store credentials are isolated, not crossed.
- Combined `/api/ebay/listings` `byStore: {dynatrack:3272, autolumen:532}`, no errors. Combined health `stores[]` shows both.

**Files touched:** `server.js`, `public/index.html`, `SNAPSHOT_ROUTES.md`, `SNAPSHOT_FRONTEND.md`. No schema/`db/`/other routes.

**⏭ PENDING FOLLOW-UPS:** #2 hands-on testing · #3 final data extract · #5 eBay token expiry (now TWO tokens — calendar both) · #8 broader Drive cleanup · **NEW: retire the legacy un-prefixed `TRADING_API_*` env vars once multi-store is proven stable** (currently ignored but still present as the rollback net). **AutoLumen multi-store: DONE.**

**Rollback:** `git revert 533f83d` returns to single-store code, which reads the still-present un-prefixed `TRADING_API_*` set — eBay sync restored with no env changes. (That's why the legacy set is being kept.)

**Production status:** `hawkerwms.up.railway.app` healthy — `/api/health` 200; both eBay stores connected; dashboard shows two store cards.

## 20:07 UTC — Ground-truth verification of #4 (recap-discrepancy check) — #4 confirmed DONE & LIVE; no code change

**Single deliverable:** verify ground truth on follow-up #4 after a prior session died mid-flight (API socket error) and a recap left doubt about whether #4 was actually patched/deployed. **No code touched** — this is a verification + documentation entry only.

### Finding: #4 was genuinely fixed, pushed, and is live. The recap was CORRECT.
- **Git history (authoritative):** `741b289 Fix #4: eBay health card — probe with GetMyeBaySelling…` exists and touches `server.js`; followed by `fc93ca9` (log) and `d5f028f` (stamp). `HEAD == origin/main == d5f028f`. SYNC STAMP = `fc93ca9 @ 2026-05-28 19:26 UTC` (real, matches the content commit).
- **Current code:** `/api/ebay/health` (server.js:393) probes with `ebayCall('GetMyeBaySelling', …)` and returns the honest non-API-response message (server.js:400) — the fix is present, not the old `GeteBayOfficialTime`/"Unknown error" path.
- **Live prod (authenticated, 3×):** `/api/ebay/health` → `{"connected":true,"message":"eBay Trading API connected"}` all three times; `/api/health` 200. Card is GREEN. Persistent, not transient.
- **Already documented:** the 19:25 UTC entry below records the fix and marks #4 ✅ CLOSED. Memory files already reflected reality.

### What actually happened (recap clarification — the "workflow gap")
- The session that **died mid-flight** was the **AutoLumen multi-store** diagnose-first read of the eBay layer — it correctly made **no** #4 changes (because #4 was already complete in the preceding 19:25 session). 
- The recap's "#4 done/deployed/verified green" was **accurate** (from the 19:25 session), but because the *died* session produced no commit, the next briefing was written as if #4 might be unverified.
- **Lesson:** the SYNC STAMP (Rule 40) + this session log + `git log`/prod already encoded the truth — trust those over a narrative recap. Verifying against git + live prod (as done here) is the correct tiebreaker.

### Real open item (NOT #4)
- **AutoLumen second-eBay-store wiring** (multi-store layer) is still **UNSTARTED** — the prior brief got as far as the diagnose-first read before the socket error. That is the next deliverable, not #4.

**Files touched:** `HAWKER_SESSION.md`, `HAWKER_CHANGELOG.md` (this verification entry only). No `server.js`/app code/schema/snapshot changes — #4 needed none.

**⏭ PENDING FOLLOW-UPS:** #2 hands-on testing · #3 final data extract · #5 eBay token expiry · #8 broader Drive cleanup · **NEW: AutoLumen multi-store eBay layer (diagnose-first read done, wiring not started).** #4 remains CLOSED.

**Production status:** `hawkerwms.up.railway.app` healthy — `/api/health` 200, eBay card green (`connected:true`).

## 19:25 UTC — Fix #4: eBay health card "Unknown error" → card now GREEN (✅ CLOSED)

**Single deliverable:** fix the Dashboard eBay health-card "Unknown error" (follow-up #4). Diagnose-first, approved, then patched. **Health route only** — `ebayCall`, the orders/listings routes, `db/`, and the frontend were untouched.

### Root cause (confirmed this session)
- The health probe called **`GeteBayOfficialTime`**, which returns an **HTTP 503 `text/html` "Service Unavailable – Zero size object"** gateway page — **no `<Ack>`, no error envelope**. `ebayCall` discards `res.statusCode` (resolves the body as a string), and the route's parser found no `<Ack>`/`<LongMessage>`/`<ShortMessage>`, so it fell through to the literal **`'Unknown error'`** fallback (server.js:396 old). The frontend (index.html:735) just renders `ebay.message` verbatim — so "Unknown error" was the *server's* string, not a frontend default.
- **Not a credential issue:** `GeteBayOfficialTime`, `GetOrders`, `GetMyeBaySelling` all share the same token + headers via `ebayCall`/`ebayHeaders`. `GetMyeBaySelling` returns `Ack=Success` in prod (verified) — so the 503 was **specific to `GeteBayOfficialTime`**, not a broad gateway outage or the token.

### Fix (Decision: clean `GetMyeBaySelling` swap; no numeric-HTTP-code variant)
- `/api/ebay/health` now probes with **`GetMyeBaySelling`** (1 entry — the *same* call the listings sync uses, **no buyer PII** unlike `GetOrders`), so the card reflects real sync capability.
- A non-XML response (no `<Ack>`) now returns an **honest** message ("non-API response / likely HTTP 503/maintenance page; live sync may still be working") instead of "Unknown error". `Ack=Failure` still surfaces eBay's `LongMessage`.
- Dropped the inaccurate "· Australia site" from the connected message (SITEID `0` = US; approved Rule-B flag).
- Skipped temp-logging capture (Decision 1): `GetMyeBaySelling` was already known-good in prod, and the fix is self-diagnosing — avoided an extra deploy/revert and any PII risk.

### Verify (Rule 17 — after Railway auto-deploy)
- Public `/api/health` → 200. Authenticated `/api/ebay/health` (logged into prod via **Railway-injected** `WMS_*` creds through `railway run`, so **no secrets printed**, no temp logging) → **`{"connected":true,"message":"eBay Trading API connected"}`**. New code confirmed live (message no longer contains "Australia"/"Unknown error").
- **Card is GREEN.** Frontend unchanged → `connected:true` renders the green "Connected · dynatrack" state. **eBay sync confirmed healthy.**

**Files touched:** `server.js` (`/api/ebay/health` route only), `SNAPSHOT_ROUTES.md` (Rule 38 regen — health-route row + helper note + line anchors). Commit **`741b289`**, pushed to `main`. No schema/frontend changes.

**⏭ PENDING FOLLOW-UPS:** #2 hands-on testing · #3 final data extract · #5 eBay token expiry (~18 mo) · #8 broader Drive-folder cleanup (incl. refreshing the Drive stubs to the new `HAWKER_` filenames). **#4 CLOSED this session** (#1/#6/#9 closed earlier; #7 dropped).

**Production status:** `hawkerwms.up.railway.app` healthy — `/api/health` 200, DB connected, eBay card green.

## 18:08 UTC — Rename memory files to `HAWKER_`-prefix + reconcile diverged main + fix phantom sync stamp

**Single deliverable:** rename this project's memory files to `HAWKER_`-prefixed names (permanent disambiguation from the *other* eBay repo) and update every live internal reference. Documentation/memory only — `server.js`, `public/index.html`, `db/` untouched. Required a reconcile first (the repo was diverged on entry).

### STEP 1 — Reconciled the diverged `main` (blocker cleared before renaming)
- On entry, `main` was **ahead 2 / behind 1** of `origin/main`, and the SYNC STAMP pointed to a **phantom commit `7b9c2d8` that existed nowhere** (local or remote). Root cause: the 02:39 desktop "Add Rule 40" session committed locally but its push never landed, while the laptop pushed `2f4c513` (follow-up #9) in parallel — the two machines forked at `fe4fa63`. Both sides were docs-only (no app code either side).
- `git rebase origin/main` replayed the 2 desktop commits onto the laptop's `2f4c513`. Conflicts were exactly the expected `LAST_SESSION.md`/`CHANGELOG.md` entry-interleaving; resolved by **keeping BOTH sessions' entries verbatim** — the two concurrent `## 02:39 UTC` entries (desktop Rule 40 + laptop #9) now coexist (newest-at-top by commit time); the laptop's #9 entry preserved intact. Non-destructive: no force-push; the laptop's published `2f4c513` was never rewritten.
- Pushed the reconciled state (`2f4c513..279357c`); confirmed `main` even with `origin/main` (0 ahead / 0 behind) before renaming.

### STEP 2 — The rename (on the clean, synced tree)
- `git mv` (history preserved, all detected as `R`):
  - `LAST_SESSION.md` → `HAWKER_SESSION.md`
  - `CHANGELOG.md` → `HAWKER_CHANGELOG.md`
  - `CLAUDE_RULES.md` → `HAWKER_RULES.md`
  - `CLAUDE.md` — **kept** (Claude Code auto-loads this name). Added a `# ⚠️ PROJECT IDENTITY: HawkerWMS` banner as its literal first lines.
- **Canonical memory files are now: `CLAUDE.md`, `HAWKER_RULES.md`, `HAWKER_SESSION.md`, `HAWKER_CHANGELOG.md`.**
- Updated every **live** reference to the new names: CLAUDE.md (boot sequence; anti-rogue G/H/I/K/L/M; CONTEXT rule refs; SYNC ARCHITECTURE four-file list); HAWKER_RULES.md (title + Rules 3, 5, 6, 9, 36, 39, 40 — incl. Rule 39's signoff text); the HAWKER_SESSION.md + HAWKER_CHANGELOG.md titles; the "per …rule 38" line in all three `SNAPSHOT_*.md`. Verified before starting that **zero** old-name refs live in tooling/config/app code.
- **Historical entries left intact (historical record, per brief):** old filenames now appear ONLY inside past-session entries — HAWKER_SESSION.md (24× `LAST_SESSION`, 18× `CLAUDE_RULES`, 23× `CHANGELOG`) and HAWKER_CHANGELOG.md (8× / 8× / 5×). All sit below the live headers; none in live instructions, tooling, or app code.

### STEP 3 — Phantom stamp fixed
- The bogus `7b9c2d8` is replaced with the REAL pushed commit hash (see SYNC STAMP at the top of this file, written in the final stamp-only commit per the Rule 40 mechanic). Confirmed the stamp hash equals the actual pushed content commit.

**Files touched:** `CLAUDE.md`, `HAWKER_RULES.md` (←`CLAUDE_RULES.md`), `HAWKER_SESSION.md` (←`LAST_SESSION.md`), `HAWKER_CHANGELOG.md` (←`CHANGELOG.md`), `SNAPSHOT_ROUTES.md`, `SNAPSHOT_FRONTEND.md`, `SNAPSHOT_SCHEMA.md`. **Drive folder untouched** — its stubs still carry the OLD names (updating them to the new `HAWKER_` names folds into follow-up #8). No app code/schema.

**⏭ PENDING FOLLOW-UPS (carried forward):** #2 hands-on testing · #3 final data extract · #4 dashboard 503 health-card bug (diagnosed last session, not yet patched) · #5 eBay token expiry · #8 broader Drive-folder cleanup (now also: refresh the Drive stubs to the new `HAWKER_` filenames).

**Production status:** unchanged — docs/memory only; Railway redeploys on push but there is no code delta.

## 02:39 UTC — Add Rule 40 (sync stamp) + CLAUDE.md item M + amend Rule 39 signoff

**Single deliverable:** documentation — add the sync-stamp staleness mechanism. No app code, no snapshot regen.

- **`CLAUDE_RULES.md`:** added **Rule 40 — Sync stamp + staleness announce** (verbatim). Amended **Rule 39**'s closing step so the signoff now includes `Current stamp: <hash> @ <UTC>`.
- **`CLAUDE.md`:** added **anti-rogue item M** (architect states the sync stamp first at session start) (verbatim).
- **Implemented the stamp itself this session:** a `<!-- SYNC STAMP -->` block is now the first line block of this file (see very top), updated after the push to reflect the just-pushed commit.

**Mechanics note (so the off-by-one isn't mistaken for staleness):** a git commit cannot contain its own hash, so the stamp is written in a **final stamp-only commit** after the content push and carries the **content commit's** hash. The signoff hash equals the stamp value — the human spot-checks the architect's announced hash against **this session's signoff line** (per the brief), not against raw `git log` HEAD (which will be the trivial stamp commit on top).

**⏭ PENDING FOLLOW-UPS (carried forward):** #2 hands-on testing · #3 final data extract · #4 dashboard 503 health-card bug · #5 eBay token expiry · #8 broader Drive-folder cleanup (stale full project copy remains) · #9 laptop verification ("option A", still open). (#1 folder consolidation & #6 blank Inventory Health closed; #7 connector dropped.)

**Files touched:** `CLAUDE_RULES.md`, `CLAUDE.md`, `LAST_SESSION.md` (this entry + stamp block), `CHANGELOG.md`. No app code/schema/snapshots. Production unchanged.

## 02:39 UTC — Laptop verification (follow-up #9 ✅): first clone on laptop, round-trip proven

**Machine:** Laptop (computer `RYAN`, user `ryan\atenr`). **Single deliverable:** verify this laptop is set up to work on HawkerWMS exactly like the desktop — pull/push the same GitHub repo, no dependency on the abandoned Drive folder. Diagnostic-first; inventory reported and approved before any change. No app code touched; no snapshot regeneration.

### ⚠️ Useful fact for future sessions — laptop path is the SAME as desktop
This laptop's user profile is **`C:\Users\atenr`** — *identical* to the desktop, not a different path. So the canonical repo path `C:\Users\atenr\dynatrack-wms-repo` (Rule 31) is correct on **both** machines; no per-machine path divergence. (`whoami` = `ryan\atenr`, `%USERPROFILE%` = `C:\Users\atenr`, computer name `RYAN`.) Future sessions on this laptop need not re-discover this.

### Part 1 — Inventory (read-only, reported before touching anything)
1. **WHO/WHERE** — `ryan\atenr`, `%USERPROFILE%`=`C:\Users\atenr`, computer `RYAN`. (Same path as desktop — see note above.)
2. **Git** — `git version 2.54.0.windows.1` at `C:\Program Files\Git\cmd\git.exe`. ✅
3. **Existing clone** — **none.** All four candidate paths absent (`%USERPROFILE%\dynatrack-wms-repo`, `%USERPROFILE%\dynatrack-wms`, `C:\dynatrack-wms-repo`, `C:\Users\atenr\dynatrack-wms-repo`). Clean first-time-setup case.
4. **Stale Drive folder** — `G:\My Drive\dynatrack-wms\` exists; the four memory files are all **MOVED-stubs** (Drive has synced the 2026-05-28 abandonment from the desktop — good). The two Drive sync-conflict copies `LAST_SESSION (1).md` / `CHANGELOG (1).md` are **also stubs** (harmless). Full stale project copy (server.js, db/, public/, hawker-import.sql, …) still present — that's follow-up #8, untouched this session. **Did not edit anything in Drive.**
5. **GitHub auth** — system gitconfig `credential.helper=manager` (GCM); binary at `C:\Program Files\Git\mingw64\bin\git-credential-manager.exe`. Git identity `dynatrackracing` / `dynatrackracingnc@gmail.com`. No PAT involved.
6. **Claude Code settings** — `C:\Users\atenr\.claude\settings.json` = `{"theme":"dark","permissions":{"defaultMode":"auto"}}`. Auto Mode present and correctly nested (matches the 2026-05-27 13:30 UTC laptop session's merge). No repair needed.
7. **Node/npm** — `node v18.20.4`, `npm 10.7.0`. Reported only; app not run.

### Part 2 — Remediation (after architect go-ahead)
- **Cloned** `https://github.com/dynatrackracing/dynatrack-wms.git` → `C:\Users\atenr\dynatrack-wms-repo`. **GCM auth succeeded with NO browser prompt** — credentials were already cached on this machine, so the clone ran non-interactively.
- **Verified state:** remote `origin` → `github.com/dynatrackracing/dynatrack-wms` (fetch+push), branch **main**, HEAD **`fe4fa63`** ("Stub abandoned Drive memory files + Rule 39 + CLAUDE.md item L" — the desktop's 02:10 UTC push), working tree **clean / up to date with origin/main**. Fresh clone already at the desktop's latest, so a separate `git pull` was redundant.
- **Belatedly satisfied the mandatory first-read** (couldn't earlier — the real docs only existed in GitHub until the clone): read CLAUDE_RULES.md in full (39 rules), LAST_SESSION.md (recent entries), CHANGELOG.md.
- **Settings (Action D):** no-op — Auto Mode already correct.
- **Drive (Action E):** no-op — memory files already stubbed (Drive caught up from desktop on its own). Re-checked at session end: still stubs.

### Round trip
This entry + the CHANGELOG line are the **first laptop→GitHub commit & push**, proving the round trip works in both directions (clone/pull ⇄ push). The desktop will see them on its next `git pull`.

### ⏭ PENDING FOLLOW-UPS (carried forward; #9 now ✅)
1. **✅ CLOSED (2026-05-28) — Folder consolidation.**
2. **Hands-on testing** in HawkerWMS before cutover. *(Open.)*
3. **Final data extract from the paid WMS** before cutover. *(Open.)*
4. **Dashboard health-check bug** — `GeteBayOfficialTime` 503 → eBay card "Unknown error". *(Open.)*
5. **eBay token expiration** (~18 months). *(Open.)*
6. **✅ CLOSED (2026-05-27) — Blank Inventory Health page.**
7. **~~Google Drive connector~~ — DROPPED** (Rules 36–37).
8. **Broader Drive-folder cleanup** — stub/delete the remaining stale full project copy in `G:\My Drive\dynatrack-wms\`. *(Open.)*
9. **✅ CLOSED (2026-05-28) — Laptop verification.** Laptop is set up end-to-end: clone present at `C:\Users\atenr\dynatrack-wms-repo`, on `main`, clean, at `fe4fa63`; Auto Mode set; GCM auth working (clone + this push). No dependency on the abandoned Drive folder.

**Files touched (repo):** `LAST_SESSION.md`, `CHANGELOG.md`. No app code, schema, or snapshots. **Drive:** nothing modified.

**Production status:** unchanged — docs only, nothing deployed beyond the Railway auto-redeploy that any `main` push triggers (no code delta).

## 02:10 UTC — Stub abandoned Drive memory files + Rule 39 (PK re-upload cadence) + CLAUDE.md item L

**Single deliverable:** documentation/housekeeping — closed two follow-ups (B: stub the abandoned Drive folder; C: add Rule 39). No app code touched; no snapshot regeneration needed.

### Part B — stubbed the abandoned Drive folder
- Inventoried `G:\My Drive\dynatrack-wms\` first (no `.git` present — good). Found **two unexpected extra files** beyond the four named memory files: **`LAST_SESSION (1).md`** and **`CHANGELOG (1).md`** (older "(1)" duplicate downloads). Per architect's go-ahead, treated them as in-scope.
- **Stubbed SIX files** (not four) in `G:\My Drive\dynatrack-wms\`, each overwritten with the "# MOVED — DO NOT EDIT THIS FILE" stub pointing at the canonical repo copy:
  1. `CLAUDE.md` → repo `CLAUDE.md`
  2. `CLAUDE_RULES.md` → repo `CLAUDE_RULES.md`
  3. `LAST_SESSION.md` → repo `LAST_SESSION.md`
  4. `CHANGELOG.md` → repo `CHANGELOG.md`
  5. **`LAST_SESSION (1).md`** → repo `LAST_SESSION.md` (points to the without-`(1)` name)
  6. **`CHANGELOG (1).md`** → repo `CHANGELOG.md` (points to the without-`(1)` name)
- *(Implementation note: first stub pass had a shell-escaping bug that left a literal `$canon` in the path line; caught it on verification and rewrote all six with correct literal paths. Confirmed correct.)*
- **Did NOT delete the Drive folder or any file** (stubs only, per brief). Did not touch the other files in that folder.

### Part C — added Rule 39 + CLAUDE.md item L
- `CLAUDE_RULES.md`: appended **Rule 39 — Project-knowledge re-upload cadence** (re-upload the four memory files after any session that committed changes to them, or weekly at minimum; human/architect performs it; closing step is to remind the human). Rules 1–38 untouched.
- `CLAUDE.md`: added **anti-rogue item L** (remind the human to re-upload project knowledge at session end if any memory file changed, per Rule 39), after item K.

### ⚠️ Still-stale in the Drive folder (broader cleanup deferred → new pending item #8)
The Drive folder still holds a **full stale project copy**: `server.js` (22,918 bytes — divergent from canonical 22,850), `public/index.html`, `db/`, `package.json`, `railway.toml`, `hawker-import.sql`, `README.md`, `.gitignore`, and `CONNECTOR-SETUP-RUNBOOK.md`. Only the six memory files were stubbed; these remain a "edit the wrong file" hazard until cleaned up.

### ⏭ PENDING FOLLOW-UPS (carried forward + updated)
1. **✅ CLOSED (2026-05-28) — Folder consolidation** (memory files canonical in repo; Drive memory files now stubbed this session).
2. **Hands-on testing** in HawkerWMS before cutover. *(Open.)*
3. **Final data extract from the paid WMS** before cutover. *(Open.)*
4. **Dashboard health-check bug** — `GeteBayOfficialTime` 503 → eBay card shows "Unknown error". *(Open.)*
5. **eBay token expiration** (~18 months). *(Open.)*
6. **✅ CLOSED (2026-05-27) — Blank Inventory Health page.**
7. **~~Google Drive connector~~ — DROPPED** (superseded by repo-canonical + manual re-upload; Rules 36–37).
8. **NEW — Broader Drive-folder cleanup.** Stub/delete the remaining stale project copy in `G:\My Drive\dynatrack-wms\` (`server.js`, `public/index.html`, `db/`, `package.json`, `railway.toml`, `hawker-import.sql`, `README.md`, `.gitignore`, `CONNECTOR-SETUP-RUNBOOK.md`) — or delete the whole folder. *(Open.)*
9. **NEW — Laptop verification ("option A").** Per architect, still pending — **not closed**. (Exact scope to confirm with architect; likely: confirm the laptop reads from the canonical repo clone, not the abandoned Drive folder.) *(Open.)*

**Files touched (repo):** `CLAUDE.md` (item L), `CLAUDE_RULES.md` (Rule 39), `LAST_SESSION.md`, `CHANGELOG.md`. **Files touched (Drive, not git-tracked):** the six stubs above. No app code, no schema, no snapshots.

**Production status:** unchanged — `hawkerwms.up.railway.app` healthy as of last session. Nothing deployed (docs only).

## 01:38 UTC — Inventory Health verification (no code change)

Investigated "Inventory Health is blank," briefed as "follow-up #1" from a **stale web-chat task list**. Read-only verification against the canonical repo (HEAD `578cf93`) + production:
- `/api/ebay/listings` route healthy (prod `/api/health` 200; route verified returning 3,224 live listings on 2026-05-27).
- **There is NO `ebay_listings` table** — eBay listings are never persisted; the route fetches them live and the browser holds them in the in-memory `ALL_LISTINGS` array. *(Corrected from the brief, which assumed a populated `ebay_listings` table — it does not exist.)*
- SKU normalization (strip trailing letters, Rule 8) present and correct in code (`normalizeSkuKey`, index.html:1343).
- Blank-page symptom was already resolved 2026-05-27 (commit `1838259`, "Option B"): empty state now shows a "Sync eBay listings & compare" button (index.html:1325-1331). Confirmed present in canonical code AND live in production this session.

No code touched. **Root cause of the confusion: the web-chat's claude.ai project knowledge was out of date** — it still treated the Inventory Health blank page as an open "#1" item and predated the 2026-05-28 folder consolidation. The on-disk canonical `LAST_SESSION.md` shows it **CLOSED as item #6** (2026-05-27) within a **7-item** follow-up list whose #1 (Folder consolidation) is also already closed. *(The brief's "7 vs 12 follow-ups" description did not match the on-disk file — the on-disk list has 7 items; this entry records the accurate state.)*

Also added a note to `CLAUDE.md` (CONTEXT YOU SHOULD ALWAYS HAVE LOADED): any `Warehouse_WMS*.html` files in the claude.ai project knowledge are browser-saved snapshots of the OLD paid WMS (`wms-prod.up.railway.app`) from data recovery — reference-only, NOT HawkerWMS source; do not edit or use them to diagnose HawkerWMS bugs.

**Files touched:** `LAST_SESSION.md`, `CHANGELOG.md`, `CLAUDE.md`. No app-code or schema changes. Did not start follow-up #2.

**Open follow-ups (unchanged):** #2 hands-on testing, #3 final data extract, #4 dashboard 503 health-card bug, #5 eBay token expiry.

## 00:47 UTC — Folder consolidation (follow-up #1 ✅): memory files moved into the git repo; DarkHawk discipline adopted

**Single deliverable:** folder consolidation. The four memory files now live in the canonical git repo; CLAUDE.md/CLAUDE_RULES.md updated to the repo-canonical + manual-reupload reality; first SNAPSHOT_*.md generated; session-end routine extended. Did **not** start follow-up #2 (hands-on testing).

> ⚠️ **CANONICAL LOCATION CHANGED.** From now on the memory files live in **`C:\Users\atenr\dynatrack-wms-repo`** (origin `github.com/dynatrackracing/dynatrack-wms`, `main`). The `G:\My Drive\dynatrack-wms\` copies are **abandoned/stale** — future sessions must read and edit the **repo** copies. (These Drive copies were the working copies for *this* session's edits, then copied into the repo; they should be deleted or stubbed as cleanup.)

### What was done
- **Moved the four memory files into the repo root** (`CLAUDE.md`, `CLAUDE_RULES.md`, `LAST_SESSION.md`, `CHANGELOG.md`) — previously the repo had *none* of them. Verified tracked, committed, pushed (see commit hash in this entry's footer / CHANGELOG).
- **Updated `CLAUDE.md`** — rewrote SYNC ARCHITECTURE (repo is canonical for code + memory + snapshots; Drive abandoned; cross-machine sync via git; project knowledge = manual re-upload). Added anti-rogue item **K** (regenerate snapshots at session end).
- **Updated `CLAUDE_RULES.md`** —
  - Rewrote **Rule 31** (canonical repo path + git-based multi-machine sync; Drive abandoned).
  - Replaced old Rule 36 (Drive-connector recommendation) with **Rule 36** (memory files canonical in repo), **Rule 37** (claude.ai project knowledge = manual briefing-room re-upload, no API/automation — supersedes the connector idea; the `CONNECTOR-SETUP-RUNBOOK.md` is now moot), and **Rule 38** (regenerate snapshots at session end).
  - **Rule 35** (architect/worker boundary) kept as-is. *(Note: there was never a literal "memory sync is automatic" rule to delete — last session's Rule 36 was the corrected no-automation version; it has now been replaced by the repo-canonical model.)*
- **Generated first SNAPSHOTS** (repo root): `SNAPSHOT_ROUTES.md` (server.js API surface), `SNAPSHOT_FRONTEND.md` (index.html: 9 pages, 3 modals, ~60 functions), `SNAPSHOT_SCHEMA.md` (5 tables). Third snapshot chosen = SCHEMA (most foundational for a WMS).
- **Did NOT touch app code** — `server.js`, `public/index.html`, `db/schema.sql` unchanged this session (only read for snapshots).

### Verification
- Repo was clean, on `main`, up to date with `origin/main`; confirmed it held none of the four memory files before the move.
- Post-move: files tracked + committed + pushed to `origin/main` (hash recorded below). `git status` clean afterward.

### ⏭ PENDING FOLLOW-UPS (carried forward; 1 now ✅, others unchanged)
1. **✅ CLOSED (2026-05-28) — Folder consolidation.** Memory files now canonical in the repo. *(Remaining cleanup: delete or stub the abandoned `G:\My Drive\dynatrack-wms\` copies.)*
2. **Hands-on testing** in HawkerWMS before cutover. *(Open — next up.)*
3. **Final data extract from the paid WMS** before cutover. *(Open.)*
4. **Dashboard health-check bug** — `GeteBayOfficialTime` 503 → eBay card shows "Unknown error". *(Open.)*
5. **eBay token expiration** (~18 months). *(Open.)*
6. **✅ CLOSED (2026-05-27) — Blank Inventory Health page.**
7. **~~Set up Google Drive connector~~ — DROPPED.** Superseded by the repo-canonical + manual-reupload model (Rules 36–37). `CONNECTOR-SETUP-RUNBOOK.md` is moot.

**Files touched (in repo):** `CLAUDE.md`, `CLAUDE_RULES.md`, `LAST_SESSION.md`, `CHANGELOG.md` (moved in + edited), `SNAPSHOT_ROUTES.md`, `SNAPSHOT_FRONTEND.md`, `SNAPSHOT_SCHEMA.md` (new). No app-code or schema changes; no deploy behavior change (Railway will redeploy on push, but only docs changed).

**Production status:** unchanged — `hawkerwms.up.railway.app` healthy as of last session.

## 00:28 UTC — Project-knowledge auto-sync: investigated, NO supported API, recommended Drive connector (no sync built/run)

**Single deliverable:** investigate/build the claude.ai project-knowledge auto-sync. **Outcome: stopped at the research gate** — there is no supported public API to write to claude.ai project knowledge, so per the task's own guardrail I did **not** build a brittle workaround. Did not start any other pending item (Rule A / Rule 2).

### Finding (researched current docs, not guessed)
- **No public/programmatic API** writes to claude.ai project knowledge (confirmed 2026-05). Programmatic project management is on Anthropic's roadmap but not shipped (open Claude Code feature request #2511).
- The **Files API** (`/v1/files`) is a **separate system** for the developer/Messages API — it does not populate a claude.ai Project's knowledge base.
- The only programmatic route would be **undocumented claude.ai cookie-auth web endpoints** = the brittle workaround the brief forbade. Not built.
- **Supported auto-sync path: the claude.ai Google Drive connector** pointed at `G:\My Drive\dynatrack-wms\`. Setup is a claude.ai **UI action** I cannot perform — a legitimate human/architect task (it crosses a boundary Claude Code can't reach; see new Rule 35).
- Sources: support.claude.com "What are projects?" / "Create & manage projects"; docs.anthropic.com Files API; github.com/anthropics/claude-code/issues/2511; support.claude.com "Use Google Workspace connectors".

### What I actually changed this session
- **`CLAUDE_RULES.md`** — appended **Rule 35 (Architect/worker boundary, verbatim)** and **Rule 36 (corrected memory-sync rule — reflects the no-API reality; explicitly forbids fake "sync ran" claims and brittle scrapers)**.
- **`CONNECTOR-SETUP-RUNBOOK.md`** (new, in this folder) — step-by-step Google Drive connector setup **plus an empirical verification step** (edit a memory file in Drive → check claude.ai → confirm live-sync vs snapshot), including explicit notes on the `.md`-vs-Google-Doc ambiguity and what to look for.
- **`LAST_SESSION.md`** + **`CHANGELOG.md`** — this update.

### ⚠️ Explicit non-claims (Rule 36 / fail-loud)
- **No automated sync was built and none ran.** The memory files are **not** auto-syncing to project knowledge.
- The **backlog is still un-pushed:** last session's `## 22:15 UTC — Inventory Health blank-page fix` entry (and its CHANGELOG line) are **not in project knowledge yet**, and neither is this entry. They require a **manual upload this session** until the connector is set up and verified.

### ⏭ PENDING FOLLOW-UPS (carried forward; 1–5 still open, 6 closed last session)
1. **Folder consolidation (do first).** Drive folder isn't a git repo; clone has `.git` but no memory files. *(Open.)*
2. **Hands-on testing** in HawkerWMS before cutover. *(Open.)*
3. **Final data extract from the paid WMS** before cutover. *(Open.)*
4. **Dashboard health-check bug** — `GeteBayOfficialTime` 503 → eBay *card* shows "Unknown error". *(Open.)*
5. **eBay token expiration** (~18 months). *(Open.)*
6. **✅ CLOSED (2026-05-27) — Blank Inventory Health page.**
7. **NEW — Set up + verify the claude.ai Google Drive connector** for project-knowledge auto-sync (architect UI task; runbook at `CONNECTOR-SETUP-RUNBOOK.md`). Until done, memory files need manual upload to project knowledge each session. *(Open.)*

**Files touched:** `G:\My Drive\dynatrack-wms\CLAUDE_RULES.md`, `CONNECTOR-SETUP-RUNBOOK.md` (new), `LAST_SESSION.md`, `CHANGELOG.md`. No code, no git commits, no deploys this session.

**Production status:** unchanged — `hawkerwms.up.railway.app` healthy as of last session. Nothing deployed today.

# 2026-05-27

## 22:15 UTC — Inventory Health blank-page fix (Option B) + eBay listings sync verified

**Single deliverable:** diagnosed and fixed the blank Inventory Health page. One commit, Health code path only. Did not start any other follow-up (Rule A / Rule 2).

### ⏭ PENDING FOLLOW-UPS (carried forward from the 19:10 entry; items 1–5 unchanged, not renamed/merged)
1. **Folder consolidation (do first).** Drive folder `G:\My Drive\dynatrack-wms` holds memory files but is NOT a git repo; the clone `C:\Users\atenr\dynatrack-wms-repo` has `.git` but no memory files. Merge into one canonical folder, then push memory files to GitHub. *(Still open — and still the reason these memory-file edits do not reach the repo.)*
2. **Hands-on testing.** Ry has not yet scanned/moved/labeled anything in HawkerWMS. *(Still open.)*
3. **Final data extract from the paid WMS** before cutover (captures moves/items since April 2026). *(Still open.)*
4. **Dashboard health-check bug.** `GeteBayOfficialTime` 503 makes the eBay status *card* show "Unknown error" even when sync works. *(Still open — distinct from today's Inventory Health page fix.)*
5. **eBay token expiration** (~18 months). Consider a refresh mechanism / calendar the expiry. *(Still open.)*
6. **✅ CLOSED this session — Blank Inventory Health page.** Was NOT previously on this list (see label-mismatch note). Diagnosed + fixed below.

### Label mismatch (reconciliation, per the task brief)
- The brief called this task "follow-up #1," but list item #1 is **Folder consolidation**, and "blank Inventory Health" was **not on PENDING FOLLOW-UPS at all** (the closest, #4, is the Dashboard eBay *card* — a different component). Proceeded with the Inventory Health diagnosis as clearly intended, added it here as item #6, and marked it closed. Existing items 1–5 were not renamed or merged.

### What happened
- **Diagnosed read-only first (Rule 1), against the canonical clone** `C:\Users\atenr\dynatrack-wms-repo` (HEAD `7e7fe08`, current with `origin/main`) — not the stale Drive copy:
  - Listings are **not persisted server-side** — there is **no `ebay_listings` table**; `/api/ebay/listings` (server.js:464) fetches live from eBay and returns them in the HTTP response. (Schema still: locations/items/moves/sequences.)
  - Inventory Health is computed **client-side** from an in-memory `ALL_LISTINGS` array (index.html:1105) that **resets on every page refresh**.
  - `loadInventoryHealth()` (index.html:1322) early-returns with a dead-end "no listings" message when `ALL_LISTINGS` is empty. Unlike the Listings page (which auto-syncs on open, line 676), the Health page never triggers a sync (line 677) → blank whenever opened/refreshed before a sync. **Exactly Rule 26.**
- **Verified the eBay side works with the current token, before patching (Rule 1).** Logged in using the project's own Railway creds and called `/api/ebay/listings`: **HTTP 200, 3,224 listings (3,222 with SKUs)**, real data (e.g. `INT4798` GMC Acadia radio, `EXT1043` Toyota Sequoia tailgate). Sync is healthy — safe to build Option B on top.
- **Fix — Option B (surgical, Health path only).** Replaced the dead-end empty-state message in `loadInventoryHealth()` with an actionable **"Sync eBay listings & compare"** button (`onclick="syncEbayListings().then(loadInventoryHealth)"`). Keeps sync user-initiated (respects Rule 24), reuses existing functions, adds no new function/file. Commit **`1838259`**, pushed to `main`.
- **Deploy verified (Rule 17):** `/api/health` 200; new button string confirmed present in the served `index.html`.

**Files touched:**
- `C:\Users\atenr\dynatrack-wms-repo\public\index.html` (Health empty-state branch only)
- `G:\My Drive\dynatrack-wms\LAST_SESSION.md` + `CHANGELOG.md` (this update)

**Commit pushed to `main`:** `1838259`.

**Production status at session end:** `hawkerwms.up.railway.app` healthy (`/api/health` 200, DB connected). `/api/ebay/listings` verified returning 3,224 listings with the current token. Inventory Health now offers a one-click sync from its empty state.

**Note (Rule B — flagged, not acted on):** `/api/ebay/listings` has no server-side error logging (failures surface only as a client toast), same pattern as the eBay health route. Out of scope today.

## 19:10 UTC — eBay token fix + repo/deploy investigation (cutover-prep session)

### ⏭ PENDING FOLLOW-UPS (priority order)
1. **Folder consolidation (do first).** The Drive folder `G:\My Drive\dynatrack-wms` holds the memory files but is **NOT a git repo**; the clone `C:\Users\atenr\dynatrack-wms-repo` has `.git` (origin `github.com/dynatrackracing/dynatrack-wms`) but **no memory files**. Merge into one canonical folder, then commit/push the memory files to GitHub so they live with the code.
2. **Hands-on testing.** Ry has not yet scanned/moved/labeled anything in HawkerWMS. Must exercise Scan & Move, Locations, Labels, and Inventory end-to-end before cutover.
3. **Final data extract from the paid WMS** before cutover — capture moves and items created since April 2026.
4. **Dashboard health-check bug.** `GeteBayOfficialTime` returned HTTP 503 → the eBay card shows "Unknown error" even though sync works. Hardening fix: check `res.statusCode` and render a specific message (e.g. "eBay returned HTTP 503") instead of falling through to "Unknown error"; consider probing with a call known to work.
5. **eBay token expiration.** The new Auth'n'Auth token expires in ~18 months. Consider a proper refresh mechanism before relying on it long-term; at minimum, calendar the expiry date.

### What happened this session
- **Located the HawkerWMS deployment.** It runs in Railway project **`robust-respect`** (account `dynatrackracingnc@gmail.com`) — the project name does **not** contain "hawker", which made it easy to miss. Service `dynatrack-wms`, environment `production`, domain `hawkerwms.up.railway.app`. (Separately, a `warehouse-wms` project under Eugene Baibourine's workspace holds the OLD paid WMS at `wms-prod.up.railway.app`.)
- **Cloned the real GitHub repo** to `C:\Users\atenr\dynatrack-wms-repo` (origin `github.com/dynatrackracing/dynatrack-wms`, branch `main`). **Critical:** the Drive folder `G:\My Drive\dynatrack-wms` is **NOT a git repo** — edits there cannot reach GitHub/Railway. Railway auto-deploys only from GitHub `main`. The canonical repo's `server.js`/`index.html` were larger than the Drive copies, i.e. the Drive copy is stale/divergent.
- **Diagnosed the eBay "Unknown error":** the `TRADING_API_TOKEN` (Auth'n'Auth token for the Trading API) had **expired** — eBay returned `Ack=Failure` with `<LongMessage>IAF token is expired</LongMessage>`. It surfaced as "Unknown error" only because the route discarded the raw eBay response.
- **Fix:** Ry generated a fresh **Production** token at developer.ebay.com and updated `TRADING_API_TOKEN` directly in the Railway dashboard (triggering a redeploy).
- **Confirmed eBay sync working:** logs showed **14 successful `GetOrders` calls with `Ack=Success`** using the new token.
- **Dashboard caveat:** the eBay status card may still show "Unknown error" because its `GeteBayOfficialTime` health probe hit eBay **HTTP 503** (an HTML error page, not XML → unparseable → "Unknown error"). Transient vs persistent is unknown (only one sample). **Sync itself is fine**; the health-card logic is a known bug (follow-up #4).
- **Temp debug logging used, then reverted.** Added `// TEMP DEBUG` logging to `ebayCall` (HTTP status + raw body) and `/api/ebay/health` (Ack/raw XML/stack) to capture eBay's real response — commit `4cdce8a`. **Reverted in commit `7e7fe08`** after confirming a **PII concern**: raw `GetOrders` responses logged include buyer names + shipping addresses. Production is now clean — no `[eBay …]` debug lines after the cleanup deploy.
- **GitHub auth:** working via **Git Credential Manager** (system-scope `credential.helper=manager`) — no PAT or SSH key needed. The first clone triggered a one-time browser authorization; cached credentials then let pushes run non-interactively.

**Commits pushed to `main` this session:** `4cdce8a` (add temp eBay debug logging) and `7e7fe08` (revert it — PII concern). Net code change vs session start: none. The real fix was the `TRADING_API_TOKEN` env-var update done in Railway.

**Files touched:**
- `C:\Users\atenr\dynatrack-wms-repo\server.js` (debug logging added then reverted — now back to original)
- Railway env var `TRADING_API_TOKEN` (updated by Ry in dashboard)
- `G:\My Drive\dynatrack-wms\LAST_SESSION.md` + `CHANGELOG.md` (this update)

**Production status at session end:** `hawkerwms.up.railway.app` healthy (`/api/health` → 200, DB connected). eBay sync functional. Dashboard eBay card cosmetically wrong due to the 503 health probe.

## 13:30 UTC — Laptop onboarding: memory files verified, Auto Mode merged, setup script created

**Machine:** Laptop (cross-machine sync check).

**What was done:**
- Verified all four memory files (`CLAUDE.md`, `CLAUDE_RULES.md`, `LAST_SESSION.md`, `CHANGELOG.md`) are present and synced via Google Drive on the laptop.
- Found an existing `%USERPROFILE%\.claude\settings.json` on the laptop containing only `{"theme": "dark"}`. Merged in `permissions.defaultMode: "auto"` while preserving the existing `theme` key (no settings lost).
- Created the previously-missing `G:\My Drive\setup-claude-auto.bat` — one-double-click Auto Mode setup for any machine: makes `%USERPROFILE%\.claude\`, writes `{"permissions":{"defaultMode":"auto"}}` only if no settings.json exists, otherwise warns the user to verify manually.

**Flag raised + resolved this session:**
- Concern: the original desktop session may have written `defaultMode` at the wrong nesting level.
- Verified from the desktop this session: `C:\Users\atenr\.claude\settings.json` reads `{"permissions":{"defaultMode":"auto"}}` — correctly nested at `permissions.defaultMode`. No issue. Flag closed; no further desktop verification needed.

**Files touched:**
- `%USERPROFILE%\.claude\settings.json` (laptop — `theme` preserved, Auto Mode merged in)
- `G:\My Drive\setup-claude-auto.bat` (new)
- `G:\My Drive\dynatrack-wms\LAST_SESSION.md` (this entry)
- `G:\My Drive\dynatrack-wms\CHANGELOG.md` (one-line entry)

**No code or schema changes.**

## 13:29 UTC — Doc corrections: placeholder timestamp + rule 5 wording

**What was changed:**
- Corrected the placeholder `22:00 UTC` stamp on the "Initial project memory setup" entry below to `12:00 UTC`, so it sorts correctly as the earliest session of the day (before the 13:13 UTC reorder session). The original 22:00 was never the real time of that work.
- Reworded `CLAUDE_RULES.md` rule 5 for the newest-at-top convention: "Append" → "Prepend" for adding session entries, and clarified that the file's "append-only" nature means *never delete old entries* (not append-at-bottom).

**Files touched:**
- `G:\My Drive\dynatrack-wms\LAST_SESSION.md` (timestamp fix + this top entry)
- `G:\My Drive\dynatrack-wms\CLAUDE_RULES.md` (rule 5 reworded)

**Notes / pending:**
- The 13:13 UTC entry below still contains a note saying the entry beneath it is "stamped 22:00 UTC ... later in the clock-day." That note is now stale (the stamp is 12:00 UTC), but it's a historical session record in an append-only log, so it was left as-written rather than rewritten.

**Production status at session end:**
- HawkerWMS live at `hawkerwms.up.railway.app` — healthy. No code or schema touched this session.

## 13:13 UTC — Flip session log + changelog to newest-at-top ordering

**What was changed:**
- Reversed the entry-ordering convention of `LAST_SESSION.md` and `CHANGELOG.md` from newest-at-BOTTOM to newest-at-TOP, matching the Darkhawk convention.
- Reworded the header instruction line in both files accordingly.
- Reordered existing entries (currently one per file, so the reorder was cosmetic). Going forward: newest `# YYYY-MM-DD` date header on top; within a day, newest `## HH:MM UTC` session on top. This note is now the top entry.

**Files touched:**
- `G:\My Drive\dynatrack-wms\LAST_SESSION.md` (header reworded + this new top entry)
- `G:\My Drive\dynatrack-wms\CHANGELOG.md` (header reworded + new top entry)

**Notes / pending:**
- `CLAUDE_RULES.md` rule 5 still calls `LAST_SESSION.md` "append-only." Under newest-at-top that effectively means "prepend, never delete old entries." Consider rewording rule 5 if the word "append" reads as misleading. (Not changed this session — out of scope.)
- The entry below is stamped `22:00 UTC`, which is later in the clock-day than this entry's real timestamp (13:13 UTC). Historical stamp left as-is; not rewritten.

**Production status at session end:**
- HawkerWMS live at `hawkerwms.up.railway.app` — healthy. No code or schema touched this session.

## 12:00 UTC — Initial project memory setup

**What was changed:**
- Established the four-file project memory system mirroring the Darkhawk pattern:
  - `CLAUDE.md` — boot loader, anti-rogue rules, sync architecture
  - `CLAUDE_RULES.md` — 34 numbered constraints across workflow, database, deployment, frontend, eBay, data integrity, environment
  - `LAST_SESSION.md` — this file, append-only session log
  - `CHANGELOG.md` — chronological summary of changes
- Project folder relocated from `C:\Users\atenr\Documents\dynatrack-wms` to `G:\My Drive\dynatrack-wms` (Google Drive synced across desktop + laptop)
- Claude Code Auto Mode enabled on desktop via `C:\Users\atenr\.claude\settings.json`
- Batch file `G:\My Drive\setup-claude-auto.bat` created to enable Auto Mode on laptop with one double-click
- Replaced earlier draft CLAUDE.md (which had a wrong path `HawkerWMS\dynatrack-wms`) with the new four-file system

**Files touched:**
- `G:\My Drive\dynatrack-wms\CLAUDE.md` (replaced)
- `G:\My Drive\dynatrack-wms\CLAUDE_RULES.md` (new)
- `G:\My Drive\dynatrack-wms\LAST_SESSION.md` (new — this file)
- `G:\My Drive\dynatrack-wms\CHANGELOG.md` (new)
- `C:\Users\atenr\.claude\settings.json` (new — Auto Mode)
- `G:\My Drive\setup-claude-auto.bat` (new — laptop setup script)

**What is still broken / pending:**
- Laptop Auto Mode setup not yet applied (Ry needs to double-click the batch file on the laptop)
- Final fresh data extract from the old paid WMS (`wms-prod.up.railway.app`) not yet done — captures moves and new items since 2026-04-02
- Warehouse tablets may still be pointed at the old WMS URL — verify and update
- Old paid WMS still subscribed at $300/mo — cancel at cutover
- ~424 items from old WMS uncaptured (pagination limits); will populate naturally via scanning

**What is next:**
- Verify the four files are visible on the laptop after Drive sync completes
- Run laptop batch file to enable Auto Mode on laptop
- Decide on the cutover plan: when to flip warehouse tablets from old WMS to HawkerWMS, when to do the final extract, when to cancel the old subscription
- Confirm HawkerWMS production is fully feature-complete vs the old paid WMS before cutover

**Production status at session end:**
- HawkerWMS live at `hawkerwms.up.railway.app` — healthy
- 537 locations, 3,380 items, 3,969 moves, 12 sequences (as of 2026-04-02 seed)
