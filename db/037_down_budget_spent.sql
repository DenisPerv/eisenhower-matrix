-- db/037_down_budget_spent.sql: rollback of 037_budget_spent.sql. Run by hand only, as admin SQL. Drops budget_spent and puts back
-- 032's ledger check (only a reserve has no reservation_id). It first deletes the settle-only rows that check refuses, so their
-- cost leaves budget_status. Re-run 003 and its followers afterwards like after any schema change, then the selftests.

drop function if exists public.budget_spent(text, text, uuid, uuid, numeric);
delete from public.budget_ledger where kind = 'settle' and reservation_id is null;
alter table public.budget_ledger drop constraint if exists budget_ledger_reservation_link;
alter table public.budget_ledger drop constraint if exists budget_ledger_check;
alter table public.budget_ledger add constraint budget_ledger_check check ((kind = 'reserve') = (reservation_id is null));
