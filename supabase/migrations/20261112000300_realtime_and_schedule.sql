-- =============================================================================
-- Household Hub: live sync and the nightly suggestion job (V1)
-- -----------------------------------------------------------------------------
-- Kept separate from the schema because both statements depend on Supabase
-- platform features (the realtime publication and the pg_cron extension).
-- =============================================================================


-- -----------------------------------------------------------------------------
-- STEP 1: Live sync
-- -----------------------------------------------------------------------------
-- Broadcast changes to list lines and lists so both phones update instantly.
-- Realtime still applies RLS, so each household only hears its own changes.
alter publication supabase_realtime add table public.list_entries;
alter publication supabase_realtime add table public.lists;


-- -----------------------------------------------------------------------------
-- STEP 2: Nightly suggestion job
-- -----------------------------------------------------------------------------
-- Runs the engine for every household at 04:15 UTC (05:15 / 06:15 in the
-- Netherlands), so the list is ready before anyone wakes up. The app also
-- runs it on demand whenever a shopping list is opened.
create extension if not exists pg_cron with schema pg_catalog;

select cron.schedule(
  'household-hub-nightly-suggestions',
  '15 4 * * *',
  $$ select public.run_all_predictions(); $$
);
