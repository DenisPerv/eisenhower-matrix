-- db/034_down_project_dir_list_order.sql: rollback of 034_project_dir_list_order.sql. Run by hand only, as admin SQL; it sorts
-- before 034, where it is a no-op on a database that never had it. Drops lists.project_dir with its values, the two RPCs and the
-- list-move trigger, and puts back the 032 key check of deploy_targets and the 032 action check of autonomy_events. It first
-- deletes the rows those older checks refuse (the deploy target 'tasksdashboard' - lists and items that name it lose it - and
-- the project_dir audit rows). Re-run 003 and its followers afterwards like after any schema change, then the selftests.

drop trigger if exists items_zzz_list_move on public.items;
drop function if exists public.items_list_move_reset();
drop function if exists public.household_list_order(uuid);
drop function if exists public.set_project_dir(uuid, text, text);

alter table public.lists drop constraint if exists lists_project_dir_path;
alter table public.lists drop column if exists project_dir;

delete from public.autonomy_events where action = 'project_dir';
alter table public.autonomy_events drop constraint if exists autonomy_events_action_check;
alter table public.autonomy_events add constraint autonomy_events_action_check
  check (action in ('autonomy', 'intake', 'brief', 'budget', 'precedent', 'precedent_revoke'));

update public.lists set deploy_target = null where deploy_target = 'tasksdashboard';
update public.items set deploy_target = null where deploy_target = 'tasksdashboard';
delete from public.deploy_targets where key = 'tasksdashboard';
alter table public.deploy_targets drop constraint if exists deploy_targets_key_check;
alter table public.deploy_targets add constraint deploy_targets_key_check check (
  key ~ '^[a-z0-9][a-z0-9-]{0,40}$'
  and key !~ '(tasksdashboard|tasks-dashboard|tasksboard|tasks-board|eisenhower-agentic-planner-app)');
