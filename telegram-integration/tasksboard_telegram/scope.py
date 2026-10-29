"""What the bot may offer one person: the answer of `rpc/telegram_scope` (db/017) as plain objects.

The database already did the intersection (lists and tag lists that the bot and the person share, owners in the
household, live only). This module only reads it and never widens it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class Member:
    id: str
    handle: str
    kind: str  # "human" or "agent"
    role: str


@dataclass(frozen=True)
class ScopeList:
    id: str
    slug: str
    name: str
    default_category: str | None
    role: str  # the person's role: owner, editor or contributor
    members: tuple[Member, ...] = ()

    @property
    def kind(self) -> str:
        """`reminder` for a list whose new items are reminders, else `task`."""
        return "reminder" if self.default_category == "reminder" else "task"

    def member(self, profile_id: str | None) -> Member | None:
        return next((m for m in self.members if m.id == profile_id), None)

    def member_by_handle(self, handle: str) -> Member | None:
        return next((m for m in self.members if m.handle == handle), None)


@dataclass(frozen=True)
class Tag:
    id: str
    name: str


@dataclass(frozen=True)
class TagList:
    id: str
    name: str
    owner: str
    tags: tuple[Tag, ...] = ()


@dataclass(frozen=True)
class Scope:
    person: str
    person_id: str
    lists: tuple[ScopeList, ...] = ()
    tag_lists: tuple[TagList, ...] = ()
    all_tags: tuple[tuple[int, Tag], ...] = field(default=(), compare=False)  # (tag list index, tag), in display order

    @classmethod
    def from_rpc(cls, data: dict[str, Any], person_id: str, include_test: bool = False) -> Scope:
        lists = tuple(
            ScopeList(
                id=str(x["id"]), slug=str(x["slug"]), name=str(x["name"]), default_category=x.get("default_category"),
                role=str(x.get("role") or ""),
                members=tuple(Member(str(m["id"]), str(m["handle"]), str(m.get("kind") or "human"), str(m.get("role") or ""))
                              for m in (x.get("members") or ())),
            )
            for x in data.get("lists") or ()
            if include_test or not str(x.get("slug", "")).startswith("_")
        )
        tag_lists = tuple(
            TagList(str(t["id"]), str(t["name"]), str(t.get("owner") or ""),
                    tuple(Tag(str(g["id"]), str(g["name"])) for g in (t.get("tags") or ())))
            for t in data.get("tag_lists") or ()
        )
        flat = tuple((i, g) for i, t in enumerate(tag_lists) for g in t.tags)
        return cls(str(data.get("person") or ""), person_id, lists, tag_lists, flat)

    def list_index(self, list_id: str | None) -> int | None:
        return next((i for i, x in enumerate(self.lists) if x.id == list_id), None)

    def list_by_slug(self, slug: str) -> int | None:
        return next((i for i, x in enumerate(self.lists) if x.slug == slug), None)

    def list_by_name(self, name: str) -> int | None:
        n = name.strip().casefold()
        return next((i for i, x in enumerate(self.lists) if x.name.casefold() == n or x.slug.casefold() == n), None)

    def tag_index(self, tag_id: str) -> int | None:
        return next((i for i, (_, g) in enumerate(self.all_tags) if g.id == tag_id), None)
