-- db/015_access_requests.sql: access requests (HomeOS access-backup-plan.md D1, review G1-G4, G12). A person who is not
-- yet let in signs in with Google on the public request page and calls request_access(): the database records them in
-- users_pending_for_decision and files a task in the household list "Access requests" (slug access-requests, owner
-- maksym; anastasiia and homeos-agent editors). A household member writes Approved or Declined as the first word of the
-- task's description; cli/access.mjs applies it to the host's access policy and reports back through
-- access_request_decided(). Every function is security definer with search_path = ''. Error codes: 42501 not allowed,
-- 22023 bad value, 54000 limit reached, 55000 the list is missing. Additive and re-runnable.
-- Order rule after this file: 003_rls.sql, 011_multiuser_rls.sql, the 012 policy block, 900, 901, 902, 903.

-- ---------- schema ----------

create table if not exists public.users_pending_for_decision (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  email        text not null check (email = lower(email) and char_length(email) between 3 and 320),
  first_name   text check (char_length(first_name) <= 60),
  last_name    text check (char_length(last_name) <= 60),
  requested_at timestamptz not null default now(),
  status       text not null default 'pending' check (status in ('pending','approved','declined','removed')),
  decided_at   timestamptz,
  applied_at   timestamptz,
  item_id      uuid references public.items(id)
);
create unique index if not exists users_pending_open_one on public.users_pending_for_decision (user_id) where status = 'pending';
create index if not exists users_pending_requested_idx on public.users_pending_for_decision (requested_at);
alter table public.users_pending_for_decision enable row level security;
-- no grants (003 resets table grants on every run anyway): reads go through access_requests() and my_access_request(),
-- writes through request_access() and access_request_decided() only

-- the request task says how it was made (G3): created_via rpc:<function>
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'items_created_via_check'
                  and pg_get_constraintdef(oid) like '%rpc%') then
    alter table public.items drop constraint if exists items_created_via_check;
    alter table public.items add constraint items_created_via_check
      check (created_via ~ '^(app|migration|telegram|(skill|routine|script|project|rpc):[a-z0-9._-]+)$');
  end if;
end $$;

insert into ops.settings (key, value, note) values
  ('access_requests_per_day', 20, 'access requests from everyone per 24 hours (G2)'),
  ('access_requests_open',    30, 'pending access requests at once (G2)')
on conflict (key) do nothing;

-- the household list, once: owner maksym, anastasiia and homeos-agent editors (G3, G12)
with m as (select id from public.profiles where handle = 'maksym')
insert into public.lists (slug, name, description, default_category, sort, owner_id, created_by)
select 'access-requests', 'Access requests', 'requests to use the app; write Approved or Declined first in a task''s description',
       'task', coalesce((select max(sort) + 1 from public.lists l where l.owner_id = m.id), 1), m.id, m.id from m
on conflict (owner_id, slug) do nothing;
insert into public.list_members (list_id, profile_id, role)
select l.id, p.id, r.role
  from public.lists l join public.profiles o on o.id = l.owner_id and o.handle = 'maksym'
  join (values ('maksym','owner'), ('anastasiia','editor'), ('homeos-agent','editor')) as r(handle, role) on true
  join public.profiles p on p.handle = r.handle
 where l.slug = 'access-requests'
on conflict (list_id, profile_id) do nothing;

-- ---------- helpers (internal) ----------

create or replace function public.access_list_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select l.id from public.lists l join public.profiles o on o.id = l.owner_id
   where o.handle = 'maksym' and l.slug = 'access-requests'
$$;

create or replace function public.access_request_json(p_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', r.id, 'status', r.status, 'email', r.email, 'first_name', r.first_name,
                            'last_name', r.last_name, 'requested_at', r.requested_at, 'decided_at', r.decided_at,
                            'applied_at', r.applied_at, 'item_id', r.item_id)
    from public.users_pending_for_decision r where r.id = p_id
$$;

-- ---------- request (G1-G3, G12) ----------

