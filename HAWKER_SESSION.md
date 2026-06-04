<!-- SYNC STAMP -->
LAST PUSHED COMMIT: 68d6eb2 @ 2026-06-04 18:40 UTC (move-endpoint status-clobber fix — status now follows destination TYPE; 16 sold-shipped phantoms remediated STORED→SHIPPED; code live at 8043ae0). All prior work LIVE on origin/main.
STAMP UPDATED BY: Claude Code, session 18:40 UTC 2026-06-04
<!-- END SYNC STAMP -->

# HAWKER_SESSION.md

Append-only log of every session. Newest entries go at the TOP. Each session header: `## HH:MM UTC — Description`. Each day gets a `# YYYY-MM-DD` header.

---

# 2026-06-04

## 19:05 UTC — SKU normalization: strip a trailing "*" (and letter+"*" combos) so *-suffixed serials match (Rule 8)

**Single deliverable** (scope-guarded — NOT the rack/Locations work, that's a separate session; Rules A/2). Byte-identical one-char regex change in BOTH `normalizeSkuKey` copies + snapshot/doc updates. No schema change; eBay read-only (Rule 25); no DB write. HEAD at start `085881f` (stamp → 68d6eb2).

### Diagnose-first (Rule 1, read-only)
- Both `normalizeSkuKey` bodies use the identical `.replace(/[A-Z]+$/,'')` (server.js:854 param `s`; index.html:1850 param `sku` — logic identical, which is the Rule-8 requirement; only the param name differs).
- `reconcileOrderLines` Phase-1 upsert sets `sku_norm = EXCLUDED.sku_norm` (NOT COALESCE) → recomputed fresh on every upsert → **no backfill needed** (a normal orders re-sync recomputes old rows). Caveat: only lines re-fetched within eBay's ~90-day window refresh — older `*` rows (mostly already-SHIPPED) keep a stale `sku_norm` until then; the gated backfill (`UPDATE … SET sku_norm = NULLIF(regexp_replace(upper(btrim(sku_raw)),'[A-Z*]+$',''),'') WHERE sku_raw LIKE '%*%'`) is available if Ry wants the 28 normalized immediately — NOT run this session.
- **`items` carrying `*`: 0** — no WMS serials carry `*` today, so zero current WMS-Only false-unmatch; the change is forward-correct hardening. **`ebay_order_lines.sku_raw` carrying `*`: 28 rows / 25 distinct** (e.g. `ENG4007V*`, `INT4366R*`, `MOD17984*`, `INT3980V**`, `MOD18527V*`, `MOD19488R*`); the trailing-`*` single-serial ones now normalize correctly (the `*` previously blocked the trailing-letter strip). Mid-string `*` (e.g. `CLU0859R*/007511`, `MOD16175* MOD12954`) is the internal-id/multi-serial form handled by the frontend `listedSerialKeys` — out of scope, unchanged.

### The change
`normalizeSkuKey`: `/[A-Z]+$/` → `/[A-Z*]+$/` in **public/index.html AND server.js** (byte-identical regex). Strips any trailing run of letters and/or `*` (`V`, `R`, `*`, `V*`, `R*`, `*R`, `**`) to the bare serial; digit-terminated serials and hyphenated/numeric junk (`MOD-20359`, `000002`) untouched, so `isIncompleteKey` still catches real junk.

### Verify (Rule 17)
`node --check` server.js OK. Normalizer spot-check (new regex): `INT4306V*` / `INT4306*` / `INT4306R*` / `INT4306R` / `INT4306` / `INT3980V**` → bare (`INT4306` / `INT3980`); `MOD-20359` & `000002` unchanged; `"MOD16175* MOD12954"` left whole (multi-serial → `listedSerialKeys`). `/api/health` 200 post-deploy.

### Files
server.js, public/index.html, SNAPSHOT_ROUTES.md, SNAPSHOT_FRONTEND.md, HAWKER_SESSION.md, HAWKER_CHANGELOG.md. No schema change, no DB write (backfill not needed — fresh recompute on re-sync).

### Memory files
HAWKER_SESSION + HAWKER_CHANGELOG (+ SNAPSHOT_ROUTES/FRONTEND) updated → **Ry: re-upload the four memory files (Rule 39).**

## 18:40 UTC — Fix: move endpoints clobber status to STORED at the SHIPPED location (phantom inventory / oversell) + remediate 16 sold-shipped phantoms

**Single deliverable, prioritized AHEAD of the Returns build (live, recurring daily).** server.js (both move handlers) + public/index.html (Confirm preview) + a gated one-off remediation UPDATE. **No schema migration** (Rule 9 n/a). eBay read-only (Rule 25); no new status (Rule 11). Briefed-from `0dd17eb @ 03:30 UTC`; true HEAD at start `585b660`, pulled ff-only, built against it.

### The bug (root cause, confirmed in code)
`/api/move` (server.js:306) and `/api/move/batch` (server.js:387) hardcoded `status='STORED'` on EVERY move — including into the front-door **SHIPPED** location. Staff scan sold/outbound items to SHIPPED as normal daily work, so the endpoint silently flipped them back to active inventory → Inventory Health + pick-matching counted them available (phantom / oversell). Per Ry, the SHIPPED location is the physical front-door staging area where the mailman collects: an item there is sold/outbound = present but NOT available, so status there must be SHIPPED.

### Step 0 (read-only, reported before any change)
- **Type-casing correction to the brief:** the shipped location is stored `name='SHIPPED', type='SHIPPED'` (UPPERCASE) — the brief's assumed `type='shipped'` would have no-op'd. Fix matches case-insensitively (`UPPER(type)='SHIPPED'`), type-based (rename-robust). Location types: SHELF_BIN 526 / UNLISTED_TOTE 21 / SHIPPED 1.
- **Exposure:** 25 `status='STORED'` at the SHIPPED location = **16** with a matched `ebay_order_lines disposition='SHIPPED'` (sold+shipped) + **9** without. 0 divergence (type- and name-based select the same single location).
- **Oversell (eBay back up — Dynatrack 3,355 / AutoLumen 543 listings):** of the 16, **1 actively listed available>0 = MOD20606 (dynatrack, avail 1)** = imminent double-sell; 15 listed but sold-out (avail 0); 0 not listed.
- **All status writers:** the two move endpoints are the only paths that silently force the wrong status on a normal scan-to-SHIPPED. (reconcile Phase 2 @999 correctly sets SHIPPED; `/api/intake`@344 hardcodes STORED but new-items-only — flagged Rule B; `POST /api/items`@206 / `PATCH /api/items/:serial`@219 set status explicitly = admin paths.)

### The fix (status follows destination TYPE)
Both move endpoints now ensure the destination location row exists, read its `type`, set `destStatus = UPPER(type)='SHIPPED' ? 'SHIPPED' : 'STORED'`, applied to both insert + update paths (single: server.js ~300–313; batch: computed once before the loop, applied to existing-UPDATE + new-INSERT). Returns-revert preserved automatically (shelf dest → STORED). **public/index.html `goToConfirm`:** destination-aware Confirm preview — `destIsShipped` (from `scanLocations` type) shows items will be marked SHIPPED (sold/outbound, not available) + per-row `(→ SHIPPED · staged at front door)`; a shelf dest keeps `(was shipped → back to STORED)`. **SHIPPED stays a selectable destination** (Ry deliberately scans outbound items there) — fixed the status, not the picker.

### Remediation (gated: dry-run → Ry Railway snapshot + go-ahead → --commit)
`UPDATE items SET status='SHIPPED'` for the 16 STORED-at-SHIPPED with a matched SHIPPED line. **NO moves rows** (Ry's call — `moves` stays a physical-movement log; consistent with the ship-once / intake_date backfills; remediation recorded HERE instead). **The 16:** CLU0815, ECU0539, ENG5006, INT2999, INT4232, INT4356, INT4839, MOD13389, MOD13610, MOD13738, MOD14214, MOD18366, MOD18579, MOD20606, MOD20635, MOD20656. Dry-run (BEGIN…ROLLBACK) → 16 updated, after 0 matched / 9 untouched; committed after snapshot + go-ahead → **live: 16 updated, 0 matched STORED@SHIPPED remaining, 9 untouched.**

### ⚠️ Handoffs to Ry (cross-boundary, not Claude Code)
- **MOD20606's eBay listing is still LIVE (dynatrack, avail 1).** The WMS status fix removes it from available WMS stock but does NOT touch eBay (Rule 25). **End/correct that listing in Seller Hub** or it can still be bought while the unit is gone.
- **The 9 unmatched (left untouched — Ry triage):** 001697, ENG4125, FUS2334, MOD15864, MOD16285, MOD18907, MOD18989, MOD19009, MOD19488 — each scanned shelf→SHIPPED (dynatrack, Jun 1–4), no matched SHIPPED order line; reconcile won't auto-fix (Phase 2 needs a matched line). With the fix deployed, re-scan to correct: to a shelf → STORED (mis-scan / back in stock), or leave at SHIPPED → stays SHIPPED (sold-not-yet-reconciled).

### Verify (Rule 17)
`node --check` server.js OK. Endpoint behavior (rolled-back txn on real serial 000002): → SHIPPED location ⇒ SHIPPED@SHIPPED; → shelf HR01S01 ⇒ STORED@HR01S01. Remediation post-write: 0 matched STORED@SHIPPED, 9 unmatched untouched. `/api/health` 200 (db connected) post-deploy. index.html edits live inside runtime-generated JS strings → static `.page`/div structure unchanged.

### Files / commits
server.js, public/index.html → commit `8043ae0` (pushed FIRST → Railway auto-deploy). SNAPSHOT_ROUTES.md, SNAPSHOT_FRONTEND.md, HAWKER_SESSION.md, HAWKER_CHANGELOG.md → session-end commit. No schema change.

### Deferred / Rule B
- The SHIPPED location carrying two meanings (logical "gone" vs physical front-door staging) under one name is the conceptual root — a future `OUTBOUND`/`FRONT_DOOR` location or a `STAGED` status is a separate design decision, not now.
- `/api/intake` also hardcodes STORED (new-items-only) — same class, not implicated; flagged.
- **Returns build (migration 0007) resumes next.**

### Memory files
HAWKER_SESSION + HAWKER_CHANGELOG + SNAPSHOT_ROUTES + SNAPSHOT_FRONTEND updated → **Ry: re-upload the four memory files (Rule 39).**

# 2026-06-03

## 05:12 UTC — Persistent session store: logins survive deploys/restarts (DB-backed sessions, migration 0006)

**Single deliverable (lead hardening item):** moved auth tokens from an in-memory `Map` into a Postgres `sessions` table, so a deploy/restart no longer drops the tablet's login. Migration + `server.js` only — **no frontend change** (confirmed); eBay untouched (Rule 25); no new env var.

### Diagnose-first (Rules 1, E)
Read the real auth code: in-memory `sessions` Map, `createToken` (`crypto.randomBytes(32).hex` = 64-char), sync `validateToken` (slides expiry), hourly Map sweep, `requireAuth`. Grepped the frontend (`x-wms-token`/`wms_token`/`WMS_TOKEN`/`showLogin`): the token is **opaque to the frontend** — it stores `data.token` in localStorage and sends `x-wms-token`; only the `{ok,token,username}` / `{username}` shapes + header name matter. **Confirmed no index.html change needed.**

### Migration 0006 (db/migrations/0006-sessions.sql, applied to prod)
`CREATE TABLE sessions (token TEXT PK, username TEXT NOT NULL, created_at, expires_at TIMESTAMPTZ NOT NULL)` + index on `expires_at`. Additive, empty. schema.sql not edited (Rule 9).

### server.js (Map → table; every contract kept; handlers now async)
- New **`touchSession(token)`** = atomic read-and-slide `UPDATE sessions SET expires_at=NOW()+INTERVAL '12 hours' WHERE token=$1 AND expires_at>NOW() RETURNING username` → username or null. Used by `requireAuth` (now async) **and** `/api/me`.
- `/api/login`: same `crypto.randomBytes(32).hex` token → `INSERT INTO sessions … expires_at=NOW()+12h`; response `{ok,token,username}` unchanged.
- `/api/logout`: `DELETE FROM sessions WHERE token=$1`. `/api/me`: `touchSession` → `{username}` or 401.
- Hourly cleanup repointed to `DELETE FROM sessions WHERE expires_at<=NOW()` (moved after `pool`). **Removed** the Map + `createToken`/`validateToken`/`SESSION_TTL_MS`. No new env var; token stored raw (hashing = future Rule-B).

### Apply order (gated)
Migration applied to prod FIRST (table live: token PK + 2 indexes, 0 rows) after Ry's go-ahead → THEN push server.js (Railway auto-deploy, Rule 16). Order matters: code referencing the table can't ship before it exists.

### Verify (Rule 17)
`node --check` server.js OK; no leftover in-memory refs; **only server.js changed** (index.html untouched). Headless SQL (rolled-back txn, created the table + ran every route query): login INSERT + touchSession(live)→AUTH user=admin; expired→401; garbage→401; logout DELETE→1 then no-auth; cleanup reclaims expired — all PASS. (The "slide didn't advance" line was a test artifact: Postgres `NOW()` is the txn-start time, constant within one txn; in prod each request is its own auto-committed query so the 12h window genuinely slides — same as the old `validateToken`.) **Restart-survival test (the whole point) = post-deploy below.**

### ⚠️ One-time behavior (told Ry)
The deploy shipping this **logs everyone out once** — the restart wipes the old in-memory Map regardless. After that, logins persist across deploys. Pushed with Ry's go-ahead (not mid-scan).

### Files
db/migrations/0006-sessions.sql, server.js, SNAPSHOT_ROUTES.md, SNAPSHOT_SCHEMA.md, HAWKER_SESSION.md, HAWKER_CHANGELOG.md. No frontend change. Commit `288d334`.

### Memory files
HAWKER_SESSION + HAWKER_CHANGELOG updated → **Ry: re-upload the four memory files (Rule 39).** Next: the **Returns brief** (its migration = 0007).

## 03:27 UTC — READ-ONLY DIAGNOSTIC: no-location pick lines + returns (no code/DB/eBay writes)

Architect brief: measure the proportions of the 3 causes behind "no location" pick lines before picking a fix. Briefed-from stamp `167dfd1` = matches HEAD. **READ-ONLY** — diagnostics only, no writes; throwaway scripts deleted (Rule C).

### Diagnose-first (Rule 1) — confirmed at HEAD
`reconcileOrderLines` Phase 1: `storedByKey`= `normalizeSkuKey(serial)` over STORED-active items; `skuNorm=normalizeSkuKey(line.sku)`; cands=`storedByKey[skuNorm]` → 1 match else `location_unknown=true`/`matched_serial=null` (never guesses >1). ON CONFLICT recomputes `location_unknown`, COALESCEs `matched_serial`, never lists `ship_move_applied_at` (preserved). Phase 2 candidate carries `AND ship_move_applied_at IS NULL`. `listedSerialKeys` is frontend-only (read verbatim).

### FINDINGS
- **Step 1 — ship-once fix HOLDING:** `would_reship` (STORED-active + unstamped SHIPPED line) = **0** ✓. 5 SHIPPED lines unstamped = genuine new post-backfill ships (correct).
- **Step 2 — ZERO no-location pick lines right now.** ebay_order_lines: SHIPPED 1881 / CANCELLED 76 / **NEEDS_PICK 16**. All 16 NEEDS_PICK are **fresh (paid Jun 2–3), matched to a STORED item, on a real shelf** — `location_unknown=TRUE` among NEEDS_PICK = 0; matched-but-null-location = 0; dangling matched_serial = 0. **`stored_but_unmatched_INVESTIGATE` = 0** (no matching bug). Suffixed single-serial SKUs (`ENG4915R`→`ENG4915`, `MOD12687V`→`MOD12687`) match fine via the trailing-letter strip.
- **Latent mechanism footprint:** `location_unknown=TRUE` across ALL dispositions = 1749 SHIPPED + 50 CANCELLED (already-resolved, NOT picks — mostly cutover-dropped shipped serials). **Compound (whitespace) sku_raw = only 2 lines total, both SHIPPED, both junk (`"Warehouse 1V"`); 0 compound NEEDS_PICK.** So **cause 2 (multi-serial sale) is not manifesting** — no real multi-serial listing has a pending paid-unshipped sale.
- **Step 3 — server-side `listedSerialKeys` would rescue ~0 pick lines today** (no compound NEEDS_PICK exist to resolve). It remains correct *insurance* for when a real multi-serial listing sells, but is **not currently urgent** by the numbers.
- **Step 4 — DEFERRED: eBay API returned HTTP 503 (Service Unavailable, HTML) for both stores** (creds present, token-len 96 → transient eBay-side/rate-limit, not auth). The live listings pull + Inventory Health "Sync listings" would fail at this moment; retry later. (Reconfirms the `ebayCall` gotcha: it ignores `res.statusCode` so a 503 resolves as empty-Ack data.)

### Interpretation
The no-location pick lines Ry saw earlier were the **pre-cutover returns/strays** (ENG re-clobbers, refund strays) — now **resolved** by the ship-once fix + dismissals + orders aging out of eBay's 90-day window. The active sheet is currently clean. The real, *recurring* gap is **visibility of returns physically on shelves** (the 69 pre-cutover SHIPPED-on-shelf items; items that are `status=SHIPPED` but actually back in a bin) — invisible today, and they reseed no-location picks / eBay-Only inflation when relisted.

### Recommendation (architect chooses one)
1. **`RETURNED` disposition at scan-back + a Returns view (lead recommendation).** Addresses the live pain — return visibility for the 69 + future returns — which the numbers say dominates. Ship-once stopped the re-ship; this surfaces "SHIPPED item is back on a shelf."
2. **Mirror `listedSerialKeys` server-side** — correct insurance but rescues ~0 today (defer until a multi-serial sale actually lands, or do opportunistically).
3. Re-run **Step 4** once eBay's 503 clears, to quantify eBay-Only relisted-return inflation + overlap with the 69 (informs #1's priority list).

### Files
HAWKER_SESSION.md + HAWKER_CHANGELOG.md only (findings record). No code/schema/DB/eBay writes. → **Ry: re-upload memory files (Rule 39).**

# 2026-06-01

## 00:20 UTC — Inventory Health: Hide/Restore omissions for eBay-Only + WMS-Only (persisted)

**Single deliverable:** a per-row **Hide** on the Inventory Health eBay-Only and WMS-Only lists → moves the row to a de-emphasized **Hidden** sub-section (declutter to actionable discrepancies); Restore brings it back. **Persisted server-side** (survives refresh/re-sync/device, like Pick List DISMISSED). ONE migration + 3 routes + frontend. **Scope: ONLY these two buckets** (no Hide on Matched/Duplicate/Cross-listed/Staging/Incomplete). View-suppression only — never touches items/moves/listings; eBay read-only (Rule 25). Reused top-level `normalizeSkuKey`.

### Step 0 diagnose (Rule 1) — the stable per-row keys
Read `loadInventoryHealth`: rows are keyed by `normalizeSkuKey`. **WMS-Only** omit key = **`r.wms[0].serial`** (item serial; rows are ~always 1 item). **eBay-Only** omit key = **`r.key`** (the row's NORMALIZED key) — confirmed raw SKU is NOT unique: a multi-serial listing (`"MOD15959V 16367V"`) makes two eBay-Only rows sharing one raw SKU, but distinct `r.key`s; the normalized key is also stable across re-syncs (same listing → same `listedSerialKeys`). Reported before wiring.

### Migration 0005 (db/migrations/0005-health-omissions.sql, applied to prod)
`CREATE TABLE health_omissions (omit_key TEXT, bucket TEXT CHECK IN ('WMS_ONLY','EBAY_ONLY'), note TEXT, created_at, PRIMARY KEY(omit_key,bucket))`. Additive, starts empty.

### Routes (server.js, mirror dismiss/restore)
`GET /api/health/omissions` → `{wmsOnly:[],ebayOnly:[]}`; `POST /api/health/omissions {key,bucket,note?}` → INSERT ON CONFLICT DO NOTHING; `POST /api/health/omissions/restore {key,bucket}` → DELETE. Bucket-guarded (400 on bad bucket). No eBay, no items/moves.

### Frontend (public/index.html)
- `loadInventoryHealth` fetches the omission set alongside items/listings into `healthOmitWms`/`healthOmitEbay`.
- **`applyHealthOmissions`** (factored out; also re-run on hide/restore WITHOUT a refetch): marks `r.hidden`, recomputes bucket **headline + WMS-Only age-band counts EXCLUDING omitted**, sets a `· N hidden` sub-count under the WMS-Only card + `#h-ebay-hidden` under the eBay-Only card + tab labels (active counts).
- `renderHealthTable`: WMS-Only view = active grouped by band **+ Hidden sub-section**; eBay-Only = active flat **+ Hidden**; All/other suppress hidden rows. WMS-Only band-grouping applied AFTER the valid/age-band split (an omitted valid item → Hidden, not its band); Incomplete unchanged.
- `healthRowHtml` adds a subtle Hide button (active) / Restore button (hidden) on those two buckets only. `exportHealthCSV` gains an `Omitted` column. Theme: light, Hidden section styled like Pick List Errors/Dismissed (Rule 21).

### Verify (Rule 17)
`node --check` server.js + inline JS OK; **div balance 342/342; 11 `.page` divs depth-0 siblings (page-health not regressed)**; migration table live (0 rows). Routes registration + the hide→count−1→Hidden→Restore round-trip + persistence across reload/re-sync = post-deploy (routes 401 unauth) + **Ry's tablet pass**. `/api/health` 200 post-deploy.

### Files
db/migrations/0005-health-omissions.sql, server.js, public/index.html, SNAPSHOT_SCHEMA.md, SNAPSHOT_ROUTES.md, SNAPSHOT_FRONTEND.md, HAWKER_SESSION.md, HAWKER_CHANGELOG.md. Commit `167dfd1`.

### Memory files
HAWKER_SESSION + HAWKER_CHANGELOG updated → **Ry: re-upload the four memory files to claude.ai project knowledge (Rule 39).**

# 2026-05-31

## 23:14 UTC — Fix: reconcile re-ships returned items (Phase 2 ship-once guard, migration 0004)

**Single deliverable:** stop `reconcileOrderLines` Phase 2 from re-shipping returned items. server.js + ONE additive migration. No frontend, no eBay writes (Rule 25), no new item status (Rule 11), no RETURNED disposition (deferred). Builds on last night's read-only diagnostic (ENG4911/ENG5036/ENG4987/ENG5004/ENG4367).

### The bug
Phase 2 ship-moved ANY item that is `STORED` with a matched `disposition='SHIPPED'` line. A returned item legitimately back on a shelf (STORED) re-shipped on **every** eBay sync, because its original order line stays SHIPPED inside eBay's ~90-day GetOrders window. (During this session a sync re-clobbered the 5 again — they were SHIPPED on arrival, plus a 6th, ENG4612, found STORED with an unstamped SHIPPED line.)

### Step 0 diagnose (Rule 1)
Re-read Phase 1 upsert + ON CONFLICT and Phase 2 (candidate `SELECT i.serial … WHERE status='STORED' AND archived_at IS NULL AND EXISTS(SHIPPED line)`; per-item `BEGIN`/`FOR UPDATE`/flip/move/`COMMIT`). Confirmed Phase 1's ON CONFLICT lists explicit columns → a new column is preserved on conflict automatically.

### Migration 0004 (db/migrations/0004-orderline-ship-move-applied.sql, applied to prod)
`ALTER TABLE ebay_order_lines ADD COLUMN IF NOT EXISTS ship_move_applied_at TIMESTAMPTZ` (nullable, null = ship-move not yet applied) + partial index `(matched_serial) WHERE disposition='SHIPPED' AND ship_move_applied_at IS NULL`. Additive/idempotent; schema.sql not edited (Rule 9).

### server.js (reconcileOrderLines Phase 2)
- Candidate guard: `AND e.ship_move_applied_at IS NULL` added to the EXISTS subquery (ship only unapplied SHIPPED lines; still STORED + archived_at IS NULL).
- In the SAME ship-move txn (after the item flip + moves row): `UPDATE ebay_order_lines SET ship_move_applied_at=NOW() WHERE matched_serial=$1 AND disposition='SHIPPED' AND ship_move_applied_at IS NULL` — atomic (rolls back together).
- Phase 1 ON CONFLICT unchanged → never clears a stamp. Net: a line ships its item once; a return to STORED is left alone; a genuine re-sale (new OLI, fresh NULL line) ships once.

### One-time backfill (gated; dry-run → Ry go-ahead → committed)
`UPDATE ebay_order_lines SET ship_move_applied_at=COALESCE(ebay_shipped_time,last_synced,NOW()) WHERE disposition='SHIPPED' AND ship_move_applied_at IS NULL` — **stamped 1,842 SHIPPED lines** so no existing ship re-clobbers. Gate decision: the single currently-STORED candidate **ENG4612** ship date 2026-04-15 = **PRE-cutover** → another return → full backfill correct (Ry's rule). Committed. Post: 0 unstamped SHIPPED lines, **0 Phase-2 candidates**, all 6 (5 + ENG4612) applied.

### Verify (Rule 17)
Dry-run (BEGIN…ROLLBACK) → 1,842 rows; candidates after backfill 0; the 5 not candidates; **simulated a genuine new ship** (`MOD20284` NEEDS_PICK→SHIPPED, unstamped) → becomes a candidate (ships once) ✓. `node --check` server.js OK. `/api/health` post-deploy below.

### Step 4 review list (read-only, NOT mutated) — handed to Ry
**69 items** currently `status='SHIPPED'` whose order shipped before the 2026-05-30 cutover = candidate unnoticed pre-cutover returns physically on a shelf (serial · last-known shelf · ship date · store). Ry reviews + scans the real ones back; with the ship-once fix they then STAY STORED. No status auto-reverted.

### Files
db/migrations/0004-orderline-ship-move-applied.sql, server.js, SNAPSHOT_SCHEMA.md, SNAPSHOT_ROUTES.md, HAWKER_SESSION.md, HAWKER_CHANGELOG.md. No frontend change. Commit `a59ed96`.

### Deferred (not this session)
A `RETURNED` disposition set at scan-back + a Returns view (visibility/audit). The ship-once guard fixes the bug without it.

### Memory files
HAWKER_SESSION + HAWKER_CHANGELOG updated → **Ry: re-upload the four memory files to claude.ai project knowledge (Rule 39).**

## 21:06 UTC — Inventory Health WMS-Only cleanup: Incomplete-SKU section + age bands (Phase 2)

**Single deliverable, frontend only** (public/index.html — `loadInventoryHealth`/`renderHealthTable`/`exportHealthCSV` + helpers). Builds on Phase 1's `intake_date` backfill. **Only the WMS-Only bucket changed** — Matched/eBay-Only/Duplicate/Cross-listed/Staging untouched (Rules A/B/2). No eBay writes (Rule 25), no theme change (Rule 21). REUSED the top-level `normalizeSkuKey`.

### Step 0 diagnose (Rule 1)
- `GET /api/items` is `SELECT * FROM items` → `intake_date` already in every row. **No server change** (the only possible server touch — avoided).
- **Refined incomplete detection.** The earlier audit's `^[A-Z]{2,4}[0-9]+$` (case-sensitive, raw) over-flagged 236 by rejecting valid suffixed serials (`INT4306R` ends in a letter). Canonical rule: `!/^[A-Z]{2,4}\d+$/.test(normalizeSkuKey(serial))` (normalizer strips the trailing letter). **Refined count = 179** (down from 236): **57** were valid suffixed serials now correctly KEPT (`ENG4113V`→`ENG4036V`…). Remaining 179 = 60 numeric-only (`000002…`), 116 hyphenated (`MOD-20359…`), 2 URL pastes, 1 single-letter prefix.

### Built (Steps 1–3)
- **Step 1 — Incomplete SKUs:** in the client reconcile, an unlisted item failing the rule (`isIncompleteKey`) → new **`Incomplete`** status (pulled OUT of WMS Only). Added a 9th stat card `#h-incomplete`, an Incomplete filter tab, and it renders in the existing table (Serial · raw form · location). WMS-Only count/table now EXCLUDE these.
- **Step 2 — age bands** on the remaining valid WMS-Only items: `ageDaysFromIntake` (date-only, TZ-safe, same-day/future=0) + `ageBand` (half-open: **New 0–13 green / Aging 14–20 yellow / Overdue 21+ red / Unknown gray**). When the WMS-Only tab is active, rows render **grouped by band** (Overdue→Aging→New→Unknown, colored section headers + counts, New visually set apart as "fine, give it time"). New **age-band chips** (`#health-band-tabs`: All/Overdue/Aging/New → `filterHealthBand`, auto-switches to the WMS-Only tab). One-line red·yellow·green breakdown under the WMS-Only card (`#h-wms-bands`). `healthRowHtml` factored out of `renderHealthTable`; WMS-Only rows show a band-colored `Nd` age.
- **Step 3 — export:** `exportHealthCSV` gains `WMS Intake Date, Age Days, Age Band, Incomplete` columns (single header button kept).

### Verify (Rule 17)
`node --check` inline JS OK; **div balance 341/341; 11 `.page` divs all depth-0 siblings, `page-health` at depth 0** (the once-swallowed page — not regressed); 9 stat cards. Refined incomplete = **179** (deterministic, confirmed vs the live items). Age-band thresholds verified in SQL (Overdue 2,537 / Aging 163 / New 693 / Unknown 0 = 3,393, sum ✓) with spot-checks: Feb-06 item (`001839`, age 114) → **Overdue/red**, today's item (`MOD12549`, age 0) → **New/green**. The exact on-page WMS-Only/Incomplete/band counts are the **live browser reconcile** (needs `ALL_LISTINGS` from a sync) → **Ry's tablet pass:** Inventory Health → Sync listings → confirm the Incomplete section lists the numerics/junk, the green/yellow/red bands render + chips filter, CSV has the new columns. `/api/health` 200 (post-deploy).

### Observation (NOT this session, Rule B)
~57 items store **suffixed serials** (`INT4306R`) in `items.serial`, contrary to the bare-serial convention (Rule 8). This change tolerates them as valid (correct), so not blocking — a later dedicated normalize-to-bare pass may be worth it. Flagging, not fixing.

### Files
public/index.html, SNAPSHOT_FRONTEND.md (no SNAPSHOT_ROUTES — `/api/items` unchanged), HAWKER_SESSION.md, HAWKER_CHANGELOG.md. No server/schema change. Commit `f71d43e`.

### Memory files
HAWKER_SESSION + HAWKER_CHANGELOG updated → **Ry: re-upload the four memory files to claude.ai project knowledge (Rule 39).**

## 20:34 UTC — Backfill items.intake_date from the extract's createdAt (REVERSES the cutover's "age forward only")

**⚠️ DELIBERATE REVERSAL — do not flag as contradicting the 18:11 cutover note.** The cutover left `intake_date` NULL ("age forward only") because the old WMS rewrites scan dates on re-consolidation (last-touched, not true first-intake). **Ry decided 2026-05-31 to backfill anyway:** for an unlisted-aging view, a real date beats NULL, and the caveat is accepted. Data UPDATE only — `intake_date` exists (migration 0002), so no schema/migration. No `moves` rows (Rule 13 is for location/status, not a date correction). Keyed on `serial` (immutable, Rule 30). eBay untouched (Rule 25).

### Step 0 (read-only) — settled the memory conflict + picked the field
- Live `intake_date` state: total **3,393** / with-date **3** / NULL **3,390**. (Records said 0 with-date — the real number is **3**: post-cutover app-intakes that stamp `intake_date`. The backfill's `IS NULL` guard protects them.)
- Extract `wms-final-extract-2026-05-30 (6).json` confirmed present; all 3,390 live (non-SHIPPED) items have both `createdAt` + `updatedAt`, all UTC, none future/absurd.
- **Field = `createdAt`** (Ry's call, after seeing the distribution). `createdAt` (true first-seen) vs `updatedAt` (last-handled): `updatedAt` collapses **84% into May (2,846)** because the bulk re-consolidation rewrote ~half the dates (50.7% shifted 31–90 days); `createdAt` preserves the real spread (Mar 1,780 / Apr 508 / May 1,045). For aging, `createdAt` is the better signal.

### Backfill (gated, mirrored the cutover)
Throwaway tmp script (no new repo file — Rule C; mirrors the cutover harness): `UPDATE items SET intake_date = extract.createdAt::date(UTC) WHERE serial=$1 AND intake_date IS NULL` (fills NULLs only — never clobbers a real scan date), single txn, chunked VALUES-join. **Dry-run (BEGIN…ROLLBACK)** reconciled to the row: 3,390 updated → 0 remaining NULL, 0 future-dated, 0 NULL-serials-not-in-extract. **Ry: explicit go-ahead** (createdAt confirmed) → `--commit`. Wrote a precise rollback artifact `~/hawker-intake-backfill-rollback-2026-05-31T20-32-45Z.json` (the exact 3,390 serials; undo = set them back to NULL).

### Verify (fresh connection) — ALL PASS
Live items **3,393**, all with `intake_date`, **0 NULL**; span **2026-02-06 .. 2026-05-31** (54 distinct days); **0 future-dated**, 0 before-2025; monthly Feb 57 / Mar 1,780 / Apr 508 / May 1,048. `/api/health` 200. No schema change; no `moves` written. Updated SNAPSHOT_SCHEMA + HAWKER_RULES rule 27 ("intake_date NULL" → "backfilled 2026-05-31 from createdAt").

### Phase-2 audit (read-only, ran now per the brief — feeds the "incomplete SKU" work)
Prefix histogram (live): MOD 1652 · INT 506 · ENG 448 · FUS 249 · ECU 182 · EXT 129 · RYN 106 · (none) 60 · CLU 51 · **PS 3 (2-letter!)** · E 2 · HTTPS 2 · M 1 · MFD 1 · EOD 1. → **Phase 2's "incomplete" rule must tolerate 2–4-letter prefixes (PS is 2; RYN is a real 3-letter), not assume exactly 3.** "Incomplete SKU" population (`serial !~ '^[A-Z]{2,4}[0-9]+$'`): **236 items** (the zero-padded numerics `000002…` + malformed `HTTPS…`/single-letter). That's what Phase 2 will pull out.

### Files
SNAPSHOT_SCHEMA.md, HAWKER_RULES.md (rule 27), HAWKER_SESSION.md, HAWKER_CHANGELOG.md. **Data-only prod change** (no app code). Rollback: Railway snapshot + `~/hawker-intake-backfill-rollback-*.json`. Commit `496474e`.

### Memory files
HAWKER_SESSION + HAWKER_CHANGELOG + HAWKER_RULES updated → **Ry: re-upload the four memory files to claude.ai project knowledge (Rule 39).**

## 18:47 UTC — Scan & Move: Scanner|Manual input toggle (fixes manual-typing junk serials, deferred #6)

**Single deliverable, frontend only** (public/index.html; no server/schema/eBay — Rule 25).

### The bug
`#scan-in` armed `setTimeout(commitScan, SCAN_FLUSH_MS=80)` on every keystroke. A scanner dumps a serial in <80ms → one clean flush; a human typing pauses >80ms between letters → flushes after the first char ("E" of ENG1234) and stages a junk serial. Fix = a mode toggle that disables the auto-flush when typing.

### Diagnose-first (Rule 1)
Read the real `#page-scan` Step 1 markup, `commitScan` (the input `input`→timer + `keydown` Enter listeners), `SCAN_FLUSH_MS`, `addToBatch`, `loadScanLocations`, `resetScan` — wiring matched the brief exactly (`resetScan` doesn't touch mode; Step 2's `#loc-filter` untouched).

### Built (mirrors old WMS Scanner|Manual layout, in HawkerWMS light theme — Rule 21)
- Module var `var scanMode = 'scanner'` — always boots to Scanner, NOT persisted.
- **Segmented `[Scanner | Manual]` toggle** in the Step 1 card header (grouped left with the title; working-date stays right). New `.seg/.seg-btn/.seg-on` CSS (navy active on beige, light theme).
- **`setScanMode(mode)`** restyles the active segment, toggles the **Add** button (`#scan-add-btn`, visible Manual-only, → `commitScan` = same path as Enter), swaps the hint (`#scan-mode-hint`: *"Scanner mode: items are added automatically after scanning."* / *"Manual mode: type a serial and press Enter or tap Add."*), sets `inputmode` (Manual `text` → Android keyboard; Scanner `none` → keyboard suppressed), clears any pending timer, refocuses `#scan-in`.
- **Auto-flush gated:** the `input` listener arms the timer ONLY when `scanMode==='scanner'`. **Enter commits in BOTH modes** (preventDefault, unchanged). `commitScan` internals untouched beyond the listener guard. Init calls `setScanMode('scanner')` as the single source of truth.

### Verify (Rule 17)
Served HTML carries the toggle + `scanMode` + both hint strings + Add button + the `scanMode==='scanner'` gate; `node --check` inline JS OK; **11 `.page` divs all depth-0 siblings; div balance 333/333** (HEAD 330 + 3 new wrapper/seg divs, still balanced); `/api/health` 200. HID timing isn't headless-testable → **Ry's tablet test:** (a) Scanner — 3 fast scans → 3 whole rows, no single-letter rows; (b) Manual — type ENG1234+Enter → one clean row (no premature "E"); type another + tap Add → adds; (c) back to Scanner — scanning still auto-adds.

### Files
public/index.html, SNAPSHOT_FRONTEND.md, HAWKER_SESSION.md, HAWKER_CHANGELOG.md. No schema/server change. Commit `d6224b2`.

### Memory files
HAWKER_SESSION + HAWKER_CHANGELOG updated → **Ry: re-upload the four memory files to claude.ai project knowledge (Rule 39).**

## 18:11 UTC — 🚀 CUTOVER: live-inventory baseline reload (shipped dropped; HawkerWMS is now the system of record)

**THE CUTOVER.** Clean-reloaded prod from the old-WMS final extract as a **live-inventory-only** baseline. Shipped items dropped (eBay + ShippingEasy own shipped going forward). Followed the architect brief's gated sequence; nothing destructive ran before the human Railway snapshot + an explicit commit go-ahead.

### Decisions (architect, final)
- **Live only:** import items where `currentLocation.locationType !== 'SHIPPED'` (3,390 of 5,161); drop the 1,771 shipped. **All imported → STORED** (remaps 6 stray STAGED_UNLISTED).
- **`intake_date` = NULL for all** — old WMS rewrites scan dates on re-consolidations, so they aren't true intake; age forward only.
- **Source:** `wms-final-extract-2026-05-30 (6).json` (Fri-evening; freshest activity 2026-05-29 16:39 UTC, 0 weekend drift).

### Diagnose-first (Rule 1) — caught a real bug in the script
Read `scripts/import-baseline.mjs` + schema + migrations + the actual extract. **The script's item field names (`it._locationType`/`_locationName`) DO NOT EXIST in this extract** — it uses `currentLocation.{locationType,name}`; running as-is would have nulled every location. Validated the extract against every target before editing (549 loc = 526 SHELF_BIN+21 UNLISTED_TOTE+2 SHIPPED; 5,161 items = 3,390 SHELF_BIN + 1,771 SHIPPED; non-shipped status 3,384 STORED + 6 STAGED; 0 null-loc / 0 garbage / 0 null-sku among non-shipped).

### Changes to scripts/import-baseline.mjs
Item filter (drop SHIPPED locationType) · force `status='STORED'` · use `currentLocation.{name,locationType}` · locations: import 547 non-SHIPPED + seed ONE empty canonical `SHIPPED` (skip historical `SHIPPED`/`SHIPPED-1`) · `intake_date` left NULL · **TRUNCATE `ebay_order_lines`** in the txn (stale `matched_serial` pointers; rebuilds on next sync) · SHIPPED-collapse removed; garbage/null-loc kept as 0-assertions · extract path → the `(6)` file · `SAFE_MOVED_BY` += `ebay-sync/intake/archive/unarchive` · added end-state checks (items-in-SHIPPED, ebay_order_lines, intake_date, archived all =0). Kept the idempotent single-txn FK-safe clean reload. `npm install` was needed first (pg not installed on this machine; gitignored per-machine).

### Safe sequence executed
1. Read-only **abort-guard** (movers: import-baseline 5061 / ebay-sync 114 / intake 38 / dynatrack 31 — all safe; no real warehouse scans). 2. **HUMAN took the Railway Postgres snapshot** (confirmed). 3. **Dry-run** (BEGIN…ROLLBACK) reconciled to EVERY target to the row; wrote pre-export `~/hawker-preexport-2026-05-31T18-03-32Z.json`. 4. **Explicit commit go-ahead** → ran `--commit` (pre-export `…T18-08-54Z.json`).

### Post-import verify (Rule 27, FRESH connection) — ALL PASS
**548 locations** (526 SHELF_BIN + 21 UNLISTED_TOTE + 1 SHIPPED) · **3,390 items** all STORED · **0 in SHIPPED location** · **3,390 moves** all `import-baseline` · **0 FK orphans** · intake_date set 0 · archived 0 · **ebay_order_lines 0** (repopulates on first sync) · sequences 12 (vestigial). `/api/health` 200.

### Expected benign side effect (documented in the brief)
First post-cutover eBay sync: orders shipped *before* cutover reference dropped serials → reconcile to `location_unknown`; the age-aware pick list routes anything >3 business days to the **Errors tab, not the active sheet**, so day-one picking stays clean and they age out as eBay's window rolls forward. Not a bug.

### Human-only follow-ups (NOT done by Claude Code)
- Repoint the warehouse tablet to `hawkerwms.up.railway.app` and **stop using the old WMS** before Monday's first scan.
- Old-WMS subscription cancellation — later, Ry's call (keep as fallback a few days).

### Files
scripts/import-baseline.mjs, SNAPSHOT_SCHEMA.md (+ HAWKER_RULES rule 27 data-counts) updated to the post-cutover baseline, HAWKER_SESSION.md, HAWKER_CHANGELOG.md. No schema/migration change. Rollback artifacts: the Railway snapshot + two `~/hawker-preexport-*.json` dumps. Commit `883458d`.

### Memory files
HAWKER_SESSION + HAWKER_CHANGELOG + HAWKER_RULES updated → **Ry: re-upload the four memory files to claude.ai project knowledge before the next web-Claude session (Rule 39).**

## 16:58 UTC — Multi-serial SKU tokenizer: listings packing several serials now match every part

**Single deliverable:** make the listed-SKU matcher recognize listings whose eBay "Custom label (SKU)" field packs MULTIPLE WMS serials, so those parts stop reading as falsely unlisted. eBay READ-ONLY (Rule 25); frontend matching logic; no schema change. **SCOPE: LISTED/UNLISTED matching only** (the order-reconcile/pick side is PARKED — see end).

### 📌 PERMANENT CONTEXT (the discovery — record so it's never re-learned)
eBay's **"Custom label (SKU)" field on many listings holds several space-separated WMS serials plus sometimes a store tag**, e.g. `"MOD15959V 16367V 18936V Autolumen"` or `"ECU0544V 0550V 0551V 0553V Autolumen"`. These are **NOT eBay Variations** (confirmed: GetMyeBaySelling ActiveList returns zero `<Variations>` nodes across all listings) — they are **multi-quantity listings of distinct one-of-one parts with every unit's serial crammed into the one SKU text field**. The matcher used to normalize the WHOLE string as one SKU, fail, and read every part in these listings as unlisted/unmatched. (This also causes some location-unknown pick lines — the PARKED order side.)

### Step 0 diagnosis (read-only eBay + DB probes)
- **3,812 listings; 118 are multi-serial** (whitespace-delimited); 96 carry a store tag.
- **Delimiter = whitespace. Store tags = `AUTOLUMEN`, `DYNATRACK`** (+ one typo `AUTOLUMENA`).
- **PREFIX-INHERITANCE confirmed (make-or-break):** in `"MOD15959V 16367V 18936V"` the bare tokens match WMS serials only as `MOD16367`/`MOD18936` (prefix inherited from the first token) — **78/91 bare tokens match the inherited form vs 9 as-is**, and those 9 are coincidental hits on legacy zero-padded serials (`000002`…), not real bare matches.
- **Grammar noise the tokenizer must tolerate:** internal-id suffix `MOD10131/000046` (take before `/`), trailing `*`/commas, qty markers `(3)` and embedded `MOD16197(3)`, pure-junk words (`Garage`/`Core`/`Bin`/`Ford`/`Seats`/`HOLD`/`OFF`/`?`) → skipped (no digit ⇒ no match).

### Built (frontend, public/index.html)
- **Hoisted `normalizeSkuKey` out of `loadInventoryHealth` to a TOP-LEVEL fn** (one canonical frontend copy; #14 — true cross-file centralization is blocked by the no-build single-file frontend, Rule 18) and added **`listedSerialKeys(field)`** beside it: splits on whitespace, strips store tags / internal-id / punctuation / qty markers, applies prefix inheritance, normalizes each token → array of WMS serial keys. Loud byte-identical-with-server comment.
- **`loadInventoryHealth` `ebayByKey`** now registers each live listing under EVERY key `listedSerialKeys` returns (was: one key per whole SKU string). So a multi-serial listing is "listed" for all its component parts; Inventory Health / cross-listed / the future unlisted view all read the enriched set.
- **server.js:** comment-only — updated the `normalizeSkuKey` note to point at the new top-level frontend location + flag that `listedSerialKeys` must be mirrored here byte-identical when the parked order-side lands. (No server behaviour change.)

### Verified live (read-only; against the REAL shipped functions, extracted from index.html)
Tokenizer on live listings: `"ECU0139V 0144V"`→`[ECU0139,ECU0144]`, `"MOD10131/000046  10221/000044"`→`[MOD10131,MOD10221]`, `"MOD14075 14076 (3)"`→`[MOD14075,MOD14076]`, `"Garage Core Bin"`/`"Ford SeatsV"`→`[]`. Against items (STORED active): **WMS-Only / false-unlisted dropped 1298 → 1009 = 289 STORED items rescued**; **eBay-Only phantom keys 348 → 175** (compound garbage strings replaced by real component serials → cross-listed/oversell now sees them). **Over-match check clean:** of 352 new keys, 289 are real STORED items; the other 63 are legitimately unresolved (sold/staged), not false matches. `node --check` server.js + inline JS OK; div balance 330/330.

### PARKED (do NOT build here)
The order-reconcile/pick side: when a multi-serial listing sells ONE unit, eBay carries only the compound SKU, so you can't tell which physical serial shipped. That pick line should show ALL candidate serials and let **scan-verify (#21)** confirm which goes out. Separate, trickier deliverable. (`reconcileOrderLines` still matches the single `line.sku`.)

### Files
public/index.html, server.js (comment), SNAPSHOT_FRONTEND.md, HAWKER_SESSION.md, HAWKER_CHANGELOG.md. No schema change. Commit `9307667`.

### Memory files
HAWKER_SESSION.md + HAWKER_CHANGELOG.md updated → **Ry: re-upload the four memory files to claude.ai project knowledge before the next web-Claude session (Rule 39).**

# 2026-05-30

## 05:42 UTC — Capture listing StartTime in ingestion (variation-SKU handling deferred — no data)

**Single deliverable (scoped down after diagnosis):** capture each eBay listing's `StartTime` in the listings ingestion. eBay READ-ONLY (Rule 25); additive; no schema change. **Architect chose "StartTime now, variations when real"** after the probe below.

### Diagnose (Step 0) + read-only probe — the build premise didn't hold
`fetchStoreListings` calls `GetMyeBaySelling` ActiveList (200/page, `HideVariations=false`) and reads only **Item-level** `SKU`/`Quantity`/`QuantitySold`/`QuantityAvailable` → one row per listing; never parses `<Variations>`, never captures `StartTime`.
- **ActiveList does NOT return `<Variations>` — even with `DetailLevel=ReturnAll`.** Probed ALL live listings (dynatrack 3,280 across 17 pages + autolumen 532): **0** carried a `<Variations>` node.
- **There are ZERO variation listings in either store.** The only empty-Item-SKU listings (dynatrack `287192249616`,`287356892876`; autolumen `397904410163`) — confirmed via one-off `GetItem` (`DetailLevel=ReturnAll, IncludeVariations=true`): **`hasVariations=false, varCount=0`** — they're genuinely SKU-less flat listings (correctly unmatched). `GetSellerList` page 1 also showed 0 variations.
- **`StartTime` IS returned by ActiveList on 100% of listings** (e.g. `2026-03-30T11:15:33Z`) and was simply being dropped.
→ So the "false unlisted on variation parts" problem **isn't occurring now** (nothing to reproduce/verify), and the task's own decision tree (if ActiveList won't expand variations → switch to `GetSellerList`) would be a forward-looking ingestion swap with no real data to verify. Reported to the architect; chose to **add StartTime now, defer the variation/GetSellerList swap until a variation listing exists.**

### Built (additive)
- **server.js `fetchStoreListings`:** each listing now emits `startTime: parseXmlValue(block,'StartTime') || null`. Added a code NOTE that per-variation SKUs require `GetSellerList` (ActiveList won't expand them) and are deferred (0 variation listings).
- **public/index.html `mapListing`:** carries `startTime` through onto `ALL_LISTINGS` (downstream Inventory Health / cross-listed read the enriched set). No behavioural change to matching (no new SKUs, since no variations).

### Verified live (read-only)
Replicated the new parse against live eBay (dynatrack page 1, 200 listings): **`startTime` present on 200/200 (100%)**, all values pass `Date.parse` (0 failures); `sku`/`available` unchanged (e.g. `INT4698R` avail 0 start 2026-03-30, `MOD20383` avail 1). `node --check` server.js + inline JS OK; div balance 330/330. (`/api/health` + the live `/api/ebay/listings` payload carrying `startTime` — post-deploy.)

### Deferred (NOT built — needs real data)
Per-variation SKU emission + the cross-listed/oversell tightening it enables. When a variation listing exists: source listings from **`GetSellerList`** (`IncludeVariations=true`, `GranularityLevel=Fine`), emit one `(sku, available=Variation.Quantity−Variation.SellingStatus.QuantitySold, startTime)` row per `Variation`; flat listings keep `Item.SKU`. The matcher (union of flat+variation SKUs) then needs no further change — each variation is already a separate `ALL_LISTINGS` entry.

### Files
server.js, public/index.html, SNAPSHOT_ROUTES.md, SNAPSHOT_FRONTEND.md, HAWKER_SESSION.md, HAWKER_CHANGELOG.md. No schema change. Commit `4be8c9d`. (origin/main still at `c97bd88`; soft-archive + reconcile-fix + this all await one authorized push.)

### Memory files
HAWKER_SESSION.md + HAWKER_CHANGELOG.md updated → **Ry: re-upload the four memory files to claude.ai project knowledge before the next web-Claude session (Rule 39).**

## 05:20 UTC — Reconcile refund/cancel detection fix (refunded lines now leave NEEDS_PICK)

**Single deliverable:** fix the reconcile so refunded/cancelled sold lines reliably leave NEEDS_PICK (root cause of stale pick-list strays). eBay READ-ONLY (Rule 25 — probe + sync are reads). No schema migration.

### Diagnose (Step 0)
`fetchStoreOrders` parses ship/cancel from: `o.shipped = parseXmlValue(block,'ShippedTime')!==''`, per-line `Transaction.ShippedTime`, `OrderStatus`, `CheckoutStatus.Status`/`eBayPaymentStatus`. `reconcileOrderLines`: `cancelledOrder = OrderStatus∈{Cancelled,CancelPending} OR (checkout=Incomplete && paid)` — **never reads `CancelStatus`, `MonetaryDetails`/refunds.**

### Step 1 — read-only eBay probe on the 3 strays (PII redacted), via `railway run --service dynatrack-wms` (holds the prefixed `{DYNATRACK,AUTOLUMEN}_TRADING_API_*` creds + DATABASE_URL)
- **EXT869** (dynatrack, paid Apr 12): OrderStatus=Completed, Checkout=Complete, **no ShippedTime**, **`RefundStatus=Succeeded` (PaymentRefund, Apr 13)** → **class (b) refund missed**.
- **MOD19995R** (autolumen, paid Apr 7): identical — **`RefundStatus=Succeeded`** (Apr 8) → **class (b)**.
- **MOD20284** (dynatrack, paid May 29): no ShippedTime, **`RefundStatus`=(none)** → **class (c) genuinely paid+unshipped, not a bug** (correct live pick).
  Key: `MonetaryDetails` is present even on a normal order, so presence ≠ refund; **`RefundStatus='Succeeded'` is the distinguishing node.** No ship-detection defect found (no missed ShippedTime; the S3 106-item ship-move already proved ship parsing works).

### Step 2 — fix (server.js)
- `fetchStoreOrders` now also emits `cancelStatus = parseXmlValue(block,'CancelStatus')` and `refundStatus = parseXmlValue(block,'RefundStatus')`.
- `reconcileOrderLines` `cancelledOrder` gains `|| o.cancelStatus==='CancelComplete' || o.refundStatus==='Succeeded'`. Ship-first precedence + monotonic ON CONFLICT unchanged → a shipped-then-refunded return stays SHIPPED; a refunded **un**shipped line → CANCELLED (its matched item correctly **stays STORED** — still on the shelf; CANCELLED never triggers Phase-2 ship-move). DISMISSED still never overwritten.

### Step 3 — verify live (read-only; no writes)
- **Fixed derivation vs live eBay:** EXT869→**CANCELLED**, MOD19995R→**CANCELLED**, MOD20284→**NEEDS_PICK** — all PASS.
- **All 13 *current* NEEDS_PICK probed against live eBay → all stay NEEDS_PICK** (none refunded/shipped) — the fix does **not** over-cancel legitimate picks.
- **Monotonic flip (exact ON CONFLICT CASE, pure SELECT):** a refunded NEEDS_PICK row → CANCELLED on next sync; idempotent (CANCELLED + later CANCELLED ⇒ CANCELLED; + a stray NEEDS_PICK ⇒ kept CANCELLED). EXT869 item = STORED, 0 matched SHIPPED lines ⇒ Phase 2 leaves it alone.
- `node --check` server.js OK. (`/api/health` post-deploy — pending push.)

### ⚠️ Two caveats (as requested — NOT fixed here)
1. **Already-DISMISSED strays won't auto-correct.** Since first diagnosis, **EXT869 and MOD19995R were DISMISSED** (via the new Errors tab) — and the reconcile never overwrites DISMISSED, so they stay DISMISSED and their items stay STORED until hand-fixed. They're already off the active pick list, so the fix is forward-looking: it stops *future* refunds from becoming strays needing manual dismissal. (MOD18509, Mar 10, also no longer NEEDS_PICK — same.)
2. **Anything paid >90 days ago is outside the GetOrders window** and is never re-fetched, so its line won't be re-derived at all (won't auto-flip regardless of this fix).

### Files
server.js, SNAPSHOT_ROUTES.md, HAWKER_SESSION.md, HAWKER_CHANGELOG.md. No schema change. Commit `75e30a9`. **(Note: origin/main is still at `c97bd88`; the soft-archive commits `bf52e2e`+`9a54e86` AND this fix are LOCAL — all deploy together on the next authorized push.)**

### Memory files
HAWKER_SESSION.md + HAWKER_CHANGELOG.md updated → **Ry: re-upload the four memory files to claude.ai project knowledge before the next web-Claude session (Rule 39).**

## 04:54 UTC — Soft-archive: decommission/scrap items (closes the SCRAP leak in Inventory Health)

**Single deliverable:** a reversible way to mark a live item as **decommissioned/scrapped** so it leaves active inventory + every report while its `moves` history is retained. This is the long-pending **soft-archive (Briefs 3a/3b)** and it closes the SCRAP leak that polluted Inventory Health (a scrapped part still matched eBay / counted as on-shelf). Schema change = migration (Rule 9), `moves` append-only (Rule 13), eBay untouched (Rule 25).

### Diagnose-first (Rules 1, E) — Step 0
- `items` schema: `serial/status/location/notes/created_at/updated_at` (+`intake_date` from 0002). **STORED is counted STATUS-based everywhere** — `/api/items/count` (182), `/api/stats` (Dashboard), `/api/items` (which also feeds Inventory Health via `?status=STORED&limit=10000`), `reconcileOrderLines` match `SELECT serial … WHERE status='STORED'` (pick matching) + Phase-2 ship, and `/api/locations` `item_count`. **No location-based counting anywhere.**
- **Mechanism decision → the FLAG, not a `SCRAPPED` location.** Because counts are status-based, a SCRAPPED location wouldn't drop items from `status='STORED'` counts without either changing status (forbidden — Rule 11) or smearing `location != 'SCRAPPED'` across every query. A single `archived_at IS NULL` predicate is clean. Honors the **Briefs 3a/3b** intent recorded in this file (soft-archive non-shipped removals, history retained, *complements the SHIPPED location* — i.e. orthogonal to status); no detailed 3a/3b mechanism was locked in, so nothing conflicted.

### Built — migration 0003 (`db/migrations/0003-items-archived.sql`)
`ALTER TABLE items ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ` + `archive_reason TEXT` (both nullable, no default → existing rows stay active/NULL, NOT backfilled) + partial index `items(archived_at) WHERE archived_at IS NOT NULL`. Additive/idempotent. **ACTIVE INVENTORY := `archived_at IS NULL`.** No new status value (Rule 11 unchanged). `schema.sql` NOT edited in place (Rule 9). **Applied to live prod** via node+pg through `railway run --service Postgres` (psql still not installed on this laptop): columns + index present, 0 archived rows, counts unchanged (items 5062 / stored 3227 / locations 544 / moves 5188).

### Built — backend (server.js)
- **Gated `archived_at IS NULL` on every active-inventory read:** `/api/items` default (+ `?archived=1` for the archived list), `/api/items/count`, `/api/stats` counts, `/api/locations` `item_count` (JOIN cond), reconcile match candidates + Phase-2 ship-move. So Dashboard, Inventory, Inventory Health, unlisted/cross-listed, and pick matching all auto-exclude archived.
- **`POST /api/items/:serial/archive`** `{reason?, moved_by='archive'}` — ONE txn: guarded `UPDATE … SET archived_at=NOW(), archive_reason=$ WHERE serial=$ AND archived_at IS NULL` (live items only) + ONE `moves` row → `'ARCHIVED'`. **status left as-is**, location retained. `200 {archived:0}` no-op if not found/already archived.
- **`POST /api/items/:serial/unarchive`** — reverse: clears `archived_at`/`archive_reason` (guard `IS NOT NULL`) + ONE `moves` row FROM `'ARCHIVED'` back to the retained `location` (→`'RESTORED'` if null). `200 {restored:0}` no-op.

### Built — frontend (public/index.html)
- **Item History overlay** (`openItemHistory`): archived item shows an **ARCHIVED** badge + Archived row (timestamp · reason); footer action = **"Decommission / Scrap"** (`archiveItem` → `prompt` reason → POST) on a live item, **"Restore to inventory"** (`unarchiveItem`) on an archived one. Both re-open the overlay + refresh Inventory/Admin if active. `humanizeMover` gained `archive`→"Decommissioned / scrapped", `unarchive`→"Restored from archive".
- **Admin** → new **"Archived / Decommissioned"** list (`loadArchived`, called from `loadAdmin`): `GET /api/items?archived=1` → table Serial(→history) · Reason · Last location · Archived-at · **[Restore]**, newest first, with a count badge.

### Verified (Rules 1, 17) — live prod DB, single-txn round-trip then ROLLBACK (zero prod impact)
On real STORED item `000002` @ `HR01S01` (exact route SQL): archive → **storedActive 3227→3226 (−1)**, **dropped from active items list**, **in archived list**, **NOT a pick candidate**, **bin count 40→39 (−1)**, **history row retained**, **+1 `ARCHIVED` moves row**; unarchive → restored to 3227 + back in active list; **ROLLBACK → prod 100% unchanged** (storedActive 3227, 0 archived rows, moves for the item unchanged — no stray `moves` rows left). `node --check` server.js + inline JS OK; **11 `.page` divs depth-0 siblings, div balance 330/330** (Archived list lives inside Admin, not a new page).

### STILL PENDING (Ry hands-on — no WMS creds on this laptop)
Authenticated browser pass: open an item's history → **Decommission / Scrap** (with a reason) → it disappears from Inventory + Dashboard STORED count + Inventory Health; **Admin → Archived list** shows it; **Restore** → it returns to its shelf + counts. Post-deploy `/api/health` + new routes return 401 (registered) — checked after push (below).

### Files
db/migrations/0003-items-archived.sql, server.js, public/index.html, SNAPSHOT_SCHEMA.md, SNAPSHOT_ROUTES.md, SNAPSHOT_FRONTEND.md, HAWKER_SESSION.md, HAWKER_CHANGELOG.md. Commit `bf52e2e`.

### Memory files
HAWKER_SESSION.md + HAWKER_CHANGELOG.md updated → **Ry: re-upload the four memory files to claude.ai project knowledge before the next web-Claude session (Rule 39).** CLAUDE.md + HAWKER_RULES.md unchanged.

## 01:09 UTC — Pick List age-aware split + retained Errors tab (stale auto-route, dismiss/restore)

**Single deliverable:** an age-aware Pick List that auto-routes stale lines (paid > 3 US business days) off the daily pick sheet into a retained, low-prominence **Errors** tab, with manual **Dismiss** (→ retained archive) and **Restore**. WMS-side writes only, no eBay calls/pushes (Rule 25). **No schema migration** — staleness is a read-time filter; `DISMISSED` already exists in the `ebay_order_lines.disposition` CHECK and is already protected by the reconcile's ON CONFLICT.

### ⚠️ Stale-clone catch (Rules 1, 3)
This laptop clone was **78 commits behind** `origin/main` at session start (HEAD `2f4c513`, May 27 — pre-`ebay_order_lines`; old `server.js` had no `/api/picklist` at all). `git pull --ff-only` → `0080dc2` (this is also where the file renames CLAUDE_RULES→HAWKER_RULES, CHANGELOG→HAWKER_CHANGELOG, LAST_SESSION→HAWKER_SESSION landed, + `db/migrations/0001-ebay-order-lines`). All work below is against current HEAD. Note: **psql is not installed on this laptop** — verified the live DB via a throwaway Node + `pg` script run through `railway run --service Postgres` (the brief's `railway run -- bash …` failed because the native Railway exe can't spawn `bash` on Windows PATH; `RAILWAY_TOKEN`, not `LAPTOP_TOKEN`, is the var the CLI reads).

### Diagnose-first (Rules 1, E) — Step 0
Read `GET /api/picklist` (was a flat NEEDS_PICK read → `{lines,count}`), the reconcile `reconcileOrderLines` ON CONFLICT (server.js ~863): **confirmed it never overwrites DISMISSED** (`WHEN …='DISMISSED' THEN 'DISMISSED'`) and never pulls SHIPPED/CANCELLED back to NEEDS_PICK — so a dismissed line stays dismissed across syncs; the `0001` migration (`DISMISSED` already in the CHECK; `paid_time`/`first_seen` columns present, no migration needed); and the frontend nav / `#page-picklist` / `navigate` / `@media print`.

### Built — backend (server.js)
- **`HOLIDAYS`** (editable `Set` of US federal-holiday `YYYY-MM-DD`, seeded 2026–2027) + **`businessDaysSince(from, now)`**: counts US-Eastern weekdays (Mon–Fri) minus HOLIDAYS in the half-open interval `(fromDay, today]`, both ends reduced to the `America/New_York` calendar date and day-stepped from a noon-UTC anchor (DST-safe). Paid today → 0.
- **`GET /api/picklist` rebuilt** — each line gains `businessDaysSincePaid` (from `paid_time`, fallback `first_seen`) + `paid_time` + `orderLineItemId`; **returns two groups — `active` (≤ 3 bd; existing daily sort: location A–Z, location-unknown LAST) and `errors` (> 3 bd; most-stale first)** + `activeCount`/`errorsCount`. No mutation; no line dropped.
- **`GET /api/picklist/dismissed`** — retained DISMISSED archive (same line shape + `lastSynced`), `last_synced DESC`. Read-only.
- **`POST /api/picklist/dismiss` / `/restore`** `{orderLineItemId}` — single **guarded** `UPDATE`s (NEEDS_PICK→DISMISSED / DISMISSED→NEEDS_PICK only; never touch SHIPPED/CANCELLED). No `moves` row, no `items` mutation, no eBay (Rule 25). Return `{ok,dismissed|restored}` (count).

### Built — frontend (public/index.html)
- `#page-picklist` (`loadPickList`) now renders only the **`active`** group; print prints only it. Sub-line shows the stale count + "see Errors" and drives the nav badge.
- **New `#page-picklist-errors`** (11th `.page`, direct child of `<main>`) + a **dimmed/low-prominence "Errors" sidebar entry** with a red count badge (`#nav-errors-badge`, shows the stale count only when > 0). Two sections: **Stale — over 3 business days** (each row + `N bd` + **[Dismiss]**) and **Dismissed** (each row + paid date + **[Restore]**). New fns `loadPickListErrors`/`renderPickErrorRows`/`pickErrRow`/`dismissPickLine`/`restorePickLine`/`updateErrorsNavBadge`; `navigate` wires `picklist-errors`.

### Verified (Rules 1, 17) — against LIVE prod DB (read + non-destructive round-trip)
Extracted the **real** `businessDaysSince`/`HOLIDAYS` from server.js and ran them on actual `paid_time`s: today(Fri)→0, Thu→1, **Fri 2026-05-22→4 (Memorial Day Mon 25 correctly excluded — holiday logic proven)**, Apr 07→37. **Split: 13 NEEDS_PICK → 10 active (all paid today, 0 bd) + 3 errors (MOD18509 Mar 10/58bd, MOD19995R Apr 07/37bd, EXT869 Apr 12/34bd)** — exactly the brief's "three months-old lines land in errors, today's stay active." **Dismiss/restore round-trip** on the oldest stale OLI (the exact route SQL): dismiss→1, line leaves NEEDS_PICK + appears in DISMISSED, re-dismiss guard→0, restore→1, **final NEEDS_PICK (prod left clean)**. **Guard:** dismiss on a SHIPPED OLI → 0 rows, stays SHIPPED. `node --check` server.js + inline JS OK; **11 `.page` divs all depth-0 siblings, div balance 319/319**; `/api/health` 200 (post-deploy, below).

### STILL PENDING (Ry hands-on — no WMS creds on this laptop)
The authenticated HTTP + browser-UI pass is Ry's: open **Pick List** (only ≤3-bd items show), open the dimmed **Errors** tab (3 stale lines + badge "3"), **Dismiss** a stale row (→ moves to Dismissed section), **Restore** it (→ back on the list), **Print** (only the active sheet), and confirm a re-sync doesn't pull a dismissed line back. The data/logic layer is fully proven above.

### Behaviour note
A **DISMISSED line is never auto-ship-moved** even if eBay later ships it (reconcile keeps DISMISSED; Phase-2 ship-move only acts on matched SHIPPED rows). That's intended — dismiss = "handle outside the normal flow." Restore it first if it should ship normally.

### Files
server.js, public/index.html, SNAPSHOT_ROUTES.md, SNAPSHOT_FRONTEND.md, HAWKER_SESSION.md, HAWKER_CHANGELOG.md. **No schema change** (SNAPSHOT_SCHEMA untouched). Commit `87ac774`.

### Memory files
HAWKER_SESSION.md + HAWKER_CHANGELOG.md updated this session → **Ry: re-upload the four memory files to claude.ai project knowledge before the next web-Claude session (Rule 39).** CLAUDE.md + HAWKER_RULES.md unchanged in content (the EOF-newline touch you made on RULES/SESSION mid-session carries no content change).

# 2026-05-29

## 18:43 UTC — Thread handoff / state snapshot (bookkeeping; no feature code)

End-of-thread handoff so the next thread picks up clean. Git clean + even with `origin/main` at HEAD `6eec9bd`. No code/schema/DB changes this session — memory files only.

### SHIPPED THIS THREAD (hashes = code → docs → stamp, verified against git log)
- **a) Locations list + per-location detail.** `#page-locations` is now a **Name · Type · Items · View** table (`renderLocGrid`, name kept per Rule D); row/View → **`openLocationDetail`** → **`#modal-location-detail`** (items in that bin; serials reuse `openItemHistory`). Backend: `GET /api/items` exact **`location`** param (`WHERE location=$1`, serial-ASC, **uncapped**); `GET /api/locations` returns **`item_count`** (LEFT JOIN + GROUP BY). Commits `2944d63` → `e72e860` → `fefcf6d`.
- **b) Scan & Move single-flow fixes.** Gap-timer item capture (`#scan-in`, `SCAN_FLUSH_MS`=80) so fast scans don't merge; scannable destination (`#loc-filter` Enter→`resolveLocInput` / gap→`commitLocScan`); `doMove` reads stable vars + guard/retention fixes. Commits `23d8ece` → `490ea89` → `02c8b7b`.
- **c) Bulk Scan & Move — 3-step batch.** `#page-scan` rebuilt into Scan Items → Pick Location → Confirm (`#scan-step-1/2/3`, `showStep`; `addToBatch`/`renderBatch`/`removeFromBatch`/`goToConfirm`/`confirmBatch`). New transactional **`POST /api/move/batch {to_location, serials[], intake_date?}`** — atomic all-or-nothing, returns `{moved, created, location}`, exactly one `moves` row each (existing→`dynatrack`, new→`intake`). **The old single flow was REMOVED** (`handleScan`, `doMove`, `openIntake`/`confirmIntake`/`cancelIntake`, `#modal-intake`). Commits `a8096b7` → `597d699` → `6eec9bd` (HEAD).

### VERIFIED headless · STILL PENDING (cutover gate)
All three were verified headless (routes exercised on test data, served-HTML markers, node --check, `/api/health` 200, page-div siblings, div balance). **STILL PENDING — Ry's physical tablet + Zebra acceptance test of the batch flow:** scan ~30 fast (no merge), remove a mis-scan, mix new+existing → Confirm shows right counts + lists the new serials → commit moves/creates all to the shelf, a 1-item batch works, typed manual entry works, an unknown serial does NOT interrupt scanning. **This hands-on pass is the cutover gate for the daily move loop.**

### OPEN NOTES
- **(i) `POST /api/intake` is now ORPHANED** — verified this session: defined at `server.js:264`, but its only caller (the intake modal) was removed with the single flow, so **no frontend calls it**. Flagged, **not deleted** (matches how other orphaned routes are handled — `POST /api/sequences/next/:prefix`, `GET`/`POST /api/print-log`). A future cleanup can remove them together, or `/api/intake` could be re-wired if a single-add entry point is ever wanted.
- **(ii) SHIPPED location detail renders ~1,834 rows** (`openLocationDetail('SHIPPED')`, uncapped). Loads fast / acceptable. Optional future tweak: route the SHIPPED row to the **Shipped Items page** instead of the generic bin modal.
- **(iii) SYNC STAMP off-by-one is BY DESIGN.** The stamp block cites the **content/docs commit** while HEAD is the **trailing stamp commit** (the stamp commit can't contain its own hash). So "stamp ≠ HEAD by one commit" is normal — the next thread's staleness check should compare the stamp to the *content* commit, not flag it.

### NEXT UP (architect recommendation)
1. **Persistent session store** — *lead hardening item.* The in-memory `sessions` Map (`server.js`) drops the tablet login on **every deploy/restart**; do this BEFORE the warehouse testing pass so Ry isn't logged out mid-test.
2. Remaining build items: **totes-vs-shelves dashboard split**, **Unlisted view** (Inventory-Health WMS-Only), **soft-archive**.

### Memory files
`CLAUDE.md` + `HAWKER_RULES.md` unchanged this thread (no rule/context change) — confirmed current; they ride along in the Rule 39 re-upload. `HAWKER_SESSION.md` + `HAWKER_CHANGELOG.md` updated (this entry).

## 18:17 UTC — Bulk Scan & Move: 3-step batch wizard (scan many → one destination, atomic commit)

**Single deliverable:** replaced the two-panel single-move flow with a **3-step batch wizard** (Scan Items → Pick Location → Confirm) that moves/creates ALL scanned items to one destination in a single atomic commit. A 1-item batch = the old single move. Backend (new transactional route) + Scan & Move frontend rebuild. No new `.page`; no schema change; eBay untouched (Rule 25); exactly one `moves` row per item (Rule 13).

### Diagnose-first (Rules 1, E)
Read the current gap-timer scan code (`commitScan`/`handleScan`/`resolveLocInput`/`commitLocScan`/`doMove`/`resetScan`, `scannedSerial`/`selectedLocName`/`scanLocations`, working-date, `openIntake`/`confirmIntake`) + `POST /api/move` (229) + `POST /api/intake` (264). Grepped every caller of the single-flow fns — all internal to the scan flow + intake modal, so a clean replace was safe. **REUSED** the gap-timer capture and the location-resolve logic; did not reinvent them.

### Built — backend (server.js)
- **`POST /api/move/batch {to_location, serials:[], intake_date?}`** — ONE transaction, all-or-nothing. Ensures the location row; de-dupes serials; per serial: **existing** → `UPDATE`→`STORED`@to_location + one `'dynatrack'` moves row (prior→to); **unknown** → `INSERT` (`STORED`, `intake_date`=given or `CURRENT_DATE`) + one `'intake'` moves row (NULL→to). 400 on empty inputs. Returns `{moved, created, location}`. Keeps Item-History labels correct (`humanizeMover`: intake/dynatrack). The wizard's Confirm screen is the create gate → creating new items here is reviewed, not silent.

### Built — frontend (public/index.html) — REPLACED the single flow
- `#page-scan` rebuilt into three toggled panels (`#scan-step-1/2/3`, `showStep`). **Step 1:** `commitScan` (existing gap timer) now **APPENDS** to `batch[]` via `addToBatch` (dedupe→toast; known→status badge; unknown→**NEW** badge, **no intake modal**); `renderBatch` list + per-row remove (`removeFromBatch`) + live count; typed+Enter adds; "Next" enabled at ≥1. **Step 2:** reuses `filterLocs`/`selectLoc`/`commitLocScan`/`resolveLocInput` (scan exact→select / filter+tap / unknown→pending); Back preserves the list. **Step 3:** `goToConfirm` shows "Move X existing, create Y new → LOC", **enumerates the Y new serials**, shows `workingDate`, flags `(was shipped)`; `confirmBatch`→`POST /api/move/batch`→toast + `resetScan` (empty Step 1) + refocus.
- **Removed** the superseded single-flow pieces: `handleScan`, `doMove`, `openIntake`/`confirmIntake`/`cancelIntake`, and the `#modal-intake` markup. Working-date control kept (stamps new items' `intake_date`).

### Verified (Rule 17)
- **`POST /api/move/batch` exercised on test serials only** (no real inventory touched): 400 guards (empty `{}`/no-serials/no-to_location → 400); batch 1 create → `moved:0, created:2` (intake_date 2026-05-20 stamped); batch 2 mix → `moved:2, created:1`, moved item's moves = `∅→L1/intake` then `L1→L2/dynatrack` (exactly 2, correct labels); **atomic rollback** — a forced bad-`intake_date` batch `[existing, new]` → 500, the existing item's location **unchanged**, the new serial **not created**, no extra moves row (the whole batch, incl. the location insert, rolled back).
- Served HTML has `#scan-step-1/2/3` + `confirmBatch`/`addToBatch`/`goToConfirm`; `node --check` server.js + inline JS OK; **all 10 `.page` divs depth-0 siblings**, div balance 304/304; `/api/health` 200.
- **Test cleanup:** deleted 3 test items + 2 test locations (locations back to 544); synthetic test `moves` retained per Rule 13 (cleared at cutover). **Ry's tablet tests** (scan ~30 fast no-merge, remove a mis-scan, mix new+existing→Confirm counts→commit, 1-item batch, typed entry, unknown serial doesn't interrupt scanning) are the hands-on verification — HID timing/focus aren't headless-testable.

**Files touched:** `server.js` (+`/api/move/batch`), `public/index.html` (3-step wizard; removed single-flow fns + intake modal), `SNAPSHOT_ROUTES.md`, `SNAPSHOT_FRONTEND.md`, `HAWKER_SESSION.md`, `HAWKER_CHANGELOG.md`. No schema change. Commit `a8096b7`. Throwaway verify/clean scripts deleted.

**Production status:** `hawkerwms.up.railway.app` healthy. Scan & Move is now a bulk wizard.

## 17:54 UTC — Scan & Move bug fixes: robust item capture + scannable destination + guards

**Single deliverable:** make a move reliably complete end-to-end in the existing two-panel layout. **Frontend-only** (`public/index.html`); `/api/move` payload unchanged; no layout rebuild, no batch/Scanner-Manual toggle (deferred #6), no schema change; eBay untouched (Rule 25).

### Diagnose-first (Rule 1) — confirmed both symptoms in code
Panel 1 `#scan-in` had a single `keydown` Enter→`handleScan(value)`; Panel 2 `#loc-filter` only `oninput=filterLocs` (dropdown) + tap `selectLoc`. **Symptom #2:** the destination was **not scannable** — a location scan landed in the still-focused Panel 1, was treated as a new serial, overwrote the staged item, and `doMove` then hit `!selectedLocName`→"Select a destination" (mis-specific). **Symptom #1:** single Enter capture + immediate field-clear races merge/drop fast back-to-back scans. Stable vars confirmed: `scannedSerial`, `scannedIsNew`, `selectedLocName`, `scanLocations[]`; ids `scan-in` / `loc-filter` / `loc-dropdown` / `selected-loc`.

### Fixes (all in the existing layout)
- **#1 Robust item capture (`#scan-in`):** replaced the lone Enter handler with a **gap timer** (`SCAN_FLUSH_MS`=80): the `input` listener (re)arms a `setTimeout(commitScan, 80)` so it fires once keystrokes stop; Enter/CR→immediate `commitScan` (`e.preventDefault()`). `commitScan` reads+clears the field, stages exactly one serial via `handleScan` (known→stage `scannedSerial`; unknown→`#modal-intake`), and refocuses Panel 1. Fast scans can't merge; an Enter/CR suffix flushes each immediately.
- **#2 Scannable destination (`#loc-filter`):** added a gap timer + Enter. **`resolveLocInput`** (Enter) = full resolution — exact case-insensitive match→`selectLoc`; else single filtered match→select; else **zero matches→`selectLoc(code)`** (pending dest; `/api/move` auto-creates the row); ambiguous→toast (don't guess). **`commitLocScan`** (gap) resolves **only an exact match**, so manual partial-typing to filter never auto-selects. Tap-select via the dropdown unchanged.
- **#3 Retain staged item + guards (`doMove`):** already reads the stable `scannedSerial`/`selectedLocName` (never an input) — typing/scanning in Panel 2 can't clear the staged serial. Guards: no serial→"Scan an item first"; serial but no dest→**"Scan or select a destination"** (was "Select a destination"); both→`POST /api/move`→success `resetScan`. `resetScan` now also **clears `#loc-filter` + hides the dropdown** (both inputs) and refocuses Panel 1.

### Verified (Rule 17)
Served HTML carries `commitScan` / `commitLocScan` / `resolveLocInput` / `SCAN_FLUSH_MS` / the new `input` listeners / "Scan or select a destination"; `node --check` inline JS OK; **all 10 `.page` divs depth-0 siblings**, div balance 304/304; `/api/health` 200. **Functional scanner tests (3 fast serials don't merge; scan-location-into-filter→Move completes with no "scan an item"; tap-select; intake on unknown; guard messages) are Ry's tablet verification** — physical HID scanner + focus + keystroke timing aren't headless-testable.

**Real-world backstop (note for Ry):** configure the Zebra to send a **CR/Enter suffix** per scan — that plus the gap timer makes zero-gap merges impossible. To scan a destination, **tap the FILTER LOCATIONS field first** so the location scan lands in Panel 2 (then it auto-resolves); item scans go to Panel 1.

**Files touched:** `public/index.html` (gap-timer capture, `commitScan`/`commitLocScan`/`resolveLocInput`, `doMove` guard msg, `resetScan` clears both inputs), `SNAPSHOT_FRONTEND.md`, `HAWKER_SESSION.md`, `HAWKER_CHANGELOG.md`. No server/schema change → SNAPSHOT_ROUTES untouched. Commit `23d8ece`. Throwaway verify script deleted.

**Production status:** `hawkerwms.up.railway.app` healthy.

## 17:43 UTC — Locations: Name·Type·Items·View list + per-location detail overlay

**Single deliverable:** render locations as a **list/table** (Name · Type · Items · View, old-WMS layout) and on click open a **detail overlay** of every item in that bin. Additive, read-only; no schema change; eBay untouched (Rule 25).

### Diagnose-first (Rule 1)
`#page-locations` was a zone-tabbed **card grid** (`loadLocations`→`buildZoneTabs`/`renderLocGrid`, `setLocZone`/`filterLocGrid`). `GET /api/items` had only `status` + fuzzy `search` (ILIKE serial/location) + `limit=500` — **over-matches + caps**, unusable for an exact-bin detail. `GET /api/locations` was `SELECT * … ORDER BY name` (no count). Detail pattern = a modal after `</main>` (like `openItemHistory`), **not a new `.page`** (the missing-`</div>` nesting bug).

### Built — backend (server.js, additive/read-only)
- **`GET /api/items`** gained an **EXACT `location` param**: when present → `WHERE location=$1`, **`ORDER BY serial ASC`, UNCAPPED** (takes precedence over fuzzy `search`; SHIPPED holds ~1,834). Existing status/search/limit path unchanged.
- **`GET /api/locations`** now returns **`item_count`** per location (`LEFT JOIN items i ON i.location=l.name … GROUP BY l.id`; 0 for empty bins). Backward-compatible (added field).

### Built — frontend (public/index.html)
- **`renderLocGrid` kept its name (Rule D)** but now renders a **Name · Type · Items · View table** (`#loc-grid` set to `display:block` to override the `.lg` grid). Zone tabs + search retained. Type badge via `locTypeBadge`/`locTypeLabel` (`SHELF_BIN`→"SHELF BIN", `*_TOTE`→"TOTE", `SHIPPED`). Row **and** the View link → `openLocationDetail(name)`.
- **`openLocationDetail(name)`** fetches `GET /api/items?location=<name>` and renders `#modal-location-detail` — header (name · type · count) + a Serial · Status · Notes table; **serials reuse `openItemHistory`**; empty bin → "No items in this location." Modal placed **before `#modal-item-history`** in DOM so history stacks on top when a serial is clicked from within it.

### Verified live (Rule 17)
- `/api/locations` → 544 rows with `item_count`. `HR01S01` (SHELF_BIN): **count 40 = /items?location returned 40**, all exact-location, serial-ASC. `SHIPPED`: **count 1834 = returned 1834** (uncapped, exact). Served HTML has `openLocationDetail` + `#modal-location-detail`; `node --check` + inline JS OK; **all 10 `.page` divs depth-0 siblings** (divs 304/304); `/api/health` 200.
- ⚠️ The client check flagged `serial-ASC=false` for SHIPPED — a **harness artifact** (JS `localeCompare` ICU collation ≠ Postgres text collation on mixed alphanumerics); the route DOES apply `ORDER BY serial ASC` (first serials `000001<000012<000039<000081`; HR01S01's homogeneous serials passed). Modal/visuals are the architect's browser eyeball.

**Files touched:** `server.js` (items `location` param + locations `item_count`), `public/index.html` (`renderLocGrid` table + `locTypeLabel`/`locTypeBadge`/`openLocationDetail` + `#modal-location-detail`), `SNAPSHOT_ROUTES.md`, `SNAPSHOT_FRONTEND.md`, `HAWKER_SESSION.md`, `HAWKER_CHANGELOG.md`. **No schema change.** Commit `2944d63`. Throwaway verify script deleted.

**Production status:** `hawkerwms.up.railway.app` healthy. Locations page is a clickable Name/Type/Items/View list; each bin opens its contents. (Note: SHIPPED bin now 1,834 — 1,724 baseline + 110 ship-moved; the +4 over the prior 1,830 reflects `ebay-sync` ship-moves from a between-sessions orders sync, the S3 self-healing.)

## 17:19 UTC — New-item intake (unknown scan → confirm + `POST /api/intake`; no silent create)

**Single deliverable:** scanning an **unknown serial** now routes to a confirm step that **explicitly creates** the part (STORED, optional location, `intake_date` = the active working date) instead of the move flow silently upserting it — plus a sticky **Working-date** control to backdate a batch to its photo-folder date. Backend route + Scan & Move frontend. **No schema change** (`intake_date` exists from 0002); eBay untouched (Rule 25).

### Diagnose-first (Rule 1)
`handleScan` on a `/api/items/:serial` **404** previously just labelled the card "NEW" — then `doMove`→`POST /api/move` **silently created** the item (upsert). `/api/move` (214) = audited txn (upsert→STORED, ensure location, one moves row), `moved_by` default `'dynatrack'`. Location picker = `loc-filter`→`filterLocs`→`selectLoc`; scan field Enter-fires `handleScan`, `resetScan` refocuses. **`moved_by` in use: `import-baseline`, `ebay-sync`** — intake adds a 4th: **`intake`**.

### Built — backend (`server.js`)
- **`POST /api/intake {serial, location?, intake_date?, moved_by='intake'}`** — create-only audited txn mirroring `/api/move`: validate non-empty serial; **if the serial exists → 409 `{alreadyExists:true}`, no overwrite** (caller falls back to move); else INSERT item (`status='STORED'`, location or NULL, `intake_date`=given or `CURRENT_DATE`), ensure the location row if given, INSERT **one moves row = the intake event** (`from_location` NULL → `to_location` = shelf or the `'INTAKE'` marker, `moved_by`). Returns the created item.

### Built — frontend (Scan & Move)
- **Working-date control** (`#working-date`, JS `workingDate`): defaults to today, **sticky** until changed, **resets to today on reload** (no stale cross-session backdating). Always visible; renders in a **loud warning style whenever ≠ today** (`refreshWorkingDateStyle`).
- **Unknown-serial branch:** `handleScan` 404 sets `scannedIsNew` + opens **`#modal-intake`** (`openIntake`) — serial, optional location (datalist of `scanLocations`), intake date **prefilled from `workingDate`, editable for this one item**. `confirmIntake` → `POST /api/intake` → success toast → `resetScan` (refocus). Cancel → discard + refocus. A 409 (race) → graceful "already in inventory — re-scan to move it". **No silent auto-create** — `doMove` on a new serial routes to `openIntake`, never `/api/move`.
- **Existing serial:** unchanged move flow (`scannedIsNew=false`), no prompt.
- `humanizeMover` maps `intake` → **"Added at intake"** (Item History timeline label).

### Verified live (Rule 17) — deployed `POST /api/intake` exercised end-to-end
- Empty serial → **400**. Existing `000002` → **409 `alreadyExists`** (rollback, no clobber). Create (backdated **2026-05-15**, no location) → **201**: item `STORED` / `location NULL` / `intake_date 2026-05-15` (**backdate reflected, not today**). Read-back: moves = `NULL→INTAKE by intake` (1 row, first=intake → history shows "Added at intake [Intake]"); **appears in Inventory** (STORED search). No-location item surfaces as **location-unknown, not an error**. Re-intake same serial → **409** (no duplicate). `/api/health` 200.
- Served HTML has `confirmIntake` + `#modal-intake` + `#working-date`; `node --check` server.js OK + inline JS OK; **all 10 `.page` divs still depth-0 siblings** (modal outside `<main>`; divs balanced 295/295).
- **Test cleanup:** the test item was deleted (items restored to **5061**); per **Rule 13** (moves append-only) the one synthetic `intake` move is retained (orphan — harmless, cleared at the cutover re-import). The frontend modal/warning visuals are the architect's browser eyeball; backend + wiring are proven.

**Files touched:** `server.js` (+`POST /api/intake`), `public/index.html` (working-date control + `#modal-intake` + intake JS + scan-flow wiring + `humanizeMover`), `SNAPSHOT_ROUTES.md`, `SNAPSHOT_FRONTEND.md`, `HAWKER_SESSION.md`, `HAWKER_CHANGELOG.md`. **No schema change.** Commit `28217a1`. Throwaway verify/clean scripts deleted.

**Production status:** `hawkerwms.up.railway.app` healthy. Mis-scans can no longer spawn junk inventory; batches can be backdated visibly.

### ⏭ Deferred (NOT this session)
Full Zebra/BT-HID robustness + batch-vs-single dual modes (#6); photo-at-intake (#23); condition grading (#24).

## 16:54 UTC — Read-only Item History overlay (serial → header + move timeline)

**Single deliverable:** a read-only Item History view — given a serial, show the item header + its full chronological move timeline. **Frontend-only, on existing routes (`GET /api/items/:serial`, `GET /api/moves?serial=`). No schema change, no mutation, eBay read-only (Rule 25).**

### Diagnose-first (read-only, Rule 1)
- `GET /api/items/:serial` → full `items` row (now incl. `intake_date`), 404 if absent (`api()` throws → caught for the graceful path). `GET /api/moves?serial=` → `SELECT * … ORDER BY moved_at DESC LIMIT $n` (default 50). **Max moves/serial = 2** (avg 1.02) so 50 suffices, but pass `&limit=1000` per brief (future-proof).
- `moves` cols: serial, from_location, to_location, moved_by, moved_at. **`moved_by` in use: `import-baseline` (5061) + `ebay-sync` (106)** — no real-user/scanner moves yet (warehouse not live).
- House modal pattern: `<div class="modal-bg" id><div class="modal">`, `openModal/closeModal` (739/740) + a backdrop-click-close (741); modals live **after `</main>`** (not `.page` sections).

### Built (frontend; `public/index.html`)
- **`#modal-item-history`** overlay (added with the other modals, outside `<main>` — deliberately NOT a new `.page` nav section, avoiding the nesting bug just fixed).
- **`openItemHistory(serial)`** (reusable v1 entry point): fetches the item + its moves (`&limit=1000`) and renders — **Header:** serial (Fira Code), status badge, current location, `intake_date` (or **"unknown (legacy)"** when NULL), created_at, notes. **Timeline oldest→newest** (API DESC, reversed): each event = time · `from → to` · humanized `moved_by` (**`humanizeMover`**: `import-baseline`→"Imported (baseline)", `ebay-sync`→"Shipped (eBay sync)", else raw user/scanner). First event tagged **Intake**; any `to_location='SHIPPED'` tagged **Shipped**. Unknown serial → graceful "not found".
- **Inventory serials are now clickable links** → `openItemHistory(serial)` (canonical v1 entry; helper stays reusable so Health/Shipped/Pick List can wire later).

### Verified live (Rule 17)
- `MOD20572` (SHIPPED, 2 moves): `— → HR12S01 · Imported (baseline) [Intake]` → `HR12S01 → SHIPPED · Shipped (eBay sync) [Shipped]` — ordered timeline ending in Shipped. `000002` (STORED legacy): single `Imported (baseline) [Intake]`, intake "unknown (legacy)". `42011946` (legacy imported straight to SHIPPED): single event tagged `[Intake] [Shipped]`. Unknown serial → 404 → graceful "not found".
- Served HTML has `openItemHistory` + the clickable serial link + `#modal-item-history`; `node --check` inline JS OK; **all 10 `.page` divs still depth-0 siblings** (whole-file divs balanced 287/287 — the modal is outside `<main>`); `/api/health` 200.
- ⚠️ No STORED item has >1 move yet (real scan-moves haven't happened; max=2, those are SHIPPED) — the multi-event ordered timeline is demonstrated via a SHIPPED item; ordering logic is status-independent.

**Files touched:** `public/index.html` (modal + `openItemHistory`/`humanizeMover` + clickable Inventory serials), `SNAPSHOT_FRONTEND.md` (modals + Inventory row + function index **re-synced to HEAD** — it had drifted ~27 lines). No server/DB change. Commit `84fa366`. Throwaway diag/verify scripts deleted.

**Production status:** `hawkerwms.up.railway.app` healthy. Click any Inventory serial → read-only history overlay.

### ⏭ Optional follow-ups (NOT this session)
Scan-a-serial to open history; wire the overlay to Inventory Health / Shipped / Pick List serials; eBay sale enrichment (join `ebay_order_lines.matched_serial` to cap the timeline with the actual sale — title/SKU/paid/shipped/store; needs a small backend join).

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