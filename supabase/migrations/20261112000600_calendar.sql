-- =============================================================================
-- Household Hub: Phase 2, shared Google Calendar
-- -----------------------------------------------------------------------------
-- What this migration creates:
--   1. Member roles (owner / member); only owners manage the calendar link
--   2. calendar_connections: one Google Calendar link per household
--   3. Refresh-token helpers backed by Supabase Vault (server-only)
--   4. calendar_events: the local copy of the family calendar
--   5. RPCs the app calls, RLS, realtime and function permissions
--
-- Who writes what:
--   * The browser can READ calendar_events and the connection status.
--   * Every write goes through Next.js server routes using the service-role
--     key, because each change must be sent to Google first.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- STEP 1: Member roles
-- -----------------------------------------------------------------------------

alter table public.members
  add column role text not null default 'member'
  check (role in ('owner', 'member'));

-- Step 1a: the first person in each existing household becomes its owner.
update public.members m
   set role = 'owner'
 where m.id in (
   select distinct on (household_id) id
   from public.members
   order by household_id, created_at
 );

-- Step 1b: members may edit their own row (name, photo) but never their role.
--          SECURITY DEFINER functions run as the table owner and may change it.
create or replace function public.members_protect_role()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.role is distinct from old.role and current_user in ('authenticated', 'anon') then
    raise exception 'role_change_not_allowed';
  end if;
  return new;
end;
$$;

create trigger members_protect_role
  before update on public.members
  for each row execute function public.members_protect_role();

-- Step 1c: the household's creator becomes its owner from now on.
create or replace function public.create_household(
  p_name         text,
  p_display_name text,
  p_avatar_url   text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_household_id uuid;
begin
  perform public.assert_can_onboard();

  insert into public.households (name)
  values (coalesce(nullif(btrim(p_name), ''), 'Our home'))
  returning id into v_household_id;

  insert into public.members (household_id, user_id, display_name, email, avatar_url, role)
  values (
    v_household_id,
    auth.uid(),
    coalesce(nullif(btrim(p_display_name), ''), split_part(auth.jwt() ->> 'email', '@', 1)),
    lower(auth.jwt() ->> 'email'),
    p_avatar_url,
    'owner'
  );

  insert into public.lists (household_id, name, type, is_default, sort_order) values
    (v_household_id, 'Groceries', 'shopping', true,  0),
    (v_household_id, 'To-do',     'todo',     false, 1);

  return v_household_id;
end;
$$;

-- Step 1d: is the signed-in user an owner of their household?
create or replace function public.is_household_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.members m
    where m.user_id = auth.uid()
      and m.household_id = public.current_household_id()
      and m.role = 'owner'
  );
$$;


