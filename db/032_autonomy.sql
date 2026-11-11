-- db/032_autonomy.sql: Eisenhower harness Configurations, DB part (HomeOS plan references/homeos/harness-configurations-plan.md,
-- v3, tasks T6 and T7, 2026-11-11). How much freedom agents get per list and task, what a task's intake says, dollar budgets
-- with a spend ledger, precedents from a person's answers, and the list brief.
--
--   autonomy_mode     enum inherit | manual | project_rules | guided | ai_brain.
--   lists             autonomy (default guided, never inherit), autonomy_set_by/_at; intake defaults e2e_self, deploy_target,
--                     notify_telegram, stage_report (null = not set); brief_decisions, brief_naming, brief_instruction,
--                     brief_concept, brief_updated_by/_at. No API role may update these columns (003 grants list columns by name).
--   items             autonomy (default inherit), autonomy_set_by/_at; intake e2e_self, deploy_target, notify_telegram,
--                     stage_report. Guarded by the trigger items_zz_settings: a REST write (role authenticated or anon) that
--                     sets or changes any of them is refused 42501; only the RPCs below write them, and they do not bump
--                     items.version (a running session's claim keeps its compare-and-set; it re-reads the mode).
--   deploy_targets    allow-list of intake deploy targets, rows by admin SQL only; a key naming TasksDashboard is refused.
--   budgets           caps in USD per period (day | month), overall (list_id null) or per list. Written by set_budget only.
--   budget_ledger     insert-only: reserve | settle | release rows keyed by host and session. Written by budget_reserve,
--                     budget_settle and budget_release only; a reservation counts until settled, released or expired.
--   precedents        class E1 only, from one answer a household person gave on a card: record_precedent takes the audit
--                     event (item_events), checks that its actor is a household person and that the person ticked
--                     "use as precedent" in that edit (details.decision.use_as_precedent = true in the event's diff), and
--                     stores that person as decided_by. Never from body text. 90 days, scope list + path glob.
--   autonomy_events   audit of every change made by the RPCs below.
--
-- RPCs (security definer, empty search_path, auth.uid()):
--   set_autonomy(p_kind 'list'|'item', p_id, p_mode, p_expected)   people only (agents 42501). List: owner or editor of
--       the list; item: owner or editor of its list. ai_brain: household only; a guest sets only manual, guided (and inherit
--       on a task). A task in a Manual list is widened only by the list's owner who is household. p_expected must equal the
--       current mode (40001 otherwise, the phone's offline queue). A list mode is never inherit (22023).
--   set_intake(p_kind, p_id, p_e2e_self, p_deploy_target, p_notify_telegram, p_stage_report)   household people, owner or
--       editor; replaces all four (null clears).
--   set_budget(p_list, p_period, p_cap)   household people; a list's budget also needs owner or editor of it; p_cap null
--       removes the cap.
--   set_list_brief(p_list, p_decisions, p_naming, p_instruction, p_concept)   household people, owner or editor; replaces all four.
--   budget_reserve(p_host, p_session, p_list, p_item, p_amount, p_ttl_minutes) -> reservation id; 54000 when any cap that
--       applies (overall, the list) would be passed by spend + open reservations + p_amount. Household logins (people, homeos-agent).
--   budget_settle(p_reservation, p_actual), budget_release(p_reservation)   the login that reserved.
--   budget_status(p_list) -> caps with spent and reserved in the current period (Europe/Lisbon). Household.
--   record_precedent(p_event, p_list, p_path_glob, p_question, p_answer) -> id; revoke_precedent(p_id) household people.
--
-- Error codes: 42501 not allowed, 22023 bad value, 40001 stale expected mode, 54000 budget reached, 23505 precedent exists.
-- Additive and re-runnable. 003_rls.sql revokes every table grant from authenticated: re-run this file after 003 (like 031).
-- Rollback: 032_down_autonomy.sql. Selftest: 915_selftest_autonomy.sql.

-- ---------- type ----------

do $$ begin
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                  where t.typname = 'autonomy_mode' and n.nspname = 'public') then
    create type public.autonomy_mode as enum ('inherit', 'manual', 'project_rules', 'guided', 'ai_brain');
  end if;
end $$;

-- ---------- tables ----------

create table if not exists public.deploy_targets (
  key         text primary key check (key ~ '^[a-z0-9][a-z0-9-]{0,40}$'
                                      and key !~ '(tasksdashboard|tasks-dashboard|tasksboard|tasks-board|eisenhower-agentic-planner-app)'),
  label       text not null check (length(label) between 1 and 80),
  created_at  timestamptz not null default now()
);

alter table public.lists add column if not exists autonomy        public.autonomy_mode not null default 'guided';
alter table public.lists add column if not exists autonomy_set_by uuid references public.profiles(id);
alter table public.lists add column if not exists autonomy_set_at timestamptz;
alter table public.lists add column if not exists e2e_self        boolean;
alter table public.lists add column if not exists deploy_target   text references public.deploy_targets(key);
alter table public.lists add column if not exists notify_telegram boolean;
alter table public.lists add column if not exists stage_report    boolean;
alter table public.lists add column if not exists brief_decisions   text;
alter table public.lists add column if not exists brief_naming      text;
alter table public.lists add column if not exists brief_instruction text;
alter table public.lists add column if not exists brief_concept     text;
alter table public.lists add column if not exists brief_updated_by  uuid references public.profiles(id);
alter table public.lists add column if not exists brief_updated_at  timestamptz;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'lists_autonomy_not_inherit') then
    alter table public.lists add constraint lists_autonomy_not_inherit check (autonomy <> 'inherit');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'lists_brief_sizes') then
    alter table public.lists add constraint lists_brief_sizes check (
      coalesce(char_length(brief_decisions), 0) <= 8000 and coalesce(char_length(brief_naming), 0) <= 8000
      and coalesce(char_length(brief_instruction), 0) <= 8000 and coalesce(char_length(brief_concept), 0) <= 8000);
  end if;
