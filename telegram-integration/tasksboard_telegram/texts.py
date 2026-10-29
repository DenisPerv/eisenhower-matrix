"""Card texts in English, Ukrainian and Russian. `lang` is "en", "uk" or "ru"; anything else is English."""

from __future__ import annotations

_T: dict[str, dict[str, str]] = {
    "new_task": {"en": "New task", "uk": "Нова задача", "ru": "Новая задача"},
    "new_reminder": {"en": "New reminder", "uk": "Нове нагадування", "ru": "Новое напоминание"},
    "change": {"en": "Change {ref}", "uk": "Зміна {ref}", "ru": "Изменение {ref}"},
    "list": {"en": "List", "uk": "Список", "ru": "Список"},
    "quadrant": {"en": "Quadrant", "uk": "Квадрант", "ru": "Квадрант"},
    "for": {"en": "For", "uk": "Для", "ru": "Для"},
    "due": {"en": "Due", "uk": "Строк", "ru": "Срок"},
    "tags": {"en": "Tags", "uk": "Теги", "ru": "Теги"},
    "description": {"en": "Description", "uk": "Опис", "ru": "Описание"},
    "no_date": {"en": "no date", "uk": "без дати", "ru": "без даты"},
    "auto": {"en": "Auto", "uk": "Авто", "ru": "Авто"},
    "auto_app": {"en": "Auto (the app decides)", "uk": "Авто (вирішує застосунок)", "ru": "Авто (решает приложение)"},
    "me": {"en": "Me", "uk": "Я", "ru": "Я"},
    "shared": {"en": "Both", "uk": "Обоє", "ru": "Оба"},
    "agent": {"en": "Agent", "uk": "Агент", "ru": "Агент"},
    "shared_long": {"en": "everyone on the list", "uk": "усі в списку", "ru": "все в списке"},
    "d_today": {"en": "Today", "uk": "Сьогодні", "ru": "Сегодня"},
    "d_tomorrow": {"en": "Tomorrow", "uk": "Завтра", "ru": "Завтра"},
    "d_weekend": {"en": "Weekend", "uk": "Вихідні", "ru": "Выходные"},
    "d_week": {"en": "+1 wk", "uk": "+1 тиж", "ru": "+1 нед"},
    "d_none": {"en": "None", "uk": "Без", "ru": "Без"},
    "tags_btn": {"en": "🏷 Tags ({n})", "uk": "🏷 Теги ({n})", "ru": "🏷 Теги ({n})"},
    "desc_btn": {"en": "+ Description", "uk": "+ Опис", "ru": "+ Описание"},
    "desc_edit": {"en": "✎ Description", "uk": "✎ Опис", "ru": "✎ Описание"},
    "save": {"en": "✅ Save", "uk": "✅ Зберегти", "ru": "✅ Сохранить"},
    "cancel": {"en": "✖ Cancel", "uk": "✖ Скасувати", "ru": "✖ Отмена"},
    "more": {"en": "More…", "uk": "Ще…", "ru": "Ещё…"},
    "back": {"en": "← Back", "uk": "← Назад", "ru": "← Назад"},
    "prev": {"en": "‹", "uk": "‹", "ru": "‹"},
    "next": {"en": "›", "uk": "›", "ru": "›"},
    "pick_list": {"en": "Pick a list:", "uk": "Оберіть список:", "ru": "Выберите список:"},
    "pick_tags": {"en": "Tap tags to add or remove them:", "uk": "Натисніть теги, щоб додати чи прибрати:",
                  "ru": "Нажмите теги, чтобы добавить или убрать:"},
    "no_tags": {"en": "No tags you share with the bot.", "uk": "Немає тегів, спільних із ботом.", "ru": "Нет тегов, общих с ботом."},
    "guess": {"en": "? = suggested, tap to change", "uk": "? = пропозиція, натисніть, щоб змінити",
              "ru": "? = предложено, нажмите, чтобы изменить"},
    "desc_prompt": {"en": "Reply to the card with the description.", "uk": "Дайте відповідь (Reply) на картку з описом.",
                    "ru": "Ответьте (Reply) на карточку описанием."},
    "needs_title": {"en": "The title is empty.", "uk": "Назва порожня.", "ru": "Название пустое."},
    "needs_date": {"en": "A reminder needs a date: pick one.", "uk": "Нагадуванню потрібна дата: оберіть її.",
                   "ru": "Напоминанию нужна дата: выберите её."},
    "nothing_changed": {"en": "Nothing changed yet.", "uk": "Поки нічого не змінено.", "ru": "Пока ничего не изменено."},
}


def t(key: str, lang: str, **kw: object) -> str:
    row = _T[key]
    return row.get(lang, row["en"]).format(**kw)
