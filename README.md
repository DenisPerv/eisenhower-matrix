# Eisenhower Matrix

A single-page task app built around the Eisenhower matrix. One HTML file (`TasksDashboard.html`), no server, no
build step and no runtime dependencies. Your tasks live in a JSON file that you choose, so they can sit in a
synced folder or a git repository and be shared with colleagues.

The interface, messages and sample data are in English.

## Quick start

```bash
open TasksDashboard.html   # or double-click the file in Finder / Explorer
```

On first start the app loads a few sample tasks and keeps everything in the browser (`localStorage`).
Click **Choose file…** in the left panel to open or create a real data file; from then on every change is
written to it automatically.

**Browsers.** Saving straight to a file uses the File System Access API, which exists in **Chrome and Edge**
only. Firefox and Safari work too, but without a data file: the data stays in the browser, you can load a file
(it replaces the current data) and use **Download a copy of the data** from time to time.

For development and testing:

```bash
npm install             # once: installs playwright-core (no browser is downloaded)
npm test                # all tests: logic + UI in a real Chrome
npm run test:core       # logic tests only: no browser and no npm install needed
```

The UI tests need an installed Chrome; set `EM_CHROME` to its path if it is not found automatically. Without
Chrome the UI tests are skipped and the logic tests still run.

## The model

Four quadrants. Importance is the row, urgency is the column.

| Quadrant | Meaning | Title in the app | Colour |
|---|---|---|---|
| A | important and urgent | DO IT NOW! | red |
| B | important, not urgent | PLAN IT! | green |
| C | not important, urgent | DELEGATE IT! | yellow |
| D | not important, not urgent | ELIMINATE IT! | grey |

- **Importance is the quadrant row.** There is no "important" checkbox and no star. To change importance,
  drag the card into a quadrant of the other row.
- **Urgency of important tasks (A and B) is computed from the dates.** It is the share of the window that has
  already elapsed, raised by the effort estimate. A task is urgent at or above the threshold. Dates move only
  important tasks between A and B.
- **Urgency of unimportant tasks (C and D) is manual.** Dragging a card between columns stores the choice as
  `urgentPin` and shows a pin badge ("urgent (manual)" / "not urgent (manual)"). An overdue unimportant task
  therefore stays where you put it. Clicking the badge, or dragging the card to the column that the dates
  would give anyway, clears the pin. Pinning an important task also works and overrides the calculation.
- Dragging between quadrants never changes the dates. One undo reverts the whole move.
- **Not-yet-started** tasks appear as dashed cards (in B or D); the option "Show not-yet-started tasks in the
  matrix" hides them.
- A card's colour is always the colour of its quadrant and changes when the card is moved. An overdue card
  also gets a red frame. Text contrast is at least 4.5:1 in both themes.

Settings that drive the calculation (gear icon, Urgency settings; stored in this browser, not in the file,
except the time zone):

| Setting | Default | Notes |
|---|---|---|
| Urgency threshold | 50% | range 10 to 90 |
| Urgency window | 7 days | 1 to 30; if the task is shorter, its whole span is used |
| Count working days only | off | Mon to Fri; weekends count neither in the span nor in the remainder; holidays are ignored |
| Task limit in "Do it now" | 5 | 0 = no limit; above it quadrant A gets a red inner frame and a warning; counted over all tasks, search does not hide it |
| Time zone | `Europe/London` | stored **in the data file**; see "Time zone" |

## Tasks and cards

- **Compact card:** title, task number, the done button (✓) and an expand arrow. The arrow shows the details
  (time left, dates, tags, description, edit button). Clicking the card itself opens the task window.
- **Task number:** an integer starting at 1 (field `num`), shown next to the title. Clicking it copies it to
  the clipboard, and search finds a task by `#12` or `12`, so colleagues can refer to tasks in chat. The
  internal `id` (used for links between tasks) never changes.
- **Task window:** one dialog for creating and editing. Fields: title, description (optional, shown in the
  expanded card), start and deadline (both optional), tags, and under **More options**: effort in hours,
  repeat, parent task, "waits for" dependencies.
- **Creating:** the "+" button in a quadrant header, or a double-click on empty space inside a quadrant, opens
  the window for that quadrant. A task without a deadline (and any unimportant task) goes into the quadrant
  where you clicked; an important task with a deadline is placed by its dates.
