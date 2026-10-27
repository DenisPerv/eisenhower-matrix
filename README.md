# TasksDashboard

Eisenhower matrix task view, **UI prototype 4-5 "Aurora instrument"** (made with the UI UX Pro Max skill). `TasksDashboard.html` plus `config/`: no server, no build, no dependencies, nothing loaded from the network.

It reads task lists from the folders named in the config and writes new list files and per-profile preferences. Task edits stay in memory (see Limits).

## Open

Double-click `TasksDashboard.html` (Chrome or Edge on Windows 11 for the intended fonts: Segoe UI Variable, Bahnschrift, Sitka, Cascadia Mono).

| URL | Effect |
|---|---|
| `TasksDashboard.html` | real lists from the configured folders |
| `?profile=<id>` | start as that profile |
| `?demo` | built-in example lists, `Today` fixed at `2026-10-26T10:00`; nothing is written |

## Files

| File | Written by | Holds |
|---|---|---|
| `config/tasksdashboard.config.js` | hand | `window.TD_CONFIG`: `readFolders`, `createFolder` |
| `config/profiles.js` | hand | `window.TD_PROFILES`: `[{ id, name, tags }]` |
| `config/<id>.prefs.json` | the page | that profile's preferences |

The config files are `.js` because a `file://` page can load a script beside it but cannot read a `.json` file.

## Config

```js
window.TD_CONFIG = {
  readFolders: ['../../references/Family-Tasks'],   // every *.json at each folder's root is a list
  createFolder: '../../references/Family-Tasks',    // New list writes <name>-tasks.json here
};
```

- Paths are relative to `TasksDashboard.html`. Absolute paths (`D:\…`, `/…`, `file:…`) are refused.
- Every folder needs a different last segment (the page checks folders by name), and none may be named `config`.
- A missing config, an empty `readFolders` or a refused path shows the errors and nothing else.
- `createFolder` should also be in `readFolders`; otherwise a new list is not read after a reload.

## Folder access

- A `file://` page cannot open a folder by path. Each configured folder, plus `config/` for preferences, is picked once in the system dialog.
- First run, or a grant Chrome dropped: the page shows only `Allow <folder name>` buttons, one per folder without a grant.
- The picked folder's name must equal the last segment of its path. Otherwise the page shows `Wrong folder: expected <name>.`
- The handles are kept in IndexedDB `td` (store `handles`, key = the path). A later restore is one click with no dialog.
- Browsers without `showDirectoryPicker`: `This browser can't open a folder. Use Chrome or Edge.`

## Model

| Quadrant | Row | Column | Title | Colour |
|---|---|---|---|---|
| A | important | urgent | Do | red |
| B | important | not urgent | Plan | green |
| C | not important | urgent | Delegate | yellow |
| D | not important | not urgent | Eliminate | grey |

- Grid order: B Plan, A Do on top; D Eliminate, C Delegate below.
- Today = the clock at page load (`?demo`: `2026-10-26T10:00`).
- Done = archive (`doneAt`); restore and delete exist in the Archive view.

## Data

- **List file:** any `*.json` at the root of a read folder, sorted by file name per folder. A leading `.` is ignored, as are subfolders and other files.
- **Label:** the file name without `-tasks.json` (else without `.json`), first letter capitalised: `backlog-tasks.json` → Backlog, `OtherTasks.json` → OtherTasks. When two folders hold the same label, the folder name is added.
- **List key:** `<folder path>/<file name>`, used in preferences.
- **Format version 2:** `{ version: 2, timeZone, backlog: { A..D: [cards] }, archive: { A..D: [cards] } }`. Card fields read: `id`, `num`, `title` (required), `deadline`, `tags`, `notes`, `urgentPin`, `completedAt`; others are ignored.
- **A file that fails to read** (not JSON, another version, a card without a title) shows as a disabled, struck-through chip with the error as its tooltip.
- **Task id:** the card's `id`. An id already seen in an earlier list gets `~2`, `~3` in memory.
- **New list:** letters, digits and dashes; it writes an empty version 2 file `<name>-tasks.json` (time zone `Europe/Lisbon`) into `createFolder`. An existing file name is refused.

## Profiles

- `config/profiles.js`: `id` (`[a-z0-9-]`, also the preferences file name), `name`, `tags`. Tasks with any of the profile's tags count as **Mine**. Duplicate and invalid entries are dropped.
- Start profile: `?profile=<id>`, then the last one used in this browser (`localStorage` `td.profile`), then the first in the file.
- The profile menu lists every profile; switching saves the current profile's preferences, then loads the other's.

## Preferences

`config/<id>.prefs.json` is written 1 s after a change (`PREFS_DELAY_MS`), and only when its content differs from the last write. It is never written in `?demo`. The files are committed with the app repo, so both machines share them through git.

