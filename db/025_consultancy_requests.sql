-- db/025_consultancy_requests.sql: consulting-call requests from the landing page (2026-11-03). The landing's
-- "Book a consulting call" and "Schedule a consulting call" buttons open /signin?intent=consult on the app host. There
-- the visitor signs in with Google (verified email), may add a Telegram username, a WhatsApp number and a note, and
-- calls request_consultation(). The function files a task in the list "Consultancy Request" (slug consultancy-request,
-- owner maksym; homeos-agent and telegram-bot editors), made by homeos-agent, due at the next 09:00 Europe/Lisbon,
-- details.notify maksym, so the 09:15 Telegram digest lists it. No table: the task is the record; the requester's id
-- is in details.requested_by. Every function is security definer with search_path = ''. Error codes: 42501 not
-- allowed, 22023 bad value, 54000 limit reached, 55000 the list is missing. Additive and re-runnable.
-- Order rule after this file: 003_rls.sql, 011_multiuser_rls.sql, the 012 policy block, 900-910.

-- ---------- settings and the list ----------

insert into ops.settings (key, value, note) values
  ('consult_requests_per_day', 20, 'consulting-call requests from everyone per 24 hours'),
  ('consult_requests_open',    50, 'open consulting-call requests at once')
on conflict (key) do nothing;

-- the list, once: owner maksym, homeos-agent editor; telegram-bot joins through bot_join_list (017) and below
with m as (select id from public.profiles where handle = 'maksym')
insert into public.lists (slug, name, description, default_category, sort, owner_id, created_by)
select 'consultancy-request', 'Consultancy Request',
       'consulting-call requests from the landing page; reply to the email, Telegram or WhatsApp in the description',
       'task', coalesce((select max(sort) + 1 from public.lists l where l.owner_id = m.id), 1), m.id, m.id from m
on conflict (owner_id, slug) do nothing;
insert into public.list_members (list_id, profile_id, role)
select l.id, p.id, r.role
  from public.lists l join public.profiles o on o.id = l.owner_id and o.handle = 'maksym'
  join (values ('maksym','owner'), ('homeos-agent','editor'), ('telegram-bot','editor')) as r(handle, role) on true
  join public.profiles p on p.handle = r.handle
 where l.slug = 'consultancy-request'
on conflict (list_id, profile_id) do nothing;

-- ---------- helpers (internal) ----------

create or replace function public.consult_list_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select l.id from public.lists l join public.profiles o on o.id = l.owner_id
   where o.handle = 'maksym' and l.slug = 'consultancy-request'
$$;