end $$;

alter table public.items add column if not exists autonomy        public.autonomy_mode not null default 'inherit';
alter table public.items add column if not exists autonomy_set_by uuid references public.profiles(id);
alter table public.items add column if not exists autonomy_set_at timestamptz;
alter table public.items add column if not exists e2e_self        boolean;
alter table public.items add column if not exists deploy_target   text references public.deploy_targets(key);
alter table public.items add column if not exists notify_telegram boolean;
alter table public.items add column if not exists stage_report    boolean;

create table if not exists public.budgets (
  id          uuid primary key default gen_random_uuid(),
  list_id     uuid references public.lists(id) on delete cascade,
  period      text not null check (period in ('day', 'month')),
  cap_usd     numeric(10,2) not null check (cap_usd >= 0 and cap_usd <= 100000),
  set_by      uuid not null references public.profiles(id),
  set_at      timestamptz not null default now()
);
create unique index if not exists budgets_scope_period
  on public.budgets ((coalesce(list_id, '00000000-0000-0000-0000-000000000000'::uuid)), period);

create table if not exists public.budget_ledger (
  id             bigint generated always as identity primary key,
  at             timestamptz not null default now(),
  kind           text not null check (kind in ('reserve', 'settle', 'release')),
  host           text not null check (host ~ '^[A-Za-z0-9_-]{1,40}$'),
  session        text not null check (session ~ '^[A-Za-z0-9._:-]{1,120}$'),
  list_id        uuid references public.lists(id) on delete set null,
  item_id        uuid references public.items(id) on delete set null,
  amount_usd     numeric(12,4) not null check (amount_usd >= 0 and amount_usd <= 10000),
  reservation_id bigint references public.budget_ledger(id),
  expires_at     timestamptz,
  created_by     uuid not null references public.profiles(id),
  check ((kind = 'reserve') = (reservation_id is null)),
  check ((kind = 'reserve') = (expires_at is not null))
);
create index if not exists budget_ledger_at on public.budget_ledger (at);
create unique index if not exists budget_ledger_one_close on public.budget_ledger (reservation_id) where reservation_id is not null;

