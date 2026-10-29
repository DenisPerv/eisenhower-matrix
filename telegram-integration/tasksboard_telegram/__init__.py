"""The TasksDashboard task card for a chat bot (Telegram first).

Pure logic, standard library only: what the bot may offer (`scope`), what a message already says (`keywords`), the card
and its taps (`card`), the message and its buttons (`render`, `codec`), what gets written (`payload`), the LLM's part
(`extract`) and the app's quadrant rule (`quadrant`). The bot supplies the network and the chat through `ports`.
README.md in this folder says how to wire it to a bot.
"""

__version__ = "1.0.0"
