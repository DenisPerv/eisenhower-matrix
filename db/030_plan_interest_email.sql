-- db/030_plan_interest_email.sql: a plan-button press needs an email (2026-11-05, replaces the optional contacts of 026).
-- request_plan_interest refuses a press with no email (22023), before anything is written, so neither an old page nor a
-- direct call can file an empty card. Telegram stays optional and is refused alone. The rest is 026 as it was: the same
-- signature, the same format checks, the same dedup and caps, the same answer.
--
-- 026 is re-run after every 003 (003 revokes its anon grant) and would bring the optional version back, so this file must
-- always follow 026: tasksdb.js apply-sql appends it. Re-runnable. Roll back by re-running 026.
-- Order rule after this file: 003_rls.sql, 011_multiuser_rls.sql, the 012 policy block, 026, 030 (this file), 900-913.

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
  if v_email is null then raise exception 'Email: please enter your email address' using errcode = '22023'; end if;
  if char_length(v_email) > 254
     or v_email !~ '^[a-z0-9._%+-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$' then
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
  if exists (
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
          left('Interest in ' || p_plan || ': ' || v_email, 300),
          'Pressed "' || v_button || '" on the landing page. The visitor did not sign in, so a contact below is unverified.' || E'\n\n'
          || '- Plan: ' || p_plan || E'\n'
          || '- Email: ' || v_email || E'\n'
          || '- Telegram: ' || coalesce(v_tg, '-') || E'\n'
          || '- Pressed: ' || to_char(now() at time zone 'Europe/Lisbon', 'YYYY-MM-DD HH24:MI') || ' Europe/Lisbon',
          jsonb_strip_nulls(jsonb_build_object('plan', p_plan, 'email', v_email, 'telegram', v_tg)),
          'rpc:request_plan_interest', 'tasksdashboard', 'plan-interest:' || gen_random_uuid());
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
  return jsonb_build_object('ok', true);
end $$;

-- ---------- rights, as in 026 ----------

revoke execute on function public.request_plan_interest(text, text, text) from public;
grant execute on function public.request_plan_interest(text, text, text) to anon, authenticated;
revoke execute on function public.request_consultation(text, text, text) from public, anon;
grant execute on function public.request_consultation(text, text, text) to authenticated;

-- final check, as in 026: definers with an empty search_path; anon may run the new function and no other of this flow
do $$
declare v text;
begin
  select string_agg(p.proname, ', ') into v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('request_plan_interest','request_consultation')
     and not (p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""']);
  if v is not null then raise exception '030: not a definer with search_path '''': %', v; end if;
  if not has_function_privilege('anon', 'public.request_plan_interest(text, text, text)', 'execute') then
    raise exception '030: anon cannot execute request_plan_interest';
  end if;
  if has_function_privilege('anon', 'public.request_consultation(text, text, text)', 'execute') then
    raise exception '030: anon can execute request_consultation';
  end if;
  if not has_schema_privilege('anon', 'public', 'usage') then
    raise exception '030: anon has no usage on schema public, the landing page would get 401';
  end if;
end $$;
