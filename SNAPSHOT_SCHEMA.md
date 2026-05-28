# SNAPSHOT_SCHEMA.md — `db/schema.sql`

> Orientation map of the database. Regenerate at session end if `db/schema.sql` changed (HAWKER_RULES rule 38).
> Generated 2026-05-28 from `db/schema.sql`. PostgreSQL (Railway). Run once on a fresh DB; **not** a re-runnable migration (rule 28).

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

## Trigger
- `touch_updated_at()` → `items_updated_at` BEFORE UPDATE on `items` keeps `updated_at` current.

## Indexes
`items(serial)`, `items(status)`, `items(location)`, `moves(serial)`, `moves(moved_at DESC)`.

## Seed sequences (⚠️ template only — NOT production)
`schema.sql` seeds prefixes **INT, EXT, HR, FR, AR** (`ON CONFLICT DO NOTHING`). **Production has 12 sequences** (per data-counts rule 27 / rule 10: INT, MOD, CLU, EXT, ECU, ENG, FUS, DMO, PS, …). Do not treat the seed list as authoritative — it's a fresh-DB starter.

## Important absences (so future sessions don't hunt for them)
- **No `ebay_listings` / `ebay_orders` tables.** eBay data is fetched live by `/api/ebay/*` and held only in the browser (`ALL_LISTINGS`, `ORDERS`) — never written to Postgres. (See SNAPSHOT_ROUTES / SNAPSHOT_FRONTEND.)
- No Supabase anywhere (rule 7). DB is Railway Postgres via `DATABASE_URL`.

## Production data baseline (as of 2026-04-02, rule 27)
537 locations · 3,380 items · 3,969 moves · 12 sequences. Drastically different counts in a session = investigate before changing anything.