-- The caller's own request. Takes no parameters: the email is the caller's verified Google identity email, the name
-- Google's given_name / family_name, else full_name split at its first space. One open request per person: a pending,
-- approved or declined request is returned as it is; a new one is made only when there is none or the last was removed.
-- The task is created as homeos-agent (created_via rpc:request_access), due at the next 09:00 Europe/Lisbon so the next
-- daily digest lists it, details.notify both people.
create or replace function public.request_access() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid    uuid := auth.uid();
  v_kind   text;
  v_hh     boolean;
  v_email  text;
  v_meta   jsonb;
  v_full   text;
  v_first  text;
  v_last   text;
  v_row    public.users_pending_for_decision%rowtype;
  v_list   uuid;
  v_agent  uuid;
  v_item   uuid;
  v_claims text;
  v_sub    text;
  v_local  timestamp;
  v_due    timestamptz;
begin
  if v_uid is null then raise exception 'sign in first' using errcode = '42501'; end if;
  select kind, is_household into v_kind, v_hh from public.profiles where id = v_uid;
  if v_kind is distinct from 'human' then raise exception 'people only' using errcode = '42501'; end if;
  if v_hh then raise exception 'household members already have access' using errcode = '22023'; end if;
  select lower(i.identity_data->>'email'), i.identity_data into v_email, v_meta from auth.identities i
   where i.user_id = v_uid and i.provider = 'google' and i.identity_data->>'email' is not null
     and coalesce((i.identity_data->>'email_verified')::boolean, false)
   order by i.created_at desc nulls last limit 1;
  if v_email is null then raise exception 'a verified Google sign-in is needed' using errcode = '42501'; end if;

  -- one at a time: the open-request and cap checks below must not race
  perform pg_advisory_xact_lock(hashtext('public.request_access'));
  select * into v_row from public.users_pending_for_decision where user_id = v_uid order by requested_at desc limit 1;
  if found and v_row.status <> 'removed' then return public.access_request_json(v_row.id); end if;
  if (select count(*) from public.users_pending_for_decision where requested_at > now() - interval '24 hours')
       >= public.setting('access_requests_per_day')
     or (select count(*) from public.users_pending_for_decision where status = 'pending')
       >= public.setting('access_requests_open') then
    raise exception 'too many access requests right now, try later' using errcode = '54000';
  end if;
  v_list := public.access_list_id();
  select id into v_agent from public.profiles where handle = 'homeos-agent' and kind = 'agent';
  if v_list is null or v_agent is null
     or exists (select 1 from public.lists where id = v_list and archived_at is not null) then
    raise exception 'the Access requests list is missing' using errcode = '55000';
  end if;

  v_meta  := coalesce(v_meta, '{}'::jsonb) || coalesce((select raw_user_meta_data from auth.users where id = v_uid), '{}'::jsonb);
  v_full  := trim(regexp_replace(coalesce(v_meta->>'full_name', v_meta->>'name', ''), '[[:cntrl:]]', '', 'g'));
  v_first := nullif(left(trim(regexp_replace(coalesce(v_meta->>'given_name', split_part(v_full, ' ', 1)), '[[:cntrl:]]', '', 'g')), 60), '');
  v_last  := nullif(left(trim(regexp_replace(coalesce(v_meta->>'family_name',
               case when position(' ' in v_full) > 0 then substr(v_full, position(' ' in v_full) + 1) end, ''),
               '[[:cntrl:]]', '', 'g')), 60), '');
  insert into public.users_pending_for_decision (user_id, email, first_name, last_name)
  values (v_uid, v_email, v_first, v_last) returning * into v_row;

  v_local := now() at time zone 'Europe/Lisbon';
  v_due   := (date_trunc('day', v_local) + interval '9 hours'
              + case when v_local::time >= time '09:00' then interval '1 day' else interval '0' end) at time zone 'Europe/Lisbon';
  -- the task is homeos-agent's (G3): items_before_write stamps created_by from auth.uid(), so the agent's claims stand
  -- in for the insert and the caller's are put back right after it (transaction-local settings)
  v_claims := current_setting('request.jwt.claims', true);
  v_sub    := current_setting('request.jwt.claim.sub', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_agent, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_agent::text, true);
  insert into public.items (list_id, category, title, body_md, due_at, details, created_via, source_app, source_ref, dedup_key)
  values (v_list, 'task', left('Access request: ' || v_email, 300),
          'Write Approved or Declined as the first word of this description.' || E'\n\n'
          || '- Email: ' || v_email || E'\n'
          || '- Name: ' || coalesce(nullif(concat_ws(' ', v_first, v_last), ''), '-') || E'\n'
          || '- Requested: ' || to_char(v_row.requested_at at time zone 'Europe/Lisbon', 'YYYY-MM-DD HH24:MI') || ' Europe/Lisbon',
          v_due, jsonb_build_object('notify', jsonb_build_array('maksym', 'anastasiia'), 'access_request_id', v_row.id,
                                    'email', v_email),
          'rpc:request_access', 'tasksdashboard', v_row.id::text, 'access-request:' || v_row.id)
  returning id into v_item;
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);

  update public.users_pending_for_decision set item_id = v_item where id = v_row.id;
  return public.access_request_json(v_row.id);
