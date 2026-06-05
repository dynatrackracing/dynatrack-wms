# HAWKER_RULES.md — READ THIS FIRST EVERY SESSION

These are non-negotiable constraints for HawkerWMS development. Violating any of these has caused, or would cause, real bugs in production. Read all of them before touching any file.

---

## WORKFLOW RULES

1. **DIAGNOSE BEFORE TOUCHING.** Read the actual deployed code before making changes. Run read-only diagnostics before any writes. No assumptions about what a file contains.

2. **ONE DELIVERABLE PER SESSION.** Fix one thing, test it, commit it. Do not touch files unrelated to the current task.

3. **READ HAWKER_SESSION.md AND HAWKER_CHANGELOG.md FIRST.** These tell you what the previous session did. Do not overwrite work from previous sessions without understanding it.

4. **COMMIT FORMAT:** `git add -A && git commit -m "descriptive message" && git push origin main`. Railway auto-deploys from `main` push (~60-90 seconds).

5. **UPDATE HAWKER_SESSION.md** at the end of every session with: what was changed, what files were touched, what's still broken, what's next. **HAWKER_SESSION.md is append-only in the sense that you never delete old entries** — old sessions stay forever. Prepend `## HH:MM UTC — Description` for each new session (newest entry at the top). Date headers (`# YYYY-MM-DD`) separate days.

6. **APPEND TO HAWKER_CHANGELOG.md** at the end of every session with: date, summary, files touched.

---

## DATABASE RULES

7. **Supabase is dead. Never reference, restore, or suggest it.** The database is Railway PostgreSQL. Connection via `DATABASE_URL` env var. If you find Supabase references anywhere in the codebase, flag them but do not fix them unless asked.

8. **eBay SKU ↔ WMS serial normalization.** eBay SKUs have trailing letter suffixes (`INT4306R`, `MOD19595V`) where R = refurbished, V = variant. WMS serials are bare (`INT4306`, `MOD19595`). Strip trailing letters before comparing in any Inventory Health, matching, or sync logic. Never store the suffixed form in the `items` table.

9. **Schema lives in `db/schema.sql`.** Tables: `locations`, `items`, `moves`, `sequences`. Any schema change requires a new migration file (`db/migrations/NNNN-description.sql`) AND a record in HAWKER_SESSION.md AND HAWKER_CHANGELOG.md. Do not edit `schema.sql` in place for live database changes.

10. **Serial sequences are not gap-free.** The `sequences` table tracks `next_num` per prefix (INT, MOD, CLU, EXT, ECU, ENG, FUS, DMO, PS). Always increment via atomic `UPDATE sequences SET next_num = next_num + 1 WHERE prefix = $1 RETURNING next_num`. Never compute the next serial by querying `MAX(serial)` — concurrent label prints will collide.

11. **`items.status` is one of:** `STORED` | `STAGED_UNLISTED` | `SHIPPED`. No other values. Validate on insert.

12. **`items.location` is a foreign key to `locations.name`** (not `locations.id`). Cascade is `ON UPDATE CASCADE ON DELETE SET NULL`. Renaming a location updates every item; deleting a location nulls items in it (does not delete them).

13. **`moves` is the audit log — append-only.** Every status or location change writes a `moves` row. Never UPDATE or DELETE `moves`. Reporting and history depend on its integrity.

---

## DEPLOYMENT RULES

14. **HawkerWMS and the old paid WMS are fully separated.**
    - **HawkerWMS** (`hawkerwms.up.railway.app`) — Ry's own Railway account, owned and controlled by Ry. Connects to Railway PostgreSQL.
    - **Old paid WMS** (`wms-prod.up.railway.app`) — third-party developer's app, still subscribed at $300/mo until cutover. Backend at `warehouse-wms-production-b1fd.up.railway.app`. View-only access for Ry. **NEVER touch this app, its database, or its deployment.** Do not attempt to log in, scrape, or modify it without explicit instruction.

15. **Railway env vars (production):** `DATABASE_URL`, `WMS_USERNAME`, `WMS_PASSWORD`, `TRADING_API_APP_NAME`, `TRADING_API_CERT_NAME`, `TRADING_API_DEV_NAME`, `TRADING_API_TOKEN`. Never commit these to the repo. `.env` is `.gitignore`d.

16. **Never deploy directly to Railway via `railway up` or CLI from local.** Push to GitHub `main` and let Railway auto-deploy. This keeps both machines (desktop + laptop) and the deployed app in sync via one source of truth.

17. **Verify deploys after push.** Wait 60-90s, then `curl https://hawkerwms.up.railway.app/api/health`. If the health check fails or the page you modified shows the old version, the deploy failed — check Railway logs before declaring done.

---

## FRONTEND RULES