create table if not exists public.precedents (
  id               uuid primary key default gen_random_uuid(),
  class            text not null default 'E1' check (class = 'E1'),
  list_id          uuid not null references public.lists(id) on delete cascade,
  path_glob        text not null check (path_glob ~ '^[A-Za-z0-9_./*{},@+ -]{1,200}$' and path_glob !~ '\.\.'),
  question         text not null check (char_length(question) between 1 and 2000),
  answer           text not null check (char_length(answer) between 1 and 2000),
  source_item_id   uuid not null references public.items(id) on delete cascade,
  source_event_id  bigint not null unique references public.item_events(id),
  decided_by       uuid not null references public.profiles(id),
  recorded_by      uuid not null references public.profiles(id),
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null default now() + interval '90 days',
  revoked_at       timestamptz,
  revoked_by       uuid references public.profiles(id)
);
create index if not exists precedents_list on public.precedents (list_id) where revoked_at is null;

create table if not exists public.autonomy_events (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  actor_id    uuid,
  target_kind text not null check (target_kind in ('list', 'item', 'overall')),
  target_id   uuid,
  action      text not null check (action in ('autonomy', 'intake', 'brief', 'budget', 'precedent', 'precedent_revoke')),
  old         jsonb,
  new         jsonb
);
create index if not exists autonomy_events_target on public.autonomy_events (target_id, at);

alter table public.deploy_targets  enable row level security;
alter table public.budgets         enable row level security;
alter table public.budget_ledger   enable row level security;
alter table public.precedents      enable row level security;
alter table public.autonomy_events enable row level security;

-- ---------- the items guard ----------

-- Not security definer on purpose: current_user is the role of the statement. A REST write runs as authenticated (or anon);
-- inside a security definer RPC it is the function owner. Named items_zz_* so it fires after items_before_write.
create or replace function public.items_settings_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      if new.autonomy <> 'inherit' or new.autonomy_set_by is not null or new.autonomy_set_at is not null
         or new.e2e_self is not null or new.deploy_target is not null or new.notify_telegram is not null
         or new.stage_report is not null then
        raise exception 'autonomy and intake are set through set_autonomy and set_intake' using errcode = '42501';
      end if;
    elsif (new.autonomy, new.autonomy_set_by, new.autonomy_set_at, new.e2e_self, new.deploy_target, new.notify_telegram, new.stage_report)
          is distinct from
          (old.autonomy, old.autonomy_set_by, old.autonomy_set_at, old.e2e_self, old.deploy_target, old.notify_telegram, old.stage_report) then
      raise exception 'autonomy and intake are set through set_autonomy and set_intake' using errcode = '42501';
    end if;
  elsif tg_op = 'UPDATE' and current_setting('td.settings_only', true) = new.id::text then
    new.version := old.version;   -- a settings change keeps the item's version (plan T7)
  end if;
  return new;
end $$;
drop trigger if exists items_zz_settings on public.items;
create trigger items_zz_settings before insert or update on public.items
  for each row execute function public.items_settings_guard();

-- ---------- helpers (not RPC endpoints) ----------

-- the caller is a household person (not an agent, not a guest)
create or replace function public.autonomy_is_household_human() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select is_household and kind = 'human' from public.profiles where id = auth.uid()), false)
$$;

create or replace function public.autonomy_log(p_kind text, p_id uuid, p_action text, p_old jsonb, p_new jsonb) returns void
language sql security definer set search_path = '' as $$
  insert into public.autonomy_events (actor_id, target_kind, target_id, action, old, new)
  values (auth.uid(), p_kind, p_id, p_action, p_old, p_new)
$$;

-- start of the current period in Europe/Lisbon
create or replace function public.budget_period_start(p_period text) returns timestamptz
language sql stable set search_path = '' as $$
  select (date_trunc(case when p_period = 'month' then 'month' else 'day' end, now() at time zone 'Europe/Lisbon'))
         at time zone 'Europe/Lisbon'
$$;

-- spent (settled) and reserved (open) USD in a period, overall (p_list null) or for one list
create or replace function public.budget_used(p_list uuid, p_period text, out spent numeric, out reserved numeric)
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(s.amount_usd) filter (where s.kind = 'settle'), 0),
         coalesce(sum(s.amount_usd) filter (where s.kind = 'reserve'
                    and s.expires_at > now()
                    and not exists (select 1 from public.budget_ledger c where c.reservation_id = s.id)), 0)
    from public.budget_ledger s
   where s.at >= public.budget_period_start(p_period)
     and (p_list is null or s.list_id = p_list)
     and s.kind in ('settle', 'reserve')
$$;

-- ---------- RPCs ----------

