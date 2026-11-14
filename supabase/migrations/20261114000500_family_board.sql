-- =============================================================================
-- HomeHub: the Family board (a wall tablet) and adult confirmation of chores
-- -----------------------------------------------------------------------------
-- A tablet on the wall shows the household's day: everyone's tasks, bins and
-- the calendar. Anyone can tap a task there and say who did it.
--
--   * A board is a household DEVICE, not a person: its own sign-in, no member
--     row. It reads what a child can read (so never budget, trips, passports
--     or documents) and writes nothing except ticks, through two RPCs.
--   * Pairing: an adult makes an 8-digit code (10 minutes); the tablet sends it
--     to /api/board/pair, which (with the service role) creates the board's
--     sign-in and calls claim_board_code().
--   * Ticked on the board FOR A CHILD -> "pending": it shows as waiting and
--     earns nothing until any adult confirms it. Rejected -> it's undone.
--     Ticked on the board for an adult -> done straight away.
--   * Stars, streaks, the week review and supplies only count confirmed ticks.
--
-- Ticks made on phones are unchanged (adults: done; kids: their own, done).
-- =============================================================================


-- -----------------------------------------------------------------------------
-- STEP 1: boards and their pairing codes
-- -----------------------------------------------------------------------------

-- 1a. One row per paired tablet. user_id is the board's own auth user.
create table public.boards (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households (id) on delete cascade,
  user_id       uuid not null unique references auth.users (id) on delete cascade,
  name          text not null default 'Family board' check (char_length(name) between 1 and 60),
  created_by    uuid references public.members (id) on delete set null,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz
);
create index boards_household_idx on public.boards (household_id);

-- 1b. Short-lived codes. Only the server (service role) reads them.
create table public.board_pairing_codes (
  code          text primary key check (code ~ '^[0-9]{8}$'),
  household_id  uuid not null references public.households (id) on delete cascade,
  created_by    uuid references public.members (id) on delete set null,
  expires_at    timestamptz not null default now() + interval '10 minutes',
  used_at       timestamptz
);


-- -----------------------------------------------------------------------------
-- STEP 2: a board belongs to its household
-- -----------------------------------------------------------------------------
-- Same as 20261112000400 (members on the allowlist), plus: a board's sign-in
-- maps to its household. Everything that reads "household_id =
-- current_household_id()" therefore works for the board; everything that
-- also needs is_household_adult(), can_see_finances() or can_see_trips()
-- stays closed, because a board has no member row.
create or replace function public.current_household_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select m.household_id
      from public.members m
      join public.app_allowlist a on a.email = lower(m.email)
      where m.user_id = auth.uid()
        and (a.expires_at is null or a.expires_at > now())
    ),
    (select b.household_id from public.boards b where b.user_id = auth.uid())
  );
$$;

-- 2a. Is the signed-in user a board?
create or replace function public.current_board_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select b.id from public.boards b where b.user_id = auth.uid();
$$;


-- -----------------------------------------------------------------------------
-- STEP 3: pending ticks
-- -----------------------------------------------------------------------------
-- pending: ticked on the board for a child, waiting for an adult.
-- via_board: made on the board (the board may only undo its own ticks).

-- 3a. Routine steps, zone tasks and chores.
alter table public.completions
  add column pending      boolean not null default false,
  add column via_board    boolean not null default false,
  add column confirmed_by uuid references public.members (id) on delete set null,
  add column confirmed_at timestamptz;
create index completions_pending_idx on public.completions (household_id) where pending;

-- 3b. To-dos. done_for: who it counts for when someone other than the
--     assignee did it (an unassigned to-do done by a child on the board).
alter table public.list_entries
  add column pending      boolean not null default false,
  add column via_board    boolean not null default false,
  add column done_for     uuid references public.members (id) on delete set null,
  add column confirmed_by uuid references public.members (id) on delete set null,
  add column confirmed_at timestamptz;
create index list_entries_pending_idx on public.list_entries (household_id) where pending;

-- 3c-0. A to-do that goes back to open (unticked on a phone, or rejected)
--       forgets everything about the board tick.
create or replace function public.list_entries_reset_board_tick()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status = 'open' and old.status is distinct from 'open' then
    new.pending      := false;
    new.via_board    := false;
    new.done_for     := null;
    new.confirmed_by := null;
    new.confirmed_at := null;
  end if;
  return new;
