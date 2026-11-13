-- =============================================================================
-- HomeHub: bin collection days
-- -----------------------------------------------------------------------------
-- Breda's Afvalservice app has no feed and shows about two months ahead, so
-- the dates are entered by hand (a recurring chore reminds someone to add the
-- next batch). One row per bin type per collection date.
--
-- Also adds the bins reminder to notification_prefs: the evening before a
-- collection ("Put the plastic out tonight").
-- =============================================================================

-- STEP 1: collection dates
create table public.bin_days (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households (id) on delete cascade,
  -- Must match BIN_KINDS in src/lib/bins.ts.
  kind          text not null check (kind in ('gft', 'plastic', 'paper', 'rest', 'glass', 'textile')),
  date          date not null,
  created_at    timestamptz not null default now(),
  unique (household_id, kind, date)
);
create index bin_days_household_date_idx on public.bin_days (household_id, date);

-- STEP 2: the evening-before reminder
alter table public.notification_prefs
  add column bins boolean not null default true,
  add column bins_time time not null default '19:00';

-- STEP 3: everyone reads, adults change (same as the rest of the plan)
alter table public.bin_days enable row level security;

create policy "bin_days: household read" on public.bin_days for select to authenticated
  using (household_id = public.current_household_id());
create policy "bin_days: adults write" on public.bin_days for all to authenticated
  using (household_id = public.current_household_id() and public.is_household_adult())
  with check (household_id = public.current_household_id() and public.is_household_adult());

alter publication supabase_realtime add table public.bin_days;
