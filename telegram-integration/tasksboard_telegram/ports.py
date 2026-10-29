"""What a bot supplies. The module never opens a socket: the bot implements these three with its own HTTP client and
its own Telegram library (TelegramBasics: `TasksDbClient` and `Replier` / `CallbackContext`)."""

from __future__ import annotations

from typing import Any, Protocol


class ScopeSource(Protocol):
    async def scope(self, person_id: str, include_test: bool = False) -> dict[str, Any]:
        """`POST /rest/v1/rpc/telegram_scope {p_person, p_include_test}` as the bot's own login."""


class ItemWriter(Protocol):
    async def create(self, body: dict[str, Any]) -> dict[str, Any] | None:
        """`POST /rest/v1/items` (Prefer: return=representation); the row, or None when it failed."""

    async def patch(self, item_id: str, version: int, patch: dict[str, Any]) -> dict[str, Any] | None:
        """`PATCH /rest/v1/items?id=eq.<id>&version=eq.<v>&deleted_at=is.null`; None when 0 rows (changed since)."""

    async def tags(self, item_id: str, add: set[str], remove: set[str]) -> bool:
        """`POST /rest/v1/item_tags` for `add`; set `removed_at` on the rows of `remove`."""


class CardMessenger(Protocol):
    async def send(self, chat_id: int, html: str, keyboard: dict[str, Any]) -> int | None:
        """Send the card; its message id (kept with the card, so a reply to it can be recognised)."""

    async def edit(self, chat_id: int, message_id: int, html: str, keyboard: dict[str, Any] | None) -> None:
        """Edit the card in place after a tap (`editMessageText`)."""
