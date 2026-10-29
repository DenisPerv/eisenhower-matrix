"""A scope like the household's: Maksym and Nastia share Backlog, OtherTasks, Reminders, HomeOS tasks; Maksym alone has
Private; two tag lists."""

from __future__ import annotations

import sys
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tasksboard_telegram.scope import Scope  # noqa: E402

MK, AN, AG, TG = "p-mk", "p-an", "p-ag", "p-tg"
TODAY = date(2026, 10, 29)  # a Thursday


def members(*who: str) -> list[dict]:
    names = {MK: ("maksym", "human"), AN: ("anastasiia", "human"), AG: ("homeos-agent", "agent"), TG: ("telegram-bot", "agent")}
    return [{"id": w, "handle": names[w][0], "kind": names[w][1], "role": "owner" if w == MK else "editor"} for w in who]


def rpc(person: str = "maksym") -> dict:
    lists = [
        {"id": "L-bl", "slug": "backlog", "name": "Backlog", "default_category": "task", "role": "owner", "members": members(MK, AN, AG, TG)},
        {"id": "L-ot", "slug": "othertasks", "name": "OtherTasks", "default_category": "task", "role": "owner", "members": members(MK, AN, AG, TG)},
        {"id": "L-rm", "slug": "reminders", "name": "Reminders", "default_category": "reminder", "role": "owner", "members": members(MK, AN, AG, TG)},
        {"id": "L-ht", "slug": "homeos-tasks", "name": "HomeOS tasks", "default_category": "task", "role": "owner", "members": members(MK, AN, AG, TG)},
        {"id": "L-pv", "slug": "private", "name": "Private", "default_category": "task", "role": "owner", "members": members(MK, TG)},
        {"id": "L-st", "slug": "_selftest", "name": "_selftest", "default_category": "task", "role": "owner", "members": members(MK, TG)},
    ]
    if person == "anastasiia":
        lists = [x for x in lists if x["slug"] != "private"]
    return {"person": person, "lists": lists, "tag_lists": [
        {"id": "TL1", "name": "My tags", "owner": "maksym", "tags": [{"id": "g-home", "name": "home"}, {"id": "g-car", "name": "car"}]},
        {"id": "TL2", "name": "Assignee", "owner": "maksym", "tags": [{"id": "g-max", "name": "Max"}]},
    ]}


def scope(person: str = "maksym", **kw) -> Scope:
    return Scope.from_rpc(rpc(person), MK if person == "maksym" else AN, **kw)


def utc_plus0(wall: datetime) -> datetime:
    """A fixed zone for tests: wall time = UTC."""
    return wall.replace(tzinfo=UTC)


def now() -> datetime:
    return datetime(2026, 10, 29, 10, 0, tzinfo=UTC)


__all__ = ["MK", "AN", "AG", "TG", "TODAY", "rpc", "scope", "utc_plus0", "now", "timedelta"]
