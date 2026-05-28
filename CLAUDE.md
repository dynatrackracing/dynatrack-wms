# CLAUDE.md — READ THIS FIRST, EVERY SESSION

You are working on HawkerWMS, the self-hosted Warehouse Management System for DynaTrack Racing LLC, owned by Ry. Production: `hawkerwms.up.railway.app`. Stack: Node.js + Express + PostgreSQL on Railway, single-file HTML frontend.

This project exists to replace a $300/month developer-built WMS (`wms-prod.up.railway.app`) with a fully self-owned solution. Ry is not a programmer.

## MANDATORY FIRST ACTIONS, BEFORE ANY TOOL CALL

1. Read CLAUDE_RULES.md in full. Every rule is non-negotiable.
2. Read the most recent ~200 lines of LAST_SESSION.md. This tells you what state the project is in. Do not start work without this context.
3. Read the most recent ~100 lines of CHANGELOG.md.
4. Only after the above three, respond to the user.

## ANTI-ROGUE RULES — VIOLATING ANY OF THESE FORFEITS THE SESSION

A. **ONE DELIVERABLE PER SESSION.** If the user asks for a small fix to X, touch only files that implement that fix. Do not refactor adjacent code. Do not improve unrelated functions. Do not add features that were not requested.

B. **NO UNSOLICITED CHANGES.** If you see something you think should change but the user did not ask for it, mention it at the end of your response as a note. Do not change it.

C. **NO NEW FILES WITHOUT EXPLICIT PERMISSION.** If you believe a new file is needed, ask once. Do not create scaffolding, helper modules, test files, or documentation files that were not requested.

D. **NO RENAMING.** Do not rename functions, variables, or files unless the user explicitly asks.

E. **READ BEFORE WRITE.** Before editing any file, read it. Before claiming a function exists or behaves a certain way, read it. No assumptions from filename or memory.

F. **DIFF DISCIPLINE.** After making changes, summarize exactly what changed in plain English. List every file touched. If you touched more than the user asked about, explain why before you committed (you should have asked first).

G. **COMMIT THE WAY THE PROJECT DOES IT.** Per CLAUDE_RULES rule 4: `git add -A && git commit -m "descriptive message" && git push origin main`. Always push. Both machines depend on the remote being current.

H. **UPDATE LAST_SESSION.md AT END OF SESSION.** Per CLAUDE_RULES rule 5: append-only, with an `## HH:MM UTC — Description` header. State what was changed, what files were touched, what is still broken, what is next.

I. **UPDATE CHANGELOG.md AT END OF SESSION.** Per CLAUDE_RULES rule 6.

J. **RY IS NOT A PROGRAMMER.** Do file moves, copies, git operations, deployments, environment setup, and any command-line work yourself. Do NOT ask Ry to run commands, edit files manually, or use File Explorer for tasks you can do directly. If a step needs to happen, you do it.

K. **REGENERATE SNAPSHOTS AT SESSION END** when code changed this session. If you touched `server.js`, `public/index.html`, or `db/schema.sql`, regenerate the matching `SNAPSHOT_*.md` before committing (per CLAUDE_RULES rule 38). Snapshots must reflect HEAD — never let them drift.

L. **REMIND THE HUMAN TO RE-UPLOAD PROJECT KNOWLEDGE** at session end if any of the four memory files were touched this session (per CLAUDE_RULES rule 39).

## WHAT THE USER MEANS WHEN THEY SAY THINGS

- "Make a small fix" = surgical change, do not expand scope
- "Check why X is broken" = diagnose first, propose fix, wait for go-ahead before patching
- "Just push it" = commit and push the existing work, do not add more changes
- "Quick question" = answer without touching code unless asked
- "I'm not a programmer" = means it literally. Do not hand Ry commands to run. Run them yourself.

## CONTEXT YOU SHOULD ALWAYS HAVE LOADED

- The project uses Node + Express + Postgres (Railway). Schema in `db/schema.sql`.
- Single-file HTML frontend at `public/index.html`. No build step, no bundler, no React.
- Token-based auth, 12-hour sessions, credentials in Railway env vars (`WMS_USERNAME`, `WMS_PASSWORD`).
- eBay Trading API integration (XML-based), site ID 0 (US). Credentials in Railway env vars.
- eBay SKU normalization: eBay SKUs have trailing letter suffixes (`INT4306R`, `MOD19595V`); WMS serials are bare (`INT4306`). Strip trailing letters before matching. (See CLAUDE_RULES rule 8.)
- Supabase is dead. Never reference it, never restore it. (See CLAUDE_RULES rule 7.)
- **`Warehouse_WMS*.html` files in the claude.ai project knowledge are browser-saved snapshots of the OLD paid WMS** (`wms-prod.up.railway.app`) from the data-recovery phase — **reference-only, NOT HawkerWMS source code.** Do not edit them, and never use them to diagnose HawkerWMS bugs. The canonical HawkerWMS source is this repo (`server.js`, `public/index.html`, `db/schema.sql`). (See rule 14 on the old-WMS separation.)

## SYNC ARCHITECTURE

- **Canonical source = the git repo at `C:\Users\atenr\dynatrack-wms-repo`** (origin: `github.com/dynatrackracing/dynatrack-wms`, branch `main`). It holds the code (`server.js`, `public/index.html`, `db/`, …) **and** the four memory files (`CLAUDE.md`, `CLAUDE_RULES.md`, `LAST_SESSION.md`, `CHANGELOG.md`) **and** the `SNAPSHOT_*.md` orientation files. Railway auto-deploys from `origin/main`.
- **The old `G:\My Drive\dynatrack-wms\` folder is ABANDONED as of 2026-05-28.** Do not read or edit memory files there — those copies are stale. Everything lives in the repo now.
- Cross-machine sync is via **git** (clone / pull / push), not Google Drive. Each machine keeps a clone; push to `origin/main` is both the deploy trigger and how memory files reach other machines.
- `.env`: machine-local, never synced. Production credentials live in Railway env vars.
- **claude.ai project knowledge** is a **manual briefing-room re-upload** — no API, no automation (see CLAUDE_RULES rules 36–37). After a session's commit, the human re-uploads the changed memory files to the project knowledge.
- Claude Code: Auto Mode is enabled (`~/.claude/settings.json` → `"defaultMode": "auto"`).

## IF YOU ARE UNCERTAIN

Ask one question. Wait for the answer. Do not proceed on a guess.

If the user has already provided the information in the conversation, in the project files, or in the rules — find it instead of asking again.
