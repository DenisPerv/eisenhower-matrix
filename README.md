# TasksDashboard

Eisenhower matrix task view, **UI prototype 4-5 "Aurora instrument"** (made in `UIPrototypes/uupm` with the UI UX Pro Max skill). One file, `TasksDashboard.html`: no server, no build, no dependencies, nothing loaded from the network.

This version is a design prototype, not the data-file app it replaced (that app is in git history before this commit). It shows built-in example data and does not read or write a task file.

## Open

Double-click `TasksDashboard.html` (Chrome or Edge on Windows 11 for the intended fonts: Segoe UI Variable, Bahnschrift, Sitka, Cascadia Mono).

## Model

| Quadrant | Row | Column | Title | Colour |
|---|---|---|---|---|
| A | important | urgent | Do | red |
| B | important | not urgent | Plan | green |
| C | not important | urgent | Delegate | yellow |
| D | not important | not urgent | Eliminate | grey |

- Grid order: B Plan, A Do on top; D Eliminate, C Delegate below.
- Today is fixed at `2026-10-26T10:00` (`TODAY`) so overdue and due-soon states match the example data.
- Done = archive (`doneAt`); restore and delete exist in the Archive view.

## Data

- Built in: three lists (`backlog`, `reminders`, `other`) in the version 2 format: `backlog` / `archive`, each with quadrants `A`..`D` as card arrays (`id`, `num`, `title`, `deadline`, `tags`, `notes`, `urgentPin`, `completedAt`). 57 open, 3 archived.
- Edits (move, add, done, tags, lists) live in memory only and are lost on reload.

## Storage

| What | Where |
|---|---|
| matrix axis split (`fx`, `fy`) | `localStorage` `td.axes` |
| side menu width and hidden state | `localStorage` `td.rail` |
| list order | `localStorage` `td.lists` |

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

- **Top bar:** Priority fan logo; list chips (All fixed first, five chips including All, the rest behind `+N`; drag or Alt+arrows to reorder; a selected list from `+N` shows sixth); profile menu; light/dark toggle.
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

## Limits

- No task file: no load, save, sync or merge; the gate screens (`#first-run`, `#restore`, `#wrong-folder`, `#unsupported`) are placeholders.
- No `<script id="core">`; the logic is not separated for Node.
- Example data only; no repeat, subtasks, effort, reminders or `.ics` export.
- The End field uses the browser's date-time control, so its format follows the system locale.