- **Dates are optional.** A task without a deadline has no date-based urgency and does not appear on the
  timeline, in calendar export or in reminders. A deadline before the start is rejected. With a deadline
  only, the urgency window counts back from the deadline.
- **Tags:** pick existing tags as chips in the task window or type new ones separated by commas (no `#`,
  case-insensitive, no duplicates).
- **Order is manual.** A new card goes on top of its quadrant. Drag and drop inside a quadrant reorders:
  dropping on the upper or left part of a card puts the dragged card before it, the lower or right part puts
  it after, empty space puts it at the end. Ids never change.
- **Repeat:** every day, weekdays, week, two weeks, month (the file accepts any
  `{ "unit": "day|weekday|week|month", "every": N }`). Completing a repeating task creates the next one with
  shifted dates; missed periods are skipped, and the completed task keeps `spawned` so that restoring and
  completing it again does not create copies. A repeating task needs a deadline.
- **Dependencies (`dependsOn`):** a waiting task shows "waits for ..." until its blockers are done. A blocker's
  effective deadline is the waiting task's deadline minus its effort, and its urgency is computed from that.
- **Subtasks (`parentId`):** the parent shows a progress badge, the child links to the parent; a subtask's
  deadline may not be later than its parent's. Cycles are rejected.

## Done means archive

- The ✓ button sends the task to the archive and records `completedAt`. There is no separate "done" state,
  and cards have no "archive" or "delete" buttons.
- The archive remembers the quadrant (colour) the card was in. **Restore** (↩) puts the card back on top of
  the backlog, without `completedAt`; its quadrant is then worked out again.
- **Delete** exists only on the **Archive** tab (and "Delete all archived"), and always asks for confirmation
  in a dialog whose default focus is Cancel.
- The Archive table has columns for title, tags, a Quadrant chip, completion date and deadline, sortable by
  completion, deadline or title. There is no importance column. Search and the tag filter apply there too. If
  a search matches archived tasks, a "Found in archive: N" button appears next to the tabs.
- Undo: delete, done, restore and move are undone by the "Undo" button in the toast (8 seconds) or
  Ctrl/Cmd+Z. Any other change (form, import, merge) clears the undo history.

## Left panel and settings

The left panel contains, top to bottom:

- **Search and filters** (collapsed by default): text search over title, description, tags and `#number`;
  tag chips (several can be selected, a task matches if it has any of them; clicking a tag on a card toggles
  it); **Today** (only tasks whose deadline is today or earlier, in the data time zone; cards due today get a
  badge); **Show as of** (view the matrix at any date and time).
- A **compact list** of open tasks grouped A (red), C (yellow), B (green), D (grey). Inside a group the order is
  the same as in the matrix. Clicking a row opens the task; ✓ completes it.
- At the bottom: file status, **Choose file…** (or **Change file…**), the profile name (plain text) and the
  gear icon.

The gear opens the **settings drawer** (Esc closes it): profile name (not a login, it hides nothing and only
labels event-log entries), theme (Auto, Light, Dark), a temporary style switcher (Soft, Flat, Contrast; it only
changes the look and is to be removed once a style is chosen), urgency settings, time zone, **weekly review**,
colour legend, event log, and **More options**: the Timeline tab, working hours per day for load, browser
notifications, and calendar `.ics` export.

Quadrant extras: "+" creates a task in that quadrant, a double-click on empty space does the same, and the
expand button ⤢ shows one quadrant over the whole matrix area (⤢ again or Esc returns). In that mode cards
cannot be dragged to another quadrant.

## Data file

The data file is plain JSON, safe to keep in git or a synced folder. Current format (version 2):

```json
{
  "version": 2,
  "timeZone": "Europe/London",
  "backlog": {
    "A": [
      {
        "id": "t5",
        "num": 5,
        "title": "Pay the invoice",
        "start": "2026-09-25T09:00",
        "deadline": "2026-10-05T18:00",
        "tags": ["finance"],
        "updatedAt": "2026-10-06T08:15:00.000Z"
      }
    ],
    "B": [
      {
        "id": "t1",
        "num": 1,
        "title": "Prepare the report for the client",
        "start": "2026-10-05T09:00",
        "deadline": "2026-10-08T18:00",
        "effortHours": 6,
        "tags": ["work"],
        "notes": "Version 2, without appendix B.",
        "dependsOn": ["t4"],
        "repeat": { "unit": "week", "every": 1 }
      }
    ],
    "C": [
      {
        "id": "t3",
        "num": 3,
        "title": "Reply to the accumulated emails",
        "urgentPin": true,
        "start": "2026-10-06T09:00",
        "deadline": "2026-10-07T12:00"
      }
    ],
    "D": []
  },
  "archive": {
    "A": [],
    "B": [
      {
        "id": "t4",
        "num": 4,
        "title": "Book the venue",
        "completedAt": "2026-10-04T16:30:00.000Z"
      }
    ],
    "C": [],
    "D": []
  }
}
```

