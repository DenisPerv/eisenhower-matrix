"""The LLM's part: one prompt for what the keywords did not settle, and a strict check of the reply. The model only
suggests; code accepts a value only when it fits (a list from the scope, a quadrant A-D, a household handle, a real
date). The message, the list names and the item titles are data in the prompt, never instructions."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

from .scope import Scope

PROMPT = (Path(__file__).with_name("extract_prompt.txt")).read_text(encoding="utf-8")
_HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


@dataclass
class Hints:
    title: str | None = None
    details: str | None = None
    due_date: date | None = None
    due_time: str | None = None
    owner: str | None = None        # "me", "shared", "agent" or a handle
    quadrant: str | None = None     # "A".."D"
    list_index: int | None = None
    target: int | None = None       # change: the number of the item meant
    candidates: list[int] = field(default_factory=list)


def build_prompt(*, text: str, action: str, scope: Scope, requester: str, now: str, calendar: str,
                 handles: list[str], items: list[tuple[int, str, str]] | None = None, known: dict[str, str] | None = None) -> str:
    """`items`: (number, title, list name) of open items a change may mean. `known`: fields the keywords already set,
    which the model must not change (shown so it does not repeat them in the title)."""
    lists = "\n".join(f"- {x.name}" for x in scope.lists) or "- (none)"
    its = "\n".join(f"{n}: {title} [{lst}]" for n, title, lst in (items or [])) or "(none)"
    kn = ", ".join(f"{k}={v}" for k, v in (known or {}).items()) or "(none)"
    return PROMPT.format(action=action, now=now, requester=requester, handles=", ".join(handles), calendar=calendar,
                         lists=lists, items=its, known=kn, text=json.dumps(text, ensure_ascii=False))


def _json(reply: str) -> dict | None:
    m = re.search(r"\{.*\}", reply, re.S)
    if not m:
        return None
    try:
        v = json.loads(m.group(0))
    except ValueError:
        return None
    return v if isinstance(v, dict) else None


def parse_reply(reply: str, scope: Scope, *, handles: set[str], item_count: int = 0) -> Hints | None:
    """None when the reply is not a JSON object (the bot may ask once more). Every field that does not fit is dropped."""
    v = _json(reply)
    if v is None:
        return None
    h = Hints()
    s = lambda k: v.get(k).strip() if isinstance(v.get(k), str) and v.get(k).strip() else None  # noqa: E731
    h.title = s("title")
    h.details = s("details")
    if (d := s("due_date")) and re.match(r"^\d{4}-\d{2}-\d{2}$", d):
        try:
            h.due_date = date.fromisoformat(d)
        except ValueError:
            pass
    if (tm := s("due_time")) and _HHMM.match(tm):
        h.due_time = tm
    if (o := s("owner")) and (o in ("me", "shared", "agent") or o in handles):
        h.owner = o
    if (q := s("quadrant")) and q.upper() in ("A", "B", "C", "D"):
        h.quadrant = q.upper()
    if (name := s("list")) is not None:
        h.list_index = scope.list_by_name(name)
    t = v.get("target")
    if type(t) is int and 1 <= t <= item_count:  # not isinstance: JSON true is a bool, and bool is an int
        h.target = t
    c = v.get("candidates")
    if isinstance(c, list):
        h.candidates = [x for x in c if type(x) is int and 1 <= x <= item_count][:5]
    return h
