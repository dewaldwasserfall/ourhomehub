-- =============================================================================
-- HomeHub: SmartThings (step 1 — connect, devices, live events)
-- -----------------------------------------------------------------------------
--   1. members.can_manage_home + can_manage_home() and the owner-only
--      set_home_access() RPC (same pattern as finances and trips). Owners
--      always can; adults when switched on; children never.
--   2. home_connections: one SmartThings connection per household. The OAuth
--      tokens live in Supabase Vault (like bunq), never in a table column.
--   3. home_devices: every device in the linked SmartThings location (TV,
--      washer, dryer, Hue lights linked into SmartThings, ...) with its last
--      known state.
--   4. home_events: device changes SmartThings sends us, kept 30 days; the
--      automations builder (a later step) will read these.
--   5. supplies.counted_by: a supply either runs down with routine/chore
--      ticks (as now) or only through automations, so a load of washing is
--      never counted twice.
--
-- The server (service role) writes devices and events; people only read.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- STEP 1: who may see and manage Home
-- -----------------------------------------------------------------------------
alter table public.members
  add column can_manage_home boolean not null default false;

comment on column public.members.can_manage_home is
  'Sees and controls SmartThings devices and builds automations. Owner-controlled; never true for children.';

-- 1a. Owner, or an adult the owner switched on.
create or replace function public.can_manage_home()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select m.role = 'owner' or (m.can_manage_home and m.role = 'adult')
    from public.members m
    where m.user_id = auth.uid() and m.household_id = public.current_household_id()
  ), false);
$$;

-- 1b. Only the owner changes the flag (through 1c).
create or replace function public.members_protect_home_access()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.can_manage_home is distinct from old.can_manage_home
     and current_user in ('authenticated', 'anon') then
    raise exception 'owner_only';
  end if;
  return new;
end;
$$;

create trigger members_protect_home_access
  before update of can_manage_home on public.members
  for each row execute function public.members_protect_home_access();

-- 1c. The owner switches it on or off for an adult.
create or replace function public.set_home_access(p_member_id uuid, p_allowed boolean)
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
    where m.id = p_member_id and m.household_id = public.current_household_id() and m.role in ('owner', 'adult')
  ) then
    raise exception 'member_not_in_household';
  end if;
  update public.members set can_manage_home = p_allowed where id = p_member_id;
end;
$$;


-- -----------------------------------------------------------------------------
-- STEP 2: the SmartThings connection
-- -----------------------------------------------------------------------------
create table public.home_connections (
  household_id      uuid primary key references public.households (id) on delete cascade,
  provider          text not null default 'smartthings' check (provider = 'smartthings'),
  vault_secret_id   uuid,
  -- SmartThings ids: the installed app (one per connection) and the location
  -- ("home") the owner picked when approving.
  installed_app_id  text,
  location_id       text,
  location_name     text,
  -- When the access token runs out (SmartThings: 24 hours); the cron job
  -- refreshes it before then.
  token_expires_at  timestamptz,
  status            text not null default 'active' check (status in ('active', 'error')),
  last_error        text,
  last_synced_at    timestamptz,
  last_event_at     timestamptz,
  -- SmartThings sends us device changes (needs the app's Target URL to be
  -- confirmed; until then devices are only read on sync).
  events_enabled    boolean not null default false,
  connected_by      uuid references public.members (id) on delete set null,
  created_at        timestamptz not null default now()
);
-- Webhook events name the installed app: find the household fast.
create unique index home_connections_installed_app_idx on public.home_connections (installed_app_id);


-- -----------------------------------------------------------------------------
-- STEP 3: devices and their last known state
-- -----------------------------------------------------------------------------
-- kind is HomeHub's own grouping (decides the icon and the controls shown);
-- capabilities are SmartThings capability ids, e.g. 'switch',
-- 'washerOperatingState', 'audioVolume'. state holds the latest value per
-- capability and attribute: {"switch": {"switch": "on"}, ...}.
create table public.home_devices (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households (id) on delete cascade,
  external_id   text not null,
  name          text not null,
  room          text,
  kind          text not null default 'other'
                check (kind in ('tv', 'washer', 'dryer', 'dishwasher', 'light', 'switch', 'sensor', 'other')),
  capabilities  text[] not null default '{}',
  state         jsonb not null default '{}'::jsonb,
  -- SmartThings still lists it (false once removed there; kept so rules
  -- that name it can say so instead of silently breaking).
  present       boolean not null default true,
  updated_at    timestamptz not null default now(),
  unique (household_id, external_id)
);


