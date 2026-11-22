-- =============================================================================
-- HomeHub: secret trips (a surprise)
-- -----------------------------------------------------------------------------
-- trips.visible_to: null for a normal trip; for a secret trip, the members
-- who can see it (the person who made it secret is always included).
--
-- For everyone else the trip doesn't exist: the trip, its travellers, stays,
-- plans, packing list, budget, rates and documents (rows AND the stored
-- files) are hidden by the access rules below, so no screen, calendar, Today
-- card, board or realtime update can show it. The check-in reminder (the only
-- notification that names a trip) is filtered per person in the 5-minute job.
--
-- "Reveal trip" sets visible_to back to null: a normal shared trip.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- STEP 1: who can see a secret trip
-- -----------------------------------------------------------------------------
alter table public.trips add column visible_to uuid[];

comment on column public.trips.visible_to is 'Secret trip: only these members can see it (null: everyone with Trips access).';

-- 1a. Can I see this trip? (Trips access is checked by the policies as before.)
create or replace function public.can_see_trip(p_trip_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.trips t
    where t.id = p_trip_id
      and t.household_id = public.current_household_id()
      and (t.visible_to is null or public.current_member_id() = any (t.visible_to))
  );
$$;

-- 1b. The same for a stored file's path: <household>/<trip>/<file>.
create or replace function public.can_see_trip_path(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_trip uuid;
begin
  begin
    v_trip := split_part(p_name, '/', 2)::uuid;
  exception when others then
    return false;
  end;
  return public.can_see_trip(v_trip);
end;
$$;

-- 1c. Making a trip secret: only adults of this household on the list, and
--     never hiding it from the person doing it.
create or replace function public.trips_check_visible_to()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := public.current_member_id();
begin
  if new.visible_to is null then
    return new;
  end if;
  select array_agg(distinct m.id) into new.visible_to
  from public.members m
  where m.household_id = new.household_id and m.role in ('owner', 'adult')
    and (m.id = any (new.visible_to) or m.id = v_me);
  if new.visible_to is null or cardinality(new.visible_to) = 0 then
    raise exception 'secret_needs_someone';
  end if;
  return new;
end;
$$;

create trigger trips_check_visible_to
  before insert or update of visible_to on public.trips
  for each row execute function public.trips_check_visible_to();


-- -----------------------------------------------------------------------------
-- STEP 2: the access rules, now also asking "can I see this trip?"
-- -----------------------------------------------------------------------------
-- 2a. The trip itself.
drop policy "trips: read with access" on public.trips;
drop policy "trips: adults with access write" on public.trips;
create policy "trips: read with access" on public.trips for select to authenticated
  using (household_id = public.current_household_id() and public.can_see_trips()
         and (visible_to is null or public.current_member_id() = any (visible_to)));
create policy "trips: adults with access write" on public.trips for all to authenticated
  using (household_id = public.current_household_id() and public.can_edit_trips()
         and (visible_to is null or public.current_member_id() = any (visible_to)))
  with check (household_id = public.current_household_id() and public.can_edit_trips()
         and (visible_to is null or public.current_member_id() = any (visible_to)));

-- 2b. Everything in it (read + write).
drop policy "trip_participants: read with access" on public.trip_participants;
drop policy "trip_participants: adults with access write" on public.trip_participants;
create policy "trip_participants: read with access" on public.trip_participants for select to authenticated
  using (household_id = public.current_household_id() and public.can_see_trips() and public.can_see_trip(trip_id));
create policy "trip_participants: adults with access write" on public.trip_participants for all to authenticated
  using (household_id = public.current_household_id() and public.can_edit_trips() and public.can_see_trip(trip_id))
  with check (household_id = public.current_household_id() and public.can_edit_trips() and public.can_see_trip(trip_id));

drop policy "trip_stays: read with access" on public.trip_stays;
drop policy "trip_stays: adults with access write" on public.trip_stays;
create policy "trip_stays: read with access" on public.trip_stays for select to authenticated
  using (household_id = public.current_household_id() and public.can_see_trips() and public.can_see_trip(trip_id));
create policy "trip_stays: adults with access write" on public.trip_stays for all to authenticated
  using (household_id = public.current_household_id() and public.can_edit_trips() and public.can_see_trip(trip_id))
  with check (household_id = public.current_household_id() and public.can_edit_trips() and public.can_see_trip(trip_id));

drop policy "trip_plans: read with access" on public.trip_plans;
drop policy "trip_plans: adults with access write" on public.trip_plans;
create policy "trip_plans: read with access" on public.trip_plans for select to authenticated
  using (household_id = public.current_household_id() and public.can_see_trips() and public.can_see_trip(trip_id));
create policy "trip_plans: adults with access write" on public.trip_plans for all to authenticated
  using (household_id = public.current_household_id() and public.can_edit_trips() and public.can_see_trip(trip_id))
  with check (household_id = public.current_household_id() and public.can_edit_trips() and public.can_see_trip(trip_id));

drop policy "trip_checklist: read with access" on public.trip_checklist;
drop policy "trip_checklist: adults with access write" on public.trip_checklist;
create policy "trip_checklist: read with access" on public.trip_checklist for select to authenticated
  using (household_id = public.current_household_id() and public.can_see_trips() and public.can_see_trip(trip_id));
create policy "trip_checklist: adults with access write" on public.trip_checklist for all to authenticated
  using (household_id = public.current_household_id() and public.can_edit_trips() and public.can_see_trip(trip_id))
  with check (household_id = public.current_household_id() and public.can_edit_trips() and public.can_see_trip(trip_id));

drop policy "trip_budget: adults with access" on public.trip_budget;
create policy "trip_budget: adults with access" on public.trip_budget for all to authenticated
  using (household_id = public.current_household_id() and public.can_edit_trips() and public.can_see_trip(trip_id))
  with check (household_id = public.current_household_id() and public.can_edit_trips() and public.can_see_trip(trip_id));

drop policy "trip_rates: adults with access" on public.trip_rates;
create policy "trip_rates: adults with access" on public.trip_rates for all to authenticated
  using (household_id = public.current_household_id() and public.can_edit_trips() and public.can_see_trip(trip_id))
  with check (household_id = public.current_household_id() and public.can_edit_trips() and public.can_see_trip(trip_id));

drop policy "trip_documents: adults with access" on public.trip_documents;
create policy "trip_documents: adults with access" on public.trip_documents for all to authenticated
  using (household_id = public.current_household_id() and public.can_edit_trips() and public.can_see_trip(trip_id))
  with check (household_id = public.current_household_id() and public.can_edit_trips() and public.can_see_trip(trip_id));


-- [storage:start] ---------------------------------------------------------
-- 2c. The stored files (booking PDFs etc.): the trip's folder is hidden too.
--     (Supabase Storage only; the test database has no storage schema.)
drop policy "trip-documents: read own household" on storage.objects;
drop policy "trip-documents: upload own household" on storage.objects;
drop policy "trip-documents: delete own household" on storage.objects;
create policy "trip-documents: read own household" on storage.objects for select to authenticated
  using (
    bucket_id = 'trip-documents'
    and (storage.foldername(name))[1] = public.current_household_id()::text
    and public.can_edit_trips()
    and public.can_see_trip_path(name)
  );
create policy "trip-documents: upload own household" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'trip-documents'
    and (storage.foldername(name))[1] = public.current_household_id()::text
    and public.can_edit_trips()
    and public.can_see_trip_path(name)
  );
create policy "trip-documents: delete own household" on storage.objects for delete to authenticated
  using (
    bucket_id = 'trip-documents'
    and (storage.foldername(name))[1] = public.current_household_id()::text
    and public.can_edit_trips()
    and public.can_see_trip_path(name)
  );
-- [storage:end] -----------------------------------------------------------


-- -----------------------------------------------------------------------------
-- STEP 3: permissions
-- -----------------------------------------------------------------------------
revoke execute on function
  public.can_see_trip(uuid),
  public.can_see_trip_path(text),
  public.trips_check_visible_to()
from public, anon;
grant execute on function public.can_see_trip(uuid), public.can_see_trip_path(text) to authenticated;
revoke execute on function public.trips_check_visible_to() from authenticated;
