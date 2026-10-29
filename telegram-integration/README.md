# Telegram integration: the task card

A Python package, `tasksboard_telegram`, that lets a chat bot create and change TasksDashboard items through one card
in the chat. The bot detects that a message asks for a task or a reminder; the package turns the message into a
prefilled card; the person taps buttons until it is right and presses Save. Standard library only, Python 3.11+.

```
New task
clean up the table
List: OtherTasks · Quadrant: Auto: Plan? · For: Me · Due: no date
? = suggested, tap to change

[Backlog] [• OtherTasks] [Reminders] [HomeOS tasks]
[• Auto] [Do] [Plan] [Delegate] [Eliminate]
[• Me] [Nastia] [Both] [Agent]
[Today] [Tomorrow] [Weekend] [+1 wk] [• None]
[🏷 Tags (0)] [+ Description]
[✅ Save] [✖ Cancel]
```

A tap edits the same message. **Tags** opens a view with every tag list the person shares with the bot and their
tags; **+ Description** asks for a reply to the card. Texts are in English, Ukrainian and Russian.

## How a message becomes a card

1. **Keywords** (`keywords.py`, words in `keywords.json`). A leading command ("add a task", "remind me", "напомни"),
   then markers that count only as a `#hashtag` or at the end of the message: a quadrant ("to plan", "срочно",
   `#delegate`), a list ("to Backlog", "в бэклог", any list name in the scope), a person ("for Nastia", "для мене",
   "for both", "for the agent") and "today" / "tomorrow". Markers are cut from the title. "I need to do the dishes"
   sets nothing; "clean up the table to plan" sets Plan.
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
- **For** shows only people on the chosen list (the database refuses an owner who is not a member). **Both** writes no
  owner. **Agent** owns it as `homeos-agent` and moves the card to the agent list when the chosen one does not have the
  agent.
- Auto writes the LLM's quadrant when it gave one, else none (the app then shows `deriveQuadrant`).
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

## Database rights (`db/017_telegram_scope.sql`)

- The bot is an agent login (for example `telegram-bot`), linked to the people it serves in `ops.bot_links`.
- A linked person's new lists get the bot as an editor and new tag lists as a viewer (triggers); existing ones are
  granted once by the migration.
- `telegram_scope(p_person)` returns only what the bot and that person share: live lists, owners in the household, the
  person with a write role, the household members of each list, and the shared tag lists with their live tags. Guests'
  lists never come back. Only a bot linked to that person may call it.
- To keep a list out of the bot, remove the bot from that list's members (the household's Access requests list is out
  this way).

## Use it in another bot

1. Apply `db/017` (README "Set up"), link your bot login and its people in `ops.bot_links`.
2. Copy this folder into your bot, or add it as a path dependency. A copy should name the commit it came from (the
   HomeOS TelegramBasics bot keeps `vendor/tasksboard_telegram/VENDORED.md` with the sha and file hashes).
3. Implement the three ports with your HTTP and Telegram libraries; route your callback prefix to `codec.decode` →
   `card.apply` → `render.render` → edit.
4. Run the tests: `python -m unittest discover -s telegram-integration/tests -t telegram-integration/tests`.

## Keep it in step with the app

The card mirrors the app's task window. When that window changes, change this package in the same change
(TasksDashboard `CLAUDE.md`). `test/telegram-parity.test.js` checks `deriveQuadrant` and the quadrant names against
`tests/quadrant_cases.json`, which `tests/test_extract_draft_quadrant.py` reads too.
