-- TasksDashboardDB 008: telegram-bot becomes an editor on Reminders and OtherTasks (004_seed made it a contributor).
-- Why: the household Telegram bot is HomeOS's chat interface for every stored reminder and task, so it may change any
-- open item on those two lists, not only the ones it made. The bot asks the person a second time before it changes an
-- item someone else created (TelegramBasics docs/specs/tasksdb-items.md). Unchanged: agents never delete or restore
-- items (trigger in 002/006), the bot has no role on Backlog, archived lists stay frozen.
-- Apply as postgres (Management API or SQL editor), then 003_rls.sql and 900_selftest.sql. Re-runnable.
-- Undo: the same update with role = 'contributor'.

update public.list_members m
set role = 'editor'
from public.profiles p, public.lists l
where m.profile_id = p.id
  and m.list_id = l.id
  and p.handle = 'telegram-bot'
  and l.slug in ('reminders', 'othertasks')
  and m.role <> 'editor';