end $$;

-- the caller's latest request, or null (the request page's state)
create or replace function public.my_access_request() returns jsonb
language sql stable security definer set search_path = '' as $$
  select public.access_request_json(r.id) from public.users_pending_for_decision r
   where r.user_id = auth.uid() order by r.requested_at desc limit 1
$$;

-- every request, newest first, for the members of the Access requests list (people and homeos-agent)
create or replace function public.access_requests(p_status text default null) returns setof jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_list_role(public.access_list_id(), array['owner','editor','contributor','viewer']) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return query select public.access_request_json(r.id) from public.users_pending_for_decision r
                where p_status is null or r.status = p_status order by r.requested_at desc;
end $$;

-- ---------- decision (agent, G4) ----------

-- An agent that edits the Access requests list (homeos-agent) records what it applied: pending -> approved | declined,
-- declined -> approved, approved -> removed. The same status again changes nothing and answers the row.
create or replace function public.access_request_decided(p_id uuid, p_status text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_old text;
begin
  if not (public.is_agent() and public.has_list_role(public.access_list_id(), array['owner','editor'])) then
    raise exception 'agents of the Access requests list only' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('approved','declined','removed') then
    raise exception 'status must be approved, declined or removed' using errcode = '22023';
  end if;
  select status into v_old from public.users_pending_for_decision where id = p_id for update;
  if v_old is null then raise exception 'no such access request' using errcode = '22023'; end if;
  if v_old = p_status then return public.access_request_json(p_id); end if;
  if not ((v_old = 'pending' and p_status in ('approved','declined')) or (v_old = 'declined' and p_status = 'approved')
          or (v_old = 'approved' and p_status = 'removed')) then
    raise exception 'cannot go from % to %', v_old, p_status using errcode = '22023';
  end if;
  update public.users_pending_for_decision set status = p_status, decided_at = now(), applied_at = now() where id = p_id;
  return public.access_request_json(p_id);
end $$;

-- ---------- rights ----------

revoke all on public.users_pending_for_decision from public, anon, authenticated;
drop policy if exists access_requests_read on public.users_pending_for_decision;
create policy access_requests_read on public.users_pending_for_decision for select to authenticated
  using (public.has_list_role(public.access_list_id(), array['owner','editor','contributor','viewer']));
revoke execute on function public.request_access(), public.my_access_request(), public.access_requests(text),
  public.access_request_decided(uuid, text), public.access_list_id(), public.access_request_json(uuid) from public, anon;
grant execute on function public.request_access(), public.my_access_request(), public.access_requests(text),
  public.access_request_decided(uuid, text) to authenticated;
revoke execute on function public.access_list_id(), public.access_request_json(uuid) from authenticated;

-- final check: the list and its members, definers with an empty search_path, nothing for anon, no table grants
do $$
declare v text;
begin
  if (select count(*) from public.list_members where list_id = public.access_list_id()) <> 3 then
    raise exception '015: the Access requests list or its three members are missing';
  end if;
  select string_agg(p.proname, ', ') into v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('request_access','my_access_request','access_requests','access_request_decided',
                                                'access_list_id','access_request_json')
     and not (p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""']);
  if v is not null then raise exception '015: not a definer with search_path '''': %', v; end if;
  if has_function_privilege('anon', 'public.request_access()', 'execute')
     or has_function_privilege('authenticated', 'public.access_request_json(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.access_list_id()', 'execute') then
    raise exception '015: a function is executable by the wrong role';
  end if;
  if has_table_privilege('authenticated', 'public.users_pending_for_decision', 'select,insert,update,delete')
     or has_table_privilege('anon', 'public.users_pending_for_decision', 'select') then
    raise exception '015: users_pending_for_decision has API grants';
  end if;
end $$;