18. **`public/index.html` is a single file.** No build step, no bundler, no React, no npm install on the frontend. Inline CSS, inline JS. Loads in any browser including warehouse tablets and phones.

19. **Frontend talks to `/api/*` only.** No third-party SDKs, no Supabase client, no direct DB connections from the browser. Every data fetch goes through Express routes in `server.js`.

20. **Auth header is `x-wms-token`.** Token stored in `localStorage` as `wms_token`. Sessions last 12 hours, sliding expiry on activity.

21. **Theme:** light, warm beiges/whites/navy blues. Fonts: Plus Jakarta Sans (UI), Fira Code (data/serial numbers). Logo: hawk SVG, app titled "HawkerWMS." Do not change the theme without explicit instruction.

22. **Barcode scanners are USB/Bluetooth HID devices** — they emit keystrokes ending in Enter. The scan input must be `<input>` with an Enter-key handler. No special drivers, no WebUSB, no native APIs.

---

## EBAY INTEGRATION RULES

23. **eBay Trading API (XML), site ID 0 (US).** Not the Sell API. Not the Inventory API. Trading API is what the old WMS used and what HawkerWMS continues to use for compatibility with existing listing data.

24. **Listings sync is manual (button-triggered), not automatic.** User clicks "Sync Live Listings" on the eBay Listings page. No cron jobs writing eBay data. Reason: rate limits and unpredictable API behavior — manual sync gives the user control.

25. **No write operations to eBay listings from HawkerWMS.** Read-only. The app pulls orders and listings; it does not revise prices, end items, or relist. Listing management happens outside this app (Seller Hub directly).

26. **Inventory Health page compares WMS items vs eBay listings.** Five buckets: Matched, eBay Only, WMS Only, Duplicate, Staging. Matching uses the SKU normalization rule (rule 8). A blank Inventory Health page means listings haven't been synced yet.

---

## DATA INTEGRITY RULES

