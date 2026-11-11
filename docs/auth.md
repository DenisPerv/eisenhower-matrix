# Sign-in and accounts

Supabase Auth issues every session. **People sign in with Google only** (since 2026-10-30): the board, the phone app and `signin.html` offer no password form. Password logins remain only for **service logins** (`homeos-agent`, the Telegram bot, `_selftest`, guest test logins; made by an admin), which sign in by REST from scripts, the CLI and the e2e runner, never through a page. The root README, section **Open and sign in**, has every screen, message and storage key; this page is the overview and the setup.

## Where people sign in

| Host | Page | Signed out |
|---|---|---|
| app host `https://eisenhower-agentic-planner-app.pages.dev` | `/board/` (the board) | goes to `/signin?next=/board/` (`signinRedirect`); with a message (Session ended, Signed out in another tab) the sign-in card shows first and its Continue with Google goes there |
| app host | `/app/` (the phone app) | goes to `/signin?next=/app/` (`goSignin`), the same way |
| app host | `/signin` (`signin.html`, public) | Continue with Google, then the access check; a household login or an approved request goes on to `next` (`/board/` or `/app/`) with `location.replace` in the same tab |
| `http://localhost:8788` (the local version) | `/board/`, `/app/` | Continue with Google in place (back to the same page; `/signin` works there too) |
| `file://` | `TasksDashboard.html` | the card, but Google cannot come back to a file: open the page on localhost or the app host |

- **The hand-over from `/signin`:** `signin.html` keeps its session in this tab's `sessionStorage` `td.request.auth` and never writes `td.auth`. The board and the phone app, opened by its `location.replace`, take its refresh token once (`signinHandover`), store it as `td.auth` as their Stay signed in box said before they went to `/signin` (`sessionStorage` `td.signin.stay`; ticked when they went on their own), delete both keys and refresh. A token that no longer works ends on an empty `/signin`, never in a loop.
- **One Google prompt on the app host:** from Supabase on `/signin` or in place, remembered while Stay signed in is on. Cloudflare Access ("Eisenhower gate") adds a second one only if its bypass policy is taken off ([hosting.md](hosting.md)).

## Password logins (service logins only)

- `POST /auth/v1/token?grant_type=password` with `{ email, password }` and the publishable key. The answer holds an access token (about an hour) and a refresh token.
- Supabase's email provider stays on for these logins. No page offers a password field; the e2e runner seeds the session it got by REST into the page's storage.
- No sign-up and no password reset in any client. A password login is made by an admin.
- **After `db/012`** a new password login must carry its allowlist row's nonce: add the row in the SQL editor (`insert into ops.signup_allowlist (email_lower, kind, is_household) values (…) returning nonce;`, valid 15 minutes), then create the login with `signup_nonce` = that nonce in its user metadata (a sign-up call with `data: { signup_nonce }`, or the admin API's `user_metadata`). Without it the sign-up hook refuses the user (42501). **Household:** HomeOS `tasksdb.js add-login` does both steps.
- Scripts and the CLI sign in this way (`cli/lib.mjs` `connect`); the API examples in [api/README.md](api/README.md) too.

## Google sign-in (PKCE)

Only on an https origin (or `http://localhost`): `file://` cannot receive the redirect.

1. The page makes a verifier (48 random bytes) and keeps it in `sessionStorage` `td.pkce`.
2. `GET /auth/v1/authorize?provider=google&redirect_to=<origin + path>&code_challenge=<S256>&code_challenge_method=s256`.
3. Google returns to the page with `?code=`; the page calls `POST /auth/v1/token?grant_type=pkce` with `{ auth_code, code_verifier }`, removes the code from the address (`history.replaceState`) and deletes `td.pkce`.

