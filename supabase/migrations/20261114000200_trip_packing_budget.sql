-- =============================================================================
-- HomeHub: Trips (phase 2 — packing and the trip budget)
-- -----------------------------------------------------------------------------
-- Same model as Voyage, so its data imports one-to-one:
--
--   1. trip_checklist: packing items, one level of groups (an item becomes a
--      group when another item points at it), each optionally for one person
--      ("Lennon's bag").
--   2. checklist_templates: reusable lists ("Beach holiday", "Car rental"),
--      kept as JSON: [{ "text": "...", "children": ["...", ...] }].
--   3. trip_budget: items with amount, currency, category, paid or not.
--   4. trip_rates: manual exchange rates, 1 unit of currency = rate x the
--      trip's home currency.
--
--   5. school_days(): the school days in a date range, so a trip can warn
--      when a child would miss school.
--
-- Packing follows Trips access (children with access may look). The budget
-- and rates are for ADULTS with access only.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- STEP 1: packing
-- -----------------------------------------------------------------------------
create table public.trip_checklist (
  id           uuid primary key default gen_random_uuid(),
  trip_id      uuid not null references public.trips (id) on delete cascade,
  household_id uuid not null references public.households (id) on delete cascade,
  -- The group this item is in (one level only; checked by trigger).
  parent_id    uuid references public.trip_checklist (id) on delete cascade,
  text         text not null check (char_length(text) between 1 and 200),
  done         boolean not null default false,
  -- Who it's for; null = shared ("Sunscreen").
  member_id    uuid references public.members (id) on delete set null,
  sort_order   int not null default 0,
  created_at   timestamptz not null default now()
);
create index trip_checklist_trip_idx on public.trip_checklist (trip_id, sort_order);

-- 1a. A parent must be a top-level item of the same trip.
create or replace function public.trip_checklist_check_parent()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.parent_id is not null and not exists (
    select 1 from public.trip_checklist p
    where p.id = new.parent_id and p.trip_id = new.trip_id and p.parent_id is null
  ) then
    raise exception 'invalid_group';
  end if;
  return new;
end;
$$;

create trigger trip_checklist_check_parent
  before insert or update of parent_id, trip_id on public.trip_checklist
  for each row execute function public.trip_checklist_check_parent();

-- household_id from the trip (same function as phase 1).
create trigger trip_checklist_fill_household
  before insert or update of trip_id on public.trip_checklist
  for each row execute function public.trip_parts_fill_household();


-- -----------------------------------------------------------------------------
-- STEP 2: packing templates
-- -----------------------------------------------------------------------------
create table public.checklist_templates (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  name         text not null check (char_length(name) between 1 and 120),
  items        jsonb not null default '[]'::jsonb check (jsonb_typeof(items) = 'array'),
  created_at   timestamptz not null default now()
);


-- -----------------------------------------------------------------------------
-- STEP 3: the trip budget
-- -----------------------------------------------------------------------------
create table public.trip_budget (
  id           uuid primary key default gen_random_uuid(),
  trip_id      uuid not null references public.trips (id) on delete cascade,
  household_id uuid not null references public.households (id) on delete cascade,
  title        text not null check (char_length(title) between 1 and 200),
  category     text not null default 'Other'
               check (category in ('Transport', 'Accommodation', 'Food & drink', 'Activities', 'Shopping', 'Visas & fees', 'Other')),
  amount_cents bigint not null check (amount_cents >= 0 and amount_cents < 100000000000),
  currency     text not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  paid         boolean not null default false,
  date         date,
  created_at   timestamptz not null default now()
);
create index trip_budget_trip_idx on public.trip_budget (trip_id);

create trigger trip_budget_fill_household
  before insert or update of trip_id on public.trip_budget
  for each row execute function public.trip_parts_fill_household();

-- 3a. Exchange rates: 1 unit of `currency` = `rate` units of the home currency.
create table public.trip_rates (
  trip_id      uuid not null references public.trips (id) on delete cascade,
  household_id uuid not null references public.households (id) on delete cascade,
  currency     text not null check (currency ~ '^[A-Z]{3}$'),
  rate         numeric(18, 8) not null check (rate > 0),
  primary key (trip_id, currency)
);

create trigger trip_rates_fill_household
  before insert or update of trip_id on public.trip_rates
  for each row execute function public.trip_parts_fill_household();


-- -----------------------------------------------------------------------------
-- STEP 3b: school days in a range (for "the kids would miss school")
-- -----------------------------------------------------------------------------
-- Same rules as Today (day_mode: holidays, public holidays, overrides).
-- Any member may ask; the range is capped at a year.
create or replace function public.school_days(p_from date, p_to date)
returns setof date
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_household_id uuid := public.current_household_id();
begin
  if v_household_id is null then
    raise exception 'not_in_household';
  end if;
  if p_to < p_from or p_to - p_from > 366 then
    raise exception 'invalid_range';
  end if;
  return query
    select d::date
    from generate_series(p_from, p_to, interval '1 day') d
    where public.day_mode(v_household_id, d::date) = 'school';
end;
$$;


-- -----------------------------------------------------------------------------
-- STEP 4: who can do what
-- -----------------------------------------------------------------------------
alter table public.trip_checklist enable row level security;
alter table public.checklist_templates enable row level security;
alter table public.trip_budget enable row level security;
alter table public.trip_rates enable row level security;

-- 4a. Packing and templates: read with Trips access; adults with access write.
create policy "trip_checklist: read with access" on public.trip_checklist for select to authenticated
  using (household_id = public.current_household_id() and public.can_see_trips());
create policy "trip_checklist: adults with access write" on public.trip_checklist for all to authenticated
  using (household_id = public.current_household_id() and public.can_edit_trips())
  with check (household_id = public.current_household_id() and public.can_edit_trips());

create policy "checklist_templates: read with access" on public.checklist_templates for select to authenticated
  using (household_id = public.current_household_id() and public.can_see_trips());
create policy "checklist_templates: adults with access write" on public.checklist_templates for all to authenticated
  using (household_id = public.current_household_id() and public.can_edit_trips())
  with check (household_id = public.current_household_id() and public.can_edit_trips());

-- 4b. Money: adults with Trips access only, for reading too.
create policy "trip_budget: adults with access" on public.trip_budget for all to authenticated
  using (household_id = public.current_household_id() and public.can_edit_trips())
  with check (household_id = public.current_household_id() and public.can_edit_trips());
create policy "trip_rates: adults with access" on public.trip_rates for all to authenticated
  using (household_id = public.current_household_id() and public.can_edit_trips())
  with check (household_id = public.current_household_id() and public.can_edit_trips());

revoke execute on function
  public.trip_checklist_check_parent(),
  public.school_days(date, date)
from public, anon, authenticated;
grant execute on function public.school_days(date, date) to authenticated;

alter publication supabase_realtime add table public.trip_checklist, public.trip_budget, public.trip_rates;