27. **Production data counts (as of 2026-05-31 CUTOVER; locations updated 2026-06-05):** 547 locations (490 RACK + 35 SHELF_BIN + 21 UNLISTED_TOTE + 1 SHIPPED — **migration 0007 2026-06-05** converted rack-pattern shelf bins → RACK, deleted 1 malformed bin, renamed 9 spelled-out section-O names to compact; the 35 SHELF_BIN are non-rack oddballs kept by design [BIN 01-26, FAN, ESECTA/B/C, RYR0001-4, CR03A02]), 3,390 items (all STORED; **intake_date backfilled 2026-05-31** from the extract's createdAt — was NULL at cutover), 3,390 moves (all import-baseline), 12 serial sequences (vestigial). Live-inventory-only baseline — shipped items were dropped at cutover (eBay/ShippingEasy own shipped now). If you see drastically different counts in a session, investigate before making changes — something may be wrong. *(Prior 2026-04-02 baseline 537/3,380/3,969 superseded by the cutover reload.)*

28. **The `hawker-import.sql` file in the repo is the initial seed,** not a re-runnable migration. Re-running it on a populated database will fail on UNIQUE constraints. Do not run it without a fresh/empty DB.

29. **Backups:** Railway PostgreSQL backups are configured at the Railway level. Do not write app-level backup logic. If a backup is needed, use Railway's UI.

30. **Item serials are the primary key for matching across systems.** Treat them as immutable once assigned. Never bulk-rename serials. If a serial needs to change, it's a `DELETE` + `INSERT` with a new `moves` row recording the change.

---

## ENVIRONMENT / SYNC RULES

31. **Canonical repo lives at `C:\Users\atenr\dynatrack-wms-repo` (origin `github.com/dynatrackracing/dynatrack-wms`, `main`).** Code **and** memory files **and** `SNAPSHOT_*.md` all live here. Cross-machine sync is via **git clone/pull/push**, not Google Drive. `git push origin main` both deploys (Railway auto-deploy) and propagates memory files to other machines. The old `G:\My Drive\dynatrack-wms\` folder is abandoned (2026-05-28).

32. **`.env` is machine-local, never synced.** It's in `.gitignore` for git, and should not be in `G:\My Drive\` either if anyone ever moves the project there fully. For HawkerWMS specifically, local `.env` is rarely needed because we develop against Railway directly — but if used, it lives only on one machine.

33. **Claude Code Auto Mode** is enabled on both machines via `~/.claude/settings.json` → `"defaultMode": "auto"`. A reusable setup batch lives at `G:\My Drive\setup-claude-auto.bat` for new machines.

34. **Single GitHub repo.** No second/legacy repo to confuse with. The HawkerWMS repo on Ry's GitHub account is the only deployment source.

---

## MEMORY / PROJECT-KNOWLEDGE SYNC RULES

35. **Architect/worker boundary.** Human is architect; Claude Code is worker. The architect never asks the human to perform worker-class tasks (commands, browser actions, endpoint checks, log reads, file uploads, code edits). If a task is worker-class, it goes in the brief to Claude Code. Human tasks are decisions, approvals, and tasks that genuinely cross a system boundary Claude Code cannot reach.

36. **Memory files are canonical in the git repo — not Drive.** The four memory files (`CLAUDE.md`, `HAWKER_RULES.md`, `HAWKER_SESSION.md`, `HAWKER_CHANGELOG.md`) plus the `SNAPSHOT_*.md` files live in the repo root (`C:\Users\atenr\dynatrack-wms-repo`, `origin/main`). Claude Code reads them at session start and updates + commits them at session end as part of the normal routine (rules 4–6). **The old `G:\My Drive\dynatrack-wms\` copies are abandoned as of 2026-05-28** — never read or edit memory files there; they are stale.

37. **claude.ai project knowledge is a manual briefing-room re-upload — no automation.** There is no supported public API to write claude.ai project knowledge (confirmed 2026-05; the Files API is a separate developer-API system, and Projects has no write endpoint). Do **not** build cookie-auth scrapers, Drive-connector dependencies, or other workarounds. After a session's commit, the **human (architect)** re-uploads the changed memory files into the project knowledge so the web Claude is briefed with current state. Claude Code must **never claim a sync ran** — none exists; fail loud, never fake success. *(This supersedes the earlier Google-Drive-connector idea and its runbook, which are now moot.)*

38. **Regenerate SNAPSHOTS at session end when code changed.** Maintained snapshots in the repo root: `SNAPSHOT_ROUTES.md` (the `server.js` API surface), `SNAPSHOT_FRONTEND.md` (`public/index.html` pages + functions), `SNAPSHOT_SCHEMA.md` (`db/schema.sql` tables). If a session changed `server.js`, `public/index.html`, or `db/schema.sql`, regenerate the affected snapshot(s) before committing so they reflect HEAD. Snapshots are a fast orientation map for future sessions and must never drift from the code.

39. **Project-knowledge re-upload cadence.** Re-upload the four memory files (`CLAUDE.md`, `HAWKER_RULES.md`, `HAWKER_SESSION.md`, `HAWKER_CHANGELOG.md`) to the claude.ai project knowledge **after every session that committed changes to any of them**, OR **weekly at minimum**, whichever is sooner. The web Claude reads project knowledge at chat start; if it's stale, the briefing-room model (Rule 37) silently fails. The human (architect) performs this upload — Claude Code cannot. After a session-end commit, the final step before closing the session is to tell the human: "Memory files updated this session — re-upload CLAUDE.md, HAWKER_RULES.md, HAWKER_SESSION.md, HAWKER_CHANGELOG.md to project knowledge before the next web-Claude session. Current stamp: <hash> @ <UTC>."

40. **Sync stamp + staleness announce.** Claude Code maintains a sync stamp as the FIRST line block of HAWKER_SESSION.md, above all entries:

    <!-- SYNC STAMP -->
    LAST PUSHED COMMIT: <short-hash> @ <YYYY-MM-DD HH:MM UTC>
    STAMP UPDATED BY: Claude Code, session <HH:MM UTC>
    <!-- END SYNC STAMP -->

  At session end, AFTER the commit+push, Claude Code rewrites this block with the just-pushed commit hash and current UTC time, then amends it into that same commit (or commits it as the final step) so the stamp always reflects HEAD. The stamp is the single machine-readable signal of "what state is the canonical repo in."

  The web Claude (architect) reads this stamp at the START of every session and states it back verbatim to the human before doing any work: "I'm briefed from commit <hash> pushed <time>." The human compares that to the latest Claude Code session. If it does not match the most recent push, project knowledge is stale (Rule 39 upload was skipped) — the human re-uploads the four memory files before work proceeds. This makes staleness visible instead of silent, and prevents re-issuing already-closed tasks (the failure mode of 2026-05-27/28).

---

## KNOWN TECH DEBT / OPEN ITEMS

- ~424 items from the old WMS were not captured in the original extract due to API pagination limits. They will populate naturally as scanning happens, but the WMS-Only bucket in Inventory Health may show inflated counts until they do.
- The old paid WMS (`wms-prod.up.railway.app`) is still subscribed at $300/mo. Cancellation pending cutover.
- Final fresh extract from old WMS not yet done — needed to capture moves and new items since 2026-04-02.
- Warehouse tablets may still be pointed at the old WMS URL. Verify and update at cutover.

---

## REMEMBER

Ry is not a programmer. When in doubt, do it yourself rather than asking Ry to run commands. The whole point of this project is for Ry to own the system without needing the developer — that means Claude Code is the developer now. Act like it.
