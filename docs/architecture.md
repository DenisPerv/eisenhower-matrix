# Architecture

TasksDashboard has no server of its own. A static page talks straight to a Supabase project; the database holds every rule that matters for safety (who may read or write what), and the page holds the rules for showing things. A small Node CLI and the end-to-end tests reuse the page's rules instead of copying them.

```
 browser (file:// or https host)                  Supabase project (free plan)
 ┌──────────────────────────────────┐             ┌──────────────────────────────────────┐
 │ TasksDashboard.html              │   fetch     │ Auth  /auth/v1  password, Google PKCE│
 │  <script id="core">  rules, no   │ ──────────▶ │       sign-up hook (db/010)          │
 │     DOM, no clock (TDCore)       │             │ REST  /rest/v1  PostgREST            │
 │  UI script: session, write queue,│ ◀────────── │       tables + RPCs (db/*.sql)       │
 │     poll, render                 │   JSON      │ Postgres: RLS on every table,        │
 │ config/tasksdashboard.config.js  │             │       triggers, item_events audit    │
 └──────────────────────────────────┘             └──────────────────────────────────────┘
          ▲ same core block (vm)                              ▲
 ┌────────┴─────────────┐  ┌───────────────────────────────┐  │ admin SQL (SQL editor, or
 │ cli/tasks.mjs        │  │ test/*.test.js, test/e2e.mjs  │  │ HomeOS tasksdb.js apply-sql)
 │ cli/access.mjs       │  │ (unit: no network; e2e: live) │  │
 └──────────────────────┘  └───────────────────────────────┘  │
```

## Pieces

| Piece | File | Role |
|---|---|---|
| Page | `TasksDashboard.html` | the whole app, one file, no build, no runtime dependency; opens from `file://` or any static https host |
| Core | `<script id="core">` in the page (global `TDCore`) | every rule with no DOM and no system clock (time is a parameter): config checks, sessions, errors in plain words, row ↔ task, preferences, `deriveQuadrant`, card order, poll merge, weekly review (`reviewEntries`, `reviewGroups`), KPI (`kpiHistory` …). The CLI and the tests load this block through Node `vm` (`cli/lib.mjs` `loadCore`), so there is one rule set |
| UI script | the rest of the page | the session, a serial write queue per item, polling every `pollMs`, rendering, dialogs |
| Config | `config/tasksdashboard.config.js` | `window.TD_CONFIG = { supabaseUrl, publishableKey, pollMs }`: public values only (a `.js` file because a `file://` page can load a script but not read JSON) |
| Request page | `request.html` | the public access-request page of a hosted copy (`/request`); no board data ([access-requests.md](access-requests.md)) |
| Privacy page | `privacy.html` | static, no script; the Google consent screen's privacy link |
| CLI | `cli/tasks.mjs`, `cli/lib.mjs` | add tasks and reminders, list overdue items and the Do quadrant, restore a list; signs in as a login, never with a secret key |
| Access CLI | `cli/access.mjs` | turns approved access requests into the host's Access policy (Cloudflare API); dry run unless `--apply` |
| Database | `db/001` … `db/018`, selftests `db/900` … `db/906` | schema, triggers, RLS, RPCs; applied in file order ([database.md](database.md)) |
| Docs | `README.md` (technical reference), `docs/` | this folder |

## Data flow

1. **Sign in** ([auth.md](auth.md)): a password grant or Google PKCE gives an access token (memory only) and a refresh token (`localStorage` or `sessionStorage`, key `td.auth`).
2. **Load:** lists, memberships, categories, profiles, tag lists and tags, then items in pages of 1000, each request with `apikey: <publishable key>` and `Authorization: Bearer <access token>`. RLS returns only what the login may see.
3. **Write:** a change shows at once and joins the item's queue. Each PATCH carries `version=eq.<n>`; zero rows updated means someone saved first, and the page merges or reopens the window. Triggers stamp `updated_at`, numbers, `completed_at` and an `item_events` row per change (the audit trail the KPI and the review read).
4. **Poll:** every `pollMs` (default 30 s) while visible, and on focus: rows changed since the last poll, tags, task links (`item_links.changed_at`, removed ones too), notes of first shares.
4a. **Task links:** loaded with the items (`item_links`, live rows of kinds `depends_on` and `parent`), shown only when both ends are loaded, changed through `rpc/link_items` / `rpc/unlink_items` in one serial queue. The board's badges and grouping and the Timeline's tree and arrows are computed in the core (`linkIndex`, `groupCards`, `timelineRows`).
5. **Review and Visuals:** the Review view computes the weekly report in the browser from the loaded items (and the cancel times from `item_events`); Visuals read `rpc/kpi_events` once and compute the charts in the core. The same report is available as an API, `rpc/review_report` ([api/README.md](api/README.md)), computed in SQL with the same rules; an e2e check keeps the two equal.

