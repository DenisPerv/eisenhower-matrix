"""Keywords first, the LLM for the rest: one Draft for a new card. What the keywords found is taken as said; what the
LLM suggests is marked as guessed on the card; what neither says gets the defaults (the default list, Auto, me)."""

from __future__ import annotations

from datetime import date, timedelta

from .card import Draft
from .extract import Hints
from .keywords import Parsed
from .scope import Scope


def make_draft(parsed: Parsed, hints: Hints | None, scope: Scope, *, today: date, default_list_slug: str = "othertasks",
               reminder_list_slug: str = "reminders") -> Draft:
    if not scope.lists:
        raise ValueError("this person shares no list with the bot")
    h = hints or Hints()
    guessed: set[str] = set()

    reminders = scope.list_by_slug(reminder_list_slug)
    if parsed.list_index is not None:
        li = parsed.list_index
    elif parsed.kind == "reminder" and reminders is not None:
        li = reminders
    elif h.list_index is not None:
        li = h.list_index
        guessed.add("list")
    else:
        default = scope.list_by_slug(default_list_slug)
        li = default if default is not None else 0

    quadrant, auto_pick = (parsed.quadrant, None) if parsed.quadrant else ("auto", h.quadrant)

    owner = parsed.owner or h.owner or "me"
    if parsed.owner is None and h.owner is not None:
        guessed.add("owner")

    if parsed.day == "today":
        due = today
    elif parsed.day == "tomorrow":
        due = today + timedelta(days=1)
    else:
        due = h.due_date
        if due is not None:
            guessed.add("due")
    if due is not None and due < today:
        due = None

    title = parsed.title
    if h.title and not parsed.filled & {"quadrant", "list"} and len(h.title) >= 2:
        title = h.title  # the LLM cleans command words; once keywords cut markers, their title stands
    return Draft(title=title, list_index=li, quadrant=quadrant, auto_pick=auto_pick, owner=owner, due_date=due,
                 due_time=h.due_time, details=h.details or "", guessed=frozenset(guessed))
