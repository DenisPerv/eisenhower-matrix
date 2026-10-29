"""Read what a message already says before any LLM: the kind (a leading command), the quadrant, the list, who it is for
and a simple day. Markers come from `keywords.json` and count only as a #hashtag or at the end of the message, so
"I need to do the dishes" sets nothing while "clean up the table to plan" sets Plan. Matched markers are cut from the
title; what is left is the title.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .scope import Scope

_WORDS = json.loads((Path(__file__).with_name("keywords.json")).read_text(encoding="utf-8"))
_TRAIL = " \t.,;:!?-—–"


@dataclass
class Parsed:
    title: str
    kind: str | None = None          # "task" or "reminder" from a leading command
    quadrant: str | None = None      # "A".."D"
    list_index: int | None = None    # into scope.lists
    owner: str | None = None         # "me", "shared", "agent" or a handle
    day: str | None = None           # "today" or "tomorrow"
    matched: list[tuple[str, str]] = field(default_factory=list)  # (field, the words as written)

    @property
    def filled(self) -> set[str]:
        return {f for f, _ in self.matched}


def _fold(s: str) -> str:
    """Case-folded, one character per character, so an index into the folded text is an index into `s` (str.casefold
    turns "ß" into "ss" and "İ" into two characters)."""
    out = []
    for c in s:
        f = c.casefold()
        out.append(f if len(f) == 1 else (c.lower() if len(c.lower()) == 1 else c))
    return "".join(out)


def _infinitive(low: str, phrase: str, words: dict[str, Any]) -> bool:
    """"I need to do", "learn how to delegate": a quadrant phrase in "to <phrase>" right after one of these words is a
    verb, not a marker."""
    before = low[: len(low) - len(phrase)].split()
    if not phrase.startswith("to "):  # "delegate" after "how to": the same verb, without its "to"
        if not before or before[-1] != "to":
            return False
        before = before[:-1]
    return bool(before) and before[-1] in words["infinitive_before"]


def _ends_with(low: str, phrase: str) -> bool:
    if not low.endswith(phrase):
        return False
    i = len(low) - len(phrase)
    return i == 0 or not low[i - 1].isalnum()


def _starts_with(low: str, phrase: str) -> bool:
    if not low.startswith(phrase):
        return False
    return len(low) == len(phrase) or not low[len(phrase)].isalnum()


def _list_names(scope: Scope, words: dict[str, Any]) -> list[tuple[str, int]]:
    """(name as typed, list index) for every way to name a list in scope, longest first."""
    out: list[tuple[str, int]] = []
    for i, lst in enumerate(scope.lists):
        out += [(_fold(lst.name), i), (_fold(lst.slug), i)]
        out += [(a, i) for a in words["list_aliases"].get(lst.slug, ())]
    return sorted(set(out), key=lambda x: -len(x[0]))


def _people(words: dict[str, Any], handles: set[str]) -> list[tuple[str, str]]:
    out = [(p, who) for who in ("me", "shared", "agent") for p in words["people"][who]]
    for handle, aliases in words["people_aliases"].items():
        if handle in handles:
            out += [(f"{pre} {a}", handle) for a in aliases for pre in words["people_prefixes"]]
    return sorted(out, key=lambda x: -len(x[0]))


def parse(text: str, scope: Scope, *, handles: set[str] | None = None, words: dict[str, Any] | None = None) -> Parsed:
    """`handles`: the household people the message may name (default: the members of the scope's lists)."""
    w = words or _WORDS
    if handles is None:
        handles = {m.handle for lst in scope.lists for m in lst.members if m.kind == "human"}
    s = " ".join(text.split())
    out = Parsed(title=s)

    # a leading command: "add a task …", "remind me to …"
    low = _fold(s)
    commands = sorted(((p, k) for k, ps in w["commands"].items() for p in ps), key=lambda x: -len(x[0]))
    for phrase, kind in commands:
        if _starts_with(low, phrase):
            out.kind = kind
            s = s[len(phrase):].lstrip(" :,-—–")
            if _fold(s).startswith("to "):
                s = s[3:]
            break

    lists = _list_names(scope, w)
    people = _people(w, handles)

    # hashtags anywhere: #plan, #backlog, #nastia
    def tag(m: re.Match[str]) -> str:
        word = _fold(m.group(1))
        for q, tags in w["quadrant_hashtags"].items():
            if word in tags and out.quadrant is None:
                out.quadrant = q
                out.matched.append(("quadrant", m.group(0)))
                return ""
        for name, i in lists:
            if word == name.replace(" ", "") and out.list_index is None:
                out.list_index = i
                out.matched.append(("list", m.group(0)))
                return ""
        for handle, aliases in w["people_aliases"].items():
            if handle in handles and word in aliases and out.owner is None:
                out.owner = handle
                out.matched.append(("owner", m.group(0)))
                return ""
        return m.group(0)
    s = re.sub(r"(?<!\w)#([\w-]+)", tag, s)

    # markers at the end, one after another
    quadrants = sorted(((p, q) for q, ps in w["quadrant"].items() for p in ps), key=lambda x: -len(x[0]))
    preps = w["list_prepositions"]
    days = sorted(((f"{pre} {d}" if pre else d, k) for k, ds in w["dates"].items() for d in ds
                   for pre in [""] + w["date_prefixes"]), key=lambda x: -len(x[0]))
    while True:
        s = s.rstrip(_TRAIL)
        low = _fold(s)
        hit = None
        if out.quadrant is None:
            hit = next((("quadrant", q, len(p)) for p, q in quadrants if _ends_with(low, p) and not _infinitive(low, p, w)), None)
        if hit is None and out.list_index is None:
            hit = next((("list", i, len(f"{pre} {n}")) for n, i in lists for pre in preps if _ends_with(low, f"{pre} {n}")), None)
        if hit is None and out.owner is None:
            hit = next((("owner", who, len(p)) for p, who in people if _ends_with(low, p)), None)
        if hit is None and out.day is None:
            hit = next((("day", k, len(p)) for p, k in days if _ends_with(low, p)), None)
        if hit is None:
            break
        fieldname, value, n = hit
        if n >= len(s.strip()):
            break  # never eat the whole title
        out.matched.append((fieldname, s[-n:]))
        setattr(out, {"quadrant": "quadrant", "list": "list_index", "owner": "owner", "day": "day"}[fieldname], value)
        s = s[:-n]

    out.title = " ".join(s.split()).strip(_TRAIL) or " ".join(text.split())
    return out
