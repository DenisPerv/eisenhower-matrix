# Where HomeOS keeps tasks, reminders and to-dos

Snapshot 2026-10-25, Telegram section 2026-10-26. A map, not a source of truth: every store below is the source of its own data. Paths are relative to the HomeOS root (`D:\Claude\Personal\HomeOS`), where this app is mounted at `Views/TasksDashboard/`. Placed here by Maksym's choice (2026-10-26), an exception to this repo's `CLAUDE.md` rule that only `TasksDashboard.html` and `README.md` belong here.

## 1. Stores

| # | Store | Path | Format | Lifecycle | Count today |
|---|---|---|---|---|---|
| S1 | Open questions | `TBD.md` | table: #, Question, Explanation, Options, Proposed, Owner, Status (`open`/`proposed`/`agreed`) | agreed row moves to `decisions/log.md` and is deleted; `/audit` flags rows older than 30 days | 16 open, 2 proposed (2 done rows kept) |
| S2 | Reminders | `references/reminders/yyyy-mm-dd--hh-mm_reminder.md` | one file each; frontmatter `name, title, due, owner, notify, status (open/done/cancelled), done_on, scheduler, source, ref`; body with a checklist | never deleted; only a person closes one; format in `.claude/rules/reminders.md` | 12 open, 1 done |
| S3 | Short-term plans | `memory/plans/shortterm/*.md` | memory record (type, priority, review, owner, status, source) | review date | 3 |
| S4 | Long-term plans | `memory/plans/longterm/` | memory record | created on first use | folder absent |
| S5 | Memory candidates | `memory/candidates/*.md` | memory record, status candidate | promoted with `/remember` | 7 (2026-09-29) |
| S6 | Wishes | `memory/wishes/*.md` + `references/wishes/*.md` | record + research note | none | 3 |
| S7 | Document renewals | `records-index.md` | table: Name, Category, Owner, Where, Expires, Renew by, Keep until, Notes | SessionStart hook lists items expiring within 60 days | passport flagged |
| S8 | Decisions to revisit | `decisions/log.md` | append-only entries with Why, Revisit, Owner | revisit date | 16 entries |
| S9 | Task app sources | `references/Family-Tasks/{backlog,reminders,to-sort}-tasks.json` | Eisenhower app v2 JSON | edited by `Views/TasksDashboard/TasksDashboard.html` | empty |

## 2. Project task lists (inside their own documents)

| Project | Path |
|---|---|
| Valheim mods | `references/ValheimCustomMods/GameplayEnhancements/docs/HomeCheat-plugin/README.md` (command index with statuses), open items in `references/ValheimCustomMods/docs/homecheat-architecture.md` |
| LinkedIn | `references/LinkedinManagement/maksym/plan.md`, `posts/backlog.md` |
| Weekly references review build | `references/homeos/weekly-references-review-design.md` (task tracker section) |
| Parked features | `Future ideas/` (HUB Feature) |

## 3. Open reminders (S2)

| File | Owner | Title |
|---|---|---|
| 2026-10-08--18-35 | maksym | Residence permit: prepare documents |
| 2026-10-08--18-36 | maksym | Residence permit: apply window opens |
| 2026-10-08--18-37 | maksym | Residence permit: deadline check |
| 2026-10-12--11-19 | shared | Candlelight Coldplay & Imagine Dragons concert, Palácio da Bolsa |
| 2026-10-16--02-32..36 | shared | References review: add recipe text (Shashlik, Deruny, Syrniki, Cabbage rolls, Chicken Kiev) |
| 2026-10-17--05-08 | anastasiia | References review: how the Package template folder is indexed |
| 2026-10-20--22-15 | maksym | Renaissance Porto Lapa Hotel, Fri 13 Nov 20:30 |
| 2026-10-24--05-08 | shared | References review: content for the Facebook reel of 2026-10-20 |

## 4. Skills, agents and scripts bound to each store

R = reads, W = writes, G = guards or validates, M = mentions only (rule text, "never write" lists).

