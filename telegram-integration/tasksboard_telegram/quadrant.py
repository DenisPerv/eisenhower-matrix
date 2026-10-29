"""The app's quadrant rule, for display only (TasksDashboard.html `deriveQuadrant` and `QN`).

`test/telegram-parity.test.js` and `tests/test_quadrant.py` read the same cases (`tests/quadrant_cases.json`), so the two
copies cannot drift apart unnoticed.
"""

from __future__ import annotations

from datetime import datetime

QS = ("A", "B", "C", "D")
QN = {"A": "Do", "B": "Plan", "C": "Delegate", "D": "Eliminate"}
IMPORTANT_CATEGORIES = ("reminder", "tbd", "decision")
DAY_S = 86400


def derive_quadrant(*, stored: str | None, priority: int | None, category: str | None, pin: bool | None,
                    deadline: datetime | None, now: datetime, window_days: int = 7) -> str:
    """The stored quadrant, else important (priority >= 3 or an important category) x urgent (the pin when set, else a
    deadline within the urgency window, overdue included)."""
    if stored in QS:
        return stored
    important = (isinstance(priority, int) and priority >= 3) or category in IMPORTANT_CATEGORIES
    if pin is not None:
        urgent = bool(pin)
    else:
        urgent = deadline is not None and (deadline - now).total_seconds() <= window_days * DAY_S
    return ("A" if urgent else "B") if important else ("C" if urgent else "D")
