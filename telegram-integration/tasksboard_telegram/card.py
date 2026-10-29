"""The card: what will be written, and what each tap does to it. Pure: no network, no clock (dates come in).

Fields match the app's task window (title, list, quadrant, end, description, tags) plus For. A card is either a new
item (`mode="add"`) or a change to a stored one (`mode="change"`, with `origin` holding the stored values).
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import date, timedelta

from .scope import Scope, ScopeList

QUADRANTS = ("auto", "A", "B", "C", "D")
DUE_PICKS = ("today", "tomorrow", "weekend", "week", "none")
DEFAULT_TIME = "09:00"
LISTS_ON_MAIN = 8
TAGS_PER_PAGE = 24


@dataclass(frozen=True)
class Origin:
    """A stored item, for a change card."""
    item_id: str
    version: int
    ref: str                    # "T12", shown on the card
    list_id: str
    quadrant: str | None
    owner_id: str | None
    due_date: date | None
    due_time: str | None
    title: str
    details: str
    tag_ids: frozenset[str] = frozenset()


@dataclass(frozen=True)
class Card:
    mode: str                   # "add" or "change"
    title: str
    list_index: int
    quadrant: str = "auto"      # "auto" or "A".."D"
    auto_pick: str | None = None  # the LLM's quadrant while quadrant is "auto"; written on Save
    owner: str = "me"           # "me", "shared", "agent" or a member handle
    due_date: date | None = None
    due_time: str | None = None
    details: str = ""
    tag_ids: frozenset[str] = frozenset()
    guessed: frozenset[str] = frozenset()  # fields the LLM filled, marked on the card
    view: str = "main"          # "main", "lists", "tags"
    page: int = 0               # tags view page
    awaiting_description: bool = False
    origin: Origin | None = None
    agent_handle: str = "homeos-agent"
    agent_list_slug: str | None = "homeos-tasks"

    def lst(self, scope: Scope) -> ScopeList:
        return scope.lists[self.list_index]

    def kind(self, scope: Scope) -> str:
        return self.lst(scope).kind

    def quadrant_to_write(self) -> str | None:
        return self.quadrant if self.quadrant in ("A", "B", "C", "D") else self.auto_pick

    def owner_id(self, scope: Scope) -> str | None:
        """The profile id to write as owner_id; None = shared (everyone on the list is told)."""
        lst = self.lst(scope)
        if self.owner == "shared":
            return None
        if self.owner == "me":
            return scope.person_id
        handle = self.agent_handle if self.owner == "agent" else self.owner
        m = lst.member_by_handle(handle)
        return m.id if m else scope.person_id

    def problem(self, scope: Scope) -> str | None:
        """Why Save is not possible yet, as a text key; None when it is."""
        if not self.title.strip():
            return "needs_title"
        if self.kind(scope) == "reminder" and self.due_date is None:
            return "needs_date"
        if self.mode == "change" and not self.changed(scope):
            return "nothing_changed"
        return None

    def changed(self, scope: Scope) -> set[str]:
        """For a change card: the fields that differ from the stored item."""
        o = self.origin
        if o is None:
            return set()
        got = {
            "list": self.lst(scope).id != o.list_id,
            "quadrant": self.quadrant != "auto" and self.quadrant != o.quadrant,
            "owner": self.owner_id(scope) != o.owner_id,
            "due": (self.due_date, self.due_time or (DEFAULT_TIME if self.due_date else None)) != (o.due_date, o.due_time),
            "title": self.title != o.title,
            "details": self.details != o.details,
            "tags": self.tag_ids != o.tag_ids,
        }
        return {k for k, v in got.items() if v}


def owner_options(card: Card, scope: Scope) -> list[str]:
    """The For row: me, the other household people on the chosen list, shared, and the agent when it can own here."""
    lst = card.lst(scope)
    others = [m.handle for m in lst.members if m.kind == "human" and m.id != scope.person_id]
    opts = ["me", *others, "shared"]
    agent_here = lst.member_by_handle(card.agent_handle) is not None
    agent_list = card.agent_list_slug is not None and scope.list_by_slug(card.agent_list_slug) is not None
    if agent_here or agent_list:
        opts.append("agent")
    return opts


def _fit_owner(card: Card, scope: Scope) -> Card:
    """After a list change: an owner who is not on the new list falls back to me."""
    if card.owner in ("me", "shared"):
        return card
    handle = card.agent_handle if card.owner == "agent" else card.owner
    return card if card.lst(scope).member_by_handle(handle) else replace(card, owner="me")


def pick_due(pick: str, today: date) -> date | None:
    if pick == "today":
        return today
    if pick == "tomorrow":
        return today + timedelta(days=1)
    if pick == "weekend":
        return today + timedelta(days=((5 - today.weekday()) % 7) or 7)  # the next Saturday after today
    if pick == "week":
        return today + timedelta(days=7)
    return None


def apply(card: Card, op: str, scope: Scope, today: date) -> Card:
    """One tap. `op` is the decoded button: l<i> list, L lists view, q<x> quadrant, o<i> For option, d<i> due pick,
    t tags view, g<i> tag toggle, p<n> tags page, b back, e description. Unknown or out-of-range ops change nothing."""
    head, arg = op[:1], op[1:]
    num = int(arg) if arg.isdigit() else None
    clear = card.guessed
    if head == "l" and num is not None and num < len(scope.lists):
        return _fit_owner(replace(card, list_index=num, view="main", guessed=clear - {"list"}), scope)
    if head == "L":
        return replace(card, view="lists")
    if head == "q" and arg in QUADRANTS:
        return replace(card, quadrant=arg, guessed=clear - {"quadrant"})
    if head == "o" and num is not None:
        opts = owner_options(card, scope)
        if num >= len(opts):
            return card
        who = opts[num]
        nxt = replace(card, owner=who, guessed=clear - {"owner"})
        if who == "agent" and card.lst(scope).member_by_handle(card.agent_handle) is None and card.agent_list_slug:
            idx = scope.list_by_slug(card.agent_list_slug)
            if idx is not None:
                nxt = replace(nxt, list_index=idx)
        return nxt
    if head == "d" and num is not None and num < len(DUE_PICKS):
        day = pick_due(DUE_PICKS[num], today)
        return replace(card, due_date=day, due_time=(card.due_time or DEFAULT_TIME) if day else None,
                       guessed=clear - {"due"})
    if head == "t":
        return replace(card, view="tags", page=0)
    if head == "g" and num is not None and num < len(scope.all_tags):
        tid = scope.all_tags[num][1].id
        ids = card.tag_ids - {tid} if tid in card.tag_ids else card.tag_ids | {tid}
        return replace(card, tag_ids=frozenset(ids))
    if head == "p" and num is not None and num * TAGS_PER_PAGE < max(len(scope.all_tags), 1):
        return replace(card, page=num)
    if head == "b":
        return replace(card, view="main")
    if head == "e":
        return replace(card, awaiting_description=True)
    return card


@dataclass(frozen=True)
class Draft:
    """What the keywords and the LLM made of a message, before it becomes a card."""
    title: str
    list_index: int
    quadrant: str = "auto"
    auto_pick: str | None = None
    owner: str = "me"
    due_date: date | None = None
    due_time: str | None = None
    details: str = ""
    guessed: frozenset[str] = field(default_factory=frozenset)


def new_card(d: Draft, scope: Scope, **kw: object) -> Card:
    card = Card(mode="add", title=d.title, list_index=d.list_index, quadrant=d.quadrant, auto_pick=d.auto_pick,
                owner=d.owner, due_date=d.due_date, due_time=d.due_time or (DEFAULT_TIME if d.due_date else None),
                details=d.details, guessed=d.guessed, **kw)  # type: ignore[arg-type]
    return _fit_owner(card, scope)


def change_card(o: Origin, scope: Scope, *, owner_handle: str | None, **kw: object) -> Card:
    """A change card opens on the stored values. `owner_handle`: the stored owner's handle (None = shared)."""
    idx = scope.list_index(o.list_id)
    if idx is None:
        raise ValueError("the item's list is not in this person's scope")
    if owner_handle is None:
        owner = "shared"
    elif o.owner_id == scope.person_id:
        owner = "me"
    else:
        owner = owner_handle
    card = Card(mode="change", title=o.title, list_index=idx, quadrant=o.quadrant or "auto", owner=owner,
                due_date=o.due_date, due_time=o.due_time, details=o.details, tag_ids=o.tag_ids, origin=o, **kw)  # type: ignore[arg-type]
    if owner == kw.get("agent_handle", "homeos-agent"):
        card = replace(card, owner="agent")
    return card