| Store | Skill / agent / script | How |
|---|---|---|
| S1 `TBD.md` | `/audit` (`.claude/skills/audit/SKILL.md`) | R: rows open > 30 days via `git log -S` |
| | `/level-up` | R; W: extra automation candidates become `proposed` rows |
| | `/onboard` | M: tells people open questions go here |
| | `/homeos-sanity-check` (`scripts/check.js`) | G: broken links in TBD, never a run-folder fix |
| | `scripts/hooks/session-start.js` | R: counts `open`/`proposed` rows for the session brief |
| | `scripts/sync/resolve-conflicts.md` | G: merge rule, keep rows from both sides |
| S2 `references/reminders/` | `.claude/rules/reminders.md` | contract: file name, frontmatter, who closes, tracing |
| | `scripts/reminders/daily-telegram.js` | R: every `status: open` file, grouped per person, sent to Telegram |
| | `/references` (`scripts/review-log.js`, `map.js`, `review-scope.js`) | W: one reminder per needs-person item from the weekly review; map skips the folder |
| | `/store-document` (`instructions/routing.md`) | M: routes "a reminder" to this folder |
| | `scripts/reindex.js`, `scripts/lib/references-index.js` | G: folder indexed as one row, never file by file; excluded from the review index |
| | `CLAUDE.md`, `AGENTS.md` | M: "remind me" must also write a file here |
| S3/S4 `memory/plans/*` | `/remember` | W: approved records |
| | `scripts/reindex.js`, `scripts/schemas/memory-record.json`, `scripts/validate.js` | G: type must match folder; MemoryMaster counts |
| | `/onboard` | M: type table |
| S5 `memory/candidates/` | `scripts/retrospective/run.js` | W: candidates from transcripts |
| | `/remember` | R/W: "review candidates" promotes or drops |
| | `/audit`, `/level-up` | R: counts, candidate pool |
| | `scripts/hooks/session-start.js` | R: "N candidates waiting" line |
| | `scripts/hooks/pre-compact.js` | M: asks to list candidate facts before compaction |
| S6 wishes | `/store-document` routing, `/references` | M/W: wish lists route to `references/wishes/` |
| S7 `records-index.md` | `/store-document` | W: one row per sensitive document |
| | `records-lookup` agent | R: "when does Z expire" |
| | `scripts/hooks/session-start.js` | R: documents expiring within 60 days |
| | `scripts/hooks/post-write-validate.js`, `scripts/validate.js` | G: table validated after every write |
| | `/homeos-sanity-check` | G: `Where` paths exist |
| | `.claude/settings.json` | G: `Edit(./records-index.md)` is ask-first |
| S8 `decisions/log.md` | `/level-up` | W: decision entries |
| | `/audit` | R: entries past Revisit |
| | `.claude/settings.json` | G: ask-first edit |
| | `scripts/sync/resolve-conflicts.md` | G: append-only merge |
| S9 `references/Family-Tasks/` | `Views/TasksDashboard/TasksDashboard.html` | R/W: the connected file |

Never-write lists (M) also name S7/S8: `/references`, `/refresh-onboard`, `/skill-security-review` checklist, weekly routines.

## 5. Routines and schedulers

| Routine / job | Where it runs | Store | How |
|---|---|---|---|
| `daily-reminders` | Task Scheduler `\HomeOS\daily-reminders` on MDENYSIUK-PERS, 09:15 | S2 | R: Telegram digest per person (`people/<name>` About: `Reminders:` preference) |
| `homeos-daily-reminders` | Desktop task on AKhrystina_Lap, 09:00 | S2 | R: redundant since 2026-10-16 |
| desktop tasks `maksym-permit-*` | Desktop app on AKhrystina_Lap | S2 | per-reminder schedule, linked by `scheduler:` in 3 reminder files |
| `weekly-references-review` | cloud trigger, Saturday 08:00 UTC | S2 | W: needs-person reminders (`scheduler: weekly-references-review`, 7 open) |
| `weekly-audit` | Desktop, Saturday 10:00 | S1, S5, S7, S8 | R: ageing report |
| `weekly-level-up` | Desktop, Sunday 11:00 (both machines) | S1, S5, S8 | R; W: TBD proposed rows, decision entries |
| `monthly-memory-retrospective` | Desktop, 1st of month | S5 | W: candidates |
| `monthly-tidy-memory`, `quarterly-facts-review` | Desktop | S3, S5 | R: ages, duplicates |
| `\HomeOS\repo-sync` | Task Scheduler, 09:00 | all | commits and pushes; conflict rules for S1, S7, S8 |
| SessionStart hook | every Claude session in HomeOS | S1, S5, S7 | R: session brief |

