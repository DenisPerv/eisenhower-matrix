# TasksDashboard

Eisenhower matrix task app. One file, `TasksDashboard.html`: no server, no build, no dependencies. Tasks live in a JSON data file kept outside this repository.

## Open

Double-click `TasksDashboard.html`. Chrome or Edge for writing to a data file (File System Access API); Firefox and Safari keep data in the browser only (load a file, download a copy).

## Model

| Quadrant | Row | Column | Title | Colour |
|---|---|---|---|---|
| A | important | urgent | DO IT NOW! | red |
| B | important | not urgent | PLAN IT! | green |
| C | not important | urgent | DELEGATE IT! | yellow |
| D | not important | not urgent | ELIMINATE IT! | grey |

- Importance = quadrant row; changed only by dragging to the other row.
- Urgency of A/B = share of the urgency window elapsed (raised by effort) >= threshold. Urgency of C/D = manual (`urgentPin`). A pin on A/B overrides the dates.
- Dragging never changes dates. Done = archive (`completedAt`); delete exists only in the Archive tab.

## Data file

```json
{
  "version": 2,
  "timeZone": "Europe/Lisbon",
  "backlog": { "A": [], "B": [ { "id": "t1", "num": 1, "title": "Report", "deadline": "2026-10-08T18:00" } ], "C": [], "D": [] },
  "archive": { "A": [], "B": [], "C": [], "D": [] }
}
```

- `backlog` = open, `archive` = done; each holds quadrants `A`..`D` as arrays of cards. Array order = display order.
- No `status` or `importance` field: both are derived from section and quadrant.
- `timeZone` (IANA) is stored in the file and wins over the device; default `Europe/London`.
- Invalid file: refused as a whole, nothing changes. Newer `version`: refused. Version 1 (`{ "tasks": [...] }` or a bare array) is read and rewritten as v2.

| Card field | Type / rule |
|---|---|
| `title` | required |
| `id` | string, never changes; duplicates re-issued on load |
| `num` | integer >= 1; missing or duplicate assigned on load (max + 1) |
| `start`, `deadline` | optional; `2026-10-08T18:00` (file zone) or with `Z`/offset; deadline >= start; legacy `end` = `deadline` |
| `effortHours` | number >= 0 |
| `tags` | string array, no `#`, case-insensitive unique |
| `notes` | string |
| `repeat` | `{ "unit": "day\|weekday\|week\|month", "every": 1..365 }`; needs `deadline` |
| `dependsOn` | id array |
| `parentId` | id; subtask deadline <= parent's; cycles rejected |
| `urgentPin` | boolean |
| `seriesId`, `spawned` | repeat bookkeeping |
| `updatedAt` | ISO, set on every change, used by merge |
| `completedAt` | archive only |

## Storage and sync

| What | Where |
|---|---|
| tasks | the connected data file; autosave after every change |
| tasks cache / before a file is chosen | `localStorage` `eisenhower_tasks_v2` (legacy `eisenhower_tasks_v1`; corrupt copy `eisenhower_tasks_corrupt_backup`) |
| preferences (theme, style, urgency settings) | `localStorage` `eisenhower_prefs_v1` |
| file handles | IndexedDB `eisenhower_matrix` / `handles` (`tasksFile`, `eventsFile`) |
| event log | `events.jsonl` (separate file, Chrome/Edge); browser keeps the last 3000 in `eisenhower_events_v1` |

- External changes: file mtime checked every 15 s, on focus and before each write. No local edits: reload. Both changed: conflict banner with **Take from file**, **Merge** (newer `updatedAt` wins; deletions not carried over), **Keep mine and overwrite the file**.
- Switching data files: always **Take from file**. Merge mixes two files; Keep mine overwrites the new file with the previous one's tasks.

## Settings

| Setting | Default | Range |
|---|---|---|
| Urgency threshold | 50% | 10-90 |
| Urgency window | 7 days | 1-30 |
| Working days only | off | Mon-Fri, no holidays |
| "Do it now" limit | 5 | 0 = none |
| Working hours per day (timeline load) | 8 | |
| Time zone | `Europe/London` | stored in the data file |

## Features

Search (title, notes, tags, `#num`), tag filter, Today, Show as of; compact list; quadrant expand; weekly review; timeline with load row; `.ics` export; browser reminders (open tab only); themes Auto/Light/Dark; undo (8 s toast, Ctrl/Cmd+Z) for move, done, restore, delete.

## Limits

- Merge does not propagate deletions; parallel adds can collide on `num` (re-issued on merge).
- No authentication: the profile name is a label.
- Monthly repeat drifts at month ends (31st -> 28th); holidays ignored.
- Reminders need an open tab and may not fire from `file://`.
- Touch and small screens untested.
