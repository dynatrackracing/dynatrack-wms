# SNAPSHOT_FRONTEND.md — `public/index.html`

> Orientation map of the single-file frontend. Regenerate at session end if `public/index.html` changed (HAWKER_RULES rule 38).
> Generated 2026-05-28 from `public/index.html` (~1615 lines: inline CSS + inline vanilla JS, no build step, no framework). Line numbers approximate.

## Shell
- **SPA**: a fixed nav + left sidebar + `<main>` holding nine `.page` divs. `navigate(p)` (664) toggles `.active` on `#page-<p>` and the matching sidebar `.ni[data-page]`.
- **Auth**: login screen (`#login-screen`, ~130). Token stored in `localStorage` as `wms_token`; sent as `x-wms-token` by the `api()` helper (627). A 401 from `api()` triggers `showLogin()`.
- **Sync dot** in the nav reflects request state via `setSyncing()/setSynced()/setSyncErr()` (645–653). Toasts via `showToast(msg,isErr)` (681).

## Pages (sidebar order)
| Page | `id` | Loader fn | What it does |
|---|---|---|---|
| Dashboard | `page-dashboard` (197) | `loadDashboard` (717) | Stats cards + recent moves + **per-store eBay status cards** (one per store, rendered from `/api/ebay/health` `stores[]`, each with its own `syncStore` button); `dashSearch` (756) global lookup. |
| Scan & Move | `page-scan` (228) | `loadScanLocations` (763) | Scan input → `handleScan` (773); pick destination (`filterLocs`/`selectLoc`); `doMove` (811) calls `POST /api/move`. |
| Locations | `page-locations` (268) | `loadLocations` (854) | Zone-tabbed grid (`buildZoneTabs`/`renderLocGrid`); `addLocation` (893); `bulkAddLocations` (905). |
| Inventory | `page-inventory` (282) | `loadInventory` (924) | Status-filtered item table (`filterInvStatus`/`filterInv`); `addItem` (955). |
| Labels | `page-labels` (301) | `loadLabels` (974) | Barcode label generator; `autoSerial` (1014) pulls next from a sequence; `printLabel` (1028) logs to print-log. |
| eBay Orders | `page-ebay` (335) | `syncEbayOrders` (1090) | Live sync (`GET /api/ebay/orders`, all stores) or `importOrdersCSV` (1178); `renderOrders` (1225) — now with a **Store** column/badge. |
| eBay Listings | `page-listings` (366) | `syncEbayListings` (1107) | Live sync (`GET /api/ebay/listings`, all stores) or `importListingsCSV` (1203); `renderListings` (1253) — **Store** column + per-store sub-counts. Populates in-memory `ALL_LISTINGS` (each entry **tagged with `store`**). Auto-syncs on open if empty (navigate, ~688). |
| Inventory Health | `page-health` (433) | `loadInventoryHealth` (1376) | Client-side reconcile of `ALL_LISTINGS` (union of all stores) vs WMS items; `normalizeSkuKey` (1397) strips trailing letters (rule 8); buckets Matched/eBay-Only/WMS-Only/Duplicate/**Cross-listed**/Staging; `renderHealthTable` (1478). **Cross-listed** = SKU active on ≥2 stores (oversell risk; dedicated 6th card, does not overload Duplicate). Per-row store badges + a store filter. Empty state shows a "Sync eBay listings & compare" button. |
| Admin | `page-admin` (392) | `loadAdmin` (1280) | Sequence management (`editSeq`/`addSeq`), bulk locations, `exportCSV` (1344) for items/locations/moves, DB + eBay status. |

## Modals
`#modal-add-location` (537), `#modal-add-item` (549), `#modal-add-seq` (563). Opened via `openModal`/`closeModal` (705–706).

## Key data facts (gotchas for future sessions)
- **eBay orders & listings are NOT persisted** — they live only in the in-memory JS arrays `ORDERS` and `ALL_LISTINGS`, repopulated per sync/import and **reset on page refresh**. Inventory Health depends on `ALL_LISTINGS` being loaded first (hence the empty-state Sync button).
- **Multi-store:** every `ORDERS`/`ALL_LISTINGS` entry carries a `store` tag (`dynatrack`/`autolumen`). `syncEbayOrders`/`syncEbayListings` hit the combined endpoints (full replace — both stores). **`syncStore(key)` (per-store) MUST replace only that store's slice via `arr.filter(x => x.store !== key).concat(fresh)` — never reassign the array, or the other store is silently wiped** (commented at the call site). `storeBadge`/`storeLabel`/`storeCountLabel` render store chips/counts.
- **SKU normalization** (`normalizeSkuKey`, 1343): `(sku||'').trim().toUpperCase().replace(/[A-Z]+$/,'')` — strips trailing letters so eBay `INT4306R` matches WMS serial `INT4306` (rule 8).
- All data access goes through `api(path,opts)` (627) → `fetch('/api'+path)` with the token header. No third-party SDKs (rule 19).

## Full function index (line → name)
587 showLogin · 592 hideLogin · 596 doLogin · 627 doLogout · 639 api · 657 setSyncing · 661 setSynced · 665 setSyncErr · 676 navigate · 693 showToast · 705 openModal · 706 closeModal · 710 openAddLocation · 711 openAddItem · 712 openAddSeq · 717 loadDashboard · 756 dashSearch · 780 loadScanLocations · 790 handleScan · 809 filterLocs · 821 selectLoc · 828 doMove · 844 resetScan · 853 loadRecentMoves · 871 loadLocations · 882 buildZoneTabs · 890 setLocZone · 897 filterLocGrid · 899 renderLocGrid · 910 addLocation · 922 bulkAddLocations · 941 loadInventory · 964 filterInvStatus · 970 filterInv · 972 addItem · 991 loadLabels · 1014 renderSeqDisplay · 1022 updateLabel · 1031 autoSerial · 1045 printLabel · **1062 storeLabel · 1063 storeBadge · 1064 storeCountLabel · 1067 mapOrder · 1080 mapListing** · 1084 syncEbayNow · 1090 syncEbayOrders · 1107 syncEbayListings · **1128 syncStore** · 1159 parseCSV · 1178 importOrdersCSV · 1203 importListingsCSV · 1225 renderOrders · 1250 filterOrders · 1251 filterOrderStatus · 1253 renderListings · 1274 filterListings · 1275 filterListingStock · 1280 loadAdmin · 1317 editSeq · 1329 addSeq · 1344 exportCSV · 1376 loadInventoryHealth · 1397 normalizeSkuKey · 1478 renderHealthTable · 1554 filterHealth · **1555 filterHealthStore** · 1557 filterHealthStatus · 1564 exportHealthCSV