## 6. Other applications

| Application | Dependency | Detail |
|---|---|---|
| TelegramBasics (`TelegramServer` service) | chat pipeline reads HomeOS | allowlist `src/tgbasics/chat/context/homeos_paths.py`: `TBD.md`, `decisions/log.md`, `memory/**`, `references/**`. Excluded: `memory/candidates/`, `references/reminders/`. Denied: `people/`, `ScansStorage/`, `localConfigs/`, any file named exactly `records-index.md`, hidden paths. `.md` only |
| TelegramBasics | references ingest | the only write path, through HomeOS `scripts/ingest/` into `references/` (not the task stores) |
| TelegramBasics | Telegram delivery | `scripts/reminders/daily-telegram.js` uses the bot to send the S2 digest |
| TalkToLocalLLM | indirect | callers list HomeOS budget guard and ingest; `decision/pilot/homeos-cases.jsonl` holds test cases, no live reads of the stores |
| CarsSearch, EventBoard, CV, LogsViewer, InteriorDesignCLI, BrandBook | none | no reference to any store |
| TasksDashboard (eisenhower-matrix) | S9 only | no code path to HomeOS; the person picks the file |

Gaps found:
- The Telegram deny rule matches the file name exactly: a copy of `records-index.md` under another name inside `references/` would be readable by the bot.
- `homeos-daily-reminders` on AKhrystina_Lap is marked redundant in `services.md` but still installed.
- `ReferencesOverview.conflict-mdenysiuk-pers.md` at the repo root is an unresolved sync conflict.

## 7. How the Telegram bot writes into HomeOS

Read 2026-10-26 from TelegramBasics `src/tgbasics/` (HEAD `32b9f12`), its `docs/architecture.md`, ADR-002, `docs/commands/learn.md`, and HomeOS `scripts/ingest/`, `HomeOS-Documentation/references-ingest.md`, `telegram-bot-access.md`, `references/tools/telegram-bot.md`. No code was changed and no `.env` was read.

Short answer: the bot has **one** write path into HomeOS, the references ingest. It adds one capture note (`.md`) under `references/`. It cannot write memory records, reminders, TBD rows or tasks in the task-app JSON files.

### 7.1 What it can write today

| Kind | Writes today? | Trigger | What blocks it, or which path |
|---|---|---|---|
| Memory records (`memory/**`, incl. `candidates/`) | **No** | none | No intent or command writes memory. `references-ingest.md` "What it may write" names `memory/` as never; the processor's write guard accepts only a folder inside `references/`. The bot only reads `memory/**` (minus `candidates/`) as chat context |
| Reminders (`references/reminders/`) | **No** | none | No reminders intent ("v1 has no reminders intent", `homeos_paths.py`). `targets.ts` excludes `reminders` from the ingest targets, so `/save reminders …` never reaches that folder: the picker files it in another collection or `Unrecognized/`, and a hand-made job with that target is refused by `guardWrite` (exit 30 `bad_target`). Not readable either: excluded from the allowlist. Indirect only: see 7.4 |
| References (`references/<collection>/`) | **Yes** | `/save [where] [url]`, `/learn` (scoped to `Learning/`), `/addrecipe` (scoped to `CookingRecipes/`), `Learning: …` / `Learning/<Topic>: …`, plain words classified `learn` ("add this to recipes"), the [Add to references] button | 7.2 |
| TBD rows (`TBD.md`) | **No** | none | Not a references folder, so outside the write guard; `TBD.md` is read-only context in the allowlist |
| Decisions (`decisions/log.md`) | **No** | none | Same as TBD |
| Task-app sources (`references/Family-Tasks/*-tasks.json`) | **No** (as tasks) | none | The processor only creates new `.md` capture notes; it never edits an existing file, and nothing produces Eisenhower v2 JSON. **But** `references/Family-Tasks/` is a live ingest target (first-level folder under `references/`, confirmed with `ingest.ts --targets` on 2026-10-26), so `/save Family-Tasks <text>` or a picker choice can drop a capture note there. See 7.5 |
| `records-index.md`, `people/`, `ScansStorage/`, `Views/` | **No** | none | Outside `references/`; named as never-write in `references-ingest.md` |

