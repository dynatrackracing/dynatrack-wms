# SNAPSHOT_FRONTEND.md — `public/index.html`

> Orientation map of the single-file frontend. Regenerate at session end if `public/index.html` changed (HAWKER_RULES rule 38).
> Generated 2026-05-28 from `public/index.html` (~1543 lines: inline CSS + inline vanilla JS, no build step, no framework). Line numbers approximate.

## Shell
- **SPA**: a fixed nav + left sidebar + `<main>` holding nine `.page` divs. `navigate(p)` (664) toggles `.active` on `#page-<p>` and the matching sidebar `.ni[data-page]`.
- **Auth**: login screen (`#login-screen`, ~130). Token stored in `localStorage` as `wms_token`; sent as `x-wms-token` by the `api()` helper (627). A 401 from `api()` triggers `showLogin()`.
- **Sync dot** in the nav reflects request state via `setSyncing()/setSynced()/setSyncErr()` (645–653). Toasts via `showToast(msg,isErr)` (681).

## Pages (sidebar order)
| Page | `id` | Loader fn | What it does |
|---|---|---|---|
| Dashboard | `page-dashboard` (197) | `loadDashboard` (705) | Stats cards + recent moves + eBay status card; `dashSearch` (739) global lookup. |
| Scan & Move | `page-scan` (228) | `loadScanLocations` (763) | Scan input → `handleScan` (773); pick destination (`filterLocs`/`selectLoc`); `doMove` (811) calls `POST /api/move`. |
| Locations | `page-locations` (268) | `loadLocations` (854) | Zone-tabbed grid (`buildZoneTabs`/`renderLocGrid`); `addLocation` (893); `bulkAddLocations` (905). |
| Inventory | `page-inventory` (282) | `loadInventory` (924) | Status-filtered item table (`filterInvStatus`/`filterInv`); `addItem` (955). |
| Labels | `page-labels` (301) | `loadLabels` (974) | Barcode label generator; `autoSerial` (1014) pulls next from a sequence; `printLabel` (1028) logs to print-log. |
| eBay Orders | `page-ebay` (335) | `syncEbayOrders` (1048) | Live sync (`GET /api/ebay/orders`) or `importOrdersCSV` (1128); `renderOrders` (1175). |
| eBay Listings | `page-listings` (366) | `syncEbayListings` (1076) | Live sync (`GET /api/ebay/listings`) or `importListingsCSV` (1153); `renderListings` (1202). Populates the in-memory `ALL_LISTINGS` (1105). Auto-syncs on open if empty (navigate, ~676). |
| Inventory Health | `page-health` (433) | `loadInventoryHealth` (1322) | Client-side reconcile of `ALL_LISTINGS` vs WMS items; `normalizeSkuKey` (1343) strips trailing letters (rule 8); buckets Matched/eBay-Only/WMS-Only/Duplicate/Staging; `renderHealthTable` (1417). **Empty state shows a "Sync eBay listings & compare" button** (2026-05-27 fix). |
| Admin | `page-admin` (392) | `loadAdmin` (1227) | Sequence management (`editSeq`/`addSeq`), bulk locations, `exportCSV` (1291) for items/locations/moves, DB + eBay status. |

## Modals
`#modal-add-location` (525), `#modal-add-item` (537), `#modal-add-seq` (551). Opened via `openModal`/`closeModal` (693–700).

## Key data facts (gotchas for future sessions)
- **eBay orders & listings are NOT persisted** — they live only in the in-memory JS arrays `ORDERS` and `ALL_LISTINGS`, repopulated per sync/import and **reset on page refresh**. Inventory Health depends on `ALL_LISTINGS` being loaded first (hence the empty-state Sync button).
- **SKU normalization** (`normalizeSkuKey`, 1343): `(sku||'').trim().toUpperCase().replace(/[A-Z]+$/,'')` — strips trailing letters so eBay `INT4306R` matches WMS serial `INT4306` (rule 8).
- All data access goes through `api(path,opts)` (627) → `fetch('/api'+path)` with the token header. No third-party SDKs (rule 19).

## Full function index (line → name)
575 showLogin · 580 hideLogin · 584 doLogin · 615 doLogout · 627 api · 645 setSyncing · 649 setSynced · 653 setSyncErr · 664 navigate · 681 showToast · 693 openModal · 694 closeModal · 698 openAddLocation · 699 openAddItem · 700 openAddSeq · 705 loadDashboard · 739 dashSearch · 763 loadScanLocations · 773 handleScan · 792 filterLocs · 804 selectLoc · 811 doMove · 827 resetScan · 836 loadRecentMoves · 854 loadLocations · 865 buildZoneTabs · 873 setLocZone · 880 filterLocGrid · 882 renderLocGrid · 893 addLocation · 905 bulkAddLocations · 924 loadInventory · 947 filterInvStatus · 953 filterInv · 955 addItem · 974 loadLabels · 997 renderSeqDisplay · 1005 updateLabel · 1014 autoSerial · 1028 printLabel · 1044 syncEbayNow · 1048 syncEbayOrders · 1076 syncEbayListings · 1109 parseCSV · 1128 importOrdersCSV · 1153 importListingsCSV · 1175 renderOrders · 1199 filterOrders · 1200 filterOrderStatus · 1202 renderListings · 1221 filterListings · 1222 filterListingStock · 1227 loadAdmin · 1264 editSeq · 1276 addSeq · 1291 exportCSV · 1322 loadInventoryHealth · 1343 normalizeSkuKey · 1417 renderHealthTable · 1485 filterHealth · 1487 filterHealthStatus · 1494 exportHealthCSV
