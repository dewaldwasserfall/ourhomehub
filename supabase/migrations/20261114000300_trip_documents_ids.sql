-- =============================================================================
-- HomeHub: Trips (phase 3 — documents, passport/ID expiry, reminders)
-- -----------------------------------------------------------------------------
--   1. trip_documents: tickets, bookings, insurance, visas per trip, with an
--      optional expiry date. The files live in a PRIVATE storage bucket,
--      under <household id>/<trip id>/...; the app opens them through
--      short-lived signed links.
--   2. member_ids: passport / ID card per person — country, expiry date and
--      the link to the 1Password item. Never the number or a scan: those
--      stay in 1Password.
--   3. notification_prefs: trip_checkin ("check in tomorrow") and id_expiry
--      (passport/ID expiring within 6 months, or before a trip's return).
--
-- All of it is for adults with Trips access only (children never see
-- documents or ID details).
-- =============================================================================


-- -----------------------------------------------------------------------------
-- STEP 1: trip documents
-- -----------------------------------------------------------------------------
create table public.trip_documents (
  id            uuid primary key default gen_random_uuid(),
  trip_id       uuid not null references public.trips (id) on delete cascade,
  household_id  uuid not null references public.households (id) on delete cascade,
  name          text not null check (char_length(name) between 1 and 200),
  category      text not null default 'Other'
                check (category in ('Flight', 'Hotel', 'Booking', 'Ticket', 'Visa', 'Insurance', 'Other')),
  -- Path in the trip-documents bucket: <household>/<trip>/<uuid>.<ext>
  storage_path  text not null unique,
  content_type  text not null default 'application/octet-stream',
  size_bytes    bigint not null default 0 check (size_bytes >= 0),
  expiry_date   date,
  created_by    uuid references public.members (id) on delete set null,
  created_at    timestamptz not null default now()
);
create index trip_documents_trip_idx on public.trip_documents (trip_id, category);

create trigger trip_documents_fill_household
  before insert or update of trip_id on public.trip_documents
  for each row execute function public.trip_parts_fill_household();

-- 1a. The file must sit in this trip's own folder.
create or replace function public.trip_documents_check_path()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_household uuid;
begin
  select t.household_id into v_household from public.trips t where t.id = new.trip_id;
  if new.storage_path not like v_household::text || '/' || new.trip_id::text || '/%' then
    raise exception 'invalid_path';
  end if;
  return new;
end;
$$;

create trigger trip_documents_check_path
  before insert or update of storage_path, trip_id on public.trip_documents
  for each row execute function public.trip_documents_check_path();


-- -----------------------------------------------------------------------------
-- STEP 2: passports and ID cards (expiry and the 1Password link only)
-- -----------------------------------------------------------------------------
create table public.member_ids (
  id               uuid primary key default gen_random_uuid(),
  household_id     uuid not null references public.households (id) on delete cascade,
  member_id        uuid not null references public.members (id) on delete cascade,
  kind             text not null check (kind in ('passport', 'id_card')),
  -- Issuing country, e.g. "Netherlands", "South Africa".
  country          text not null default '' check (char_length(country) <= 80),
  expiry_date      date not null,
  -- Link to the item in 1Password (https://start.1password.com/... or a
  -- onepassword:// app link). Never the document number.
  onepassword_url  text check (onepassword_url is null or onepassword_url ~ '^(https://|onepassword://)'),
  created_at       timestamptz not null default now()
);
create index member_ids_member_idx on public.member_ids (member_id);

-- 2a. household_id comes from the member (so it can't point elsewhere).
create or replace function public.member_ids_fill_household()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select m.household_id into new.household_id from public.members m where m.id = new.member_id;
  if new.household_id is null then
    raise exception 'member_not_found';
  end if;
  return new;
end;
$$;

create trigger member_ids_fill_household
  before insert or update of member_id on public.member_ids
  for each row execute function public.member_ids_fill_household();


-- -----------------------------------------------------------------------------
-- STEP 3: reminder settings
-- -----------------------------------------------------------------------------
alter table public.notification_prefs
  add column trip_checkin boolean not null default true,
  add column id_expiry    boolean not null default true;


-- -----------------------------------------------------------------------------
-- STEP 4: who can do what (adults with Trips access, for reading too)
-- -----------------------------------------------------------------------------
alter table public.trip_documents enable row level security;
alter table public.member_ids enable row level security;

create policy "trip_documents: adults with access" on public.trip_documents for all to authenticated
  using (household_id = public.current_household_id() and public.can_edit_trips())
  with check (household_id = public.current_household_id() and public.can_edit_trips());

create policy "member_ids: adults with access" on public.member_ids for all to authenticated
  using (household_id = public.current_household_id() and public.can_edit_trips())
  with check (household_id = public.current_household_id() and public.can_edit_trips());

revoke execute on function
  public.trip_documents_check_path(),
  public.member_ids_fill_household()
from public, anon, authenticated;


-- [storage:start] ---------------------------------------------------------
-- STEP 5: the private bucket and its rules (Supabase Storage only; the test
-- database has no storage schema, so the tests skip this block)
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'trip-documents', 'trip-documents', false, 26214400, -- 25 MB
  array['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp',
        'text/plain', 'application/vnd.apple.pkpass']
)
on conflict (id) do nothing;

-- Only adults with Trips access, only inside their own household's folder.
create policy "trip-documents: read own household" on storage.objects for select to authenticated
  using (
    bucket_id = 'trip-documents'
    and (storage.foldername(name))[1] = public.current_household_id()::text
    and public.can_edit_trips()
  );
create policy "trip-documents: upload own household" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'trip-documents'
    and (storage.foldername(name))[1] = public.current_household_id()::text
    and public.can_edit_trips()
  );
create policy "trip-documents: delete own household" on storage.objects for delete to authenticated
  using (
    bucket_id = 'trip-documents'
    and (storage.foldername(name))[1] = public.current_household_id()::text
    and public.can_edit_trips()
  );
-- [storage:end] -----------------------------------------------------------

alter publication supabase_realtime add table public.trip_documents, public.member_ids;