Other bot writes stay outside HomeOS: chat history, sessions, intent tags (the `note` intent only tags the row) and traces go to the bot's Supabase database; `/adduser` writes TelegramBasics `Config/groups.md`; `/configevents` writes its own `commands/events/config/`; `/remotecontrol` writes the control files of the services it lists.

### 7.2 The references write path, step by step

| Step | Where | What happens |
|---|---|---|
| 1. Ask detected | `learn/prefix.py`, `chat/router.py`, `ai/local/classifier.py` | prefix or slash command (shortcut names from `LearnPolicy.shortcuts`, default `learn` → `Learning`, `addrecipe` → `CookingRecipes`), or the classifier's `learn` intent (`classifier_enabled`; `audience = "owners"` lets every owner use plain words). Forwards are never asks |
| 2. Gate 0 | `learn/service.py` `_gate0` | refused when learn is off (`LearnPolicy.enabled`), `node`, `HOMEOS_PATH` or `scripts/ingest/ingest.ts` is missing, the sender is not in `OWNER_TELEGRAM_USER_IDS`, the words carry ID, card or account numbers (`has_sensitive_numbers`), or a job is already running (one at a time) |
| 3. Material | `learn/share.py`, `service._attach`, `_is_empty` | an ask with no link, image or text takes the owner's closest share from the last 10 minutes; under 20 characters of material → "empty"; a shared text with sensitive numbers → refused |
| 4. Gate 1 confirm | `service._needs_confirm` | classifier asks below `confirm_below` (0.8), a bare "save it" on a share, or no ask word → [Add to references] / [No, just keep it] buttons (24 h, in memory) |
| 5. Gate 2 collection | `learn/target.py` | the list comes fresh from `node scripts/ingest/ingest.ts --targets` (HomeOS `targets.ts`, built from `map.js --json`); an exact hint wins, else one `avg` local-LLM call per tree level picks a number from that list (the model never names a path); below `place_confirm_below` (0.6) the "Which references collection?" buttons; nothing fits → `references/Unrecognized/` |
| 6. Job file | `learn/collector.py` | writes `HomeOS/LocalInputs/<yyyy-mm-dd--hh-mm>/ingest-job.json` (schema 2) plus downloaded images `img-<n>.<ext>` (max 6, 10 MB each). Description, hint and shared texts are redacted; no Telegram ids or names |
| 7. Processor | `learn/runner.py` → HomeOS `scripts/ingest/ingest.ts <job>` | runs in the HomeOS checkout with `CLAUDE_PROJECT_DIR`, `LOCAL_LLM_MCP_URL`, `LOCAL_LLM_MCP_TOKEN`; timeout 300 s, 420 s with images, process tree killed on timeout |
| 8. Write guard | `paths.ts` `guardWrite` | `target` must start with `references/`, be on the `--targets` list, and resolve (after links and junctions) to that exact folder inside `references/` |
| 9. Content | `ingest.ts`, `fetch.ts`, `images.ts`, `extract.ts` | ingest lock `%TEMP%\homeos-ingest.lock`; duplicate check on normalised URLs (status `duplicate`, nothing written); fetch (no private addresses); images checked by the `strong` model, any personal image stops the job and deletes the images (exit 35); one `avg` call writes title, summary, key points |
| 10. Guarded write | `write.ts` `guardedWrite` | waits for the sync lock `.git/ai-sync/lock` (up to 15 min); refuses (exit 40) unless HomeOS is on `main`, no merge or rebase is in progress, `reindex.js --check` is clean and the index files it touches have no uncommitted edits. Writes `references/<collection>/yyyy-mm-dd_<slug>.md` (frontmatter `captured_via: telegram`, `validation: unverified`) and images `<note>_<n>.<ext>` (≤ 500 KB, indexed collections only), runs `reindex.js`, `map.js --stale`, `validate.js`; any new problem undoes the write (exit 50) |
| 11. Commit | `write.ts` | `git add -- <touched>` and `git commit --only -m "ingest: <title>"` with only the note, its images and the rewritten index files (`ReferencesOverview.md`, `MemoryMaster.md`, `references/claude-code/references-index.json`, the README chain). **Never pushes**: the 09:00 `\HomeOS\repo-sync` (`scripts/sync.ps1`) pushes it |
| 12. Reply | `learn/reporter.py` | the bot replies with the `references/…` path or the failure, and writes one `route=learn_job` trace row |

