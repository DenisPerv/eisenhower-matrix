-- db/028_access_request_buttons.sql: Approve and Decline buttons on access-request tasks.
-- A task with details.decision (two labels) shows the decision block above its description, on the board and in the phone
-- app (the block self-improvement cards use). A click stores the answer and sets the task done; cli/access.mjs process
-- reads the answer, also from closed tasks, and writes applied_at. The first word of the description still counts where
-- there are no buttons (Telegram, another client).
--
-- What it changes:
--   - request_access(): the same as db/015, with details.decision and a new first line in the description.
--   - open tasks of pending requests get the same details.decision and description line.
-- Rollback: re-run the request_access() block of db/015; a task keeps details.decision, which is harmless. Re-runnable.

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
          'Use Approve or Decline above. Without the buttons (Telegram, another client): write Approved or Declined as the first word of this description.' || E'\n\n'
          || '- Email: ' || v_email || E'\n'
          || '- Name: ' || coalesce(nullif(concat_ws(' ', v_first, v_last), ''), '-') || E'\n'
          || '- Requested: ' || to_char(v_row.requested_at at time zone 'Europe/Lisbon', 'YYYY-MM-DD HH24:MI') || ' Europe/Lisbon',
          v_due, jsonb_build_object('notify', jsonb_build_array('maksym', 'anastasiia'), 'access_request_id', v_row.id,
                                    'email', v_email,
                                    'decision', jsonb_build_object('v', 1, 'label_1', 'Approve', 'label_0', 'Decline', 'answer', null,
                                      'answered_by', null, 'answered_at', null, 'applied_at', null, 'applied_result', null)),
          'rpc:request_access', 'tasksdashboard', v_row.id::text, 'access-request:' || v_row.id)
  returning id into v_item;
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);

  update public.users_pending_for_decision set item_id = v_item where id = v_row.id;
  return public.access_request_json(v_row.id);
end $$;

-- the open tasks of pending requests get the buttons; a description a person already changed keeps its text
update public.items i
   set details = coalesce(i.details, '{}'::jsonb)
                 || jsonb_build_object('decision', jsonb_build_object('v', 1, 'label_1', 'Approve', 'label_0', 'Decline', 'answer', null,
                      'answered_by', null, 'answered_at', null, 'applied_at', null, 'applied_result', null)),
       body_md = case when i.body_md like 'Write Approved or Declined as the first word of this description.%'
                      then 'Use Approve or Decline above. Without the buttons (Telegram, another client): write Approved or Declined as the first word of this description.'
                           || substr(i.body_md, length('Write Approved or Declined as the first word of this description.') + 1)
                      else i.body_md end
  from public.users_pending_for_decision r
 where i.list_id = public.access_list_id()
   and i.details->>'access_request_id' = r.id::text
   and r.status = 'pending'
   and i.deleted_at is null
   and i.status not in ('done', 'cancelled')
   and not (coalesce(i.details, '{}'::jsonb) ? 'decision');
