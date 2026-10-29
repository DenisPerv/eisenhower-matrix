"""The card as a Telegram message: HTML text and `inline_keyboard` rows of `{"text", "callback_data"}`.

Main view, one row per field: List, Due, then Tags and Description, then Save / Cancel. No Quadrant and no For: the app's
task window has neither since 2026-10-29 (the quadrant stays Auto or as stored, the owner as the card was opened). The lists view
shows every list; the tags view shows each tag list as a header with its tags, 24 per page. Selected buttons start
with "• ". At most 60 buttons per message (Telegram allows 100).
"""

from __future__ import annotations

from datetime import date
from html import escape
from typing import Any, Callable

from .card import DUE_PICKS, LISTS_ON_MAIN, TAGS_PER_PAGE, Card, pick_due
from .codec import encode
from .scope import Scope
from .texts import t, weekday

MAX_BUTTONS = 60
Button = dict[str, str]


def _rows(items: list[Button], width: int) -> list[list[Button]]:
    return [items[i:i + width] for i in range(0, len(items), width)]


def _due_text(card: Card, lang: str) -> str:
    if card.due_date is None:
        return t("no_date", lang)
    return f"{weekday(card.due_date.weekday(), lang)} {card.due_date.isoformat()} {card.due_time or ''}".strip()


def render(card: Card, scope: Scope, *, prefix: str, token: str, lang: str, today: date,
           label: Callable[[str], str] = lambda h: h.capitalize(), problem: str | None = None) -> tuple[str, list[list[Button]]]:
    """(HTML text, keyboard). `label` (a handle to a name) is kept for callers; the card names no people since For went.
    `problem`: a text key shown under the card (from `Card.problem` after a refused Save)."""
    b = lambda text, op: {"text": text, "callback_data": encode(prefix, token, op)}  # noqa: E731
    sel = lambda on, text: ("• " + text) if on else text  # noqa: E731
    q = lambda f: "?" if f in card.guessed else ""  # noqa: E731
    lst = card.lst(scope)

    head = t("change", lang, ref=card.origin.ref) if card.origin else t("new_reminder" if lst.kind == "reminder" else "new_task", lang)
    lines = [f"<b>{escape(head)}</b>", f"<b>{escape(card.title)}</b>",
             f"{t('list', lang)}: {escape(lst.name)}{q('list')} · {t('due', lang)}: {escape(_due_text(card, lang))}{q('due')}"]
    if card.tag_ids:
        names = [g.name for _, g in scope.all_tags if g.id in card.tag_ids]
        lines.append(f"{t('tags', lang)}: {escape(', '.join(names))}")
    if card.details:
        d = card.details if len(card.details) <= 300 else card.details[:297] + "…"
        lines.append(f"{t('description', lang)}: {escape(d)}")
    if card.guessed & {"list", "due"}:  # a guessed quadrant or owner is not shown, so it needs no note
        lines.append(f"<i>{escape(t('guess', lang))}</i>")
    if card.awaiting_description:
        lines.append(f"<i>{escape(t('desc_prompt', lang))}</i>")
    if problem:
        lines.append(f"⚠ {escape(t(problem, lang))}")

    if card.view == "lists":
        lines.append(t("pick_list", lang))
        btns = [b(sel(i == card.list_index, x.name), f"l{i}") for i, x in enumerate(scope.lists)][:MAX_BUTTONS - 1]
        return "\n".join(lines), _rows(btns, 3) + [[b(t("back", lang), "b")]]

    if card.view == "tags":
        rows: list[list[Button]] = []
        flat = list(enumerate(scope.all_tags))
        page = flat[card.page * TAGS_PER_PAGE:(card.page + 1) * TAGS_PER_PAGE]
        if not flat:
            lines.append(t("no_tags", lang))
        else:
            lines.append(t("pick_tags", lang))
        group: list[Button] = []
        current = None
        for idx, (tl, g) in page:
            if tl != current:
                rows += _rows(group, 3)
                group = []
                rows.append([b(f"— {scope.tag_lists[tl].name} —", "n")])
                current = tl
            group.append(b(sel(g.id in card.tag_ids, g.name), f"g{idx}"))
        rows += _rows(group, 3)
        nav = []
        if card.page > 0:
            nav.append(b(t("prev", lang), f"p{card.page - 1}"))
        if (card.page + 1) * TAGS_PER_PAGE < len(flat):
            nav.append(b(t("next", lang), f"p{card.page + 1}"))
        nav.append(b(t("back", lang), "b"))
        return "\n".join(lines), rows + [nav]

    # main view
    lists = [b(sel(i == card.list_index, x.name), f"l{i}") for i, x in enumerate(scope.lists)]
    if len(lists) > LISTS_ON_MAIN:
        keep = lists[:LISTS_ON_MAIN - 1]
        if card.list_index >= LISTS_ON_MAIN - 1:
            keep[-1] = lists[card.list_index]
        lists = keep + [b(t("more", lang), "L")]
    # one pick at most is marked: the first whose date is the card's (on a Friday Tomorrow and Weekend are one day)
    on_pick = next((p for p in DUE_PICKS if (card.due_date is None if p == "none" else pick_due(p, today) == card.due_date)), None)
    dues = [b(sel(pick == on_pick, t("d_" + pick, lang)), f"d{i}") for i, pick in enumerate(DUE_PICKS)]
    extra = [b(t("tags_btn", lang, n=len(card.tag_ids)), "t"), b(t("desc_edit" if card.details else "desc_btn", lang), "e")]
    rows = _rows(lists, 4) + [dues, extra, [b(t("save", lang), "s"), b(t("cancel", lang), "x")]]
    return "\n".join(lines), rows


def keyboard_json(rows: list[list[Button]]) -> dict[str, Any]:
    return {"inline_keyboard": rows}


def button_count(rows: list[list[Button]]) -> int:
    return sum(len(r) for r in rows)
