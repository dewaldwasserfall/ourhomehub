-- =============================================================================
-- HomeHub: admin mode on the Family board (PIN unlock for parents)
-- -----------------------------------------------------------------------------
-- The board is read-and-tick only. A parent (the owner, or an adult marked as
-- a parent) can unlock it with their own PIN for a few minutes to:
--   * add groceries and to-dos;
--   * confirm or reject the kids' waiting ticks right on the board.
--
-- How it's safe:
--   * PINs (4-6 digits) are stored as bcrypt hashes in a table with no
--     policies at all: nobody reads them, only the RPCs below compare.
--   * Unlocking writes a session row for the board (who, until when). Every
--     admin RPC checks that session in the database, so hidden buttons or a
--     hand-made request from the tablet get nowhere while it's locked.
--   * 5 wrong PINs block unlocking on that board for 5 minutes.
--   * The session ends after the board's auto-lock time (default 2 minutes,
--     set per board by an adult), counted from the last tap, or on Lock.
--
-- While unlocked, the admin RPCs run the household's normal RPCs (add_entry,
-- confirm_ticks, reject_ticks) AS the parent who unlocked: their sign-in id
-- is set for that one call, so every rule and the "added by Anél" attribution
-- work exactly as on their phone.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- STEP 1: tables
-- -----------------------------------------------------------------------------

-- 1a. Each parent's board PIN (hash only). No policies: RPC access only.
create table public.board_pins (
  member_id     uuid primary key references public.members (id) on delete cascade,
  household_id  uuid not null references public.households (id) on delete cascade,
  pin_hash      text not null,
  updated_at    timestamptz not null default now()
);
alter table public.board_pins enable row level security;

-- 1b. A board's unlock session and its wrong-PIN counter. No policies.
create table public.board_unlocks (
  board_id      uuid primary key references public.boards (id) on delete cascade,
  member_id     uuid references public.members (id) on delete cascade,
  until         timestamptz,
  failures      int not null default 0,
  blocked_until timestamptz
);
alter table public.board_unlocks enable row level security;

-- 1c. How long a board stays unlocked after the last tap (adults set it
--     through the existing "adults rename" update policy on boards).
alter table public.boards
  add column unlock_minutes int not null default 2 check (unlock_minutes between 1 and 30);


-- -----------------------------------------------------------------------------
-- STEP 2: a parent's PIN (set on their phone)
-- -----------------------------------------------------------------------------

-- 2a. Set or change my PIN. Two parents can't share a PIN (the board tells
--     them apart by it).
create or replace function public.set_board_pin(p_pin text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_member_id    uuid := public.current_member_id();
  v_household_id uuid := public.current_household_id();
begin
  -- Step 2a-1: parents only, a 4-6 digit PIN.
  if v_member_id is null or not public.is_parent() then
    raise exception 'parents_only';
  end if;
  if p_pin is null or p_pin !~ '^[0-9]{4,6}$' then
    raise exception 'pin_format';
  end if;

  -- Step 2a-2: not the same as another parent's.
  if exists (
    select 1 from public.board_pins b
    where b.household_id = v_household_id and b.member_id <> v_member_id
      and extensions.crypt(p_pin, b.pin_hash) = b.pin_hash
  ) then
    raise exception 'pin_taken';
  end if;

  -- Step 2a-3: store the hash.
  insert into public.board_pins (member_id, household_id, pin_hash)
  values (v_member_id, v_household_id, extensions.crypt(p_pin, extensions.gen_salt('bf', 8)))
  on conflict (member_id) do update set pin_hash = excluded.pin_hash, updated_at = now();
end;
$$;

-- 2b. Remove my PIN.
create or replace function public.clear_board_pin()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.board_pins where member_id = public.current_member_id();
$$;

-- 2c. Have I set one? (The settings screen shows Set or Change.)
create or replace function public.has_board_pin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.board_pins where member_id = public.current_member_id());
$$;


-- -----------------------------------------------------------------------------
-- STEP 3: unlocking and locking (called by the board)
-- -----------------------------------------------------------------------------