Rollback: `policy.learn.enabled = false` and a bot restart stops every capture; `git revert <sha>` removes one.

### 7.3 Guards that apply

- **Read allowlist** (`chat/context/homeos_paths.py`): governs what the chat pipeline reads, not the ingest. Allowed: `MemoryMaster.md`, `ReferencesOverview.md`, `decisions/log.md`, `TBD.md`, `memory/**` minus `memory/candidates/`, `references/**` minus `references/reminders/`, `.md` only. Denied first: `people/`, `ScansStorage/`, `localConfigs/`, `.git/`, any dot component, and a file named exactly `records-index.md`. Checked on the resolved path; Family members only.
- **Write guard**: lives in HomeOS, not in the bot (`targets.ts` decides eligibility, `paths.ts` `guardWrite` enforces it). Eligible: every first-level folder under `references/`, plus deeper folders with a README index; never submodules, `reminders/`, `homeos/`, `claude-code/`, `examples/`, `_*`, `images/`, `Infographics/`; `Unrecognized/` only as the fallback.
- **Who**: owners only (`OWNER_TELEGRAM_USER_IDS` in the bot's `.env`; unset means nobody). One job at a time, in the bot and through the ingest lock.
- **Content**: redaction of ID, card and account numbers and secrets in both the bot and the processor; the sensitive-image stop; captures always `validation: unverified`, so the bot labels them "unverified note".

### 7.4 Indirect writes after a capture

- **Reminders**: the cloud `weekly-references-review` routine moves every capture out of `Unrecognized/` and writes a `needs-source` or `needs-person` reminder into `references/reminders/` for one it cannot settle (`review-log.js reminder`). Example: `references/reminders/2026-10-24--05-08_reminder.md`, for a Facebook reel captured from Telegram. The routine writes it, not the bot, and commits it straight to `main`.
- **Outbound only**: `scripts/reminders/daily-telegram.js` (09:15) sends the open-reminders digest with the bot token. It reads reminders and writes only `LocalOutputs/<ts>/reminders-run.md` and its once-a-day marker; it takes no replies.

### 7.5 Gaps

- `references/Family-Tasks/` is an ingest target. A task-like ask ("save this task") can land as a capture note in the task-source folder, which the app never reads; the weekly review would then have to move it. Fix in HomeOS: add `Family-Tasks` to `EXCLUDED_TOP` in `scripts/ingest/targets.ts`, or decide captures are welcome there.
- The `example-*.md` snapshots in `references/Family-Tasks/` copy files the bot is not meant to read: `example-reminders-*` (from the excluded `references/reminders/`) and `example-candidates-*` (from the excluded `memory/candidates/`). Under `references/**` they are readable by the chat pipeline, which bypasses both exclusions. Same root cause as the `records-index.md` file-name gap in section 6: the exclusions match paths and names, not content.
- No Telegram path exists for reminders, TBD rows, memory records or tasks. Adding one needs a new bot intent and a new HomeOS writer with its own guard; a reminders intent would also have to open `references/reminders/` in the read allowlist.
- Captures are committed locally and wait for the 09:00 sync to be pushed. The guarded write refuses (exit 40 `busy_homeos:*`) while a session leaves HomeOS off `main`, mid-rebase, or with an uncommitted index file, so a long interactive session can block captures.
