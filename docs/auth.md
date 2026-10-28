# Sign-in and accounts

Supabase Auth issues every session. There are two ways in: a **password login** (the household, its agents, test logins; made by an admin) and **Google sign-in** (anyone the sign-up hook lets in, as a guest unless allowlisted). The root README, section **Open and sign in**, has every screen, message and storage key; this page is the overview and the setup.

## Password sign-in

- `POST /auth/v1/token?grant_type=password` with `{ email, password }` and the publishable key. The answer holds an access token (about an hour) and a refresh token.
- Works on `file://` and on a hosted copy. Needs no redirect URL.
- No sign-up and no password reset in the app. A password login is made by an admin.
- **After `db/012`** a new password login must carry its allowlist row's nonce: add the row in the SQL editor (`insert into ops.signup_allowlist (email_lower, kind, is_household) values (…) returning nonce;`, valid 15 minutes), then create the login with `signup_nonce` = that nonce in its user metadata (a sign-up call with `data: { signup_nonce }`, or the admin API's `user_metadata`). Without it the sign-up hook refuses the user (42501). **Household:** HomeOS `tasksdb.js add-login` does both steps.
- Scripts and the CLI sign in this way (`cli/lib.mjs` `connect`); the API examples in [api/README.md](api/README.md) too.

## Google sign-in (PKCE)

Only on an https origin (or `http://localhost`): `file://` cannot receive the redirect.

1. The page makes a verifier (48 random bytes) and keeps it in `sessionStorage` `td.pkce`.
2. `GET /auth/v1/authorize?provider=google&redirect_to=<origin + path>&code_challenge=<S256>&code_challenge_method=s256`.
3. Google returns to the page with `?code=`; the page calls `POST /auth/v1/token?grant_type=pkce` with `{ auth_code, code_verifier }`, removes the code from the address (`history.replaceState`) and deletes `td.pkce`.

Setup in Supabase (once per hosted origin):

| Where | What |
|---|---|
| Authentication → Sign In / Providers → Google | on, with the Google OAuth client id and secret (Google Cloud console → APIs & Services → Credentials → OAuth client, type Web; authorised redirect URI `https://<project-ref>.supabase.co/auth/v1/callback`) |
| Authentication → URL Configuration → Site URL | the hosted page, e.g. `https://<project>.pages.dev` |
| Authentication → URL Configuration → Redirect URLs | `https://<project>.pages.dev/**` (and `http://localhost:<port>/**` for a local test server) |
| Google consent screen | app name, the privacy policy link (`<origin>/privacy`, served from `privacy.html`) |

The hosted copy sends `Referrer-Policy: no-referrer`, so the `?code=` in the address never leaks in a request the page makes before it swaps and removes it ([hosting.md](hosting.md)).

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
| `td.accounts` | `localStorage` | which accounts this browser has seen (email, provider), for prefilling the form |
| `td.theme`, `td.rail` | `localStorage` | look and rail state |

- **Refresh:** one silent refresh on a 401, then a retry. Refresh tokens rotate; tabs share a new pair through the Web Lock `td.refresh` and the BroadcastChannel `td.auth`, so parallel 401s cause one refresh.
- **Sign out:** `/auth/v1/logout?scope=local`: this browser only; other devices stay signed in. On the free plan a session never times out by itself.
- **Per origin:** `file://` and each hosted origin have their own storage, so each needs its own sign-in, and signing out of one leaves the others signed in. Every local `file://` page in the same browser profile can read the `file://` storage: open only files you trust there.

## Agents

Agent logins (`kind = agent`) sign in with a password only ("This login signs in with a password only." if one tries Google). They see only lists they are members of and never delete or restore. **Household:** `homeos-agent` (HomeOS skills and scripts) and `telegram-bot`.
