# Normalise one item

Turns one item into the flags of `add-task` or `add-reminder` (`node cli/tasks.mjs`). The CLI normalises again (title spaces, trailing dots) and the database screens every write; this file decides the content.

| Flag | Rule |
|---|---|
| `--title` | ≤ 80 characters, imperative or noun phrase, no trailing period, no dates or owners that live in their own flags ("Call the landlord about the boiler") |
| `--body` | the rest of the detail as short Markdown bullets; the person's own wording kept for facts (addresses, names, booking references); a last line `Source: <path or URL>` when a file or URL is the origin. Empty is fine |
| command | from [classify.md](classify.md): `add-reminder` for a reminder, `add-task` for everything else |
| `--list` | the list slug from [classify.md](classify.md); left out for the category's default list |
| `--due` | local wall time `YYYY-MM-DD HH:mm` in Europe/Lisbon, resolved from words: "Friday" = the coming Friday (today counts only if the time is still ahead), "tomorrow 15:00", "in two weeks", "by end of month" = the last day of this month, "on the 3rd" = the next 3rd. No time given: 09:00 for reminders, 18:00 for deadlines. The CLI stores it as UTC. No date words: no `--due` (and no reminder: see classify.md) |
| `--start` | only when the person names a start ("start on Monday"); a bare date is 09:00 |
| `--owner`, `--for` | the person at the keyboard, always (`--for` is who the agent acts for; `--owner` who the item belongs to). `--owner none` only when the person says it belongs to nobody |
| `--notify` | other people to tell as well, by handle (`a,b`); people of this board only |
| `--tags` | topic tags only, one or two (`boiler`, `gym`); never a person's name (the CLI turns names into the owner and drops them) |
| `--q` | the quadrant from [classify.md](classify.md); always set (`add-task` only; a reminder's quadrant is derived) |
| `--confidence`, `--needs-review` | the confidence from classify.md; `--needs-review` when classify.md says so |
| `--parent`, `--after` | when the person says the new task is a subtask of, or comes after, an existing one: its `<list>#<num>` from `find` |
| no priority | there is no priority field: a task's priority is its position in its quadrant. "top priority", "most important", "do this first": create it, then `update '<printed ref>' --top`. "top priority" and "most important" also count as "important" for the quadrant. "low priority" is only a hint for quadrant D |

The CLI computes the `dedup_key` itself (`task:<hash of title, due day and list>`, `reminder:<creation stamp>`): the same task twice on the same day and list is exit 4.

## Example (reminder)

"remind me Friday 15:00 to call the landlord about the boiler", typed on Monday 2026-10-26 by the person with the handle `alex`:

```
node cli/tasks.mjs add-reminder --title 'Call the landlord about the boiler' --due '2026-10-30 15:00' --owner alex --for alex --env <env file>
```
