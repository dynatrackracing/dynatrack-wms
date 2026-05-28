# SNAPSHOT_FRONTEND.md — `public/index.html`

> Orientation map of the single-file frontend. Regenerate at session end if `public/index.html` changed (HAWKER_RULES rule 38).
> Generated 2026-05-28 from `public/index.html` (~1663 lines: inline CSS + inline vanilla JS, no build step, no framework). Line numbers approximate.

## Shell
- **SPA**: a fixed nav + left sidebar + `<main>` holding nine `.page` divs. `navigate(p)` (664) toggles `.active` on `#page-<p>` and the matching sidebar `.ni[data-page]`.
- **Auth**: login screen (`#login-screen`, ~130). Token stored in `localStorage` as `wms_token`; sent as `x-wms-token` by the `api()` helper (627). A 401 from `api()` triggers `showLogin()`.
- **Sync dot** in the nav reflects request state via `setSyncing()/setSynced()/setSyncErr()` (645–653). Toasts via `showToast(msg,isErr)` (681).

## Pages (sidebar order)
| Page | `id` | Loader fn | What it does |
|---|---|---|---|
| Dashboard | `page-dashboard` (197) | `loadDashboard` (729) | Stats cards + recent moves + **per-store eBay status cards** (one per store, rendered from `/api/ebay/health` `stores[]`, each with its own `syncStore` button); `dashSearch` (768) global lookup. |
| Scan & Move | `page-scan` (228) | `loadScanLocations` (792) | Scan input → `handleScan` (802); pick destination (`filterLocs`/`selectLoc`); `doMove` (840) calls `POST /api/move`. |
| Locations | `page-locations` (268) | `loadLocations` (883) | Zone-tabbed grid (`buildZoneTabs`/`renderLocGrid`); `addLocation` (922); `bulkAddLocations` (934). |
| Inventory | `page-inventory` (282) | `loadInventory` (953) | Status-filtered item table (`filterInvStatus`/`filterInv`); `addItem` (984). |
| Labels | `page-labels` (301) | `loadLabels` (1003) | Barcode label generator; `autoSerial` (1043) pulls next from a sequence; `printLabel` (1057) logs to print-log. |
| eBay Orders | `page-ebay` (335) | `syncEbayOrders` (1102) | Live sync (`GET /api/ebay/orders`, all stores) or `importOrdersCSV` (1190); `renderOrders` (1237) — **Store** column/badge. |
| eBay Listings | `page-listings` (366) | `syncEbayListings` (1119) | Live sync (`GET /api/ebay/listings`, all stores) or `importListingsCSV` (1215); `renderListings` (1265) — **Store** column + per-store sub-counts. Populates in-memory `ALL_LISTINGS` (each entry **tagged with `store`**). Auto-syncs on open if empty (navigate, ~700). |
| Inventory Health | `page-health` (433) | `loadInventoryHealth` (1388) | Old-WMS-style layout (multi-store-aware). **8 stat cards:** WMS Items, eBay Inventory, Matched, eBay Only, WMS Only, Duplicate, **Cross-listed**, Staging (responsive `auto-fit` grid). Header: "Comparing N eBay listings with SKUs against M active shelf items. Staging items (S) excluded." Client-side reconcile of `ALL_LISTINGS` (union of all stores) vs WMS items; `normalizeSkuKey` (1413) strips trailing letters (rule 8); `renderHealthTable` (1506), **rows sorted by SKU asc**. eBay col = per-listing block w/ inline store badge (raw SKU · qty · green price · title[title attr] · View-on-eBay); **Cross-listed rows show BOTH stores' listings stacked** (`listingBlock`, 1548). WMS col = **plain serial (NOT linked — no item-detail page exists; never the old paid WMS)**, raw form in parens if ≠ normalized, location below; all items stacked for Duplicate; em-dash for eBay Only. Search + status chips (live counts) + store filter. Empty state = "Sync eBay listings & compare" button. **No CSV download icons** (architect skipped; the single header Export CSV button predates this). **Defensive (2026-05-28):** the whole function is wrapped in try/catch — on error it logs `[Inventory Health] render failed:` and renders a visible "failed to render — Reload Page" state (never truly blank). A top-of-function `// DIAGNOSTIC` `console.log` prints input shapes (counts only) — **slated for removal** once the blank-page bug is confirmed fixed via user testing. |
| Admin | `page-admin` (392) | `loadAdmin` (1292) | Sequence management (`editSeq`/`addSeq`), bulk locations, `exportCSV` (1356) for items/locations/moves, DB + eBay status. |