Setup in Supabase (once per hosted origin; the household's values in brackets):

| Where | What |
|---|---|
| Authentication → Sign In / Providers → Google | on, with the Google OAuth client id and secret (Google Cloud console → APIs & Services → Credentials → OAuth client, type Web; authorised redirect URI `https://<project-ref>.supabase.co/auth/v1/callback`) |
| Authentication → URL Configuration → Site URL | the hosted page, e.g. `https://<project>.pages.dev` |
| Authentication → URL Configuration → Redirect URLs | the exact pages that receive `?code=`: `https://<app host>/signin`, `https://<app host>/board/`, `https://<app host>/app/` (`https://eisenhower-agentic-planner-app.pages.dev/…`), and `http://localhost:8788/**` for the local version |
| Google consent screen | app name, the privacy policy link (`<origin>/privacy`, served from `privacy.html`) |

The hosted copy sends `Referrer-Policy: no-referrer`, so the `?code=` in the address never leaks in a request the page makes before it swaps and removes it ([hosting.md](hosting.md)).

## Sign-in in the phone app

The installed app (`/app/`, [architecture.md](architecture.md)) signs in with Google only, through `app/td-data.js`.

- **Hosted:** signed out it goes to `/signin?next=/app/` and takes the session back from `td.request.auth` (`takeSignin`), as the board does. "Stay signed in on this phone" picks `localStorage` (on) or `sessionStorage`. The tokens are the page's own `td.auth`, so the web page on the same origin is signed in too, and the refresh lock and channel are shared.
- **Google in place (localhost):** like the page's, but it returns to `<origin>/app/` and keeps the verifier in `localStorage` under `td.app.pkce` as `{ verifier, stay, at }`, not in `sessionStorage`: an installed app on iPhone may come back from Google in a new page that has no session storage. The verifier is used once (deleted on first read) and refused after 10 minutes ("The Google sign-in expired. Try again."). Only on an https origin or `http://localhost`. **iPhone caveat: whether the installed app comes back from Google into the app or into Safari is to be confirmed on a device**; the fallback is the password.
- **The gate:** after a sign-in the app asks whether this login may see the board. Household logins, approved access requests and members of a list someone else owns get the board; everyone else gets the request screen ("Ask for access"), which files the same request as `/request`. The gate is a courtesy: RLS and the sign-up hook still decide what a login can read and write.
- **Session ended:** an expired or revoked refresh token shows "Session ended"; the unsent changes stay in the durable queue and are sent after the same person signs in. Signing out sends what it can, then clears the queue of that login, and tells the person's other tabs on the BroadcastChannel `td.auth` (they show "Signed out in another tab.").

## Who may get an account: the sign-up hook

`hook_before_user_created` (`db/010`, tightened in `012`) runs inside Supabase Auth before any new user exists (Authentication → Hooks → Before User Created → Postgres function `public.hook_before_user_created`):

- a **password** sign-up needs a live `ops.signup_allowlist` row for its email with the right nonce; the row also says `kind` (human or agent) and `is_household`;
- a **Google** sign-up is let in as a guest (`is_household = false`) unless an allowlist row says otherwise, and refused when the project holds 200 human profiles or the database is over 400 MB ("TasksDashboard is full right now");
- `handle_new_user` then makes the profile, a private list "My tasks" and a default tag list "My tags".

Auth settings that go with it: "Allow new users to sign up" **on** only behind the hook (off closes registrations completely: the switch-off), "Allow manual linking" off, "Allow anonymous sign-ins" off, Email provider on with "Confirm email" off (password logins are made by an admin).

## Sessions and storage

| Key | Where | Holds |
|---|---|---|
| `td.auth` | `localStorage` (Stay signed in ticked) or `sessionStorage` (this tab only) | the refresh token and the login's id; the access token stays in memory |
| `td.pkce` | `sessionStorage` | the PKCE verifier between the redirect and the callback |
| `td.app.pkce` | `localStorage` | the phone app's PKCE verifier, `{ verifier, stay, at }`, valid 10 minutes, used once |
| `td.request.auth` | `sessionStorage` | `signin.html`'s session in this tab; taken once by the board or the phone app when `/signin` sends the visitor on |
| `td.signin.stay` | `sessionStorage` | the Stay signed in box of the page that went to `/signin` (`'1'`, `'0'`); deleted when the session comes back |
| `td.accounts` | `localStorage` | which accounts this browser has seen (email, provider), for Google's account picker and login hint |
| `td.theme`, `td.rail` | `localStorage` | look and rail state |

- **Refresh:** one silent refresh on a 401, then a retry. Refresh tokens rotate; tabs share a new pair through the Web Lock `td.refresh` and the BroadcastChannel `td.auth`, so parallel 401s cause one refresh.
- **Sign out:** `/auth/v1/logout?scope=local`: this browser only; other devices stay signed in. On the free plan a session never times out by itself.
- **Per origin:** each hosted origin (and `file://`) has its own storage, so each needs its own sign-in, and signing out of one leaves the others signed in. Every local `file://` page in the same browser profile can read the `file://` storage: open only files you trust there.

## Telegram link (db/032)

The household Telegram bot signs in as the agent login `telegram-bot` and learns who writes to it only from a link a person makes:

1. At `/signin` a person may type their Telegram (username or numeric id). It is a claim: stored with `set_telegram_claim` and shown on the access-request task, it proves nothing, because usernames can be changed and taken by someone else.
2. **Link Telegram** (on `/signin` after a request, or the board's account menu) asks `telegram_link_token()` for a single-use token, valid 15 minutes and stored only as its sha256, and shows `https://t.me/<TD_CONFIG.telegramBot>?start=<token>`.
3. In Telegram, Start sends `/start <token>`; the bot calls `telegram_redeem_link(token, from.id, from.username)`. Only the numeric `from.id` is the key.
4. Each message: `telegram_member(from.id)` gives the group (household or approved guest), the display name and the default list "My tasks", or `null` = no access. The link shares "My tasks" with the bot as editor.

Unlink (`telegram_unlink`) removes the link and the bot's membership of "My tasks". The bot never gets an email address.

## Agents

Agent logins (`kind = agent`) sign in with a password only ("This login signs in with a password only." if one tries Google). They see only lists they are members of and never delete or restore. **Household:** `homeos-agent` (HomeOS skills and scripts) and `telegram-bot`.
