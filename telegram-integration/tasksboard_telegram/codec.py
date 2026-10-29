"""Button data: `<prefix>:<token>:<op>`. Telegram allows 64 bytes of callback data, so a button carries an index into the
card's frozen scope, never an id or a name. The token names one card (the bot keeps the card under it)."""

from __future__ import annotations

import re
import secrets

MAX_BYTES = 64
_OP = re.compile(r"^(?:[lqodgp][A-Za-z0-9]{1,4}|[LtbesxnN])$")
_TOKEN = re.compile(r"^[0-9a-f]{8}$")


def new_token() -> str:
    return secrets.token_hex(4)


def encode(prefix: str, token: str, op: str) -> str:
    data = f"{prefix}:{token}:{op}"
    if not _TOKEN.match(token) or not _OP.match(op) or len(data.encode()) > MAX_BYTES:
        raise ValueError(f"bad button data {data!r}")
    return data


def decode(prefix: str, data: str) -> tuple[str, str] | None:
    """(token, op), or None for data that is not one of ours or is malformed."""
    parts = data.split(":")
    if len(parts) != 3 or parts[0] != prefix or not _TOKEN.match(parts[1]) or not _OP.match(parts[2]):
        return None
    return parts[1], parts[2]
