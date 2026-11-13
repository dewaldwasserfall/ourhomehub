-- =============================================================================
-- HomeHub: grocery budget from the bunq groceries account
-- -----------------------------------------------------------------------------
-- What this migration creates:
--   1. members.can_see_finances: who sees money (Dewald and Anél); owner-set
--   2. bunq_connections: one per household. The bunq credentials (OAuth access
--      token, this server's RSA private key, installation token) are one JSON
--      secret in Vault; this row only points at it. Also the chosen account
--      and the budget settings (EUR 1000, month starting on the 26th).
--   3. bunq_payments: the chosen account's payments, copied by the server
--   4. RPCs: service-role ones for the Vault secret, and set_finance_access
--      for the owner
--   5. RLS: only members who can see finances read any of it; the browser
--      never writes, the server does (bunq API routes)
-- =============================================================================


-- -----------------------------------------------------------------------------
-- STEP 1: Who can see finances
-- -----------------------------------------------------------------------------
alter table public.members
  add column can_see_finances boolean not null default false;

comment on column public.members.can_see_finances is
  'Sees the grocery budget. Owner-controlled; never true for children.';

-- The owner always can; give it to the current owner(s) now.
update public.members set can_see_finances = true where role = 'owner';

-- 1a. Helper for RLS: the owner always; adults the owner gave access.
create or replace function public.can_see_finances()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select m.role = 'owner' or (m.can_see_finances and m.role = 'adult')
    from public.members m
    where m.user_id = auth.uid() and m.household_id = public.current_household_id()
  ), false);
$$;

-- 1b. Members may update their own row (display name, theme), so stop anyone
--     but the server or the owner's RPC from changing this column.
create or replace function public.members_protect_finance_access()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.can_see_finances is distinct from old.can_see_finances
     and current_user in ('authenticated', 'anon') then
    raise exception 'owner_only';
  end if;
  return new;
end;
$$;

create trigger members_protect_finance_access
  before update of can_see_finances on public.members
  for each row execute function public.members_protect_finance_access();

-- 1c. The owner gives or removes access for an adult in the household.
create or replace function public.set_finance_access(p_member_id uuid, p_allowed boolean)
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
  -- Runs as the function owner, so the protect trigger lets it through.
  update public.members set can_see_finances = p_allowed where id = p_member_id;
end;
$$;


-- -----------------------------------------------------------------------------
-- STEP 2: The bunq connection and budget settings
-- -----------------------------------------------------------------------------
create table public.bunq_connections (
  household_id        uuid primary key references public.households (id) on delete cascade,
  vault_secret_id     uuid,
  -- The groceries account (chosen after connecting).
  account_id          bigint,
  account_label       text,
  balance_cents       bigint,
  -- Budget: EUR amount per month, and the day the month starts (top-up day).
  budget_cents        int not null default 100000 check (budget_cents between 0 and 100000000),
  period_start_day    int not null default 26 check (period_start_day between 1 and 28),
  status              text not null default 'active' check (status in ('active', 'error')),
  last_error          text,
  last_synced_at      timestamptz,
  connected_by        uuid references public.members (id) on delete set null,
  created_at          timestamptz not null default now()
);


-- -----------------------------------------------------------------------------
-- STEP 3: Payments on the groceries account
-- -----------------------------------------------------------------------------
-- id is bunq's payment id. kind is worked out by the server:
--   spend   money out (a shop, Picnic, ...)
--   refund  money back from a shop
--   topup   the monthly top-up (or any other transfer in)
create table public.bunq_payments (
  id             bigint primary key,
  household_id   uuid not null references public.households (id) on delete cascade,
  created_at     timestamptz not null,
  amount_cents   bigint not null,
  counterparty   text,
  description    text,
  kind           text not null check (kind in ('spend', 'refund', 'topup'))
);
create index bunq_payments_household_date_idx on public.bunq_payments (household_id, created_at desc);


-- -----------------------------------------------------------------------------
-- STEP 4: Vault access (server only)
-- -----------------------------------------------------------------------------

-- 4a. Save (or replace) the credentials JSON and mark the connection active.
create or replace function public.bunq_save_credentials(p_household_id uuid, p_credentials text, p_connected_by uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secret_id uuid;
begin
  select c.vault_secret_id into v_secret_id from public.bunq_connections c where c.household_id = p_household_id;

  if v_secret_id is not null then
    perform vault.update_secret(v_secret_id, p_credentials);
  else
    v_secret_id := vault.create_secret(
      p_credentials,
      'bunq_credentials_' || p_household_id::text,
      'bunq OAuth access token and API context for one household'
    );
  end if;

  insert into public.bunq_connections (household_id, vault_secret_id, connected_by, status, last_error)
  values (p_household_id, v_secret_id, p_connected_by, 'active', null)
  on conflict (household_id) do update set
    vault_secret_id = excluded.vault_secret_id,
    connected_by    = excluded.connected_by,
    status          = 'active',
    last_error      = null;
end;
$$;

-- 4b. Read the credentials.
create or replace function public.bunq_get_credentials(p_household_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select s.decrypted_secret
  from public.bunq_connections c
  join vault.decrypted_secrets s on s.id = c.vault_secret_id
  where c.household_id = p_household_id;
$$;

-- 4c. Disconnect: forget the credentials and every copied payment.
create or replace function public.bunq_remove_connection(p_household_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secret_id uuid;
begin
  select c.vault_secret_id into v_secret_id from public.bunq_connections c where c.household_id = p_household_id;
  delete from public.bunq_payments where household_id = p_household_id;
  delete from public.bunq_connections where household_id = p_household_id;
  if v_secret_id is not null then
    delete from vault.secrets where id = v_secret_id;
  end if;
end;
$$;


-- -----------------------------------------------------------------------------
-- STEP 5: RLS and permissions
-- -----------------------------------------------------------------------------
alter table public.bunq_connections enable row level security;
alter table public.bunq_payments    enable row level security;

-- Read-only, and only for members who can see finances. vault_secret_id is
-- just a pointer; the secret itself is only reachable through the RPCs above.
create policy "bunq_connections: finance read" on public.bunq_connections for select to authenticated
  using (household_id = public.current_household_id() and public.can_see_finances());
create policy "bunq_payments: finance read" on public.bunq_payments for select to authenticated
  using (household_id = public.current_household_id() and public.can_see_finances());

revoke execute on function
  public.can_see_finances(),
  public.members_protect_finance_access(),
  public.set_finance_access(uuid, boolean),
  public.bunq_save_credentials(uuid, text, uuid),
  public.bunq_get_credentials(uuid),
  public.bunq_remove_connection(uuid)
from public, anon, authenticated;

grant execute on function
  public.can_see_finances(),
  public.set_finance_access(uuid, boolean)
to authenticated;

grant execute on function
  public.bunq_save_credentials(uuid, text, uuid),
  public.bunq_get_credentials(uuid),
  public.bunq_remove_connection(uuid)
to service_role;
