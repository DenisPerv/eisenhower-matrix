-- db/004_seed.sql: the 4 profiles, 7 categories, 3 lists and their members.
-- Source of truth since 2026-10-27; was HomeOS references/homeos/tasksdb/schema.md §4, now history.
-- Apply in file order as postgres (Supabase SQL editor or the Management API). Re-runnable. README "Database".
-- {{MAKSYM_EMAIL}} and the other {{…}} placeholders are the Phase 0 login emails: replace them by hand in the SQL editor
-- (or let an admin script fill them from an env file). The emails are never committed.

insert into public.profiles (id, handle, display_name, kind, email, mine_tags, reminder_channel)
select u.id, v.handle, v.name, v.kind, u.email, v.tags, v.channel
from (values ('{{MAKSYM_EMAIL}}',     'maksym',       'Maksym',       'human', '{maksym,shared}'::text[],     'telegram'),
             ('{{ANASTASIIA_EMAIL}}', 'anastasiia',   'Anastasiia',   'human', '{anastasiia,shared}'::text[], 'telegram'),
             ('{{AGENT_EMAIL}}',      'homeos-agent', 'HomeOS agent', 'agent', '{}'::text[],                  'local'),
             ('{{TELEGRAM_EMAIL}}',   'telegram-bot', 'Telegram bot', 'agent', '{}'::text[],                  'local'))
     as v(email, handle, name, kind, tags, channel)
join auth.users u on lower(u.email) = lower(v.email)
on conflict (id) do nothing;
do $$ begin
  if (select count(*) from public.profiles where handle in ('maksym','anastasiia','homeos-agent','telegram-bot')) <> 4 then
    raise exception 'seed: one of the 4 Phase 0 logins is missing in Authentication > Users';
  end if;
end $$;

insert into public.categories (slug, name, description, details_hint) values
  ('task',      'Task',      'something to do',                                   null),
  ('tbd',       'TBD',       'open question for one or both owners (was TBD.md)', 'section, explanation, options, proposed'),
  ('decision',  'Decision',  'a decision to revisit (decisions/log.md)',          'decided_on, revisit, log_anchor'),
  ('candidate', 'Candidate', 'memory candidate to promote or drop (/remember)',   'memory_file'),
  ('plan',      'Plan',      'short- or long-term plan (memory/plans/)',          'memory_record, review'),
  ('reminder',  'Reminder',  'time-bound reminder (was references/reminders/)',   'notify, scheduler, legacy_file'),
  ('wish',      'Wish',      'something wanted (memory/wishes/)',                 'budget_eur, where')
on conflict (slug) do nothing;

with m as (select id from public.profiles where handle = 'maksym')
insert into public.lists (slug, name, description, default_category, sort, owner_id, created_by)
select v.slug, v.name, v.descr, v.cat, v.sort, m.id, m.id from m,
  (values ('backlog',    'Backlog',    'the working matrix: decided and placed',          'task',     1),
          ('othertasks', 'OtherTasks', 'inbox: captured, not yet placed',                 'task',     2),
          ('reminders',  'Reminders',  'tied to a date',                                  'reminder', 3)) as v(slug, name, descr, cat, sort)
on conflict (slug) do nothing;

update public.categories c set default_list_id = l.id
from (values ('task','othertasks'), ('tbd','backlog'), ('decision','othertasks'), ('candidate','othertasks'),
             ('plan','othertasks'), ('reminder','reminders'), ('wish','othertasks')) as v(cat, list)
join public.lists l on l.slug = v.list
where c.slug = v.cat and c.default_list_id is null;

insert into public.list_members (list_id, profile_id, role)
select l.id, p.id, r.role
from public.lists l
join (values ('maksym','owner',null), ('anastasiia','owner',null), ('homeos-agent','editor',null),
             ('telegram-bot','contributor','othertasks'), ('telegram-bot','contributor','reminders'))
     as r(handle, role, only_list) on r.only_list is null or r.only_list = l.slug
join public.profiles p on p.handle = r.handle
where l.slug in ('backlog','othertasks','reminders')
on conflict (list_id, profile_id) do nothing;