## Task deck

The task window is a small reusable component, the **task deck** (`deckOpen`, `let DECK`, `TasksDashboard.html`). It keeps one full-screen modal open for a whole edit session, so moving between tasks never closes and reopens a window (the flicker the earlier close-and-reopen caused: one frame with no modal, a board render and a fade-in per switch).

| Part | What it is |
|---|---|
| deck | one `<dialog class="tk-deck">`, a transparent 3×3 grid (`data-switcher` = `standard` or `coverflow`), opened once with `showModal()` and removed on close, which runs `render()` once |
| card | `.tk-card`, the middle cell and the visible window. `openTask(id, quad, opts)` builds one task's form into it; `deck.swap(build, dir, to)` replaces the content in place (slide 60 ms out, 100 ms in; Coverflow turns the row) |
| zones | real elements beside and around the card: `[data-zone=prev]` and `[data-zone=next]` between its top and bottom edge, `top` and `bottom` above and below. Each side with a neighbour holds one `<button data-nav>` (a shadow band from 1000 px in Standard, edge tabs below); a side with none closes |
| previews | Coverflow only: `.tk-pv`, read-only copies of the neighbours made by `openTask(id, null, { preview })`, inert and `aria-hidden`, posed by `C.deckGeo` |
| dots | Coverflow only: `.tk-dots`, at most 9 buttons (`C.dotWindow`) that jump to a task of the quadrant |

Rules without DOM or clock live in the core and are unit-tested (`test/edit-nav.test.js`): `deckSequence` (the order across the quadrants A to D), `deckAct` (zone and press start give `prev`, `next`, `close` or nothing), `swipeDir`, `deckPos`, `deckGeo`, `dotWindow`. The mode is `prefs.taskSwitcher` (`TASK_SWITCHERS`), read when the deck opens.

**Leave paths.** Every way out goes to `DECK.cur.leave(kind, to)`, set by the content builder: `prev` and `next` (a zone, the keys, a swipe, an edge tab), `close` (a band, an end, Esc) and `jump` (a dot). If the form changed (`dirty()`), `leave` asks first in the sticky button row (Save and go, Discard and go, Stay) and does nothing else while the question is open. Mark cancelled, Delete and Save close the deck directly. Per-content listeners use one `AbortController` (`DECK.cur.ac`), aborted on every swap and on close. The Undo toast is appended to the open deck so it shows above the window, and moves to `<body>` when the deck closes.

**Reusing it.** Another window can use the deck by (1) giving its content builder the same contract (fill `deck.card`, set `deck.cur = { ac, nav: { prev, next }, isNew, q, id, order, leave, onClose }`, call `deck.show(c)`), (2) getting its neighbours from a core function like `deckSequence` so the order is testable, and (3) routing every exit through `leave`. The zones, the pointer rule, the keys, the swap and the unsaved question then come with the deck.

## Design choices

- **The database is the lock.** The page hides what a role cannot do, but RLS, protected-column triggers and `security definer` RPCs with `search_path = ''` enforce it. The publishable key is public; without a login it reads nothing.
- **No server, no build.** Nothing to patch or host beyond static files; the page works offline from `file://` with the same database.
- **One rule set.** Rules live once in the core block; Node reuses it. Where SQL must repeat a rule (the review API's quadrant), a test compares the two.
- **Soft deletes and an audit trail.** Items are never deleted (`deleted_at`); every change is an `item_events` row with who, how (`x-homeos-via`) and the diff.
- **Free tiers only.** Supabase free plan for the database and auth, Cloudflare Pages and Access (free) for the hosted copy ([hosting.md](hosting.md)).

**Household:** HomeOS (a separate private repo) mounts this repo as a submodule, writes items through the same database as an agent login (`homeos-agent`), and holds the deploy script and the secrets of the one hosted copy.