-- 3a. Unlock with a PIN. Returns a JSON answer rather than raising, so a
--     wrong PIN is still counted (an exception would roll the count back):
--       {ok: true,  member_id, until, minutes}
--       {ok: false, error: 'wrong_pin', left}
--       {ok: false, error: 'blocked', until}
create or replace function public.board_unlock(p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_board_id     uuid := public.current_board_id();
  v_household_id uuid := public.current_household_id();
  v_minutes      int;
  v_row          public.board_unlocks;
  v_member_id    uuid;
  v_until        timestamptz;
begin
  -- Step 3a-1: boards only.
  if v_board_id is null then
    raise exception 'not_a_board';
  end if;
  select b.unlock_minutes into v_minutes from public.boards b where b.id = v_board_id;
  insert into public.board_unlocks (board_id) values (v_board_id) on conflict (board_id) do nothing;
  select * into v_row from public.board_unlocks where board_id = v_board_id for update;

  -- Step 3a-2: blocked after too many wrong PINs?
  if v_row.blocked_until is not null and v_row.blocked_until > now() then
    return jsonb_build_object('ok', false, 'error', 'blocked', 'until', v_row.blocked_until);
  end if;

  -- Step 3a-3: whose PIN is it? Parents of this household only.
  if p_pin ~ '^[0-9]{4,6}$' then
    select p.member_id into v_member_id
    from public.board_pins p
    join public.members m on m.id = p.member_id
    where p.household_id = v_household_id
      and (m.role = 'owner' or (m.role = 'adult' and m.is_parent))
      and extensions.crypt(p_pin, p.pin_hash) = p.pin_hash
    limit 1;
  end if;

  -- Step 3a-4: wrong: count it; the 5th in a row blocks for 5 minutes.
  if v_member_id is null then
    if v_row.failures + 1 >= 5 then
      update public.board_unlocks set failures = 0, blocked_until = now() + interval '5 minutes', member_id = null, until = null
       where board_id = v_board_id;
      return jsonb_build_object('ok', false, 'error', 'blocked', 'until', now() + interval '5 minutes');
    end if;
    update public.board_unlocks set failures = v_row.failures + 1 where board_id = v_board_id;
    return jsonb_build_object('ok', false, 'error', 'wrong_pin', 'left', 5 - (v_row.failures + 1));
  end if;

  -- Step 3a-5: right: open a session.
  v_until := now() + make_interval(mins => v_minutes);
  update public.board_unlocks
     set member_id = v_member_id, until = v_until, failures = 0, blocked_until = null
   where board_id = v_board_id;
  update public.boards set last_seen_at = now() where id = v_board_id;
  return jsonb_build_object('ok', true, 'member_id', v_member_id, 'until', v_until, 'minutes', v_minutes);
end;
$$;

-- 3b. Still unlocked? Pushes the end time out (a tap on the board). Returns
--     the new end, or null when locked.
create or replace function public.board_touch()
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_board_id uuid := public.current_board_id();
  v_until    timestamptz;
begin
  if v_board_id is null then
    raise exception 'not_a_board';
  end if;
  update public.board_unlocks u
     set until = now() + make_interval(mins => b.unlock_minutes)
    from public.boards b
   where u.board_id = v_board_id and b.id = u.board_id and u.until > now()
  returning u.until into v_until;
  return v_until;
end;
$$;

-- 3c. Lock now.
create or replace function public.board_lock()
returns void
language sql
security definer
set search_path = public
as $$
  update public.board_unlocks set member_id = null, until = null where board_id = public.current_board_id();
$$;

-- 3d. Internal: the parent who unlocked this board, or an error. Extends the
--     session (an admin action counts as a tap).
create or replace function public.board_admin_member()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_board_id  uuid := public.current_board_id();
  v_member_id uuid;
begin
  if v_board_id is null then
    raise exception 'not_a_board';
  end if;
  select u.member_id into v_member_id
  from public.board_unlocks u
  join public.members m on m.id = u.member_id
  where u.board_id = v_board_id and u.until > now()
    and (m.role = 'owner' or (m.role = 'adult' and m.is_parent));
  if v_member_id is null then
    raise exception 'board_locked';
  end if;
  perform public.board_touch();
  return v_member_id;
end;
$$;

-- 3e. Internal: act as that parent for the rest of this call (their sign-in
--     id becomes auth.uid()). Returns the board's own setting, to restore.
create or replace function public.board_act_as(p_member_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev text := current_setting('request.jwt.claim.sub', true);
  v_user uuid;
begin
  select m.user_id into v_user from public.members m where m.id = p_member_id;
  if v_user is null then
    raise exception 'board_locked';
  end if;
  perform set_config('request.jwt.claim.sub', v_user::text, true);
  return coalesce(v_prev, '');
end;
$$;


-- -----------------------------------------------------------------------------
-- STEP 4: what an unlocked board can do
-- -----------------------------------------------------------------------------

-- 4a. Add a grocery or a to-do (exactly what add_entry does on a phone).
create or replace function public.board_add_entry(
  p_list_id     uuid,
  p_text        text,
  p_due_date    date default null,
  p_assigned_to uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev text;
  v_id   uuid;
begin
  v_prev := public.board_act_as(public.board_admin_member());
  v_id := public.add_entry(p_list_id, p_text, null, null, p_due_date, p_assigned_to);
  perform set_config('request.jwt.claim.sub', v_prev, true);
  return v_id;
end;
$$;

-- 4b. Confirm (or reject) a waiting tick, found by what was ticked: a to-do
--     by its id; a step, chore or zone task by its kind and id.
create or replace function public.board_review_tick(p_kind text, p_item_id uuid, p_confirm boolean)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_household_id uuid := public.current_household_id();
  v_prev         text;
  v_completions  uuid[];
  v_entries      uuid[];
  v_count        int;
begin
  -- Step 4b-1: unlocked; act as the parent.
  v_prev := public.board_act_as(public.board_admin_member());

  -- Step 4b-2: the waiting ticks for that item.
  if p_kind = 'todo' then
    v_entries := array[p_item_id];
  else
    select array_agg(c.id) into v_completions
    from public.completions c
    where c.household_id = v_household_id and c.kind = p_kind and c.item_id = p_item_id and c.pending;
  end if;

  -- Step 4b-3: the same confirm / reject as on a phone.
  if p_confirm then
    v_count := public.confirm_ticks(v_completions, v_entries);
  else
    v_count := public.reject_ticks(v_completions, v_entries);
  end if;
  perform set_config('request.jwt.claim.sub', v_prev, true);
  return v_count;
end;
$$;


-- -----------------------------------------------------------------------------
-- STEP 5: permissions
-- -----------------------------------------------------------------------------
revoke execute on function
  public.set_board_pin(text),
  public.clear_board_pin(),
  public.has_board_pin(),
  public.board_unlock(text),
  public.board_touch(),
  public.board_lock(),
  public.board_admin_member(),
  public.board_act_as(uuid),
  public.board_add_entry(uuid, text, date, uuid),
  public.board_review_tick(text, uuid, boolean)
from public, anon, authenticated;

grant execute on function
  public.set_board_pin(text),
  public.clear_board_pin(),
  public.has_board_pin(),
  public.board_unlock(text),
  public.board_touch(),
  public.board_lock(),
  public.board_add_entry(uuid, text, date, uuid),
  public.board_review_tick(text, uuid, boolean)
to authenticated;
