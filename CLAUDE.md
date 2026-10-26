# TasksDashboard: rules for Claude

Eisenhower matrix task app: `TasksDashboard.html` (the whole app), `README.md` (its documentation), `config/` (`tasksdashboard.config.js`, `profiles.js`, and the `<id>.prefs.json` files the page writes) and `dependencies-doc.md`. Nothing else belongs here.

## README is the view documentation: update it with every change

Every change to `TasksDashboard.html` updates `README.md` in the same commit. No exceptions, including small fixes.

- Before committing, check each README section against the change: Model, Data file (format, card fields, load rules), Storage and sync (keys, intervals), Settings (defaults, ranges), Features, Limits.
- Values in the README come from the code (`DEFAULTS`, `*_KEY`, `CHECK_EVERY_MS`, `normalizeTask`, `normalizeData`), never from memory.
- Keep it minimal and technical: tables and short bullets, no tutorials, no marketing, nothing that is not in this repository.
- A change with no documentation impact still gets a check; say "README checked, no change" in the commit body.
- A commit that touches `TasksDashboard.html` without touching `README.md` or that line is incomplete: fix it before pushing.

## Branches

- Work only on `development_maxden` (while developing) or `release_maxden` (default). Never check out, commit to, merge into or push `main` or any other branch.
- Commits go to `development_maxden`. When asked to merge or push: merge `development_maxden` into `release_maxden` and push `release_maxden`.
- Never force-push.

## Code

- One HTML file, no build step, no runtime dependencies, opens from `file://`. Scripts load nothing from the network.
- Logic stays in `<script id="core">` with no DOM and no system clock (time is a parameter), so it can be loaded with `require()` in Node.
- Data format changes: bump `DATA_VERSION`, keep reading older versions, document both in the README.
- After a UI change, open the page and check it at desktop and mobile widths.

## Data

Task data never lives in this repository. Data files are chosen in the app and kept elsewhere.