## Modals
`#modal-add-location` (549), `#modal-add-item` (561), `#modal-add-seq` (575). Opened via `openModal`/`closeModal` (717–718).

## Key data facts (gotchas for future sessions)
- **eBay orders & listings are NOT persisted** — they live only in the in-memory JS arrays `ORDERS` and `ALL_LISTINGS`, repopulated per sync/import and **reset on page refresh**. Inventory Health depends on `ALL_LISTINGS` being loaded first (hence the empty-state Sync button).
- **Multi-store:** every `ORDERS`/`ALL_LISTINGS` entry carries a `store` tag (`dynatrack`/`autolumen`). `syncEbayOrders`/`syncEbayListings` hit the combined endpoints (full replace — both stores). **`syncStore(key)` (per-store) MUST replace only that store's slice via `arr.filter(x => x.store !== key).concat(fresh)` — never reassign the array, or the other store is silently wiped** (commented at the call site). `storeBadge`/`storeLabel`/`storeCountLabel` render store chips/counts.
- **SKU normalization** (`normalizeSkuKey`, 1409): `(sku||'').trim().toUpperCase().replace(/[A-Z]+$/,'')` — strips trailing letters so eBay `INT4306R` matches WMS serial `INT4306` (rule 8).
- All data access goes through `api(path,opts)` (651) → `fetch('/api'+path)` with the token header. No third-party SDKs (rule 19).

## Full function index (line → name)
599 showLogin · 604 hideLogin · 608 doLogin · 639 doLogout · 651 api · 669 setSyncing · 673 setSynced · 677 setSyncErr · 688 navigate · 705 showToast · 717 openModal · 718 closeModal · 722 openAddLocation · 723 openAddItem · 724 openAddSeq · 729 loadDashboard · 768 dashSearch · 792 loadScanLocations · 802 handleScan · 821 filterLocs · 833 selectLoc · 840 doMove · 856 resetScan · 865 loadRecentMoves · 883 loadLocations · 894 buildZoneTabs · 902 setLocZone · 909 filterLocGrid · 911 renderLocGrid · 922 addLocation · 934 bulkAddLocations · 953 loadInventory · 976 filterInvStatus · 982 filterInv · 984 addItem · 1003 loadLabels · 1026 renderSeqDisplay · 1034 updateLabel · 1043 autoSerial · 1057 printLabel · 1074 storeLabel · 1075 storeBadge · 1076 storeCountLabel · 1079 mapOrder · 1092 mapListing · 1096 syncEbayNow · 1102 syncEbayOrders · 1119 syncEbayListings · 1140 syncStore · 1171 parseCSV · 1190 importOrdersCSV · 1215 importListingsCSV · 1237 renderOrders · 1262 filterOrders · 1263 filterOrderStatus · 1265 renderListings · 1286 filterListings · 1287 filterListingStock · 1292 loadAdmin · 1329 editSeq · 1341 addSeq · 1356 exportCSV · 1388 loadInventoryHealth · 1413 normalizeSkuKey · 1506 renderHealthTable · **1548 listingBlock** (nested in renderHealthTable) · 1602 filterHealth · 1603 filterHealthStore · 1605 filterHealthStatus · 1612 exportHealthCSV
