-- =============================================================================
-- HomeHub: Trips (phase 1 — trips, who's going, stays, day plans)
-- -----------------------------------------------------------------------------
-- Voyage's trip planner, folded into HomeHub. Private to the people the
-- owner chooses (Dewald and Anél to start; maybe the kids later):
--
--   1. members.can_see_trips + can_see_trips()/can_edit_trips() helpers and
--      the owner-only set_trips_access() RPC (same pattern as finances).
--      Anyone with access may READ trips; only adults with access may change
--      them (so the kids can be given a read-only view later).
--   2. trips: name, destination, dates, notes, home currency, budget, and
--      the emergency card.
--   3. trip_participants: who's going, with optional join/leave dates.
--   4. trip_stays: where you sleep (check-in / check-out dates).
--   5. trip_plans: the day-by-day itinerary (date, optional time).
--
-- Packing, budget and documents follow in later phases.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- STEP 1: who can see trips
-- -----------------------------------------------------------------------------
alter table public.members
  add column can_see_trips boolean not null default false;

comment on column public.members.can_see_trips is
  'Sees Trips. Owner-controlled; children may be given read-only access.';

-- Start with the people who already see the household money (Dewald, Anél).
update public.members set can_see_trips = true where role = 'owner' or can_see_finances;

-- 1a. May I see trips? The owner always; others the owner chose.
create or replace function public.can_see_trips()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select m.role = 'owner' or m.can_see_trips
    from public.members m
    where m.user_id = auth.uid() and m.household_id = public.current_household_id()
  ), false);
$$;

-- 1b. May I change trips? Adults with access (children only ever read).
create or replace function public.can_edit_trips()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.can_see_trips() and public.is_household_adult();
$$;

-- 1c. Members may update their own row (name, theme): stop them changing
--     this column themselves.
create or replace function public.members_protect_trips_access()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.can_see_trips is distinct from old.can_see_trips
     and current_user in ('authenticated', 'anon') then
    raise exception 'owner_only';
  end if;
  return new;
end;
$$;

create trigger members_protect_trips_access
  before update of can_see_trips on public.members
  for each row execute function public.members_protect_trips_access();

-- 1d. The owner gives or removes access for anyone in the household.
create or replace function public.set_trips_access(p_member_id uuid, p_allowed boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_household_owner() then
    raise exception 'owner_only';
  end if;
  if not exists (
    select 1 from public.members m
    where m.id = p_member_id and m.household_id = public.current_household_id()
  ) then
    raise exception 'member_not_in_household';
  end if;
  update public.members set can_see_trips = p_allowed where id = p_member_id;
end;
$$;


-- -----------------------------------------------------------------------------
-- STEP 2: trips
-- -----------------------------------------------------------------------------
create table public.trips (
  id                   uuid primary key default gen_random_uuid(),
  household_id         uuid not null references public.households (id) on delete cascade,
  name                 text not null check (char_length(name) between 1 and 120),
  destination          text not null default '' check (char_length(destination) <= 200),
  start_date           date not null,
  end_date             date not null,
  notes                text not null default '' check (char_length(notes) <= 5000),
  home_currency        text not null default 'EUR' check (home_currency ~ '^[A-Z]{3}$'),
  planned_budget_cents bigint check (planned_budget_cents is null or planned_budget_cents >= 0),
  -- { embassy, insurance_policy, insurance_phone, contacts, notes }
  emergency            jsonb not null default '{}'::jsonb,
  created_by           uuid references public.members (id) on delete set null,
  created_at           timestamptz not null default now(),
  check (end_date >= start_date),
  check (end_date - start_date <= 366)
);
create index trips_household_dates_idx on public.trips (household_id, start_date);


-- -----------------------------------------------------------------------------
-- STEP 3: the trip's parts (each carries household_id for simple RLS)
-- -----------------------------------------------------------------------------

-- 3a. Who's going. No dates = the whole trip.
create table public.trip_participants (
  trip_id      uuid not null references public.trips (id) on delete cascade,
  household_id uuid not null references public.households (id) on delete cascade,
  member_id    uuid not null references public.members (id) on delete cascade,
  join_date    date,
  leave_date   date,
  primary key (trip_id, member_id),
  check (leave_date is null or join_date is null or leave_date >= join_date)
);

-- 3b. Where you sleep: the nights from check-in up to (not including) check-out.
create table public.trip_stays (
  id           uuid primary key default gen_random_uuid(),
  trip_id      uuid not null references public.trips (id) on delete cascade,
  household_id uuid not null references public.households (id) on delete cascade,
  name         text not null check (char_length(name) between 1 and 200),
  location     text not null default '' check (char_length(location) <= 300),
  check_in     date not null,
  check_out    date not null,
  booking_ref  text not null default '' check (char_length(booking_ref) <= 200),
  notes        text not null default '' check (char_length(notes) <= 2000),
  created_at   timestamptz not null default now(),
  check (check_out > check_in)
);
create index trip_stays_trip_idx on public.trip_stays (trip_id, check_in);

-- 3c. The day plans (flights, visits, dinners). Time is optional.
create table public.trip_plans (
  id           uuid primary key default gen_random_uuid(),
  trip_id      uuid not null references public.trips (id) on delete cascade,
  household_id uuid not null references public.households (id) on delete cascade,
  day          date not null,
  time         time,
  title        text not null check (char_length(title) between 1 and 200),
  details      text not null default '' check (char_length(details) <= 2000),
  created_at   timestamptz not null default now()
);
create index trip_plans_trip_idx on public.trip_plans (trip_id, day, time);

-- 3d. household_id always comes from the trip, so a part can't be attached
--     to another household's trip (RLS then checks it's ours).
create or replace function public.trip_parts_fill_household()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select t.household_id into new.household_id from public.trips t where t.id = new.trip_id;
  if new.household_id is null then
    raise exception 'trip_not_found';
  end if;
  return new;
