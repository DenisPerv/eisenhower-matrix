"""What Save writes: a create body for `POST /rest/v1/items`, or a patch for a stored item, plus the tag changes for
`item_tags`. Due dates are wall time in the person's zone; the bot passes `to_utc` (no tz database needed here)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from typing import Any, Callable

from .card import DEFAULT_TIME, Card
from .scope import Scope

ToUtc = Callable[[datetime], datetime]  # naive wall time -> aware UTC instant


@dataclass(frozen=True)
class Provenance:
    """Who and where, as the bot knows it. `key` is unique per message, e.g. telegram:<chat>:<message id>."""
    key: str
    created_via: str = "telegram"
    source_app: str = "telegrambasics"
    ai: dict[str, Any] | None = None
    ai_confidence: float | None = None


def due_at(day: date | None, time: str | None, to_utc: ToUtc) -> str | None:
    if day is None:
        return None
    hh, mm = (time or DEFAULT_TIME).split(":")
    return to_utc(datetime(day.year, day.month, day.day, int(hh), int(mm))).isoformat()


def create_body(card: Card, scope: Scope, prov: Provenance, to_utc: ToUtc) -> dict[str, Any]:
    lst = card.lst(scope)
    body: dict[str, Any] = {
        "list_id": lst.id, "category": lst.kind, "title": card.title.strip(), "body_md": card.details,
        "due_at": due_at(card.due_date, card.due_time, to_utc), "owner_id": card.owner_id(scope),
        "created_via": prov.created_via, "on_behalf_of": scope.person_id, "source_app": prov.source_app,
        "source_ref": prov.key, "dedup_key": prov.key, "run_id": prov.key,
    }
    q = card.quadrant_to_write()
    if q:
        body["quadrant"] = q
    if lst.kind == "reminder":
        body["details"] = {"scheduler": "none"}
    if prov.ai is not None:
        body["ai"] = prov.ai
    if prov.ai_confidence is not None:
        body["ai_confidence"] = prov.ai_confidence
    return body


def change_patch(card: Card, scope: Scope, to_utc: ToUtc) -> dict[str, Any]:
    """Only the fields that differ from the stored item. A list change also sends the category of the new list."""
    if card.origin is None:
        raise ValueError("not a change card")
    ch = card.changed(scope)
    patch: dict[str, Any] = {}
    lst = card.lst(scope)
    if "list" in ch:
        patch["list_id"] = lst.id
        patch["category"] = lst.kind
    if "quadrant" in ch:
        patch["quadrant"] = card.quadrant_to_write()  # None: back to Auto, the app's deriveQuadrant
    if "owner" in ch:
        patch["owner_id"] = card.owner_id(scope)
    if "due" in ch:
        patch["due_at"] = due_at(card.due_date, card.due_time, to_utc)
    if "title" in ch:
        patch["title"] = card.title.strip()
    if "details" in ch:
        patch["body_md"] = card.details
    return patch


def tag_changes(card: Card) -> tuple[set[str], set[str]]:
    """(tag ids to add, tag ids to remove) against the stored item (nothing stored for a new card)."""
    before = card.origin.tag_ids if card.origin else frozenset()
    return set(card.tag_ids - before), set(before - card.tag_ids)
