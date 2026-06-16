# SETUP_DB_ACCESS.md — Durable DB access for Claude Code sessions

**Problem this kills:** every session starts with no creds → Railway logged out → diagnosis stalls on an interactive `railway login`. Fix: a **read-only** connection that's always present (safe to leave ambient), and a **privileged** connection that's supplied only for gated write sessions. Done once.

You do **not** need the Railway CLI for any of this — two connection strings in `.env` cover reads and writes. (CLI/token is an optional footnote at the bottom.)

See also: the **DB ACCESS** section in `CLAUDE.md` (the session-start convention that points here).

---

## 1. Create a read-only Postgres role (run once, as the privileged user)
Connect to prod Postgres with the existing `postgres` creds (Railway dashboard → Postgres service → **Data** or `railway connect`), then:

```sql
CREATE ROLE claude_ro LOGIN PASSWORD '<generate-a-strong-random-password>';
GRANT CONNECT ON DATABASE railway TO claude_ro;
GRANT USAGE  ON SCHEMA public TO claude_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO claude_ro;
-- so future tables (new migrations) are readable too, without re-granting:
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO claude_ro;
```

`claude_ro` can read everything and write nothing. That's the whole point — even if this string sits in a file forever, the blast radius is "someone read the data," never a mutation.

> Note: `ALTER DEFAULT PRIVILEGES` only auto-grants for tables created by the role that ran it (`postgres`). Since migrations run as `postgres`, new tables are covered. If a future table ever isn't readable, re-run the two `GRANT … SELECT` lines.

## 2. Get the **public** connection string
The app's internal `DATABASE_URL` points at `*.railway.internal`, which is only reachable from inside Railway's network — it will **not** connect from a Claude Code session. Use the **public** proxy URL instead (Railway → Postgres service → **Variables** → the public URL, usually `DATABASE_PUBLIC_URL`, host like `<region>.proxy.rlwy.net:<port>`).

Build the read-only string by swapping in the `claude_ro` user:
```
postgresql://claude_ro:<password>@<public-host>.proxy.rlwy.net:<port>/railway?sslmode=require
```

## 3. Drop both strings in a gitignored `.env` at the repo root
```dotenv
# READ-ONLY — ambient, safe, used for ALL diagnosis (Step 0 etc.)
DATABASE_URL_RO=postgresql://claude_ro:<password>@<public-host>.proxy.rlwy.net:<port>/railway?sslmode=require

# PRIVILEGED — persistent (set 2026-06-16). Used for gated mutations.
# The gate is the dry-run + explicit "commit", NOT cred presence.
DATABASE_URL_RW=postgresql://postgres:<password>@<public-host>.proxy.rlwy.net:<port>/railway
```
Distinct names on purpose: `DATABASE_URL_RO` for diagnosis, `DATABASE_URL_RW` only when intentionally mutating. Neither is the app's own `DATABASE_URL` (that stays a Railway service var, untouched).

## 4. Make sure `.env` is ignored and never commits
Confirm `.gitignore` contains:
```
.env
.env.*
```
`git status` must show `.env` as untracked/ignored. **Never commit a connection string** — the repo is on GitHub. *(Verified present in this repo's `.gitignore`, lines 6–7.)*

## 5. Verify it survives a fresh session
Open a **new** Claude Code session and run — it must work with zero interaction:
```bash
node -e "const {Client}=require('pg');const c=new Client(process.env.DATABASE_URL_RO||require('dotenv').config()&&process.env.DATABASE_URL_RO);c.connect().then(()=>c.query('select count(*) from items')).then(r=>{console.log('RO OK, items=',r.rows[0].count);return c.end();}).catch(e=>{console.error('FAIL',e.message);process.exit(1);});"
```
Then prove it's truly read-only (this should **fail** with a permission error):
```bash
node -e "const {Client}=require('pg');const c=new Client(process.env.DATABASE_URL_RO);c.connect().then(()=>c.query('create table _probe(i int)')).then(()=>{console.log('BAD: write succeeded');process.exit(1);}).catch(e=>{console.log('GOOD, write denied:',e.message);return c.end();});"
```
> Note for this machine: `dotenv` is **not** installed, so the `require('dotenv')` fallback above won't load `.env` on its own. Either (a) export the var into the shell before running, or (b) have the script read `.env` directly. Read-only diagnostic scripts in this repo parse `.env` with `fs` (no dotenv dependency) — that's the supported pattern.

If your sessions are **ephemeral** (fresh clone each time) and `.env` doesn't persist, put `DATABASE_URL_RO` in your Claude Code project's environment/secrets config or a host-level user variable instead — the test above is the proof it's wired right.

---

## Gated writes (migrations, the archive step)
`DATABASE_URL_RW` is **persistent** in `.env` (privileged URL, set 2026-06-16) — no per-session paste. The human-in-the-loop gate is the **dry-run → explicit "commit"** step, not cred presence: every mutation runs `BEGIN … <update> … verify … ROLLBACK` first, Claude Code reports the rowcount/verify, and only re-runs with `--commit` after the architect types "commit". That discipline — not withholding the credential — is the safety. (Rotate the privileged password periodically; treat the RW string as a secret, never commit it.)

## Deploys
Unchanged: code ships via `git push` → Railway auto-deploy. No CLI needed.

## Optional — Railway CLI token (only if you ever want CLI-driven `railway run`/`variables`/`up`)
Create an **account/workspace token** and set `RAILWAY_API_TOKEN` (NOT a project token). Project tokens are deployment-scoped and return "Unauthorized" on `railway run`/`variables` — that's the exact wall sessions have been hitting. With the token set the CLI skips interactive login automatically; scope with `--service <name>` and **avoid `--project`** (passing it makes the CLI ignore the token and fall back to interactive login). Treat this token like `DATABASE_URL_RW`: supplied for write sessions, not left ambient.

## Hygiene
Never commit creds · rotate `claude_ro` periodically · the RO role's only power is reading.