-- -----------------------------------------------------------------------------
-- STEP 2: Calendar connection (one per household)
-- -----------------------------------------------------------------------------
-- Holds the sync bookkeeping. The refresh token itself lives in Vault; this
-- row only stores the Vault secret's id. No RLS policies: invisible to the
-- browser. The app reads a safe summary through calendar_connection_status().
create table public.calendar_connections (
  household_id         uuid primary key references public.households (id) on delete cascade,
  google_email         text not null,
  calendar_id          text not null,
  vault_secret_id      uuid not null,
  connected_by         uuid references public.members (id) on delete set null,
  sync_token           text,
  channel_id           text unique,
  channel_resource_id  text,
  channel_token        text,
  channel_expires_at   timestamptz,
  last_synced_at       timestamptz,
  status               text not null default 'active' check (status in ('active', 'error')),
  last_error           text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

alter table public.calendar_connections enable row level security;


-- -----------------------------------------------------------------------------
-- STEP 3: Refresh-token helpers (service role only)
-- -----------------------------------------------------------------------------

-- 3a. Store or replace the household's Google refresh token and connection.
create or replace function public.calendar_save_connection(
  p_household_id  uuid,
  p_google_email  text,
  p_calendar_id   text,
  p_refresh_token text,
  p_connected_by  uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing_secret uuid;
  v_secret_id       uuid;
begin
  -- Step 3a-1: reuse the Vault secret on reconnect, otherwise create one.
  select c.vault_secret_id into v_existing_secret
  from public.calendar_connections c
  where c.household_id = p_household_id;

  if v_existing_secret is not null then
    perform vault.update_secret(v_existing_secret, p_refresh_token);
    v_secret_id := v_existing_secret;
  else
    v_secret_id := vault.create_secret(
      p_refresh_token,
      'google_calendar_refresh_token_' || p_household_id::text,
      'Google Calendar refresh token for one household'
    );
  end if;

  -- Step 3a-2: (re)write the connection row; a reconnect starts a fresh sync.
  insert into public.calendar_connections as c (
    household_id, google_email, calendar_id, vault_secret_id, connected_by,
    sync_token, status, last_error, updated_at
  )
  values (
    p_household_id, lower(p_google_email), p_calendar_id, v_secret_id, p_connected_by,
    null, 'active', null, now()
  )
  on conflict (household_id) do update set
    google_email    = excluded.google_email,
    calendar_id     = excluded.calendar_id,
    vault_secret_id = excluded.vault_secret_id,
    connected_by    = excluded.connected_by,
    sync_token      = null,
    status          = 'active',
    last_error      = null,
    updated_at      = now();
end;
$$;

-- 3b. Read the decrypted refresh token for server-side use.
create or replace function public.calendar_get_refresh_token(p_household_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select s.decrypted_secret
  from public.calendar_connections c
  join vault.decrypted_secrets s on s.id = c.vault_secret_id
  where c.household_id = p_household_id;
$$;

-- 3c. Remove the connection, its Vault secret and all synced events.
create or replace function public.calendar_remove_connection(p_household_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secret_id uuid;
begin
  select c.vault_secret_id into v_secret_id
  from public.calendar_connections c
  where c.household_id = p_household_id;

  delete from public.calendar_events where household_id = p_household_id;
  delete from public.calendar_connections where household_id = p_household_id;

  if v_secret_id is not null then
    delete from vault.secrets where id = v_secret_id;
  end if;
end;
$$;


-- -----------------------------------------------------------------------------
-- STEP 4: Local copy of the family calendar
-- -----------------------------------------------------------------------------
-- One row per Google event resource:
--   * one-off events               recurrence null, recurring_event_id null
--   * repeating series (masters)   recurrence = RRULE/EXDATE lines
--   * changed or cancelled single occurrences of a series
--                                   recurring_event_id = master's id,
--                                   original_start = the slot it replaces
-- Timed events use start_at/end_at; all-day events use start_date/end_date
-- (end_date exclusive, as Google sends it).
create table public.calendar_events (
  id                  uuid primary key default gen_random_uuid(),
  household_id        uuid not null references public.households (id) on delete cascade,
  google_event_id     text not null,
  etag                text,
  status              text not null default 'confirmed',
  title               text not null default '',
  description         text,
  location            text,
  all_day             boolean not null default false,
  start_at            timestamptz,
  end_at              timestamptz,
  start_date          date,
  end_date            date,
  time_zone           text,
  recurrence          text[],
  recurring_event_id  text,
  original_start      text,
  added_by_member     uuid references public.members (id) on delete set null,
  html_link           text,
  google_updated_at   timestamptz,
  updated_at          timestamptz not null default now(),
  unique (household_id, google_event_id)
);
create index calendar_events_household_start_idx on public.calendar_events (household_id, start_at);
create index calendar_events_household_date_idx on public.calendar_events (household_id, start_date);

alter table public.calendar_events enable row level security;

-- Members read their household's calendar; there are no write policies.
create policy "calendar_events: household read"
  on public.calendar_events for select to authenticated
  using (household_id = public.current_household_id());


-- -----------------------------------------------------------------------------
-- STEP 5: RPCs, realtime and permissions
-- -----------------------------------------------------------------------------

-- 5a. Safe connection summary for the Household and Calendar screens.
create or replace function public.calendar_connection_status()
returns table (
  connected       boolean,
  google_email    text,
  status          text,
  last_synced_at  timestamptz,
  connected_by    text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    true,
    c.google_email,
    c.status,
    c.last_synced_at,
    m.display_name
  from public.calendar_connections c
  left join public.members m on m.id = c.connected_by
  where c.household_id = public.current_household_id();
$$;

-- 5b. Live updates to the other phones.
alter publication supabase_realtime add table public.calendar_events;

-- 5c. Lock down the new functions, then open what the browser needs.
revoke execute on function
  public.members_protect_role(),
  public.is_household_owner(),
  public.calendar_save_connection(uuid, text, text, text, uuid),
  public.calendar_get_refresh_token(uuid),
  public.calendar_remove_connection(uuid),
  public.calendar_connection_status()
from public, anon, authenticated;

grant execute on function
  public.is_household_owner(),
  public.calendar_connection_status()
to authenticated;

grant execute on function
  public.calendar_save_connection(uuid, text, text, text, uuid),
  public.calendar_get_refresh_token(uuid),
  public.calendar_remove_connection(uuid)
to service_role;
