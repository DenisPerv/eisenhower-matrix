# Telegram integration: the task card

A Python package, `tasksboard_telegram`, that lets a chat bot create and change TasksDashboard items through one card
in the chat. The bot detects that a message asks for a task or a reminder; the package turns the message into a
prefilled card; the person taps buttons until it is right and presses Save. Standard library only, Python 3.11+.

```
New task
clean up the table
List: OtherTasks · Due: no date
? = suggested, tap to change

[Backlog] [• OtherTasks] [Reminders] [HomeOS tasks]
[Today] [Tomorrow] [Weekend] [+1 wk] [• None]
[🏷 Tags (0)] [+ Description]
[✅ Save] [✖ Cancel]
```

A tap edits the same message. **Tags** opens a view with every tag list the person shares with the bot and their
tags; **+ Description** asks for a reply to the card. Texts are in English, Ukrainian and Russian.

## How a message becomes a card

1. **Keywords** (`keywords.py`, words in `keywords.json`). A leading command ("add a task", "remind me", "напомни"),
   then markers that count only as a `#hashtag` or at the end of the message: a quadrant ("to plan", "срочно",
   `#delegate`), a list after to / into / в / у / до ("to Backlog", "в бэклог", any list name in the scope), a person
   after for / для ("for Nastia", "для мене", "for both", "for the agent") and "today" / "tomorrow". Markers are cut
   from the title. A quadrant phrase in "to …" after a word like need, want, how ("I need to do", "learn how to
   delegate") is a verb, not a marker. "I need to do the dishes", "give the keys to Nastia" and "fix the bug in HomeOS"
   set nothing; "clean up the table to plan" sets Plan.
2. **The LLM** (`extract.py`, `extract_prompt.txt`) for what is left: the due date and time, who it is for, the
   quadrant that fits the meaning (shown as "Auto: Plan?"), a list that clearly fits, extra details. Code accepts a
   value only when it fits: a list from the scope, A-D, a household handle, a real date.
3. **`draft.make_draft`** merges them: keywords as said, LLM values marked `?`, defaults for the rest (the
   `othertasks` list, Auto, the person). A reminder command goes to `reminders`.
4. **`card.new_card`** / **`card.change_card`** make the card; **`card.apply`** is one tap; **`render.render`** gives
   the HTML text and the keyboard; **`payload`** gives what Save writes.

Rules on the card:
- The list decides the kind: a list whose `default_category` is `reminder` makes a reminder, which needs a date (a date
  alone gets 09:00).
- No Quadrant and no For on the card since 2026-10-29, as in the app's task window. The quadrant is still written:
  the keyword or the LLM's quadrant when there is one, else none (the app then shows `deriveQuadrant`); a change card
  keeps the stored one. The owner is still written: "for Nastia", "for both" (no owner) or "for the agent" in the
  message, else the asker; after a list change, an owner who is not on the new list falls back to the asker (the
  database refuses an owner who is not a member). `owner_options` stays exported for bots that want their own row.
- Buttons `q…` and `o…` on cards sent before the change do nothing when tapped.
- The leading command's kind holds: "remind me" lands on a reminder list, "add a task" never on one.
- A change card opens on the stored values and Save sends only what changed, with the version shown.

## What the bot supplies (`ports.py`)

| Port | What it does |
|---|---|
| `ScopeSource.scope(person_id)` | `POST /rest/v1/rpc/telegram_scope` as the bot's own login |
| `ItemWriter` | `create`, `patch` (with `version=eq.<v>`), `tags` (`item_tags` add and remove) |
| `CardMessenger` | `send` the card (keep its message id), `edit` it in place after a tap |

The bot also owns:
- who may use it (its own allow list; map the sender's Telegram user id to a household profile);
- a store of open cards by token, for the asker only, with a time limit;
- the LLM call;
- a check for card, IBAN and ID numbers before any write;
- a time-zone converter (`to_utc`) for due dates.

Button data is `<prefix>:<token>:<op>` (`codec.py`), at most 64 bytes, with indexes into the card's scope, never ids.

## Public surface (stable since 1.0.0)

Bots depend on these names and shapes. Add to them freely (new keyword-only arguments with defaults, new ops, new
fields with defaults); renaming or removing one, or changing what it returns, needs a major version in `__init__.py`
and a note here.

| Module | Names |
|---|---|
| `scope` | `Scope.from_rpc(data, person_id, include_test=False)`, `Scope.list_index`, `list_by_slug`, `list_by_name`, `tag_index`, `all_tags`; `ScopeList` (`id`, `slug`, `name`, `default_category`, `role`, `members`, `kind`, `member`, `member_by_handle`), `Member`, `TagList`, `Tag` |
| `keywords` | `parse(text, scope, *, handles=None, words=None) -> Parsed` (`title`, `kind`, `quadrant`, `list_index`, `owner`, `day`, `matched`, `filled`) |
| `extract` | `build_prompt(*, text, action, scope, requester, now, calendar, handles, items=None, known=None)`, `parse_reply(reply, scope, *, handles, item_count=0) -> Hints | None`, `Hints` |
| `draft` | `make_draft(parsed, hints, scope, *, today, default_list_slug="othertasks", reminder_list_slug="reminders") -> Draft` |
| `card` | `Card`, `Draft`, `Origin`, `new_card(draft, scope, **kw)`, `change_card(origin, scope, *, owner_handle, **kw)`, `apply(card, op, scope, today)`, `owner_options`, `pick_due`, `Card.problem`, `Card.changed`, `Card.owner_id`, `Card.quadrant_to_write`; constants `QUADRANTS`, `DUE_PICKS`, `DEFAULT_TIME` |
| `render` | `render(card, scope, *, prefix, token, lang, today, label=..., problem=None) -> (html, rows)`, `keyboard_json(rows)`, `button_count(rows)` |
| `codec` | `new_token()`, `encode(prefix, token, op)`, `decode(prefix, data) -> (token, op) | None`; ops `l<i> L q<auto|A-D> o<i> d<0-4> t g<i> p<n> b e` handled by `card.apply`, `s` (Save), `x` (Cancel) and `n` (no-op header) handled by the bot |
| `payload` | `Provenance`, `create_body(card, scope, prov, to_utc)`, `change_patch(card, scope, to_utc)`, `tag_changes(card) -> (add, remove)`, `due_at(day, time, to_utc)` |
| `quadrant` | `derive_quadrant(*, stored, category, pin, deadline, now, window_days=7)` (no priority since 2026-10-29), `QN`, `QS` |
| `texts` | `t(key, lang, **kw)`, `weekday(n, lang)` |
| `ports` | `ScopeSource`, `ItemWriter`, `CardMessenger` |

## Database rights (`db/017_telegram_scope.sql`)

- The bot is an agent login (for example `telegram-bot`), linked to the people it serves in `ops.bot_links`.
- A linked person's new lists get the bot as an editor and new tag lists as a viewer (triggers); existing ones are
  granted once by the migration.
- `telegram_scope(p_person)` returns only what the bot and that person share: live lists, owners in the household, the
  person with a write role, the household members of each list, and the shared tag lists with their live tags. Guests'
  lists never come back. Only a bot linked to that person may call it.
- To keep a list out of the bot, remove the bot from that list's members. `db/019` remembers the removal
  (`ops.bot_opt_out`): a later insert with no person behind it, such as re-running 017, is undone, and only a person
  adding the bot back lets it in again. The household's Access requests list is opted out this way.

## Use it in another bot

1. Apply `db/017` (README "Set up"), link your bot login and its people in `ops.bot_links`.
2. Copy this folder into your bot, or add it as a path dependency. A copy should name the commit it came from (the
   HomeOS TelegramBasics bot keeps `vendor/tasksboard_telegram/VENDORED.md` with the sha and file hashes).
3. Implement the three ports with your HTTP and Telegram libraries; route your callback prefix to `codec.decode` →
   `card.apply` → `render.render` → edit.
4. Run the tests: `python -m unittest discover -s telegram-integration/tests -t telegram-integration/tests`.

## Keep it in step with the app

The card mirrors the app's task window. When that window changes, change this package in the same change
(TasksDashboard `CLAUDE.md`). The quadrant rule has three copies (the page's `deriveQuadrant`, the SQL
`review_quadrant` of `db/016`, `quadrant.py`); all three run the cases in `tests/quadrant_cases.json`:
`tests/test_extract_draft_quadrant.py`, `test/telegram-parity.test.js` (which also checks that `db/905` T13 holds the
same rows) and `db/905` itself.
