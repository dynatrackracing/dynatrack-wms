# Dynatrack WMS — Self-Hosted on Railway

Your own Warehouse Management System. No subscriptions. Full data ownership.

## What's included

| Feature | Status |
|---|---|
| Dashboard with live stats | ✅ |
| Scan & Move (USB/Bluetooth barcode scanners) | ✅ |
| Locations management + bulk add | ✅ |
| Inventory tracking (STORED / STAGED / SHIPPED) | ✅ |
| Label generator with auto-sequences | ✅ |
| eBay Orders (CSV import from Seller Hub) | ✅ |
| eBay Listings (CSV import from Seller Hub) | ✅ |
| CSV export (items, locations, moves) | ✅ |
| Admin panel | ✅ |
| Live eBay API sync | 🔜 (add env vars — see below) |

---

## Deploy to Railway (step by step)

### 1. Create a Railway account
Go to [railway.app](https://railway.app) and sign up.

### 2. Install the Railway CLI
```bash
npm install -g @railway/cli
railway login
```

### 3. Push this project
```bash
cd dynatrack-wms
railway init          # creates a new project
railway up            # deploys the app
```

### 4. Add a PostgreSQL database
In the Railway dashboard:
- Click **+ New** → **Database** → **PostgreSQL**
- Railway will automatically set `DATABASE_URL` in your service's environment

### 5. Run the database schema
In the Railway dashboard, open your PostgreSQL service → **Connect** tab → copy the connection string, then run:
```bash
psql "your-connection-string" -f db/schema.sql
```

Or use any Postgres GUI (TablePlus, DBeaver, etc.) to run `db/schema.sql`.

### 6. Get your app URL
Railway assigns a URL like `https://dynatrack-wms-production.up.railway.app`.
You can add a custom domain in Railway dashboard → Settings → Domains.

---

## Environment Variables

Set these in Railway dashboard → your service → Variables:

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | ✅ Auto-set | Set automatically when you add a Railway Postgres DB |
| `PORT` | Auto-set | Railway sets this automatically |
| `EBAY_APP_ID` | Optional | eBay Developer App ID for live sync |
| `EBAY_TOKEN` | Optional | eBay OAuth token for live sync |

---

## Importing eBay data

Until you wire up the live eBay API:

1. Go to **eBay Seller Hub** → Orders → Download report (CSV)
2. In the WMS → **eBay Orders** → click **Import CSV**
3. For listings: Seller Hub → Listings → Export → Import CSV into **eBay Listings**

The CSV parser handles eBay's standard column names automatically.

---

## Barcode scanners

USB and Bluetooth scanners work out of the box — they emulate keyboard input.
- Open **Scan & Move**
- The input field is auto-focused
- Scan the barcode → it submits on Enter (scanners send Enter automatically)

---

## Adding locations

Two ways:
1. **Locations page** → Add Location (one at a time)
2. **Admin** → Add Location Bulk (paste a list, one per line)

Location types: `GENERAL`, `FREEZER`, `AMBIENT`, `RETURNS`, `STAGING`

---

## Local development

```bash
npm install

# Set your local Postgres URL
export DATABASE_URL="postgresql://localhost/dynatrack_wms"

# Create the schema
psql $DATABASE_URL -f db/schema.sql

# Start the server
npm start
# or with auto-reload:
npm run dev
```

Open http://localhost:3000

---

## Project structure

```
dynatrack-wms/
├── server.js          # Express backend + all API routes
├── package.json
├── railway.toml       # Railway deployment config
├── public/
│   └── index.html     # Full WMS frontend (single file)
└── db/
    └── schema.sql     # PostgreSQL schema — run once after deploy
```

---

## API reference

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | DB health check |
| GET | `/api/stats` | Dashboard counts + recent moves |
| GET | `/api/locations` | List all locations |
| POST | `/api/locations` | Add location `{name, type}` |
| DELETE | `/api/locations/:name` | Remove location |
| GET | `/api/items` | List items (filter: `status`, `search`, `limit`) |
| GET | `/api/items/:serial` | Get single item |
| POST | `/api/items` | Add item `{serial, status, location, notes}` |
| PATCH | `/api/items/:serial` | Update item |
| POST | `/api/move` | Scan & move `{serial, to_location}` — atomic |
| GET | `/api/moves` | Move history (filter: `serial`, `limit`) |
| GET | `/api/sequences` | List serial sequences |
| POST | `/api/sequences` | Add prefix `{prefix}` |
| POST | `/api/sequences/next/:prefix` | Issue next serial number |
| PATCH | `/api/sequences/:prefix` | Update next num `{next_num}` |
| GET | `/api/print-log` | Label print history |
| POST | `/api/print-log` | Log a print `{value, type, qty}` |
| GET | `/api/ebay/health` | eBay API connection status |
