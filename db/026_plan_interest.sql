-- db/026_plan_interest.sql: interest from the landing page's plan buttons (2026-11-03). "Try the demo", "Subscribe to
-- Personal" and "Subscribe to Team" call request_plan_interest() with the publishable key and no login, and may send an
-- email and a Telegram username (both optional, both unverified). The function files a task in the list "Consultancy
-- Request", quadrant B (Plan), made by homeos-agent, with no due date. No table: the task is the record.
--
-- THE ONE FUNCTION ANON MAY EXECUTE. Nothing else in the database is open to a visitor without a login. So it takes fixed
-- fields only (a plan from a list, an email and a Telegram name that must match a strict format; no free text), reads
-- nothing back (the answer is always { ok: true }, so it is no oracle for who asked before) and is capped: 40 a day and
-- 200 open, counted on its own rows, so a flood stops here and never reaches consulting-call requests.
--
-- request_consultation (025) is replaced for one reason: its open cap counted every open task in the list, so anonymous
-- presses could have used it up. It now counts its own rows, like its daily cap.
--
-- 003_rls.sql revokes every function from anon, so this file must run again after 003: tasksdb.js apply-sql appends it.
-- Error codes: 22023 bad value, 54000 limit reached, 55000 the list is missing. Additive and re-runnable.
-- Order rule after this file: 003_rls.sql, 011_multiuser_rls.sql, the 012 policy block, 026 (this file), 900-911.

insert into ops.settings (key, value, note) values
  ('plan_interest_per_day', 40,  'plan-button presses filed from the landing page per 24 hours'),
  ('plan_interest_open',    200, 'open plan-button tasks at once')
on conflict (key) do nothing;

create or replace function public.request_plan_interest(p_plan text, p_email text default null, p_telegram text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_button text;
  v_email  text;
  v_tg     text;
  v_list   uuid;
  v_agent  uuid;
  v_claims text;
  v_sub    text;
begin
  v_button := case p_plan when 'Demo' then 'Try the demo' when 'Personal' then 'Subscribe to Personal'
                          when 'Team' then 'Subscribe to Team' end;
  if v_button is null then raise exception 'Plan: Demo, Personal or Team' using errcode = '22023'; end if;

  v_email := lower(nullif(trim(coalesce(p_email, '')), ''));
  if v_email is not null and (char_length(v_email) > 254
       or v_email !~ '^[a-z0-9._%+-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$') then
    raise exception 'Email: that does not look like an email address' using errcode = '22023';
  end if;
  v_tg := nullif(trim(coalesce(p_telegram, '')), '');
  if v_tg is not null then
    v_tg := regexp_replace(v_tg, '^(https?://)?(www\.)?(t\.me|telegram\.me)/', '', 'i');
    v_tg := regexp_replace(v_tg, '^@', '');
    if v_tg !~ '^[A-Za-z0-9_]{5,32}$' then
      raise exception 'Telegram: a username of 5 to 32 letters, digits or _' using errcode = '22023';
    end if;
    v_tg := 'https://t.me/' || v_tg;
  end if;

  -- one at a time: the checks below must not race
  perform pg_advisory_xact_lock(hashtext('public.request_plan_interest'));
  v_list := public.consult_list_id();
  select id into v_agent from public.profiles where handle = 'homeos-agent' and kind = 'agent';
  if v_list is null or v_agent is null
     or exists (select 1 from public.lists where id = v_list and archived_at is not null) then
    raise exception 'the Consultancy Request list is missing' using errcode = '55000';
  end if;

  -- the same contact pressing the same plan again: nothing new, and the same answer
  if (v_email is not null or v_tg is not null) and exists (
       select 1 from public.items i
        where i.list_id = v_list and i.created_via = 'rpc:request_plan_interest' and i.deleted_at is null
          and i.status not in ('done','cancelled') and i.details->>'plan' = p_plan
          and (i.details->>'email' = v_email or i.details->>'telegram' = v_tg)) then
    return jsonb_build_object('ok', true);
  end if;

  if (select count(*) from public.items where list_id = v_list and created_via = 'rpc:request_plan_interest'
        and created_at > now() - interval '24 hours') >= public.setting('plan_interest_per_day')
     or (select count(*) from public.items where list_id = v_list and created_via = 'rpc:request_plan_interest'
           and deleted_at is null and status not in ('done','cancelled')) >= public.setting('plan_interest_open') then
    raise exception 'too many requests right now, try again tomorrow' using errcode = '54000';
  end if;

  -- the task is homeos-agent's, as in request_consultation (025): the agent's claims stand in for the insert
  v_claims := current_setting('request.jwt.claims', true);
  v_sub    := current_setting('request.jwt.claim.sub', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_agent, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_agent::text, true);
  insert into public.items (list_id, category, quadrant, title, body_md, details, created_via, source_app, dedup_key)
  values (v_list, 'task', 'B',
          left('Interest in ' || p_plan || ': ' || coalesce(v_email, v_tg, 'no contact'), 300),
          'Pressed "' || v_button || '" on the landing page. The visitor did not sign in, so a contact below is unverified.' || E'\n\n'
          || '- Plan: ' || p_plan || E'\n'
          || '- Email: ' || coalesce(v_email, '-') || E'\n'
          || '- Telegram: ' || coalesce(v_tg, '-') || E'\n'
          || '- Pressed: ' || to_char(now() at time zone 'Europe/Lisbon', 'YYYY-MM-DD HH24:MI') || ' Europe/Lisbon',
          jsonb_strip_nulls(jsonb_build_object('plan', p_plan, 'email', v_email, 'telegram', v_tg)),
          'rpc:request_plan_interest', 'tasksdashboard', 'plan-interest:' || gen_random_uuid());
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
  return jsonb_build_object('ok', true);
end $$;

-- ---------- request_consultation: the open cap counts its own rows (the rest is 025 as it was) ----------

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
     or (select count(*) from public.items where list_id = v_list and created_via = 'rpc:request_consultation'
           and deleted_at is null and status not in ('done','cancelled')) >= public.setting('consult_requests_open') then
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

-- ---------- rights ----------

revoke execute on function public.request_plan_interest(text, text, text) from public;
grant execute on function public.request_plan_interest(text, text, text) to anon, authenticated;
revoke execute on function public.request_consultation(text, text, text) from public, anon;
grant execute on function public.request_consultation(text, text, text) to authenticated;

-- final check: definers with an empty search_path; anon may run the new function and no other of this flow
do $$
declare v text;
begin
  select string_agg(p.proname, ', ') into v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('request_plan_interest','request_consultation')
     and not (p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""']);
  if v is not null then raise exception '026: not a definer with search_path '''': %', v; end if;
  if not has_function_privilege('anon', 'public.request_plan_interest(text, text, text)', 'execute') then
    raise exception '026: anon cannot execute request_plan_interest';
  end if;
  if has_function_privilege('anon', 'public.request_consultation(text, text, text)', 'execute') then
    raise exception '026: anon can execute request_consultation';
  end if;
  if not has_schema_privilege('anon', 'public', 'usage') then
    raise exception '026: anon has no usage on schema public, the landing page would get 401';
  end if;
end $$;