end;
$$;

create trigger list_entries_reset_board_tick
  before update of status on public.list_entries
  for each row execute function public.list_entries_reset_board_tick();

-- 3c. done_for: keep a value set by the board RPC (who did it), otherwise the
--     assignee, else whoever ticked (same as 20261113001600 step 1a).
create or replace function public.completions_fill_done_for()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.done_for is null then
    new.done_for := coalesce(
      (select a.assignee from public.completion_assignee(new.kind, new.item_id) a limit 1),
      new.done_by
    );
  end if;
  return new;
end;
$$;


-- -----------------------------------------------------------------------------
-- STEP 4: supplies only run down once a tick is confirmed
-- -----------------------------------------------------------------------------
-- Same as 20261113001500 step 3, except: a pending tick uses nothing yet;
-- confirming it does (4b); undoing a pending tick gives nothing back (4c).

-- 4a. A tick: one use less of every supply the task uses (not while pending).
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
    returning s.id
  loop
    perform public.supply_check(v_supply_id);
  end loop;
  return null;
end;
$$;

-- 4b. Confirmed (pending -> not pending): now it uses them.
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
      returning s.id
    loop
      perform public.supply_check(v_supply_id);
    end loop;
  end if;
  return null;
end;
$$;

create trigger completions_confirm_use_supplies
  after update of pending on public.completions
  for each row execute function public.supplies_after_completion_confirm();

-- 4c. An untick: the use comes back, unless it never left (still pending).
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
     and old.done_at >= u.created_at;
  return null;
end;
$$;