| Key | Default | Holds |
|---|---|---|
| `version` | `1` | format |
| `theme` | `auto` | `auto` (system), `light`, `dark` |
| `view` | `matrix` | `matrix`, `archive`, `timeline` |
| `list` | `all` | `all` or a list key |
| `listOrder` | `[]` (file-name order) | list keys in chip order |
| `tagOrder` | `[]` | tag order in the task window; filled once a task window is opened |
| `axes` | `{ fx: 0.5, fy: 0.5 }` | matrix split: `fx` = width share of the not-urgent column, `fy` = height share of the important row; clamped to the window when applied |
| `menuCollapsed` | `[]` | collapsed side-menu groups `A`..`D` |
| `cards` | `{ mode: 'collapsed', flipped: [] }` | card mode and the task ids shown the other way |

Example (`config/maksym.prefs.json`):

```json
{
  "version": 1,
  "theme": "auto",
  "view": "matrix",
  "list": "../../references/Family-Tasks/backlog-tasks.json",
  "listOrder": [
    "../../references/Family-Tasks/backlog-tasks.json",
    "../../references/Family-Tasks/reminders-tasks.json",
    "../../references/Family-Tasks/OtherTasks.json"
  ],
  "tagOrder": [],
  "axes": { "fx": 0.5, "fy": 0.1354 },
  "menuCollapsed": [],
  "cards": { "mode": "collapsed", "flipped": [] }
}
```

- Unknown keys are dropped, and a value of the wrong type takes its default.
- A broken file loads the defaults and is rewritten on the next change.
- A list, task or tag that no longer exists is dropped; `list` then falls back to `all`.
- First run with no preferences file: the old `td.axes` and `td.lists` values are copied in once, then removed.

## Storage

| What | Where |
|---|---|
| preferences | `config/<id>.prefs.json` |
| folder handles | IndexedDB `td`, store `handles` |
| last profile | `localStorage` `td.profile` |
| theme before the folders load (no flash) | `localStorage` `td.theme` |
| side menu width and hidden state | `localStorage` `td.rail` |

Tasks, tags and settings are not stored.

## Settings (in memory)

| Setting | Default |
|---|---|
| Urgency threshold | 50% |
| Urgency window | 7 days |
| Working days only | off |
| "Do" limit | 5 |
| Working hours per day | 8 |

## Features

- **Top bar:** Priority fan logo (`ADV_LOGO`), a button: at rest it shows the last frame of its animation; a click, Enter or Space plays the animation once (`.play` for `LOGO_PLAY_MS` 3600 ms: intro, then one glow cycle); a click while it plays does nothing, a re-render during it keeps its place, and with reduced motion the click does nothing. Tile and colours follow the app theme (`--td-*` on `.td-adv`): white tile with the deeper palette on light, black tile with the lifted palette on dark; list chips (All fixed first, five chips including All, the rest behind `+N`; drag or Alt+arrows to reorder; a selected list from `+N` shows sixth); profile menu (profiles, weekly review, settings, card mode); theme button (Auto until the first click, then Light or Dark).
- **Search:** search with Due, Tag, Mine filters; results grouped by quadrant; `/` focuses, arrows and Enter open.
- **Side menu:**
  - views (Matrix, Archive, Timeline) and the open items by quadrant;
  - drag its edge to resize (256 px to start, 128-560 px); drag below 128 px, double-click or Enter on the edge to hide;
  - a slim tab brings it back.
- **Matrix:**
  - drag cards between and inside quadrants; `+` and double-click to add; expand one quadrant;
  - movable axes (drag the lines or the centre knob; arrows, Home or double-click to reset) with a minimum of one ~50-character title per column and one card per row;
  - list-to-card and card-to-list highlights in the quadrant colour.
- **Task window:** title and description with bold, italic and lists; list; quadrant; end date; tags with delete (corner cross or Delete, with a yes/no question that counts dependent items), drag or Alt+arrows to reorder, and double-click or F2 to rename (applies to every task).
- **Other views:** archive (sort, restore, delete); timeline with weekends, today and load row; weekly review; undo toast (Ctrl/Cmd+Z).

## Code

- `<script id="core">` (global `TDCore`, `module.exports` in Node): config, folder, list-file, profile and preferences rules; no DOM, no clock.
- The UI script and the 4-5 layer script (axes, side-menu width) hold the rest. The axes layer exposes `window.tdAxes` (`get`, `set`, `onSave`).

## Limits

- Task edits (move, add, done, tags, list) are not saved to the files and are lost on reload. A new list file is created, but tasks added to it are lost too.
- Lists are read once at page load; a file added or changed outside the page shows after a reload.
- Chrome may drop a grant after a restart: one `Allow` click restores it. Whether Chrome's "allow on every visit" works for `file://` is untested.
- Only the folder name is checked, not its location: a different folder with the same name is accepted.
- Two open tabs write the same preferences file: the last write wins.
- No repeat, subtasks, effort, reminders or `.ics` export.
- The End field uses the browser's date-time control, so its format follows the system locale.
