# SNAPSHOT_SCHEMA.md — `db/schema.sql`

> Orientation map of the database. Regenerate at session end if `db/schema.sql` or a `db/migrations/` file changed (HAWKER_RULES rule 38).
> Generated 2026-05-29 from `db/schema.sql` **+ applied migrations in `db/migrations/`**. PostgreSQL (Railway).
> `db/schema.sql` is the fresh-provision seed (run once; **not** re-runnable — rule 28). **Live schema changes are additive migration files (rule 9); `schema.sql` is intentionally NOT edited in place**, so the live DB = `schema.sql` + every `db/migrations/NNNN-*.sql` applied in order. Migrations applied: **`0001-ebay-order-lines.sql`** (2026-05-29).

## Tables

### `locations`
| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `name` | TEXT NOT NULL **UNIQUE** | the human/barcode location code; referenced by `items.location` |
| `type` | TEXT NOT NULL DEFAULT `'SHELF_BIN'` | values seen: SHELF_BIN, UNLISTED_TOTE, RETURNS_TOTE, GENERAL, FREEZER, AMBIENT, STAGING |
| `created_at` | TIMESTAMPTZ DEFAULT NOW() | |

### `items`
| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `serial` | TEXT NOT NULL **UNIQUE** | primary cross-system key; immutable once assigned (rule 30) |
| `status` | TEXT NOT NULL DEFAULT `'STAGED_UNLISTED'` | **only** `STORED` \| `STAGED_UNLISTED` \| `SHIPPED` (rule 11) |
| `location` | TEXT → **`locations(name)`** | FK `ON UPDATE CASCADE ON DELETE SET NULL` (rule 12) — renaming a location updates items; deleting nulls them |
| `notes` | TEXT | |
| `created_at` / `updated_at` | TIMESTAMPTZ DEFAULT NOW() | `updated_at` auto-maintained by trigger |

### `moves` — append-only audit log (rule 13)
| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `serial` | TEXT NOT NULL | not an FK (history survives item deletion) |
| `from_location` | TEXT | nullable (first placement has no origin) |
| `to_location` | TEXT NOT NULL | |
| `moved_by` | TEXT NOT NULL DEFAULT `'dynatrack'` | |
| `moved_at` | TIMESTAMPTZ DEFAULT NOW() | |
| | | **Never UPDATE/DELETE** rows — reporting depends on integrity. |

### `sequences` — gap-free serial issuance (rule 10)
| Column | Type | Notes |
|---|---|---|
| `prefix` | TEXT PK | e.g. INT, EXT, … |
| `next_num` | INTEGER NOT NULL DEFAULT 1 | incremented atomically server-side; never via MAX(serial) |

### `print_log`
| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `value` | TEXT NOT NULL | label value printed |
| `type` | TEXT NOT NULL DEFAULT `'serial'` | serial \| sku \| location |
| `qty` | INTEGER NOT NULL DEFAULT 1 | |
| `printed_at` | TIMESTAMPTZ DEFAULT NOW() | |

### `ebay_order_lines` — *added by migration `0001-ebay-order-lines.sql` (2026-05-29); NOT in `schema.sql`*
Persists eBay **sold order LINES** (one row per `OrderLineItemID`) so fulfilment state survives page refresh and a sync can reconcile against it. Backbone for the Pick List / Shipped Items rework. **Created empty — not yet populated or wired** (the sync + read paths land in later sessions of the rework). eBay listings and live order *headers* are still ephemeral (browser `ALL_LISTINGS` / `ORDERS`); this table is the first persisted eBay data.
| Column | Type | Notes |
|---|---|---|
| `order_line_item_id` | TEXT **PK** | eBay `OrderLineItemID` = `"<ItemID>-<TransactionID>"`. **The stable per-line key — never key on `OrderID`** (one order can hold many lines / combined-payment carts). |
| `store` | TEXT NOT NULL | STORES registry key (`dynatrack` \| `autolumen` \| future). No CHECK — adding a store must not need a migration. |
| `ebay_item_id` | TEXT NOT NULL | eBay `ItemID` |
| `ebay_transaction_id` | TEXT NOT NULL | eBay `TransactionID` |
| `sku_raw` | TEXT (nullable) | as listed on eBay (may be NULL / suffixed, e.g. `INT4306R`) |
| `sku_norm` | TEXT (nullable) | normalized per rule 8 (trailing letters stripped); NULL if no SKU |
| `title` | TEXT (nullable) | listing title at time of sale |
| `paid` | BOOLEAN NOT NULL DEFAULT FALSE | |
| `paid_time` | TIMESTAMPTZ (nullable) | |
| `shipped` | BOOLEAN NOT NULL DEFAULT FALSE | eBay's shipped flag (`ShippedTime` present) — eBay's view, distinct from WMS pick state |
| `ebay_shipped_time` | TIMESTAMPTZ (nullable) | |
| `matched_serial` | TEXT (nullable) | WMS `items.serial` this line resolved to. **Soft pointer, NOT an FK** (like `moves.serial` — survives item deletion, tolerates fuzzy/normalized matching) |
| `location_unknown` | BOOLEAN NOT NULL DEFAULT FALSE | true when no WMS shelf location could be resolved |
| `disposition` | TEXT NOT NULL DEFAULT `'NEEDS_PICK'` | **CHECK** ∈ `NEEDS_PICK` \| `SHIPPED` \| `CANCELLED` \| `DISMISSED`. WMS-side fulfilment state (vs eBay's own `shipped`/`paid`). |
| `first_seen` | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |
| `last_synced` | TIMESTAMPTZ NOT NULL DEFAULT NOW() | set by the sync each pass |
| `ebay_last_modified` | TIMESTAMPTZ (nullable) | eBay's last-modified, for change detection |

## Trigger
- `touch_updated_at()` → `items_updated_at` BEFORE UPDATE on `items` keeps `updated_at` current.
- No trigger on `ebay_order_lines` — `last_synced` is set explicitly by the sync.

## Indexes
`items(serial)`, `items(status)`, `items(location)`, `moves(serial)`, `moves(moved_at DESC)`.
`ebay_order_lines`: PK on `order_line_item_id` + `(store)`, `(disposition)`, `(sku_norm)`, `(matched_serial)`, `(ebay_item_id)`.

## Seed sequences (⚠️ template only — NOT production)
`schema.sql` seeds prefixes **INT, EXT, HR, FR, AR** (`ON CONFLICT DO NOTHING`). **Production has 12 sequences** (per data-counts rule 27 / rule 10: INT, MOD, CLU, EXT, ECU, ENG, FUS, DMO, PS, …). Do not treat the seed list as authoritative — it's a fresh-DB starter.

## Important absences (so future sessions don't hunt for them)
- **No `ebay_listings` table, no order-*header* table.** eBay listings and order headers are still fetched live by `/api/ebay/*` and held only in the browser (`ALL_LISTINGS`, `ORDERS`) — never written to Postgres. (See SNAPSHOT_ROUTES / SNAPSHOT_FRONTEND.) **Exception:** `ebay_order_lines` (migration 0001) now persists sold-order *lines* — but it is **created empty and not yet read/written by any route** (the Pick List still reads live orders via a server-side join); wiring lands in later sessions of the rework.
- No Supabase anywhere (rule 7). DB is Railway Postgres via `DATABASE_URL`.

## Production data baseline (as of 2026-04-02, rule 27)
537 locations · 3,380 items · 3,969 moves · 12 sequences. Drastically different counts in a session = investigate before changing anything.
