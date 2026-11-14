-- =============================================================================
-- HomeHub: the AEG dishwasher (Electrolux Group API)
-- -----------------------------------------------------------------------------
--   * One appliance connection per household: the owner pastes the API key,
--     access token and refresh token from developer.electrolux.one once.
--     They live in Supabase Vault (like bunq and SmartThings).
--   * The 5-minute job reads the dishwasher's state and keeps the last known
--     state here, so Today and the Family board can show "40 min left".
--   * When a run finishes, appliance_run_finished() adds an unassigned to-do
--     "Empty the dishwasher" (once per run; not if one is still open).
--
-- The server (service role) writes; everyone in the household reads the
-- state (it's on Today and on the board); only the owner changes settings.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- STEP 1: the connection and the last known state
-- -----------------------------------------------------------------------------
create table public.appliance_connections (
  household_id     uuid primary key references public.households (id) on delete cascade,
  provider         text not null default 'electrolux' check (provider = 'electrolux'),
  vault_secret_id  uuid,
  -- The appliance (Electrolux ids and names).
  appliance_id     text,
  appliance_name   text,
  appliance_type   text,
  -- Last known state: OFF, IDLE, READY_TO_START, DELAYED_START, RUNNING,
  -- PAUSED, END_OF_CYCLE (Electrolux's applianceState values).
  state            text,
  cycle_phase      text,
  door_state       text,
  online           boolean,
  -- When the run will end (now + timeToEnd at the last check), so screens
  -- can count down between checks.
  ends_at          timestamptz,
  last_polled_at   timestamptz,
  last_run_ended_at timestamptz,
  -- Add "Empty the dishwasher" when a run finishes.
  auto_task        boolean not null default true,
  task_text        text not null default 'Empty the dishwasher' check (char_length(task_text) between 1 and 200),
  status           text not null default 'active' check (status in ('active', 'error')),
  last_error       text,
  connected_by     uuid references public.members (id) on delete set null,
  created_at       timestamptz not null default now()
);


-- -----------------------------------------------------------------------------
-- STEP 2: Vault access for the tokens (server only)
-- -----------------------------------------------------------------------------

-- 2a. Save (or replace) the credentials JSON; creates or reactivates the row.
create or replace function public.appliance_save_credentials(p_household_id uuid, p_credentials text, p_connected_by uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secret_id uuid;
begin
  select c.vault_secret_id into v_secret_id from public.appliance_connections c where c.household_id = p_household_id;
  if v_secret_id is not null then
    perform vault.update_secret(v_secret_id, p_credentials);
  else
    v_secret_id := vault.create_secret(
      p_credentials,
      'electrolux_credentials_' || p_household_id::text,
      'Electrolux Group API key, access and refresh token for one household'
    );
  end if;

  insert into public.appliance_connections (household_id, vault_secret_id, connected_by, status, last_error)
  values (p_household_id, v_secret_id, p_connected_by, 'active', null)
  on conflict (household_id) do update set
    vault_secret_id = excluded.vault_secret_id,
    connected_by    = coalesce(excluded.connected_by, appliance_connections.connected_by),
    status          = 'active',
    last_error      = null;
end;
$$;

-- 2b. Read the credentials JSON.
create or replace function public.appliance_get_credentials(p_household_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select s.decrypted_secret
  from public.appliance_connections c
  join vault.decrypted_secrets s on s.id = c.vault_secret_id
  where c.household_id = p_household_id;
$$;

-- 2c. Disconnect: forget the tokens and the state.
create or replace function public.appliance_remove(p_household_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secret_id uuid;
begin
  select c.vault_secret_id into v_secret_id from public.appliance_connections c where c.household_id = p_household_id;
  delete from public.appliance_connections where household_id = p_household_id;
  if v_secret_id is not null then
    delete from vault.secrets where id = v_secret_id;
  end if;
end;
$$;


-- -----------------------------------------------------------------------------
-- STEP 3: a run finished -> "Empty the dishwasher" (server only)
-- -----------------------------------------------------------------------------
-- Unassigned, on the household's first to-do list. Skipped when auto_task is
-- off or the same to-do is still open (a run that wasn't emptied yet).
-- Returns the new to-do's id, or null when nothing was added.
create or replace function public.appliance_run_finished(p_household_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conn    public.appliance_connections;
  v_list_id uuid;
  v_id      uuid;
begin
  -- Step 3-1: note the run's end.
  update public.appliance_connections set last_run_ended_at = now()
   where household_id = p_household_id
  returning * into v_conn;
  if v_conn.household_id is null or not v_conn.auto_task then
    return null;
  end if;

  -- Step 3-2: the first to-do list (none: nothing to add to).
  select l.id into v_list_id from public.lists l
   where l.household_id = p_household_id and l.type = 'todo'
   order by l.sort_order, l.created_at
   limit 1;
  if v_list_id is null then
    return null;
  end if;

  -- Step 3-3: not twice.
  if exists (
    select 1 from public.list_entries e
    where e.list_id = v_list_id and e.status = 'open' and lower(e.text) = lower(v_conn.task_text)
  ) then
    return null;
  end if;

  insert into public.list_entries (list_id, household_id, text, status, source)
  values (v_list_id, p_household_id, v_conn.task_text, 'open', 'manual')
  returning id into v_id;
  return v_id;
end;
$$;


-- -----------------------------------------------------------------------------
-- STEP 4: the owner's settings
-- -----------------------------------------------------------------------------
create or replace function public.set_appliance_auto_task(p_on boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_household_owner() then
    raise exception 'owner_only';
  end if;
  update public.appliance_connections set auto_task = p_on where household_id = public.current_household_id();
end;
$$;


-- -----------------------------------------------------------------------------
-- STEP 5: RLS and permissions
-- -----------------------------------------------------------------------------
alter table public.appliance_connections enable row level security;

-- Everyone in the household (and the board) sees the state; nobody writes
-- directly. vault_secret_id is only a pointer: the tokens are reachable only
-- through the service-role functions above.
create policy "appliance_connections: household reads" on public.appliance_connections for select to authenticated
  using (household_id = public.current_household_id());

revoke execute on function
  public.appliance_save_credentials(uuid, text, uuid),
  public.appliance_get_credentials(uuid),
  public.appliance_remove(uuid),
  public.appliance_run_finished(uuid),
  public.set_appliance_auto_task(boolean)
from public, anon, authenticated;

grant execute on function public.set_appliance_auto_task(boolean) to authenticated;
grant execute on function
  public.appliance_save_credentials(uuid, text, uuid),
  public.appliance_get_credentials(uuid),
  public.appliance_remove(uuid),
  public.appliance_run_finished(uuid)
to service_role;

-- Live countdown on Today and the board.
alter publication supabase_realtime add table public.appliance_connections;