create or replace function public.set_autonomy(p_kind text, p_id uuid, p_mode text, p_expected text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid(); v_kind text; v_hh boolean; v_mode public.autonomy_mode; v_cur public.autonomy_mode;
  v_list uuid; v_list_mode public.autonomy_mode; v_owner uuid; v_arch timestamptz; v_del timestamptz;
begin
  select kind, is_household into v_kind, v_hh from public.profiles where id = v_uid;
  if v_kind is distinct from 'human' then raise exception 'only people set autonomy' using errcode = '42501'; end if;
  if p_mode is null or p_mode not in ('inherit', 'manual', 'project_rules', 'guided', 'ai_brain') then
    raise exception 'unknown mode' using errcode = '22023';
  end if;
  if p_expected is null or p_expected not in ('inherit', 'manual', 'project_rules', 'guided', 'ai_brain') then
    raise exception 'expected mode is required' using errcode = '22023';
  end if;
  v_mode := p_mode::public.autonomy_mode;
  if v_mode = 'ai_brain' and not v_hh then raise exception 'AI Brain is for the household only' using errcode = '42501'; end if;
  if not v_hh and v_mode not in ('manual', 'guided', 'inherit') then
    raise exception 'guests set Manual or Guided only' using errcode = '42501';
  end if;

  if p_kind = 'list' then
    select autonomy, archived_at into v_cur, v_arch from public.lists where id = p_id;
    if v_cur is null or not public.has_list_role(p_id, array['owner', 'editor']) then
      raise exception 'not allowed' using errcode = '42501';
    end if;
    if v_arch is not null then raise exception 'this list is archived' using errcode = '42501'; end if;
    if v_mode = 'inherit' then raise exception 'a list has no parent to inherit from' using errcode = '22023'; end if;
    if v_cur <> p_expected::public.autonomy_mode then
      raise exception 'the mode changed meanwhile (now %)', v_cur using errcode = '40001';
    end if;
    update public.lists set autonomy = v_mode, autonomy_set_by = v_uid, autonomy_set_at = now() where id = p_id;
  elsif p_kind = 'item' then
    select i.autonomy, i.list_id, i.deleted_at into v_cur, v_list, v_del from public.items i where i.id = p_id;
    if v_cur is null or not public.has_list_role(v_list, array['owner', 'editor']) then
      raise exception 'not allowed' using errcode = '42501';
    end if;
    if v_del is not null then raise exception 'this task is deleted' using errcode = '42501'; end if;
    select autonomy, owner_id into v_list_mode, v_owner from public.lists where id = v_list;
    if v_list_mode = 'manual' and v_mode not in ('inherit', 'manual') and not (v_owner = v_uid and v_hh) then
      raise exception 'only the household owner of a Manual list widens its tasks' using errcode = '42501';
    end if;
    if v_cur <> p_expected::public.autonomy_mode then
      raise exception 'the mode changed meanwhile (now %)', v_cur using errcode = '40001';
    end if;
    perform set_config('td.settings_only', p_id::text, true);
    update public.items set autonomy = v_mode, autonomy_set_by = v_uid, autonomy_set_at = now() where id = p_id;
    perform set_config('td.settings_only', '', true);
  else
    raise exception 'kind is list or item' using errcode = '22023';
  end if;
  perform public.autonomy_log(p_kind, p_id, 'autonomy', to_jsonb(v_cur::text), to_jsonb(v_mode::text));
  return v_mode::text;
end $$;

create or replace function public.set_intake(p_kind text, p_id uuid, p_e2e_self boolean, p_deploy_target text,
                                             p_notify_telegram boolean, p_stage_report boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v_list uuid; v_old jsonb; v_new jsonb; v_arch timestamptz; v_del timestamptz;
begin
  if not public.autonomy_is_household_human() then
    raise exception 'intake is set by household people' using errcode = '42501';
  end if;
  if p_deploy_target is not null and not exists (select 1 from public.deploy_targets where key = p_deploy_target) then
    raise exception 'unknown deploy target' using errcode = '22023';
  end if;
  v_new := jsonb_build_object('e2e_self', p_e2e_self, 'deploy_target', p_deploy_target,
                              'notify_telegram', p_notify_telegram, 'stage_report', p_stage_report);
  if p_kind = 'list' then
    select jsonb_build_object('e2e_self', e2e_self, 'deploy_target', deploy_target, 'notify_telegram', notify_telegram,
                              'stage_report', stage_report), archived_at
      into v_old, v_arch from public.lists where id = p_id;
    if v_old is null or not public.has_list_role(p_id, array['owner', 'editor']) then
      raise exception 'not allowed' using errcode = '42501';
    end if;
    if v_arch is not null then raise exception 'this list is archived' using errcode = '42501'; end if;
    update public.lists set e2e_self = p_e2e_self, deploy_target = p_deploy_target, notify_telegram = p_notify_telegram,
                            stage_report = p_stage_report where id = p_id;
  elsif p_kind = 'item' then
    select jsonb_build_object('e2e_self', e2e_self, 'deploy_target', deploy_target, 'notify_telegram', notify_telegram,
                              'stage_report', stage_report), list_id, deleted_at
      into v_old, v_list, v_del from public.items where id = p_id;
    if v_old is null or not public.has_list_role(v_list, array['owner', 'editor']) then
      raise exception 'not allowed' using errcode = '42501';
    end if;
    if v_del is not null then raise exception 'this task is deleted' using errcode = '42501'; end if;
    perform set_config('td.settings_only', p_id::text, true);
    update public.items set e2e_self = p_e2e_self, deploy_target = p_deploy_target, notify_telegram = p_notify_telegram,
                            stage_report = p_stage_report where id = p_id;
    perform set_config('td.settings_only', '', true);
  else
    raise exception 'kind is list or item' using errcode = '22023';
  end if;
  perform public.autonomy_log(p_kind, p_id, 'intake', v_old, v_new);
end $$;

create or replace function public.set_list_brief(p_list uuid, p_decisions text, p_naming text, p_instruction text,
                                                 p_concept text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_old jsonb; v_arch timestamptz;
begin
  if not public.autonomy_is_household_human() then
    raise exception 'the list brief is written by household people' using errcode = '42501';
  end if;
  select jsonb_build_object('decisions', brief_decisions, 'naming', brief_naming, 'instruction', brief_instruction,
                            'concept', brief_concept), archived_at
    into v_old, v_arch from public.lists where id = p_list;
  if v_old is null or not public.has_list_role(p_list, array['owner', 'editor']) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_arch is not null then raise exception 'this list is archived' using errcode = '42501'; end if;
  if greatest(coalesce(char_length(p_decisions), 0), coalesce(char_length(p_naming), 0),
              coalesce(char_length(p_instruction), 0), coalesce(char_length(p_concept), 0)) > 8000 then
    raise exception 'text too long' using errcode = '22023';
  end if;
  perform public.assert_no_sensitive(concat_ws(' ', p_decisions, p_naming, p_instruction, p_concept));
  update public.lists set brief_decisions = nullif(p_decisions, ''), brief_naming = nullif(p_naming, ''),
                          brief_instruction = nullif(p_instruction, ''), brief_concept = nullif(p_concept, ''),
                          brief_updated_by = auth.uid(), brief_updated_at = now()
   where id = p_list;
  perform public.autonomy_log('list', p_list, 'brief', v_old,
    jsonb_build_object('decisions', p_decisions, 'naming', p_naming, 'instruction', p_instruction, 'concept', p_concept));
end $$;

create or replace function public.set_budget(p_list uuid, p_period text, p_cap numeric) returns void
language plpgsql security definer set search_path = '' as $$
declare v_old numeric;
begin
  if not public.autonomy_is_household_human() then
    raise exception 'budgets are set by household people' using errcode = '42501';
  end if;
  if p_period is null or p_period not in ('day', 'month') then raise exception 'period is day or month' using errcode = '22023'; end if;
  if p_cap is not null and (p_cap < 0 or p_cap > 100000) then raise exception 'cap out of range' using errcode = '22023'; end if;
  if p_list is not null then
    if not exists (select 1 from public.lists where id = p_list) or not public.has_list_role(p_list, array['owner', 'editor']) then
      raise exception 'not allowed' using errcode = '42501';
    end if;
  end if;
  perform pg_advisory_xact_lock(hashtext('td.budget'));
  select cap_usd into v_old from public.budgets where list_id is not distinct from p_list and period = p_period;
  delete from public.budgets where list_id is not distinct from p_list and period = p_period;
  if p_cap is not null then
    insert into public.budgets (list_id, period, cap_usd, set_by) values (p_list, p_period, p_cap, auth.uid());
  end if;
  perform public.autonomy_log(case when p_list is null then 'overall' else 'list' end, p_list, 'budget',
    jsonb_build_object('period', p_period, 'cap_usd', v_old), jsonb_build_object('period', p_period, 'cap_usd', p_cap));
end $$;

create or replace function public.budget_reserve(p_host text, p_session text, p_list uuid, p_item uuid, p_amount numeric,
                                                 p_ttl_minutes int default 120) returns bigint
language plpgsql security definer set search_path = '' as $$
declare b record; u record; v_id bigint;
begin
  if not public.is_household() then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 1000 then raise exception 'amount out of range' using errcode = '22023'; end if;
  if p_ttl_minutes is null or p_ttl_minutes < 1 or p_ttl_minutes > 1440 then raise exception 'ttl out of range' using errcode = '22023'; end if;
  if p_list is not null and not public.has_list_role(p_list, array['owner', 'editor', 'contributor', 'viewer']) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_item is not null and not exists (select 1 from public.items where id = p_item and list_id is not distinct from p_list) then
    raise exception 'the task is not in that list' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('td.budget'));
  for b in select * from public.budgets where list_id is null or list_id = p_list loop
    select * into u from public.budget_used(b.list_id, b.period);
    if u.spent + u.reserved + p_amount > b.cap_usd then
      raise exception 'budget reached: % %', case when b.list_id is null then 'overall' else 'list' end, b.period
        using errcode = '54000';
    end if;
  end loop;
  insert into public.budget_ledger (kind, host, session, list_id, item_id, amount_usd, expires_at, created_by)
  values ('reserve', p_host, p_session, p_list, p_item, p_amount, now() + make_interval(mins => p_ttl_minutes), auth.uid())
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.budget_close(p_reservation bigint, p_kind text, p_amount numeric) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.budget_ledger;
begin
  select * into r from public.budget_ledger where id = p_reservation and kind = 'reserve';
  if r.id is null or r.created_by is distinct from auth.uid() then raise exception 'not allowed' using errcode = '42501'; end if;
  if exists (select 1 from public.budget_ledger where reservation_id = p_reservation) then
    raise exception 'reservation already closed' using errcode = '22023';
  end if;
  if p_amount is null or p_amount < 0 or p_amount > 10000 then raise exception 'amount out of range' using errcode = '22023'; end if;
  insert into public.budget_ledger (kind, host, session, list_id, item_id, amount_usd, reservation_id, created_by)
  values (p_kind, r.host, r.session, r.list_id, r.item_id, p_amount, r.id, auth.uid());
end $$;

create or replace function public.budget_settle(p_reservation bigint, p_actual numeric) returns void
language plpgsql security definer set search_path = '' as $$ begin perform public.budget_close(p_reservation, 'settle', p_actual); end $$;

create or replace function public.budget_release(p_reservation bigint) returns void
language plpgsql security definer set search_path = '' as $$ begin perform public.budget_close(p_reservation, 'release', 0); end $$;

create or replace function public.budget_status(p_list uuid default null)
returns table (scope text, list_id uuid, period text, cap_usd numeric, spent_usd numeric, reserved_usd numeric)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_household() then raise exception 'not allowed' using errcode = '42501'; end if;
  return query
    select case when b.list_id is null then 'overall' else 'list' end, b.list_id, b.period, b.cap_usd, u.spent, u.reserved
      from public.budgets b cross join lateral public.budget_used(b.list_id, b.period) u
     where b.list_id is null or b.list_id = p_list
     order by b.list_id nulls first, b.period;
end $$;

create or replace function public.record_precedent(p_event bigint, p_list uuid, p_path_glob text, p_question text,
                                                   p_answer text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare e public.item_events; v_item_list uuid; v_id uuid;
begin
  if not public.is_household() then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into e from public.item_events where id = p_event;
  if e.id is null then raise exception 'no such answer' using errcode = '22023'; end if;
  if e.actor_kind is distinct from 'human'
     or not exists (select 1 from public.profiles where id = e.actor_id and kind = 'human' and is_household) then
    raise exception 'a precedent comes from a household person''s answer only' using errcode = '42501';
  end if;
  if e.at < now() - interval '30 days' then raise exception 'the answer is too old' using errcode = '22023'; end if;
  if coalesce(e.diff #>> '{details,new,decision,use_as_precedent}', '') <> 'true'
     or coalesce(e.diff #>> '{details,old,decision,use_as_precedent}', '') = 'true' then
    raise exception 'the person did not tick "use as precedent" in this answer' using errcode = '22023';
  end if;
  select list_id into v_item_list from public.items where id = e.item_id;
  if p_list is null or v_item_list is distinct from p_list then
    raise exception 'the precedent''s list is the list of the answered card' using errcode = '22023';
  end if;
  if not public.has_list_role(p_list, array['owner', 'editor', 'contributor', 'viewer']) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  perform public.assert_no_sensitive(concat_ws(' ', p_question, p_answer));
  insert into public.precedents (list_id, path_glob, question, answer, source_item_id, source_event_id, decided_by, recorded_by)
  values (p_list, p_path_glob, p_question, p_answer, e.item_id, e.id, e.actor_id, auth.uid())
  returning id into v_id;
  perform public.autonomy_log('list', p_list, 'precedent', null,
    jsonb_build_object('precedent', v_id, 'event', e.id, 'decided_by', e.actor_id, 'path_glob', p_path_glob));
  return v_id;
end $$;

create or replace function public.revoke_precedent(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_list uuid;
begin
  if not public.autonomy_is_household_human() then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.precedents set revoked_at = now(), revoked_by = auth.uid()
   where id = p_id and revoked_at is null returning list_id into v_list;
  if v_list is null then raise exception 'no such precedent' using errcode = '22023'; end if;
  perform public.autonomy_log('list', v_list, 'precedent_revoke', jsonb_build_object('precedent', p_id), null);
end $$;

-- ---------- policies (select only; no API role writes these tables) ----------

drop policy if exists deploy_targets_read on public.deploy_targets;
create policy deploy_targets_read on public.deploy_targets for select to authenticated using (true);
drop policy if exists budgets_read on public.budgets;
create policy budgets_read on public.budgets for select to authenticated using (public.is_household());
drop policy if exists budget_ledger_read on public.budget_ledger;
create policy budget_ledger_read on public.budget_ledger for select to authenticated using (public.is_household());
drop policy if exists precedents_read on public.precedents;
create policy precedents_read on public.precedents for select to authenticated using (public.is_household());
drop policy if exists autonomy_events_read on public.autonomy_events;
create policy autonomy_events_read on public.autonomy_events for select to authenticated using (public.is_household());

-- ---------- grants ----------

revoke all on public.deploy_targets, public.budgets, public.budget_ledger, public.precedents, public.autonomy_events
  from anon, authenticated;
grant select on public.deploy_targets, public.budgets, public.budget_ledger, public.precedents, public.autonomy_events
  to authenticated;

revoke all on function public.items_settings_guard(), public.autonomy_is_household_human(),
  public.autonomy_log(text, uuid, text, jsonb, jsonb), public.budget_period_start(text), public.budget_used(uuid, text),
  public.budget_close(bigint, text, numeric)
  from public, anon, authenticated;

revoke all on function public.set_autonomy(text, uuid, text, text), public.set_intake(text, uuid, boolean, text, boolean, boolean),
  public.set_list_brief(uuid, text, text, text, text), public.set_budget(uuid, text, numeric),
  public.budget_reserve(text, text, uuid, uuid, numeric, int), public.budget_settle(bigint, numeric),
  public.budget_release(bigint), public.budget_status(uuid),
  public.record_precedent(bigint, uuid, text, text, text), public.revoke_precedent(uuid)
  from public, anon;
grant execute on function public.set_autonomy(text, uuid, text, text), public.set_intake(text, uuid, boolean, text, boolean, boolean),
  public.set_list_brief(uuid, text, text, text, text), public.set_budget(uuid, text, numeric),
  public.budget_reserve(text, text, uuid, uuid, numeric, int), public.budget_settle(bigint, numeric),
  public.budget_release(bigint), public.budget_status(uuid),
  public.record_precedent(bigint, uuid, text, text, text), public.revoke_precedent(uuid)
  to authenticated;
