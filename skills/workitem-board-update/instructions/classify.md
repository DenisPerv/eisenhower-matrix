# Classify: category, list, quadrant, confidence

Never ask. Every item leaves this step with a category, a list that is not archived, a quadrant and a confidence.

## Category (the first rule that fits wins)

1. An explicit category, or the `kind` hint when nothing contradicts it: `reminder` → reminder, `tbd-item` → tbd. A hint is overruled by the words: a "task" saying "remind" is a reminder.
2. Words:
   - "remind", "reminder", "don't forget on/at", a date plus a notify intent → **reminder**
3. Otherwise **task**.

The package copy: the app CLI creates tasks and reminders only. An open question, a decision to revisit, a wish or a plan becomes a task, and the reply says so.

## List

The package copy: the CLI has no list catalogue command. Use the list the person names (a slug, or `OWNER/slug`), else leave `--list` out so the CLI picks the category's default list; an archived list is refused by the CLI (exit 8).
1. An explicit list name or slug in the request wins (case-insensitive on `name` or `slug`). If that list is archived: report "list archived: <name>" for this item and write nothing (exit 8 rule); never move it elsewhere silently.

## Quadrant (always set)

- Explicit words win: "urgent and important" → A, "urgent" → C unless important, "important" (also "top priority", "most important") → B unless urgent, "low priority", "someday" → D. Priority words never become a number: the order inside the quadrant is the priority (`update --top`, [normalise.md](normalise.md)).
- The package copy: otherwise **urgent** = due within 7 days (the app's default urgency window; a person may set another in the app's settings). **Important** = category `reminder` (the app's `deriveQuadrant`), or words like "must" or "deadline" in the request.
- A = important and urgent, B = important, C = urgent, D = neither.

## Confidence and what happens

Rule hits (an explicit value, or a category rule from step 2 above) count as 0.95. A model pick reports its own confidence, capped at 0.9.

| Confidence | Action |
|---|---|
| ≥ 0.85 | write; report |
| 0.70 – 0.85 | write with `review_state = needs_review`; the report adds "check: …" |
| < 0.70, or no list fits (package copy) | write to the default list (no `--list`) with `--needs-review` and `--confidence <c>`; the report asks where it belongs |
| a reminder with no date at all (package copy) | `add-task` with `--needs-review` (a reminder needs `--due`); the report says the date is missing |

Vague text ("the thing with the papers next month") is below 0.70: there is no clear action or object.