end;
$$;

create trigger trip_participants_fill_household
  before insert or update of trip_id on public.trip_participants
  for each row execute function public.trip_parts_fill_household();
create trigger trip_stays_fill_household
  before insert or update of trip_id on public.trip_stays
  for each row execute function public.trip_parts_fill_household();
create trigger trip_plans_fill_household
  before insert or update of trip_id on public.trip_plans
  for each row execute function public.trip_parts_fill_household();

-- 3e. A participant must be in the trip's household. (Looks the trip up
--     itself: triggers run alphabetically, so household_id may not be
--     filled yet.)
create or replace function public.trip_participants_check_member()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.members m join public.trips t on t.household_id = m.household_id
    where m.id = new.member_id and t.id = new.trip_id
  ) then
    raise exception 'member_not_in_household';
  end if;
  return new;
end;
$$;

create trigger trip_participants_check_member
  before insert or update of member_id on public.trip_participants
  for each row execute function public.trip_participants_check_member();


-- -----------------------------------------------------------------------------
-- STEP 4: who can do what
-- -----------------------------------------------------------------------------
alter table public.trips enable row level security;
alter table public.trip_participants enable row level security;
alter table public.trip_stays enable row level security;
alter table public.trip_plans enable row level security;

create policy "trips: read with access" on public.trips for select to authenticated
  using (household_id = public.current_household_id() and public.can_see_trips());
create policy "trips: adults with access write" on public.trips for all to authenticated
  using (household_id = public.current_household_id() and public.can_edit_trips())
  with check (household_id = public.current_household_id() and public.can_edit_trips());

create policy "trip_participants: read with access" on public.trip_participants for select to authenticated
  using (household_id = public.current_household_id() and public.can_see_trips());
create policy "trip_participants: adults with access write" on public.trip_participants for all to authenticated
  using (household_id = public.current_household_id() and public.can_edit_trips())
  with check (household_id = public.current_household_id() and public.can_edit_trips());

create policy "trip_stays: read with access" on public.trip_stays for select to authenticated
  using (household_id = public.current_household_id() and public.can_see_trips());
create policy "trip_stays: adults with access write" on public.trip_stays for all to authenticated
  using (household_id = public.current_household_id() and public.can_edit_trips())
  with check (household_id = public.current_household_id() and public.can_edit_trips());

create policy "trip_plans: read with access" on public.trip_plans for select to authenticated
  using (household_id = public.current_household_id() and public.can_see_trips());
create policy "trip_plans: adults with access write" on public.trip_plans for all to authenticated
  using (household_id = public.current_household_id() and public.can_edit_trips())
  with check (household_id = public.current_household_id() and public.can_edit_trips());

revoke execute on function
  public.can_see_trips(),
  public.can_edit_trips(),
  public.members_protect_trips_access(),
  public.set_trips_access(uuid, boolean),
  public.trip_parts_fill_household(),
  public.trip_participants_check_member()
from public, anon, authenticated;

grant execute on function
  public.can_see_trips(),
  public.can_edit_trips(),
  public.set_trips_access(uuid, boolean)
to authenticated;

alter publication supabase_realtime add table public.trips, public.trip_participants, public.trip_stays, public.trip_plans;
