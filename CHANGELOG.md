# CHANGELOG.md

Chronological summary of all changes to HawkerWMS. Newest entries at the TOP. Each entry: `## YYYY-MM-DD — Summary`. Append-only.

---

## 2026-05-28 — Folder consolidation (follow-up #1 ✅): moved the four memory files into the git repo root (canonical now `C:\Users\atenr\dynatrack-wms-repo`; Drive folder abandoned). Updated CLAUDE.md (SYNC ARCHITECTURE + anti-rogue K) and CLAUDE_RULES (Rule 31 repo-canonical; Rule 36 memory-in-repo; Rule 37 project-knowledge manual re-upload, supersedes the dropped connector idea; Rule 38 snapshot regen). Generated first SNAPSHOT_ROUTES.md / SNAPSHOT_FRONTEND.md / SNAPSHOT_SCHEMA.md. No app-code/schema changes.

## 2026-05-28 — Project-knowledge auto-sync investigated; NO supported public API to write claude.ai project knowledge (Files API is separate; only undocumented cookie endpoints exist = forbidden brittle workaround). No sync built or run. Added CLAUDE_RULES 35 (architect/worker boundary) + 36 (memory-sync reality, no fake-success). Wrote `CONNECTOR-SETUP-RUNBOOK.md` for the supported path (claude.ai Google Drive connector, one-time architect UI setup) with an empirical live-sync-vs-snapshot verification step. Backlog (the 2026-05-27 entries) still needs a one-time manual upload to project knowledge.

## 2026-05-27 — Inventory Health blank-page fix (Option B): added an actionable "Sync eBay listings & compare" button to the Health empty state (commit `1838259`, index.html Health path only). Root cause: listings live only in the in-memory `ALL_LISTINGS` array (no `ebay_listings` table) and the Health page never auto-synced — Rule 26. Verified `/api/ebay/listings` returns 3,224 real listings with the current token before patching. Reconciled master list: added "blank Inventory Health" as item #6 (closed); brief's "follow-up #1" label was a mismatch (actual #1 is folder consolidation).

## 2026-05-27 — Fixed eBay sync: diagnosed expired TRADING_API_TOKEN (via temp debug logging, reverted in 7e7fe08 over PII), Ry refreshed token in Railway → 14 GetOrders Ack=Success; located deploy in Railway project `robust-respect`, cloned canonical GitHub repo to `C:\Users\atenr\dynatrack-wms-repo` (Drive folder is not a git repo). Follow-ups: consolidate folders, hands-on testing, dashboard 503 health-card bug, token expiry ~18mo.

## 2026-05-27 — Laptop onboarding: verified synced memory files, merged Auto Mode into existing settings.json (theme preserved), created setup-claude-auto.bat; verified desktop settings.json is correctly nested.

## 2026-05-27 — Doc corrections: placeholder timestamp + rule 5 wording

Fixed the placeholder `22:00 UTC` stamp on the initial LAST_SESSION.md entry (→ `12:00 UTC`) so sessions sort correctly. Reworded CLAUDE_RULES.md rule 5 for the newest-at-top convention ("Append" → "Prepend"; clarified "append-only" = never delete old entries).

**Files touched:** LAST_SESSION.md, CLAUDE_RULES.md.

**No code or schema changes.** Documentation only.

## 2026-05-27 — Session log + changelog flipped to newest-at-top

Reversed the entry-ordering convention in `LAST_SESSION.md` and `CHANGELOG.md` from newest-at-bottom to newest-at-top to match the Darkhawk pattern. Reworded the header instruction line in both files. Existing entries reordered (one per file — cosmetic).

**Files touched:** LAST_SESSION.md, CHANGELOG.md.

**No code or schema changes.** Documentation/convention only.

## 2026-05-27 — Initial project memory system established

Set up the four-file Claude Code memory pattern (CLAUDE.md, CLAUDE_RULES.md, LAST_SESSION.md, CHANGELOG.md) mirroring the Darkhawk project. Migrated project folder from local Documents to Google Drive (`G:\My Drive\dynatrack-wms`) for cross-machine sync between desktop and laptop. Enabled Claude Code Auto Mode on desktop; created reusable setup batch file in Drive for laptop activation.

**Files touched:** CLAUDE.md, CLAUDE_RULES.md, LAST_SESSION.md, CHANGELOG.md (all in project root), `C:\Users\atenr\.claude\settings.json`, `G:\My Drive\setup-claude-auto.bat`.

**No code or schema changes.** Memory/workflow scaffolding only.