-- -----------------------------------------------------------------------------
-- STEP 4: device events (30 days)
-- -----------------------------------------------------------------------------
create table public.home_events (
  id            bigint generated always as identity primary key,
  household_id  uuid not null references public.households (id) on delete cascade,
  device_id     uuid references public.home_devices (id) on delete cascade,
  capability    text not null,
  attribute     text not null,
  value         jsonb,
  -- The value just before, so "changed from running to finished" is easy.
  previous      jsonb,
  occurred_at   timestamptz not null default now()
);
create index home_events_household_time_idx on public.home_events (household_id, occurred_at desc);
create index home_events_device_time_idx on public.home_events (device_id, occurred_at desc);

-- 4a. Record one event and update the device's state (server only). Returns
--     the event id, or null when the value didn't change (SmartThings often
--     re-reports the same value: those aren't events for us).
create or replace function public.home_record_event(
  p_household_id uuid,
  p_external_id  text,
  p_capability   text,
  p_attribute    text,
  p_value        jsonb,
  p_occurred_at  timestamptz
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device   public.home_devices;
  v_previous jsonb;
  v_id       bigint;
begin
  -- Step 4a-1: a device we know (new devices arrive with the next sync).
  select * into v_device from public.home_devices d
   where d.household_id = p_household_id and d.external_id = p_external_id;
  if v_device.id is null then
    return null;
  end if;

  -- Step 4a-2: unchanged? Nothing to record.
  v_previous := v_device.state -> p_capability -> p_attribute;
  if v_previous is not distinct from p_value then
    return null;
  end if;

  -- Step 4a-3: store the new state and the event.
  update public.home_devices
     set state = jsonb_set(
                   case when state ? p_capability then state else state || jsonb_build_object(p_capability, '{}'::jsonb) end,
                   array[p_capability, p_attribute], coalesce(p_value, 'null'::jsonb), true),
         updated_at = now()
   where id = v_device.id;

  insert into public.home_events (household_id, device_id, capability, attribute, value, previous, occurred_at)
  values (p_household_id, v_device.id, p_capability, p_attribute, p_value, v_previous, coalesce(p_occurred_at, now()))
  returning id into v_id;

  update public.home_connections set last_event_at = now() where household_id = p_household_id;
  return v_id;
end;
$$;

-- 4b. Forget events older than 30 days (called by the cron job).
create or replace function public.home_prune_events()
returns int
language sql
security definer
set search_path = public
as $$
  with gone as (delete from public.home_events where occurred_at < now() - interval '30 days' returning 1)
  select count(*)::int from gone;
$$;


-- -----------------------------------------------------------------------------
-- STEP 5: Vault access for the tokens (server only)
-- -----------------------------------------------------------------------------

-- 5a. Save (or replace) the token JSON; creates or reactivates the connection.
create or replace function public.home_save_credentials(
  p_household_id     uuid,
  p_credentials      text,
  p_installed_app_id text,
  p_expires_at       timestamptz,
  p_connected_by     uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secret_id uuid;
begin
  select c.vault_secret_id into v_secret_id from public.home_connections c where c.household_id = p_household_id;

  if v_secret_id is not null then
    perform vault.update_secret(v_secret_id, p_credentials);
  else
    v_secret_id := vault.create_secret(
      p_credentials,
      'smartthings_credentials_' || p_household_id::text,
      'SmartThings OAuth access and refresh token for one household'
    );
  end if;

  insert into public.home_connections (household_id, vault_secret_id, installed_app_id, token_expires_at, connected_by, status, last_error)
  values (p_household_id, v_secret_id, p_installed_app_id, p_expires_at, p_connected_by, 'active', null)
  on conflict (household_id) do update set
    vault_secret_id  = excluded.vault_secret_id,
    installed_app_id = coalesce(excluded.installed_app_id, home_connections.installed_app_id),
    token_expires_at = excluded.token_expires_at,
    connected_by     = coalesce(excluded.connected_by, home_connections.connected_by),
    status           = 'active',
    last_error       = null;
end;
$$;

-- 5b. Read the token JSON.
create or replace function public.home_get_credentials(p_household_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select s.decrypted_secret
  from public.home_connections c
  join vault.decrypted_secrets s on s.id = c.vault_secret_id
  where c.household_id = p_household_id;
$$;

-- 5c. Disconnect: forget the tokens, devices and events.
create or replace function public.home_remove_connection(p_household_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secret_id uuid;
begin
  select c.vault_secret_id into v_secret_id from public.home_connections c where c.household_id = p_household_id;
  delete from public.home_devices where household_id = p_household_id;
  delete from public.home_connections where household_id = p_household_id;
  if v_secret_id is not null then
    delete from vault.secrets where id = v_secret_id;
  end if;
end;
$$;


-- -----------------------------------------------------------------------------
-- STEP 6: supplies counted by routine ticks, or by automations only
-- -----------------------------------------------------------------------------
alter table public.supplies
  add column counted_by text not null default 'tasks' check (counted_by in ('tasks', 'automations'));

comment on column public.supplies.counted_by is
  'tasks: a tick on a linked routine step or chore uses one. automations: only Home automations use it (so a washer rule and a washing task never both count).';

-- 6a-c. Same as 20261114000500 step 4, but only for supplies counted by ticks.
create or replace function public.supplies_after_completion_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_supply_id uuid;
begin
  if new.pending then
    return null;
  end if;
  for v_supply_id in
    update public.supplies s
       set uses_left = greatest(0, s.uses_left - 1)
      from public.supply_uses u
     where u.supply_id = s.id and u.kind = new.kind and u.task_id = new.item_id
       and s.counted_by = 'tasks'
    returning s.id
  loop
    perform public.supply_check(v_supply_id);
  end loop;
  return null;
end;
$$;

create or replace function public.supplies_after_completion_confirm()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_supply_id uuid;
begin
  if old.pending and not new.pending then
    for v_supply_id in
      update public.supplies s
         set uses_left = greatest(0, s.uses_left - 1)
        from public.supply_uses u
       where u.supply_id = s.id and u.kind = new.kind and u.task_id = new.item_id
         and s.counted_by = 'tasks'
      returning s.id
    loop
      perform public.supply_check(v_supply_id);
    end loop;
  end if;
  return null;
end;
$$;

create or replace function public.supplies_after_completion_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.pending then
    return null;
  end if;
  if (select a.household_id from public.completion_assignee(old.kind, old.item_id) a) is null then
    return null;
  end if;
  update public.supplies s
     set uses_left = s.uses_left + 1
    from public.supply_uses u
   where u.supply_id = s.id and u.kind = old.kind and u.task_id = old.item_id
     and old.done_at >= u.created_at
     and s.counted_by = 'tasks';
  return null;
end;
$$;


-- -----------------------------------------------------------------------------
-- STEP 7: RLS and permissions
-- -----------------------------------------------------------------------------
alter table public.home_connections enable row level security;
alter table public.home_devices     enable row level security;
alter table public.home_events      enable row level security;

-- Read-only for those who manage Home; the server writes. vault_secret_id is
-- just a pointer: the tokens are only reachable through the RPCs above.
create policy "home_connections: managers read" on public.home_connections for select to authenticated
  using (household_id = public.current_household_id() and public.can_manage_home());
create policy "home_devices: managers read" on public.home_devices for select to authenticated
  using (household_id = public.current_household_id() and public.can_manage_home());
create policy "home_events: managers read" on public.home_events for select to authenticated
  using (household_id = public.current_household_id() and public.can_manage_home());

revoke execute on function
  public.can_manage_home(),
  public.members_protect_home_access(),
  public.set_home_access(uuid, boolean),
  public.home_record_event(uuid, text, text, text, jsonb, timestamptz),
  public.home_prune_events(),
  public.home_save_credentials(uuid, text, text, timestamptz, uuid),
  public.home_get_credentials(uuid),
  public.home_remove_connection(uuid)
from public, anon, authenticated;

grant execute on function
  public.can_manage_home(),
  public.set_home_access(uuid, boolean)
to authenticated;

grant execute on function
  public.home_record_event(uuid, text, text, text, jsonb, timestamptz),
  public.home_prune_events(),
  public.home_save_credentials(uuid, text, text, timestamptz, uuid),
  public.home_get_credentials(uuid),
  public.home_remove_connection(uuid)
to service_role;

-- Live updates for the Home screen.
alter publication supabase_realtime add table public.home_devices;
