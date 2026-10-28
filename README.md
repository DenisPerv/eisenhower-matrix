# TasksDashboard

Eisenhower matrix task app, UI 4-5 "Aurora instrument", on a Supabase database (TasksDashboardDB). `TasksDashboard.html` plus `config/tasksdashboard.config.js`: no server, no build, no dependencies. The page opens from `file://` (or a static host, see Hosting) and talks only to the Supabase project in its config. A small CLI in `cli/` reads and writes the same database.

The household's own setup lives in HomeOS (`references/homeos/tasksdb/`); this README is enough to set the app up for another household.

## Set up (Phase 0, once)

1. **Supabase project.** supabase.com → New project (free plan). Note the project URL (`https://<ref>.supabase.co`).
2. **Auth settings.** Authentication → Sign In / Providers: turn off "Allow new users to sign up", "Allow manual linking" and "Allow anonymous sign-ins"; Email provider on, "Confirm email" off.
3. **Logins.** Authentication → Users → Add user → Create new user, one per person and per agent (email + password, "Auto Confirm User" on). The seed expects four: two people (`maksym`, `anastasiia` in `004_seed.sql`; change the handles for your household) and two agents (`homeos-agent`, `telegram-bot`).
4. **Data API.** Project Settings → Data API: `public` exposed, "Automatically expose new tables" off. Never click a table in the Data API page: it would replace the explicit grants with defaults that include `anon` (if it happens, re-run `003_rls.sql`).
5. **Database.** SQL editor, in this order, each file pasted whole:

   | File | What |
   |---|---|
   | `db/001_schema.sql` | tables and indexes (`profiles`, `preferences`, `categories`, `lists`, `list_members`, `items`, `item_links`, `item_refs`, `item_events`, `notification_deliveries`, `ops.keepalive`) |
   | `db/002_functions.sql` | helpers and triggers: protected columns, per-list numbers, audit events, sensitive-data screen, `create_list`, `keepalive` |
   | `db/003_rls.sql` | row level security, grants, policies |
   | `db/004_seed.sql` | profiles, 7 categories, 3 lists, members. Replace `{{MAKSYM_EMAIL}}`, `{{ANASTASIIA_EMAIL}}`, `{{AGENT_EMAIL}}`, `{{TELEGRAM_EMAIL}}` with the login emails by hand in the editor (never commit them) |
   | `db/005_item_order.sql` | `items.sort_key`, the shared card order |
   | `db/006_archived_lists.sql` | archived lists are frozen: no update of their items except by admin SQL |
   | `db/007_renewal.sql` | category `renewal` (default list Reminders; `details`: `renew_by` and the records-index row name, dates only) |
   | `db/008_telegram_editor.sql` | `telegram-bot` becomes an editor on Reminders and OtherTasks (was contributor): the Telegram bot may change any open item there; agents still never delete or restore |
   | `db/009_multiuser_schema.sql` | multi-user tables and columns: `profiles.is_household`, `categories.audience`, slugs unique per owner, `items.space_owner_id` with dedup keys unique per space owner, `list_members.hidden_at`, `invites`, `invite_blocks`, `tag_lists`, `tag_list_members`, `tags`, `item_tags`, `ops.signup_allowlist`, `ops.settings` (caps and limits); a Default tag list per profile |
   | `db/010_multiuser_functions.sql` | replaces `items_before_write` (after 006), `create_list` (private unless `p_shared`, household only) and `keepalive_status`; tag compatibility trigger (`items.tags` filed into a Default, then cleared); sign-up hook `hook_before_user_created`; `handle_new_user` (profile, "My tasks", Default); identity guards on `auth.users` and `auth.identities`; invitations (`share_list`, `share_tag_list`, `my_invitations`, `accept_invite`, `decline_invite`, `revoke_invite`); `leave_list`, `leave_tag_list`, `set_list_hidden`, `set_tag_list_hidden`, `list_people`, `tag_list_people`, `visible_profiles` |
   | `db/003_rls.sql` again | grants for what 005 to 010 added |
   | `db/011_multiuser_rls.sql` | multi-user policies and grants; runs after every `003` (it replaces some of 003's household policies); ends with a check that fails if a public table has RLS off or a public function is executable by `anon` |
   | `db/900_selftest.sql` | the RLS selftest; it ends with an error whose text must read `SELFTEST 57 of 57 passed (rolled back). Failures: none` |
   | `db/901_selftest_multiuser.sql` | the multi-user selftest (guests, invitations, tags, hook, identity guards, limits); must read `SELFTEST 73 of 73 passed (rolled back). Failures: none` |

   Every file is re-runnable. Later changes come only as new `db/NNN_*.sql` files, followed by `003`, `011`, `900` and `901`. Order rule for the trigger function `items_before_write`: `002` → `006` → `010`.
6. **Config.** Project Settings → API Keys: copy the **publishable** key (`sb_publishable_…`) into `config/tasksdashboard.config.js` (below). Never the secret or service key.

## Config

```js
window.TD_CONFIG = {
  supabaseUrl: 'https://<ref>.supabase.co',
  publishableKey: 'sb_publishable_…',
  pollMs: 30000,
};
```

- Public values only; the lock is RLS plus closed sign-ups.
- A missing file, a URL that is not https (or `http://localhost`), an empty key, a secret key, or `pollMs` outside 5000-600000 shows "The page is not set up yet." with the errors.
- The config is a `.js` file because a `file://` page can load a script beside it but cannot read a `.json` file.

## Open and sign in

Double-click `TasksDashboard.html` (Chrome or Edge on Windows 11 for the intended fonts: Segoe UI Variable, Bahnschrift, Sitka, Cascadia Mono).

| Situation | What shows |
|---|---|
| no saved session, hosted page (https, or `http://localhost`) | "Continue with Google", "Stay signed in on this computer" (ticked), "Other ways to sign in" (the password form; open when an email is prefilled or the last account on this browser used a password), the privacy line |
| no saved session, `file://` | the password form (Email, Password, Stay signed in), a note that Google works on the hosted page, the privacy line |
| saved session | the board, after a silent token refresh |
| back from Google (`?code=`) | the code is swapped at once, then removed from the address; the board |
| back from Google with an error | the sign-in screen with the reason in plain words (`oauthMessage`) |
| the database can't be reached | "Can't reach the database." with Retry (a free project pauses after a week without use; restore it in the dashboard) |
| a login without a profile row | "This login can't open the board." with Sign out |
| `?profile=<handle>` | only prefills the form's email, when this browser has seen that account sign in |

- **Continue with Google** (PKCE, no library): a verifier from 48 random bytes in `sessionStorage` `td.pkce` (with the Stay signed in choice), then `GET /auth/v1/authorize?provider=google&redirect_to=<origin + path>&code_challenge=<S256>&code_challenge_method=s256` (`authorizeUrl`; `login_hint` and `prompt=select_account` when picking a remembered account). Back with `?code=`: `POST /auth/v1/token?grant_type=pkce` with `{ auth_code, code_verifier }`, `history.replaceState` drops the code (`readCallback` keeps other parameters, drops any token in a hash), `td.pkce` is deleted. The session then works as a password one. Supabase needs the page origin in Authentication → URL Configuration (Site URL, Redirect URLs) and the Google provider on.
- **Refusals in plain words** (`oauthMessage`): "Sign-up is by Google only.", "TasksDashboard is full right now. Try again later." (the sign-up hook, `db/010`), "New accounts are not open yet. Ask Maksym." (sign-ups off), "Google sign-in was cancelled.", "The Google sign-in expired. Try again." (no or a stale `td.pkce`), "This login signs in with a password only." (agents).
- **Privacy line** (`PRIVACY`): "We store your email, name and the items you create. Only people you share a list with see them. Ask Maksym to delete your account."
- **Sign in with a password:** Enter submits. A wrong password shows "Email or password is wrong."; 429 shows "Too many attempts. Wait a minute, then try again." The message takes focus. No automatic retry, no sign-up, no password reset (password logins are made in the Supabase dashboard: the household, its agents, tests).
- **Stay signed in:** ticked keeps the refresh token in `localStorage` `td.auth`; unticked keeps it in `sessionStorage` (this tab only; a new tab asks again). The access token stays in memory. `td.auth` also holds the login's id: a tab reads its own `sessionStorage` first and never takes another person's token.
- **Several tabs:** a refresh runs under the Web Lock `td.refresh`, and the BroadcastChannel `td.auth` hands the new token pair to the person's other tabs (refresh tokens rotate; reusing an old one ends the session). Parallel 401s cause one refresh, not one each.
- **401:** one silent refresh and a retry; if that fails, the form shows "Session ended. Sign in again." and the waiting changes are sent after the next sign-in.
- **Account menu (the name; a badge counts open invitations):** the display name and the session email; Tags; Sharing; Settings; Weekly review, card mode, Archived lists, Hidden lists (when any); **Accounts on this browser** (`td.accounts`, other accounts by email, "Google" when they used it; picking one signs out here, then opens Google with that email, or the password form filled in; a cross forgets it); Add account (sign out, then the sign-in screen); Sign out (`/auth/v1/logout?scope=local` with a fresh token: this browser only; other devices stay signed in; with changes still waiting it sends them first, and if they can't be sent it says so and signs out on the second click). Nothing from other people's profiles is listed, and no token of another account is kept.

## Model

| Quadrant | Row | Column | Title | Colour |
|---|---|---|---|---|
| A | important | urgent | Do | red |
| B | important | not urgent | Plan | green |
| C | not important | urgent | Delegate | yellow |
| D | not important | not urgent | Eliminate | grey |

- Grid order: B Plan, A Do on top; D Eliminate, C Delegate below.
- **Quadrant:** `items.quadrant`. An item without one (from the CLI without `--q` or another project) is shown where `deriveQuadrant` puts it, and nothing is written back: important = `priority` ≥ 3 or category `reminder`, `tbd` or `decision`; urgent = the pin (`urgent_pin`), else the deadline inside the urgency window (Settings).
- **Card number:** `<first letter of the list><num>`; `num` is set by the database per list (a moved item takes the next number of its new list).
- **Now** is recomputed on every render and poll. Dates show and are entered in the browser's time zone and are stored as `timestamptz`.
- **Statuses:** `done` and `cancelled` go to the Archive (cancelled with a mark). `inbox`, `in_progress`, `waiting`, `proposed`, `agreed` show as a small badge. Restore puts back the status from before completion (from `item_events`), `open` if unknown.
- **Badges on a card:** "check" (an assistant added it with low confidence: `review_state = needs_review`; the tooltip gives `ai_confidence`), the status, the category (except `task`).

## Data and sync

- **Load:** lists (`archived_at=is.null`), my `list_members` rows (role, `hidden_at`), categories, profiles (my own row; the household's rows for household members, by RLS; `email` is not readable), `rpc/visible_profiles` (names of people I share a list or tag list with), my tag lists and `tag_list_members` rows, live tags, `rpc/my_invitations`, my preferences, then every live item and every live `item_tags` row. Every load pages with `order=id&limit=1000&offset=…` (`item_tags`: `order=item_id,tag_id`) until a short page.
- **Tags** (`item_tags`, `db/009`): a task holds tag ids; a chip shows the tag's name, with the owner's initial when two people's tag lists hold the same name (`tagLabels`; never on my own). Tags of a hidden tag list don't show. Adding writes `item_tags` (a removed row is revived by PATCH `removed_at=null`, else inserted); removing sets `removed_at`. These go after the item's own fields in the same queue, without a version (the last write wins). A new name is created in my Default tag list on Save (a deleted one with that name is revived). Renaming a tag is one PATCH on `tags`; deleting sets `tags.deleted_at` and takes it off every item I may edit. The legacy `items.tags` column is never read or written by the page.
- **Owner:** a new item from the page carries `owner_id` = me (who it is for; "Mine").
- **Roles** (`list_members.role`): viewer reads only; contributor adds and edits only items they created, never deletes; owner and editor do everything. The page hides what the role can't do; the database enforces it.
- **Saving:** every change is shown at once and queued: one serial queue per item, changes to the same item merged. Each PATCH carries `version=eq.<the version the last response returned>` and `x-homeos-via: app`. A new item is sent with a client `crypto.randomUUID()` as `id`; a retry that gets 409 / 23505 counts as saved.
- **Conflicts (0 rows updated):** the page reads the item. Someone else saved first and changed other fields: mine are re-applied on the new version. They changed the same field: their version stays, and an edit from the task window reopens it with my text and a note saying what changed. The same version: "You can't edit this item here", and the item goes back.
- **Task window:** Save sends only the fields changed in the window. If the item changed while the window was open (a poll updates it in place) and someone else changed one of those same fields, the window reopens with the person's text and a note instead of overwriting it.
- **Errors** (`restError`): 22023 starting "sensitive data" the database's text (card, IBAN or ID number; the window stays open); any other 22023 a bad value in plain words (`DB_TEXT`, e.g. "The person it is for is not a member of this list."; kind `invalid`, the window stays open), or "This list is archived. Restore it first."; 54000 a limit (`DB_TEXT`, e.g. "This list is full: its item limit is reached."); 42501 / 403 "Not allowed for your role on this list.", "This list is archived. Restore it first." or a sharing text from `DB_TEXT` ("This invitation is no longer open.", "Owners can't leave their own list.", …); 23514 "The title is over 300 characters."; 23505 on a list "A list with this name exists."; 401 refresh once; 429 wait.
- **Offline:** a network error, a 5xx or a 429 keeps the change in the queue ("Offline: N changes waiting", or "The database is busy" for 429); it is sent on `online`, on the next poll or on focus. Leaving the page with changes waiting asks first.
- **Poll:** every `pollMs` while the page is visible, and on focus: items with `updated_at` ≥ the newest seen minus 120 s (`POLL_OVERLAP_MS`), deleted ones included; versions dedupe; items with waiting changes are skipped. Then `item_tags` with `changed_at` ≥ the newest seen minus 120 s (`tagPollFilter`), soft removals included (`mergeTagRows`). On focus, or when an item shows up on an unknown list or a tag on an unknown tag, lists, roles, categories, tag lists, tags and invitations load again; a list or tag list that became readable reloads every live `item_tags` row.
- **Hidden lists:** "Hide for me" (`rpc/set_list_hidden`) takes a list off my chips, All and search; Account menu → Hidden lists → Show again.
- **Card order:** the shared `items.sort_key` (`db/005`), ascending; cards without one go last. A dropped card takes the midpoint of its new neighbours (±1024 at the ends); a quadrant with missing keys or a gap under 1e-6 is renumbered with spacing 1024 first. New cards go on top.
- **Undo** (toast, 8 s, or Ctrl/Cmd+Z): sends the inverse as a new versioned write: add → soft delete (no Undo where the role can't delete), delete → restore, done / cancel → the earlier status, move or edit → the old fields.
- **Delete** is a soft delete (`deleted_at`). There is no trash view: after the 8 s Undo, only admin SQL brings an item back.
- **Archived lists:** an owner archives a list from its `…` chip menu (with a question). It leaves the chips, All and search; its items are never shown or edited, and the database refuses any update of them (`db/006`). Archived lists (menu) shows each with Restore for owners.
- **New list:** `rpc/create_list`, private. Household members also see "Share with the household and the HomeOS agent" (ticked; `p_shared`, which adds the other household people and `homeos-agent` as editors). A name without ASCII letters gets the slug `list-<6 random>`.
- **Sharing** (`db/010`; nothing shows before Accept):
  - **Share** (owners: list chip menu → Share…, Account menu → Sharing → My lists, Account menu → Tags → Share my tags…): the people on it (`rpc/list_people` / `rpc/tag_list_people`: members with a role select and Remove, invitations as "pending" with Revoke via `rpc/revoke_invite`), and Email + Role → `rpc/share_list` / `rpc/share_tag_list`. Roles: lists Editor, Contributor, Viewer; tag lists Editor, Viewer. No email is sent; the person signs in with Google and accepts.
  - **Account menu → Sharing:** Invitations (`rpc/my_invitations`: Accept → `rpc/accept_invite`; Decline; Decline and block, after a question → `rpc/decline_invite`), My lists (Share), Shared with me (role and owner; People, Hide for me or Show, Leave → `rpc/leave_list` after a question).
  - **List chip menu:** owner: Share…, Archive; member: People, Hide for me, Leave; both: Archived lists, Hidden lists.
  - **Account menu → Tags:** my tags (rename in place, ↑ ↓ for my tag order, delete after a question, New tag + Add, Share my tags…) and tag lists shared with me (their tags; Hide for me or Show via `rpc/set_tag_list_hidden`, Leave via `rpc/leave_tag_list`).
- **Settings → Display name and Time zone** (people): PATCH of my own `profiles` row (`display_name`, `timezone`; the time zone from the browser's list, the browser's own by default).
- **Sources:** the task window lists the item's `item_refs` (read only; links are shown as text).

## Preferences and Settings

One row per person in `preferences` (`app = tasksdashboard`), upserted on `profile_id,app` 1 s after a change (`PREFS_DELAY_MS`) when it differs from the last write.

| Key | Default | Holds |
|---|---|---|
| `version` | `2` | format |
| `theme` | `auto` | `auto` (system), `light`, `dark` |
| `view` | `matrix` | `matrix`, `archive`, `timeline` |
| `list` | `all` | `all` or a list id |
| `listOrder` | `[]` | list ids in chip order |
| `tagOrder` | `[]` | my tag order (tag ids) in the task window and Account menu → Tags; names from before multi-user are dropped |
| `axes` | `{ fx: 0.5, fy: 0.5 }` | matrix split: `fx` = width share of the not-urgent column, `fy` = height share of the important row; clamped to the window |
| `menuCollapsed` | `[]` | collapsed side-menu groups `A`..`D` |
| `cards` | `{ mode: 'collapsed', flipped: [] }` | card mode and the item ids shown the other way |
| `settings` | below | the Settings dialog |

Unknown keys, version 1 path keys and ids that no longer exist are dropped; a value of the wrong type takes its default.

| Setting | Default | Range |
|---|---|---|
| `threshold` (urgency threshold, %) | 50 | 10-90 |
| `windowDays` (urgency window) | 7 | 1-30 |
| `workingDays` | false | |
| `doLimit` ("Do" limit; the A count turns red above it; the CLI's `do`) | 5 | 0-50 |
| `hoursPerDay` | 8 | 1-24 |

## Storage in the browser

| Key | Where | Holds |
|---|---|---|
| `td.auth` | `localStorage` (Stay signed in) or `sessionStorage` | `{ refresh_token, uid }` |
| `td.accounts` | `localStorage` | `[{ handle, email, provider }]` of the accounts that signed in here, the most recent first, at most 8 (`readAccounts`); never a token. Prefills the form, feeds Accounts on this browser |
| `td.pkce` | `sessionStorage` | `{ verifier, stay }` of a Google sign-in in flight; deleted on the way back |
| `td.emails` | `localStorage` | before multi-user: `{ handle: email }`; read once into `td.accounts`, then removed |
| `td.theme` | `localStorage` | the theme before the data loads (no flash) |
| `td.rail` | `localStorage` | side menu width and hidden state |

The keys `td.profile`, `td.axes` and `td.lists` of the file-based app are removed once. Its IndexedDB `td` stays (the frozen file-based app on `release_maxden_filesbased` uses it).

## Features

- **Top bar:** Priority fan logo (`ADV_LOGO`), a button that plays its animation once (`LOGO_PLAY_MS` 3600 ms; nothing with reduced motion); list chips (All first, five chips, the rest behind `+N`; drag or Alt+arrows to reorder; a selected list from `+N` shows sixth); `…` list menu on a selected list (Archive, Archived lists); New list (people only); the person's menu; theme button (Auto until the first click).
- **Search:** Due, Tag, Category, "To check" (low confidence) and Mine filters; results grouped by quadrant; `/` focuses, arrows and Enter open. Mine (`isMine`) = items whose `owner_id` is me, or that carry a tag I can see whose name is in my `mine_tags`. The Tag filter and search use the chip labels.
- **Side menu:** views (Matrix, Archive, Timeline) and the open items by quadrant; drag its edge to resize (256 px to start, 128-560 px), drag below 128 px, double-click or Enter on the edge to hide; a slim tab brings it back.
- **Matrix:** drag cards between and inside quadrants (the row sets importance, the column sets urgency by hand); `+` and double-click to add; expand one quadrant; movable axes (drag, arrows, Home or double-click to reset).
- **Task window:** title and description with bold, italic and lists; list (with All selected, a new item's list is preselected: the `task` category's default list when I may add there, else my own first list, else the first I may add to: `defaultAddList`); quadrant; end; tags (chips of the tag lists I own or edit; tags from tag lists I only view show pressed and disabled and are kept; + adds a name, created in my Default on Save; double-click or F2 renames the tag, the cross or Delete deletes it, both for owners and editors of its tag list; drag or Alt+arrows reorder); Sources; Mark cancelled; Delete. Read only for a viewer.
- **Other views:** Archive (sort, Restore, Delete, Clear with a question); Timeline with weekends, today and a load row; Weekly review.

## CLI

`node cli/tasks.mjs <command> [options]`, Node 18+, no dependencies. Each run signs in, does one command and logs its session out (local scope). It loads the page's `<script id="core">`, so the rules are the same.

| Command | Options | Does |
|---|---|---|
| `add-task` | `--title` (required) `--list <slug>` `--q A\|B\|C\|D` `--due <when>` `--tags a,b` `--body <md>` `--priority 0-5` `--confidence 0-1` `--needs-review` | adds a task; default list = the `task` category's default list; `dedup_key = task:<sha1(lower(title) + due day + list slug)[0:12]>`; `sort_key` on top of its quadrant |
| `add-reminder` | `--title --due` (required) `--list <slug>` `--notify 09:00,18:00` `--body` | adds to `--list`, else the `reminder` category's default list; `dedup_key = reminder:<creation yyyy-mm-dd--hh-mm>`; `details.notify` |
| `overdue` | `--limit 10` `--list <slug>` | open items with `due_at` before now, the most recent first |
| `do` | `--list <slug>` `--limit N` | per list, quadrant A (stored or derived) in card order, up to the login's own `settings.doLimit` (5 for agents) |
| `restore-list` | `--list <slug>` | un-archives a list (people only: `--as maksym` or `anastasiia`) |

- **Common options:** `--env <file>` (KEY=value lines; `TASKSDB_*` variables from the environment fill gaps), `--as <handle>` (default `homeos-agent`; reads `TASKSDB_<HANDLE>_EMAIL` / `_PASSWORD`, with `AGENT` and `TELEGRAM` for the two agents), `--for <handle>` (`on_behalf_of`, a person), `--via <channel>` (`created_via` and `x-homeos-via`, default `script:tasks-cli`), `--run-id`, `--json`, `--dry-run` (reads, sends no write).
- **When:** `YYYY-MM-DD` (09:00) or `YYYY-MM-DD HH:mm` in Europe/Lisbon, or ISO with an offset.
- **Env:** `TASKSDB_URL`, `TASKSDB_ANON_KEY` (the publishable key), and the login pairs. The URL and key get the page's config checks (https or localhost, never a secret key); a failure is exit 2.
- **List status:** every write reads its list first; an archived list is exit 8 and nothing is sent. `overdue` and `do` skip archived lists.
- **Output:** one line per item, `<initial><num> · title · due · list`, or `--json`.
- **Exit codes** (`EXIT`): 0 ok, 1 error (including not allowed and a bad value, 22023 without "sensitive data"), 2 env missing, 3 conflict, 4 duplicate, 5 sensitive data, 6 unreachable, 7 auth failed, 8 list archived (or, for `restore-list`, not archived or not found).
- It never prints an env value, a token or a password.

## Tests

| Command | What | Network |
|---|---|---|
| `node --test "test/*.test.js"` | `core.test.js` (the core rules), `multiuser.test.js` (Google sign-in: `isHostedOrigin`, PKCE against RFC 7636 appendix B, `authorizeUrl`, `readCallback`, `oauthMessage`, `td.accounts`; errors in plain words; tags from `item_tags`, `tagLabels`, `isMine`, `mergeTagRows`; `membershipActions`, `defaultAddList`) and `cli.test.js` (arguments, keys, dates, output, exit codes, the e2e `--url` / `--access-env` helpers) | none |
| `node test/e2e.mjs --env <file> --out <dir> [--group auth,data,sync,archive,errors,ui] [--smoke] [--page <html>] [--url <https origin> [--access-env <file>]]` | the page against the live database in headless Chrome or Edge (or Playwright's chromium) over DevTools; report `e2e-report.md` and screenshots in `<dir>` | live, Node 22+ |

- The e2e runner signs in over REST in Node and seeds `td.auth`; the form is only fed dummy credentials while Fetch interception answers it, so no real password is typed into the page.
- Writes stay in the `_selftest` list and one Cyrillic-named test list; it soft-deletes its items, archives both lists and puts both people's preferences back at the end. Leftovers are listed in the report.
- Every session the run made is logged out at the end.
- `--smoke` is read only: the board opens signed in, chip counts equal the database, only the Supabase host is contacted, no console errors.
- Console errors include security messages from the browser (a CSP violation counts as an error).
- **`--url <https origin>`** (a hosted copy, e.g. `https://homeos-tasksboard.pages.dev`): the page is `<origin>/` instead of the local file, and sessions are seeded on `<origin>/version.json` (same origin, so the same `td.auth`). An origin only: https, no path. The host checks then allow exactly the Supabase host and the page origin. The core rules still load from the local `TasksDashboard.html` (or `--page`). Without `--url` everything runs from `file://`.
- **`--access-env <file>`** (with `--url`): reads `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` (KEY=value lines; never printed) and adds the `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers through DevTools Fetch interception to requests whose origin equals the page origin only: never to Supabase or any other host. Missing keys: exit 2 with the names.

## Code

- `<script id="core">` (global `TDCore`): config, headers, sessions, `restError`, row ↔ task, preferences v2, `deriveQuadrant`, card order, `mergePoll`, `inverseOf`, paging, `overdueItems`, `topDo`, role rules. No DOM, no clock.
- The UI script holds the session, the write queue, polling and rendering. The 4-5 layer script (axes, side-menu width) exposes `window.tdAxes` (`get`, `set`, `onSave`).

## Hosting

The same two files can be served by any static host over https; nothing in the app changes.

- **Allow-list:** `TasksDashboard.html` published as `index.html`, plus `config/tasksdashboard.config.js` at the same relative path. Nothing else: not `db/`, `cli/`, `test/`, `docs/`, `config/profiles.js`, `config/*.prefs.json` or the Markdown files. A `version.json` with the commit sha helps a version check.
- **CSP** (a response header): `script-src 'self'` plus `'sha256-<base64>'` of the body of each inline `<script>` (line endings as LF), `connect-src` = the `supabaseUrl` from the config, `default-src 'none'`, `style-src 'unsafe-inline'` (the timeline writes `style` attributes), `img-src 'self' data:`, `base-uri 'none'`, `form-action 'none'`, `frame-ancestors 'none'`, `object-src 'none'`. A new inline script, external script or network host changes the hashes or the policy.
- The full header set, the cache rules and the household's Cloudflare Pages deploy: `docs/deployment/2-deploy.md`.
- Storage is per origin: a hosted copy has its own `td.auth`, `td.accounts`, `td.pkce`, `td.theme` and `td.rail`. Sign in once on each; signing out of one leaves the other signed in.
- Supabase needs no change for a password-only sign-in (CORS allows any origin). Google sign-in needs the hosted URL as Site URL and `<origin>/**` under Redirect URLs (the household's: `https://homeos-tasksboard.pages.dev/**`, `http://localhost:8787/**`), and the Google provider on.

## Limits

- Local (`file://`), or hosted: see `docs/deployment/` and, in HomeOS, `references/homeos/tasksdb/hosting-plan.md`. The household copy is on Cloudflare Pages behind Cloudflare Access. Supabase's free plan cannot serve the page as HTML.
- `file://` storage is shared by every local page in the same browser profile: they can read `td.auth` (a refresh token), `td.accounts` (email addresses) and the `td.auth` BroadcastChannel (new token pairs). Open only files you trust in that browser profile; sign out on a shared computer. A hosted copy's storage is readable only by its own origin.
- On the free plan a session never times out; Sign out (or revoking sessions in the dashboard) ends it.
- No trash view: a deleted item is recoverable only by admin SQL after the 8 s Undo.
- No password sign-up and no password reset in the app; new accounts come only through Google (when sign-ups are on, behind the sign-up hook). `file://` has no Google sign-in.
- No unblock in the app: "Decline and block" is undone by admin SQL (`invite_blocks`).
- Links in descriptions and sources are shown as text.
- No repeat, subtasks, effort, reminders delivery or `.ics` export in the app.
- The End field uses the browser's date-time control, so its format follows the system locale.