-- what the requester may see of their own request: never the item id, the list or other people's data
create or replace function public.consult_request_json(p_item uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('status', case when i.status in ('done','cancelled') then i.status else 'open' end,
                            'requested_at', i.created_at, 'email', i.details->>'email',
                            'telegram', i.details->>'telegram', 'whatsapp', i.details->>'whatsapp')
    from public.items i where i.id = p_item
$$;

-- the caller's newest request in the list, deleted ones left out
create or replace function public.consult_latest(p_uid uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select i.id from public.items i
   where i.list_id = public.consult_list_id() and i.deleted_at is null and i.details->>'requested_by' = p_uid::text
   order by i.created_at desc limit 1
$$;

-- ---------- request ----------

-- The caller's consulting-call request. The email is the caller's verified Google identity email. Optional:
-- p_telegram (a username, @name or a t.me link: 5-32 letters, digits or _), p_whatsapp (a phone number, 7-15 digits,
-- spaces, dashes, dots and brackets allowed), p_note (up to 500 characters). Stored as https://t.me/<name> and
-- https://wa.me/<digits> (links are clickable, and the sensitive-number check skips links, so a phone number is never
-- taken for a card number). One open request per person: an open one is returned as it is; a new one is made when
-- there is none or the last is done or cancelled. Any signed-in person may call it (household included, for tests).
create or replace function public.request_consultation(p_telegram text default null, p_whatsapp text default null,
                                                       p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid    uuid := auth.uid();
  v_kind   text;
  v_email  text;
  v_tg     text;
  v_wa     text;
  v_note   text;
  v_last   uuid;
  v_list   uuid;
  v_agent  uuid;
  v_item   uuid;
  v_claims text;
  v_sub    text;
  v_local  timestamp;
  v_due    timestamptz;
begin
  if v_uid is null then raise exception 'sign in first' using errcode = '42501'; end if;
  select kind into v_kind from public.profiles where id = v_uid;
  if v_kind is distinct from 'human' then raise exception 'people only' using errcode = '42501'; end if;
  select lower(i.identity_data->>'email') into v_email from auth.identities i
   where i.user_id = v_uid and i.provider = 'google' and i.identity_data->>'email' is not null
     and coalesce((i.identity_data->>'email_verified')::boolean, false)
   order by i.created_at desc nulls last limit 1;
  if v_email is null then raise exception 'a verified Google sign-in is needed' using errcode = '42501'; end if;

  -- the contacts: cleaned, checked, stored as links
  v_tg := nullif(trim(coalesce(p_telegram, '')), '');
  if v_tg is not null then
    v_tg := regexp_replace(v_tg, '^(https?://)?(www\.)?(t\.me|telegram\.me)/', '', 'i');
    v_tg := regexp_replace(v_tg, '^@', '');
    if v_tg !~ '^[A-Za-z0-9_]{5,32}$' then
      raise exception 'Telegram: a username of 5 to 32 letters, digits or _' using errcode = '22023';
    end if;
    v_tg := 'https://t.me/' || v_tg;
  end if;
  v_wa := nullif(trim(coalesce(p_whatsapp, '')), '');
  if v_wa is not null then
    if v_wa !~ '^\+?[0-9 ().-]+$' then
      raise exception 'WhatsApp: a phone number with the country code, digits only' using errcode = '22023';
    end if;
    v_wa := regexp_replace(v_wa, '[^0-9]', '', 'g');
    if char_length(v_wa) not between 7 and 15 then
      raise exception 'WhatsApp: a phone number with the country code, digits only' using errcode = '22023';
    end if;
    v_wa := 'https://wa.me/' || v_wa;
  end if;
  v_note := nullif(trim(regexp_replace(coalesce(p_note, ''), '[\x01-\x09\x0b-\x1f\x7f]', '', 'g')), '');
  if char_length(v_note) > 500 then raise exception 'Note: at most 500 characters' using errcode = '22023'; end if;

  -- one at a time: the open-request and cap checks below must not race
  perform pg_advisory_xact_lock(hashtext('public.request_consultation'));
  v_last := public.consult_latest(v_uid);
  if v_last is not null and (select status from public.items where id = v_last) not in ('done','cancelled') then
    return public.consult_request_json(v_last) || jsonb_build_object('created', false);
  end if;
  v_list := public.consult_list_id();
  select id into v_agent from public.profiles where handle = 'homeos-agent' and kind = 'agent';
  if v_list is null or v_agent is null
     or exists (select 1 from public.lists where id = v_list and archived_at is not null) then
    raise exception 'the Consultancy Request list is missing' using errcode = '55000';
  end if;
  if (select count(*) from public.items where list_id = v_list and created_via = 'rpc:request_consultation'
        and created_at > now() - interval '24 hours') >= public.setting('consult_requests_per_day')
     or (select count(*) from public.items where list_id = v_list and deleted_at is null
           and status not in ('done','cancelled')) >= public.setting('consult_requests_open') then
    raise exception 'too many requests right now, try again tomorrow' using errcode = '54000';
  end if;

  v_local := now() at time zone 'Europe/Lisbon';
  v_due   := (date_trunc('day', v_local) + interval '9 hours'
              + case when v_local::time >= time '09:00' then interval '1 day' else interval '0' end) at time zone 'Europe/Lisbon';
  -- the task is homeos-agent's: items_before_write stamps created_by from auth.uid(), so the agent's claims stand in
  -- for the insert and the caller's are put back right after it (transaction-local settings), as in request_access (015)
  v_claims := current_setting('request.jwt.claims', true);
  v_sub    := current_setting('request.jwt.claim.sub', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_agent, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_agent::text, true);
  insert into public.items (list_id, category, title, body_md, due_at, details, created_via, source_app, source_ref, dedup_key)
  values (v_list, 'task', left('Consulting call: ' || v_email, 300),
          'Consulting-call request from the landing page. Reply within two working days.' || E'\n\n'
          || '- Email: ' || v_email || E'\n'
          || '- Telegram: ' || coalesce(v_tg, '-') || E'\n'
          || '- WhatsApp: ' || coalesce(v_wa, '-') || E'\n'
          || '- Requested: ' || to_char(now() at time zone 'Europe/Lisbon', 'YYYY-MM-DD HH24:MI') || ' Europe/Lisbon'
          || coalesce(E'\n\n' || 'Note from the requester:' || E'\n\n' || v_note, ''),
          v_due, jsonb_strip_nulls(jsonb_build_object('notify', jsonb_build_array('maksym'), 'requested_by', v_uid,
                                    'email', v_email, 'telegram', v_tg, 'whatsapp', v_wa)),
          'rpc:request_consultation', 'tasksdashboard', v_uid::text, 'consult-request:' || gen_random_uuid())
  returning id into v_item;
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
  return public.consult_request_json(v_item) || jsonb_build_object('created', true);
end $$;

-- the caller's latest request, or null (the consult screen's state)
create or replace function public.my_consultation_request() returns jsonb
language sql stable security definer set search_path = '' as $$
  select public.consult_request_json(public.consult_latest(auth.uid())) where auth.uid() is not null
$$;

-- ---------- rights ----------

revoke execute on function public.request_consultation(text, text, text), public.my_consultation_request(),
  public.consult_list_id(), public.consult_request_json(uuid), public.consult_latest(uuid) from public, anon;
grant execute on function public.request_consultation(text, text, text), public.my_consultation_request() to authenticated;
revoke execute on function public.consult_list_id(), public.consult_request_json(uuid), public.consult_latest(uuid) from authenticated;

-- final check: the list and its members, definers with an empty search_path, nothing for anon, helpers not RPCs
do $$
declare v text;
begin
  if (select string_agg(p.handle || ':' || m.role, ',' order by p.handle) from public.list_members m
        join public.profiles p on p.id = m.profile_id where m.list_id = public.consult_list_id())
     is distinct from 'homeos-agent:editor,maksym:owner,telegram-bot:editor' then
    raise exception '025: the Consultancy Request list or its three members are not as expected';
  end if;
  select string_agg(p.proname, ', ') into v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('request_consultation','my_consultation_request','consult_list_id',
                                                'consult_request_json','consult_latest')
     and not (p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""']);
  if v is not null then raise exception '025: not a definer with search_path '''': %', v; end if;
  if has_function_privilege('anon', 'public.request_consultation(text, text, text)', 'execute')
     or has_function_privilege('anon', 'public.my_consultation_request()', 'execute')
     or has_function_privilege('authenticated', 'public.consult_list_id()', 'execute')
     or has_function_privilege('authenticated', 'public.consult_request_json(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.consult_latest(uuid)', 'execute') then
    raise exception '025: a function is executable by the wrong role';
  end if;
end $$;