-- -----------------------------------------------------------------------------
-- STEP 5: one place that ticks a completion on or off
-- -----------------------------------------------------------------------------
-- The body of set_completion (20261113000700 step 9b-3 to 9b-5), taken out so
-- the board RPC can share it. Callers check permissions first.
create or replace function public.apply_completion(
  p_household_id uuid,
  p_kind         text,
  p_item_id      uuid,
  p_for_date     date,
  p_done         boolean,
  p_done_by      uuid,
  p_done_for     uuid,
  p_pending      boolean,
  p_via_board    boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_for_date date := p_for_date;
  v_chore    public.chores;
  v_prev_due date;
  v_inserted uuid;
begin
  -- Step 5a: zone tasks count once per fortnight.
  if p_kind = 'zone_task' then
    v_for_date := public.zone_period_start(p_household_id, p_for_date);
  end if;

  -- Step 5b: tick on. Chores move to their next due date (also while
  --          pending, so the chore leaves the to-do list; a rejection puts
  --          the old date back through 5c).
  if p_done then
    if p_kind = 'chore' then
      select * into v_chore from public.chores c where c.id = p_item_id;
      v_prev_due := v_chore.next_due;
    end if;

    insert into public.completions
      (household_id, kind, item_id, for_date, done_by, done_for, prev_next_due, pending, via_board)
    values
      (p_household_id, p_kind, p_item_id, v_for_date, p_done_by, p_done_for, v_prev_due, p_pending, p_via_board)
    on conflict (kind, item_id, for_date) do nothing
    returning id into v_inserted;

    if v_inserted is not null and p_kind = 'chore' then
      update public.chores
         set next_due = (v_for_date + case v_chore.unit
                                         when 'day'   then make_interval(days   => v_chore.every_n)
                                         when 'week'  then make_interval(weeks  => v_chore.every_n)
                                         else              make_interval(months => v_chore.every_n)
                                       end)::date
       where id = p_item_id;
    end if;
    return;
  end if;

  -- Step 5c: tick off. A chore goes back to the due date it had.
  delete from public.completions c
   where c.kind = p_kind and c.item_id = p_item_id and c.for_date = v_for_date
  returning c.prev_next_due into v_prev_due;

  if p_kind = 'chore' and v_prev_due is not null then
    update public.chores set next_due = v_prev_due where id = p_item_id;
  end if;
end;
$$;

-- 5a. set_completion: same checks as before, then the shared body.
create or replace function public.set_completion(
  p_kind     text,
  p_item_id  uuid,
  p_for_date date,
  p_done     boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_household_id uuid := public.current_household_id();
  v_member_id    uuid := public.current_member_id();
  v_item_house   uuid;
  v_assignee     uuid;
begin
  -- Step 5a-1: who is asking, and does the item exist in their household?
  --            (A board has no member row: it uses board_set_completion.)
  if v_household_id is null or v_member_id is null then
    raise exception 'not_in_household';
  end if;
  if p_kind not in ('step', 'zone_task', 'chore') or p_for_date is null then
    raise exception 'invalid_completion';
  end if;

  select a.household_id, a.assignee into v_item_house, v_assignee
  from public.completion_assignee(p_kind, p_item_id) a;

  if v_item_house is distinct from v_household_id then
    raise exception 'item_not_found';
  end if;

  -- Step 5a-2: children tick only their own things.
  if not public.is_household_adult() and v_assignee is distinct from v_member_id then
    raise exception 'not_assigned_to_you';
  end if;

  -- Step 5a-3: a phone tick is never pending.
  perform public.apply_completion(v_household_id, p_kind, p_item_id, p_for_date, p_done, v_member_id, null, false, false);
end;
$$;


-- -----------------------------------------------------------------------------
-- STEP 6: ticking on the board
-- -----------------------------------------------------------------------------

-- 6a. Who may be credited: the assignee if there is one, else whoever the
--     tapper picked. Returns the member and whether they're a child.
create or replace function public.board_check_doer(p_household_id uuid, p_assignee uuid, p_member_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  if p_assignee is not null and p_member_id is distinct from p_assignee then
    raise exception 'assigned_to_someone_else';
  end if;
  select m.role into v_role from public.members m where m.id = p_member_id and m.household_id = p_household_id;
  if v_role is null then
    raise exception 'member_not_in_household';
  end if;
  return v_role = 'child';
end;
$$;

-- 6b. A step, zone task or chore. p_member_id: who did it.
create or replace function public.board_set_completion(
  p_kind      text,
  p_item_id   uuid,
  p_for_date  date,
  p_done      boolean,
  p_member_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_board_id     uuid := public.current_board_id();
  v_household_id uuid := public.current_household_id();
  v_item_house   uuid;
  v_assignee     uuid;
  v_is_child     boolean;
  v_existing     public.completions;
  v_for_date     date := p_for_date;
begin
  -- Step 6b-1: boards only, and the item must be in the board's household.
  if v_board_id is null or v_household_id is null then
    raise exception 'not_a_board';
  end if;
  if p_kind not in ('step', 'zone_task', 'chore') or p_for_date is null then
    raise exception 'invalid_completion';
  end if;
  select a.household_id, a.assignee into v_item_house, v_assignee
  from public.completion_assignee(p_kind, p_item_id) a;
  if v_item_house is distinct from v_household_id then
    raise exception 'item_not_found';
  end if;

  -- Step 6b-2: untick: only the board's own ticks (a confirmed or phone tick
  --            is for a grown-up to undo).
  if not p_done then
    if p_kind = 'zone_task' then
      v_for_date := public.zone_period_start(v_household_id, p_for_date);
    end if;
    select * into v_existing from public.completions c
     where c.kind = p_kind and c.item_id = p_item_id and c.for_date = v_for_date;
    if v_existing.id is null then
      return;
    end if;
    if not v_existing.via_board or (not v_existing.pending and v_existing.confirmed_by is not null) then
      raise exception 'ask_a_grown_up';
    end if;
    perform public.apply_completion(v_household_id, p_kind, p_item_id, p_for_date, false, null, null, false, true);
    return;
  end if;

  -- Step 6b-3: tick: credit the doer; a child's tick waits for an adult.
  v_is_child := public.board_check_doer(v_household_id, v_assignee, p_member_id);
  perform public.apply_completion(v_household_id, p_kind, p_item_id, p_for_date, true, null, p_member_id, v_is_child, true);
  update public.boards set last_seen_at = now() where id = v_board_id;
end;
$$;

-- 6c. A to-do (free-text line on a to-do list; shopping lines aren't ticked
--     on the board).
create or replace function public.board_set_entry(
  p_entry_id  uuid,
  p_done      boolean,
  p_member_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_board_id     uuid := public.current_board_id();
  v_household_id uuid := public.current_household_id();
  v_entry        public.list_entries;
  v_list_type    text;
  v_is_child     boolean;
begin
  -- Step 6c-1: boards only; a to-do in the board's household.
  if v_board_id is null or v_household_id is null then
    raise exception 'not_a_board';
  end if;
  select e.* into v_entry from public.list_entries e where e.id = p_entry_id;
  select l.type::text into v_list_type from public.lists l where l.id = v_entry.list_id;
  if v_entry.id is null or v_entry.household_id is distinct from v_household_id or v_list_type is distinct from 'todo' then
    raise exception 'item_not_found';
  end if;

  -- Step 6c-2: untick: only the board's own, not yet confirmed.
  if not p_done then
    if v_entry.status <> 'done' then
      return;
    end if;
    if not v_entry.via_board or (not v_entry.pending and v_entry.confirmed_by is not null) then
      raise exception 'ask_a_grown_up';
    end if;
    update public.list_entries
       set status = 'open', pending = false, via_board = false, done_for = null
     where id = p_entry_id;
    return;
  end if;

  -- Step 6c-3: tick.
  if v_entry.status <> 'open' then
    return;
  end if;
  v_is_child := public.board_check_doer(v_household_id, v_entry.assigned_to, p_member_id);
  update public.list_entries
     set status = 'done', pending = v_is_child, via_board = true, done_for = p_member_id
   where id = p_entry_id;
  update public.boards set last_seen_at = now() where id = v_board_id;
end;
$$;


-- -----------------------------------------------------------------------------
-- STEP 7: adults confirm or undo what's waiting
-- -----------------------------------------------------------------------------

-- 7a. Confirm: any adult, any number at once.
create or replace function public.confirm_ticks(p_completion_ids uuid[], p_entry_ids uuid[])
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_household_id uuid := public.current_household_id();
  v_member_id    uuid := public.current_member_id();
  v_count        int := 0;
  v_n            int;
begin
  if not public.is_household_adult() then
    raise exception 'adults_only';
  end if;

  update public.completions
     set pending = false, confirmed_by = v_member_id, confirmed_at = now()
   where id = any (coalesce(p_completion_ids, '{}')) and household_id = v_household_id and pending;
  get diagnostics v_n = row_count;
  v_count := v_count + v_n;

  update public.list_entries
     set pending = false, confirmed_by = v_member_id, confirmed_at = now()
   where id = any (coalesce(p_entry_ids, '{}')) and household_id = v_household_id and pending;
  get diagnostics v_n = row_count;
  return v_count + v_n;
end;
$$;

-- 7b. Not done after all: undo them (a chore gets its old due date back).
create or replace function public.reject_ticks(p_completion_ids uuid[], p_entry_ids uuid[])
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_household_id uuid := public.current_household_id();
  v_row          public.completions;
  v_count        int := 0;
  v_n            int;
begin
  if not public.is_household_adult() then
    raise exception 'adults_only';
  end if;

  for v_row in
    select * from public.completions c
     where c.id = any (coalesce(p_completion_ids, '{}')) and c.household_id = v_household_id and c.pending
  loop
    perform public.apply_completion(v_household_id, v_row.kind, v_row.item_id, v_row.for_date, false, null, null, false, true);
    v_count := v_count + 1;
  end loop;

  update public.list_entries
     set status = 'open', pending = false, via_board = false, done_for = null
   where id = any (coalesce(p_entry_ids, '{}')) and household_id = v_household_id and pending;
  get diagnostics v_n = row_count;
  return v_count + v_n;
end;
$$;


-- -----------------------------------------------------------------------------
-- STEP 8: stars, streaks and the week review count confirmed ticks only
-- -----------------------------------------------------------------------------

-- 8a. Same as 20261113001600 step 2, plus "not pending", and to-dos count for
--     done_for when set.
create or replace function public.member_stars(p_member_id uuid, p_today date)
returns table (earned int, spent int, balance int, streak int)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_earned int;
  v_spent  int;
begin
  -- Step 8a-1: same household; children see only their own (a board sees all).
  if not exists (
    select 1 from public.members m
    where m.id = p_member_id and m.household_id = public.current_household_id()
  ) then
    raise exception 'member_not_in_household';
  end if;
  if not public.is_household_adult() and public.current_board_id() is null
     and p_member_id is distinct from public.current_member_id() then
    raise exception 'not_assigned_to_you';
  end if;

  -- Step 8a-2: count.
  select
    (select count(*) from public.completions c where c.done_for = p_member_id and not c.pending)
    + (select count(*) from public.list_entries e
       where coalesce(e.done_for, e.assigned_to) = p_member_id
         and e.status in ('done', 'cleared') and not e.pending)
  into v_earned;

  select coalesce(sum(r.stars_needed), 0) into v_spent
  from public.rewards r where r.member_id = p_member_id and r.given_at is not null;

  return query select v_earned, v_spent, v_earned - v_spent, public.member_streak(p_member_id, p_today);
end;
$$;

-- 8b. Same as 20261113001300 step 2a, counting only confirmed ticks.
create or replace function public.member_streak(p_member_id uuid, p_today date)
returns int
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_household_id uuid;
  v_since        date;
  v_day          date := p_today;
  v_mode         text;
  v_due          int;
  v_done         int;
  v_streak       int := 0;
begin
  select m.household_id, m.created_at::date into v_household_id, v_since
  from public.members m where m.id = p_member_id;
  if v_household_id is null then
    return 0;
  end if;

  -- Walk back day by day (at most a year, never before they joined).
  while v_day >= greatest(v_since, p_today - 365) loop
    v_mode := public.day_mode(v_household_id, v_day);

    -- Their steps that applied that day (current routines), and how many
    -- have a confirmed tick.
    select count(*), count(c.id) into v_due, v_done
    from public.routine_steps s
    join public.routines r on r.id = s.routine_id and r.active
    left join public.completions c
      on c.kind = 'step' and c.item_id = s.id and c.for_date = v_day and not c.pending
    where s.household_id = v_household_id
      and coalesce(s.assigned_to, r.owner_member) = p_member_id
      and (s.weekdays is null or extract(isodow from v_day)::smallint = any (s.weekdays))
      and v_mode = any (s.modes);

    if v_due > 0 then
      if v_done >= v_due then
        v_streak := v_streak + 1;
      elsif v_day <> p_today then
        exit; -- a missed day ends the streak (today may still be in progress)
      end if;
    end if;
    v_day := v_day - 1;
  end loop;

  return v_streak;
end;
$$;

-- 8c. Same as 20261113001600 step 3, counting only confirmed ticks, and
--     to-dos for done_for when set.
create or replace function public.week_counts(p_household_id uuid, p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with bounds as (
    select (p_from::timestamp at time zone h.timezone) as t_from,
           ((p_to + 1)::timestamp at time zone h.timezone) as t_to
    from public.households h where h.id = p_household_id
  ),
  people as (
    select m.id, m.user_id from public.members m where m.household_id = p_household_id
  ),
  ticks as (
    select c.done_for as member_id, c.kind, count(*) as n
    from public.completions c, bounds b
    where c.household_id = p_household_id
      and c.done_at >= b.t_from and c.done_at < b.t_to
      and c.done_for is not null
      and not c.pending
    group by c.done_for, c.kind
  ),
  todos as (
    select coalesce(e.done_for, e.assigned_to, p.id) as member_id, count(*) as n
    from public.list_entries e
    join public.lists l on l.id = e.list_id and l.type = 'todo'
    left join people p on p.user_id = e.completed_by
    cross join bounds b
    where e.household_id = p_household_id
      and e.status in ('done', 'cleared')
      and not e.pending
      and e.completed_at >= b.t_from and e.completed_at < b.t_to
    group by 1
  )
  select jsonb_build_object(
    'people', coalesce((
      select jsonb_agg(jsonb_build_object(
        'member_id', p.id,
        'steps',      coalesce((select n from ticks t where t.member_id = p.id and t.kind = 'step'), 0),
        'chores',     coalesce((select n from ticks t where t.member_id = p.id and t.kind = 'chore'), 0),
        'zone_tasks', coalesce((select n from ticks t where t.member_id = p.id and t.kind = 'zone_task'), 0),
        'todos',      coalesce((select n from todos t where t.member_id = p.id), 0)
      ))
      from people p
    ), '[]'::jsonb),
    'shopping_bought', (
      select count(*)
      from public.list_entries e
      join public.lists l on l.id = e.list_id and l.type = 'shopping'
      cross join bounds b
      where e.household_id = p_household_id
        and e.status in ('done', 'cleared')
        and e.completed_at >= b.t_from and e.completed_at < b.t_to
    )
  );
$$;


-- -----------------------------------------------------------------------------
-- STEP 9: pairing a board
-- -----------------------------------------------------------------------------

-- 9a. An adult makes a code for the tablet to type in.
create or replace function public.create_board_code()
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_household_id uuid := public.current_household_id();
  v_code         text;
begin
  if not public.is_household_adult() then
    raise exception 'adults_only';
  end if;
  -- Old codes for this household go; a fresh random 8-digit code comes
  -- (10 minutes x 100 million combinations: not guessable in time).
  delete from public.board_pairing_codes where household_id = v_household_id or expires_at < now();
  loop
    v_code := lpad((floor(random() * 100000000))::bigint::text, 8, '0');
    exit when not exists (select 1 from public.board_pairing_codes c where c.code = v_code);
  end loop;
  insert into public.board_pairing_codes (code, household_id, created_by)
  values (v_code, v_household_id, public.current_member_id());
  return v_code;
end;
$$;

-- 9b. Server only: use a code for a freshly made board sign-in.
create or replace function public.claim_board_code(p_code text, p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code  public.board_pairing_codes;
  v_board uuid;
begin
  update public.board_pairing_codes
     set used_at = now()
   where code = p_code and used_at is null and expires_at > now()
  returning * into v_code;
  if v_code.code is null then
    raise exception 'invalid_code';
  end if;
  insert into public.boards (household_id, user_id, created_by)
  values (v_code.household_id, p_user_id, v_code.created_by)
  returning id into v_board;
  return v_board;
end;
$$;


-- -----------------------------------------------------------------------------
-- STEP 10: RLS and permissions
-- -----------------------------------------------------------------------------
alter table public.boards              enable row level security;
alter table public.board_pairing_codes enable row level security;

-- 10a. Adults see the household's boards (and a board sees itself); adults
--      remove them (the server deletes the sign-in too). Pairing codes: no
--      policies at all, so only the RPCs and the service role touch them.
create policy "boards: adults and self read" on public.boards for select to authenticated
  using (household_id = public.current_household_id() and (public.is_household_adult() or user_id = auth.uid()));
create policy "boards: adults rename" on public.boards for update to authenticated
  using (household_id = public.current_household_id() and public.is_household_adult())
  with check (household_id = public.current_household_id() and public.is_household_adult());
create policy "boards: adults delete" on public.boards for delete to authenticated
  using (household_id = public.current_household_id() and public.is_household_adult());

-- 10b. Functions: internal ones closed; the RPCs open to signed-in users
--      (each checks who is calling); claiming a code is server-only.
revoke execute on function
  public.apply_completion(uuid, text, uuid, date, boolean, uuid, uuid, boolean, boolean),
  public.board_check_doer(uuid, uuid, uuid),
  public.supplies_after_completion_confirm(),
  public.list_entries_reset_board_tick(),
  public.claim_board_code(text, uuid)
from public, anon, authenticated;
grant execute on function public.claim_board_code(text, uuid) to service_role;

revoke execute on function
  public.board_set_completion(text, uuid, date, boolean, uuid),
  public.board_set_entry(uuid, boolean, uuid),
  public.confirm_ticks(uuid[], uuid[]),
  public.reject_ticks(uuid[], uuid[]),
  public.create_board_code(),
  public.current_board_id()
from public, anon;
grant execute on function
  public.board_set_completion(text, uuid, date, boolean, uuid),
  public.board_set_entry(uuid, boolean, uuid),
  public.confirm_ticks(uuid[], uuid[]),
  public.reject_ticks(uuid[], uuid[]),
  public.create_board_code(),
  public.current_board_id()
to authenticated;

-- 10c. The board screen stays live on ticks and to-dos (both tables are
--      already in the realtime publication); boards change rarely.