Top level: `version` (2), `timeZone` (optional IANA name), `backlog` and `archive`, each with the four keys
`A`, `B`, `C`, `D`, each an array of cards.

| Card field | Meaning |
|---|---|
| `id` | Unique string, never changes; used by `dependsOn`, `parentId`. Duplicates are given new ids on load. |
| `num` | Task number, integer from 1. Missing or duplicate numbers are assigned on load (max + 1). |
| `title` | Required. |
| `start`, `deadline` | Optional, `2026-10-08T18:00` (wall-clock time in the file's time zone) or with `Z` / offset (absolute). Older `end` is read as `deadline`. |
| `effortHours` | Optional number >= 0. |
| `tags` | Array of strings. |
| `notes` | Description text. |
| `repeat` | `{ "unit": "day\|weekday\|week\|month", "every": 1..365 }`. Needs a deadline. |
| `dependsOn` | Array of ids this task waits for. |
| `parentId` | Id of the parent task. |
| `urgentPin` | `true` / `false`: manual urgency, used for unimportant tasks. Absent means computed from dates. |
| `seriesId`, `spawned` | Bookkeeping for repeating tasks. |
| `updatedAt` | Set on every change; used by merge. |
| `completedAt` | Archive cards only. |

Rules worth knowing:

- **There is no `status` and no `importance` field.** The section (`backlog` / `archive`) is the status; the
  quadrant key is the importance row (A and B important, C and D not). Both are written when saving and
  derived when loading.
- **The order of cards in an array is the displayed order.**
- The **backlog quadrant is recorded when the file is written.** Dates can move an important card between A
  and B between writes; the app recomputes this on load, so a stale quadrant in the file is harmless.
- A broken file is rejected as a whole and nothing changes. A file with a newer `version` is refused.
- **Older files** (a flat `{ "version": 1, "tasks": [...] }` with `status` and `importance`, or a bare array
  of tasks) are still read and are rewritten in v2 on the next write.

### Switching between data files

Data files are kept outside this repository. The app shows one file at a time. When you switch with
**Change file…** and the new file differs from what is on screen, the conflict banner appears: choose
**Take from file**. **Merge** would mix the two files into the new one, and **Keep mine and overwrite the
file** would replace it with the previous file's tasks.

### Sync with the file

- **Autosave.** After every change the app writes the file. The browser cache (`localStorage`, key
  `eisenhower_tasks_v2`) is an invisible safety net and the store until a file is chosen.
- **Remembered file.** The file handle is kept in IndexedDB. On start: access still valid, the file connects
  itself; the browser wants permission again (usually after a restart), a "Continue with file ..." button
  appears and nothing is written until you click it; file moved or deleted, it is forgotten and you are asked
  to choose again; file damaged, an error is shown and the file is not touched. "Disconnect file" drops the
  link without touching the file or the browser data. Without IndexedDB (private mode) the file is simply not
  remembered.
- **External changes** (a colleague, git, cloud sync). The app notes the file's modification time after each
  of its own writes and checks it every 15 seconds, when the tab regains focus and before every write.
  If you have no unsaved edits, the new content is loaded with a notice. If the content is the same, nothing
  happens. If both sides differ, a **conflict banner** lists the differences and offers **Take from file**,
  **Merge** and **Keep mine and overwrite the file**; autosave pauses until you choose.
- **Merge** keeps tasks from both sides; on a conflict the more recent `updatedAt` wins. **Deletions are not
  carried over:** a task deleted on one side comes back from the other.
- **Download a copy of the data** saves a snapshot as a file (backup, sending to a colleague); the connection
  and the file are unchanged.

## Time zone

The default is `Europe/London`, whatever the device's zone. The zone is stored in the data file
(`"timeZone"`) and every time is read in it, so deadlines do not drift when someone travels. A file's zone
takes priority over the local choice. Changing the zone in settings shifts all deadlines in time (the same
wall-clock time in another zone); strings with `Z` or an offset are absolute and unaffected. "Show as of",
day boundaries, working days, the timeline and the calendar export all use the data zone.

## Event log

All actions (clicks, task edits, search and filters, settings, file operations, conflicts, errors) are
recorded as one JSON line per event, with the profile name, in a **separate file**, `events.jsonl`, chosen in
settings (Chrome and Edge). The tasks file is never touched by the log.

- Events are buffered and written about 1.2 seconds after the last one, so a crash can lose the tail.
- Until a log file is connected, the browser keeps the last 3000 events (they can be downloaded); connecting a
  file appends everything accumulated. There is no rotation.
- Entered values (search text, task titles, fields up to 100 characters) are recorded, so mind who receives
  the file. The profile name is not authentication; entries can be forged.

Statistics (tables by type, person, day, clicks, search and errors):

```bash
node tools/events-stats.mjs events.jsonl
```

## Other features

- **Weekly review** (settings): overdue, became urgent this week, completed this week, deadlines in the next
  7 days, plus counters. A week is exactly 168 hours; it uses "Show as of" and the urgency settings. Search
  and tag filters do not affect it.
- **Timeline** (settings, More options; adds a tab): horizontal bars from start to deadline per day, weekends
  and today highlighted, and a load row (tasks and hours per day against the "working hours per day"
  setting, default 8). Navigate by week, zoom 2, 4 or 8 weeks, click a bar to edit.
- **Calendar export** (`.ics`): a "Deadline: ..." event per open dated task (30 minutes, alarm before it, 0 =
  none) and optionally a "Work: ..." event over the whole period. Times are written in UTC from the data
  zone; UIDs are stable, so re-importing updates events instead of duplicating them. Archived tasks are not
  exported.
- **Browser reminders** (settings, More options): overdue, deadline within 24 hours, became urgent. One
  notification per task and event. They work only while the tab is open, and notifications may be unavailable
  for a `file://` page; if so serve the folder locally (for example `python3 -m http.server`).
- **Dark theme:** Auto, Light or Dark, applied before the first paint. Overdue pulsing is off when the system
  asks for reduced motion. The minute refresh of colours and labels pauses while you drag a card.

## Project structure

```
TasksDashboard.html         the whole application; the logic is in <script id="core">, separate from the UI
tools/events-stats.mjs      statistics over events.jsonl
tests/app-core.test.js      logic tests, read straight from TasksDashboard.html (no browser)
tests/events-stats.test.js  tests for the statistics tool
tests/ui/                   UI tests in real Chrome via playwright-core; helpers.js is the shared harness
PLAN.md, STATUS.md          working plan and current status
```

## Testing notes

- `npm test` runs everything with `--test-concurrency=1`. Core tests need only Node; UI tests need Chrome
  (`EM_CHROME`).
- The UI suites cover: basic flows, filters and settings, file sync (a real file handle), file picking,
  time zones, dark theme and contrast, repeats and dependencies, timeline, export, reminders, ordering and
  drag and drop, layout, the archive tab, backward compatibility with older files.
- The clock is fixed in UI tests and the default time zone is UTC, so results do not depend on the day.
- By default the test harness expands the filters, enables the Timeline and shows card details, to keep
  tests short. Pass the `rawUi` option to `openApp` to test the real default interface; `group2.test.js` and
  `order.test.js` do this.
- Not yet checked: touch and mobile screens, and contrast in
  the temporary style variants.

## Known limitations

- **Number reuse:** a task's number is the highest existing number plus one. Deleting the highest-numbered
  archived task lets a new task take its number. If two people add tasks to one file at the same time, one
  duplicate gets a new number on merge.
- **No authentication:** the profile name is only a label. Anyone with the file can read and edit it.
- **Firefox and Safari** cannot write files or keep an event-log file; use import and "Download a copy".
- **Merge does not propagate deletions.**
- Months in repeat rules are counted from the previous occurrence, so the 31st becomes the 28th after
  February and stays there.
- Reminders need an open tab and may not work from `file://`.
- Holidays are not taken into account by "working days only".
- Touch and small screens are untested: double-click, drag and drop and the small buttons may be awkward.
