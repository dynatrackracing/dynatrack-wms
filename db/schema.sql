-- Dynatrack WMS — PostgreSQL Schema
-- Run this once after provisioning your Railway Postgres database

CREATE TABLE IF NOT EXISTS locations (
  id        SERIAL PRIMARY KEY,
  name      TEXT NOT NULL UNIQUE,
  type      TEXT NOT NULL DEFAULT 'SHELF_BIN',  -- SHELF_BIN, UNLISTED_TOTE, RETURNS_TOTE, GENERAL, FREEZER, AMBIENT, STAGING
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS items (
  id         SERIAL PRIMARY KEY,
  serial     TEXT NOT NULL UNIQUE,
  status     TEXT NOT NULL DEFAULT 'STAGED_UNLISTED', -- STORED | STAGED_UNLISTED | SHIPPED
  location   TEXT REFERENCES locations(name) ON UPDATE CASCADE ON DELETE SET NULL,
  notes      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS moves (
  id            SERIAL PRIMARY KEY,
  serial        TEXT NOT NULL,
  from_location TEXT,
  to_location   TEXT NOT NULL,
  moved_by      TEXT NOT NULL DEFAULT 'dynatrack',
  moved_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sequences (
  prefix   TEXT PRIMARY KEY,
  next_num INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS print_log (
  id         SERIAL PRIMARY KEY,
  value      TEXT NOT NULL,
  type       TEXT NOT NULL DEFAULT 'serial',
  qty        INTEGER NOT NULL DEFAULT 1,
  printed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Trigger to auto-update items.updated_at
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS items_updated_at ON items;
CREATE TRIGGER items_updated_at
  BEFORE UPDATE ON items
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Default sequences — edit prefixes to match your warehouse naming
INSERT INTO sequences (prefix, next_num) VALUES
  ('INT', 1),
  ('EXT', 1),
  ('HR',  1),
  ('FR',  1),
  ('AR',  1)
ON CONFLICT (prefix) DO NOTHING;

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS items_serial_idx   ON items(serial);
CREATE INDEX IF NOT EXISTS items_status_idx   ON items(status);
CREATE INDEX IF NOT EXISTS items_location_idx ON items(location);
CREATE INDEX IF NOT EXISTS moves_serial_idx   ON moves(serial);
CREATE INDEX IF NOT EXISTS moves_moved_at_idx ON moves(moved_at DESC);
