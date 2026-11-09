# Privacy inputs

Facts for whoever writes the privacy policy, the cookie list, the terms and the data-deletion process. Collected from the code on 2026-10-30. **Facts only, no legal wording**: nothing here is a policy or advice. When the code changes what it stores or sends, change this page in the same commit.

## Who to contact

`md.solutions.homeos@gmail.com`: the contact in `privacy.html`, the landing page footer and the legal placeholders.

## Per page: data collected and sent

| Page | Host | Data collected | Sent to |
|---|---|---|---|
| Landing page `/` (`site/index.html`) | landing | the demo's cards stay in the browser. A press of Try the demo, Subscribe to Personal or Subscribe to Team followed by Send with an email keeps the plan, the time and the email, and the Telegram username if the person gives it (optional; both unverified), as a task in the household list "Consultancy Request" (read by Maksym, `homeos-agent` and the household Telegram bot); a press without an email keeps nothing; no IP address or other detail is stored by the function | Supabase (`rpc/request_plan_interest`, `db/026`, `db/030`; Supabase's own request logs apply) on Send with an email, nothing else; the consulting buttons go to `/signin?intent=consult` on the app host |
| Legal placeholders, `/privacy` | landing, app | nothing | nothing (no script) |
| Sign-in `/signin` (`signin.html`) | app | Google sign-in returns email, name and profile picture (scopes `openid`, `email`, `profile`); an access request keeps email, first and last name and the request time (`users_pending_for_decision`); a consulting-call request (`?intent=consult`, `db/025`) keeps the email, the Telegram username and WhatsApp number if given, a note if given and the time, as a task in the household list "Consultancy Request" (read by Maksym, `homeos-agent` and the household Telegram bot) | Supabase (Auth and four RPCs); Google (the sign-in screen); the task appears in Maksym's Telegram digest |
| Board `/board/` (`TasksDashboard.html`) | app | the account (email, display name), the lists, items, tags, sharing and preferences a person creates | Supabase only |
| Phone app `/app/` | app | the same as the board; changes made offline wait on the device until they are sent | Supabase only |
| Eisenhower Harness `/harness/` (`harness/*`, `db/031`) | app | nothing new from the reader: it uses the board's session. A reader's button press keeps who pressed, when, the session, the action, an optional note (up to 1000 characters) or a limits change, and the PC's answer, for 30 days. The PCs that publish upload their agent runs (session tree, goals, states, costs, reports, decisions, the last 400 steps of each session, redacted: secrets and ID-like strings withheld, paths outside the repo cut to a file name), kept 30 days | Supabase only |
| Cloudflare Access login (before `/board/` and `/app/`) | app | the email Google returns to Access | Cloudflare (Access), Google |
| Access decision email | (outside this repository) | the requester's email address, to send one email with the decision | the mail sender the host runs |

## Storage on the device

| Key or store | Kind | Page | Holds | Kept |
|---|---|---|---|---|
| `td.auth` | `localStorage` with Stay signed in ticked, else `sessionStorage` | board, phone app | refresh token and the login's id | until sign-out (or the tab closes, in `sessionStorage`) |
| `td.accounts` | `localStorage` | board | email, handle and provider of up to 8 accounts that signed in on this browser; never a token | until removed |
| `td.pkce` | `sessionStorage` | board | the PKCE verifier of a Google sign-in in flight | deleted on the way back |
| `td.emails` | `localStorage` | board | an old key, read once and removed | removed on first load |
| `td.theme` | `localStorage` | board, sign-in | light or dark | until changed |
| `td.rail` | `localStorage` | board | side menu width and hidden state | until changed |
| `td.app.pkce` | `localStorage` | phone app | the PKCE verifier of a sign-in in flight | deleted on the way back |
| `td.app.theme`, `td.app.list`, `td.app.lastList`, `td.app.installHint`, `td.app.hint` | `localStorage` | phone app | theme, selected list, whether hints were shown | until changed |
| IndexedDB `td-app` | IndexedDB | phone app | the offline copy and the queue of changes not yet sent | until sent or signed out |
| cache `td-app-<release sha>` | Cache Storage (service worker) | phone app | the app's own files for offline start; never Supabase answers | replaced on the next release |
| `td.request.pkce`, `td.request.auth` | `sessionStorage` | sign-in | the PKCE verifier; the sign-in page's own session | this tab only |
| `td.signin.next` | `sessionStorage` | sign-in | `/board/` or `/app/`, where a let-in login goes next | removed when it goes |
| `ec.demo.v5` | `localStorage` | landing page demo | the demo's cards | until the browser's site data is cleared |
| `ec.interest.v1` | `localStorage` | landing page plan buttons | the plans already filed from this browser, and that the demo's dialog was shown; never a contact | until the browser's site data is cleared |
| `CF_Authorization`, `CF_AppSession` | cookies (set by Cloudflare Access) | app host `/board/`, `/app/` | the Access login | the session length of the Access policy |

Before any click on `/signin` and `/app/` (checked 2026-10-30 on the older host): no cookies, no storage keys, no request to another host. No analytics, no advertising, no tracker in the code.

## Processors and regions

| Who | What for | Region |
|---|---|---|
| Supabase | database, sign-in (Auth) | EU Central (Frankfurt) |
| Cloudflare | hosting of both hosts (Pages), the Access login in front of `/board/` and `/app/` | global network |
| Google | sign-in (Google account), through Supabase Auth and Cloudflare Access | Google's own |

## Deletion today

The board and the phone app tell people to ask for deletion at the contact above. There is no self-service deletion and no export route in the app; the landing page says an export is on the way. A written process and an admin runbook are not part of this repository yet.

## Open points for the legal texts

- Whether the preference keys (`td.theme`, `td.rail`, `td.app.theme`, `td.app.list`, `td.app.installHint`, `td.app.hint`, `ec.demo.v5`, `ec.interest.v1`) count as strictly necessary.
- Legal basis, retention periods, transfers, rights and the supervisory authority: not in the code, to be decided.
- Business details for a legal notice (entity, address, tax number): not in this repository.

## Draft for the privacy page: the Eisenhower Harness page (for review, not published)

Draft paragraph for `privacy.html`, written for HomeOS #45 (2026-11-09). A person reviews it before it goes into the page; nothing here is legal advice.

> **Eisenhower Harness page (`/harness/`).** If you have access to the board, you can open a page that shows the AI agent runs started from the lists you can see. The computers that run the agents upload a summary of each run to our database: which sessions ran, their goals, states, costs, reports and decisions, and the last 400 steps of each session. Secrets, ID-like numbers and file paths outside the project are removed before upload. You see only the runs of lists shared with you; household members see all of them. Owners of a list can press Stop, Continue, Take over, Release or change that list's limits. Each press is stored with who pressed it, when, the session, any note you typed and the computer's answer. Run data and presses are deleted after 30 days. They are stored with Supabase, like the rest of the board, and are not shared with anyone else.

Open: whether 30 days needs a stated legal basis per run type, and the EU and Portuguese checks (GDPR art. 5(1)(e) storage limitation, Lei 58/2019). The basic-product-compliance skill was not run for this.
