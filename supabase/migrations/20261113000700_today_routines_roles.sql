-- =============================================================================
-- HomeHub: Phase 3, Today, to-dos, routines, zones, chores, holidays, kids
-- -----------------------------------------------------------------------------
-- What this migration does:
--   1. Roles become owner / adult / child. The allowlist records the role a
--      person joins with, so kids land in the household as children.
--   2. Role helpers used by RLS and the RPCs.
--   3. Tightens V1 access: only adults write lists, items, list lines and
--      household settings; children may only tick lines assigned to them.
--      The invite code is hidden from children (column-level grants).
--   4. New columns: households.school_region / zone_rotation_start,
--      list_entries.due_date / assigned_to.
--   5. School holidays, public holidays and your own days (day_overrides),
--      and day_mode(): school / holiday / weekend for any date.
--   6. Routines and their per-weekday, per-mode steps.
--   7. Zones (fortnightly rotation) and their tasks.
--   8. Recurring chores.
--   9. Completions: one row per tick, for steps, zone tasks and chores, and
--      set_completion(), the only way to write them.
--  10. RLS, realtime and function permissions.
--
-- Child permissions are deliberately minimal (see the architecture doc):
-- read everything in the household, tick only what is assigned to them.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- STEP 1: Roles
-- -----------------------------------------------------------------------------

-- 1a. members.role: 'member' becomes 'adult', and 'child' is new.
alter table public.members drop constraint members_role_check;
update public.members set role = 'adult' where role = 'member';
alter table public.members alter column role set default 'adult';
alter table public.members
  add constraint members_role_check check (role in ('owner', 'adult', 'child'));

-- 1b. The allowlist says which role someone joins with.
alter table public.app_allowlist
  add column role text not null default 'adult'
  check (role in ('adult', 'child'));

comment on column public.app_allowlist.role is
  'Role given when this person joins a household with an invite code.';

-- 1c. Joining takes the role from the allowlist (adult unless listed as child).
create or replace function public.join_household(
  p_invite_code  text,
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
  v_role         text;
begin
  perform public.assert_can_onboard();

  -- Step 1c-1: look the code up (case and spaces don't matter).
  select h.id into v_household_id
  from public.households h
  where h.invite_code = upper(regexp_replace(coalesce(p_invite_code, ''), '\s', '', 'g'));

  if v_household_id is null then
    raise exception 'invite_code_not_found';
  end if;

  -- Step 1c-2: keep households small.
  if (select count(*) from public.members m where m.household_id = v_household_id) >= 8 then
    raise exception 'household_full';
  end if;

  -- Step 1c-3: the role recorded on the allowlist for this email.
  select a.role into v_role
  from public.app_allowlist a
  where a.email = lower(coalesce(auth.jwt() ->> 'email', ''));

  -- Step 1c-4: add the member.
  insert into public.members (household_id, user_id, display_name, email, avatar_url, role)
  values (
    v_household_id,
    auth.uid(),
    coalesce(nullif(btrim(p_display_name), ''), split_part(auth.jwt() ->> 'email', '@', 1)),
    lower(auth.jwt() ->> 'email'),
    p_avatar_url,
    coalesce(v_role, 'adult')
  );

  return v_household_id;
end;
$$;


-- -----------------------------------------------------------------------------
-- STEP 2: Role helpers
-- -----------------------------------------------------------------------------
-- All three go through current_household_id(), so they inherit the allowlist
-- and end-date checks: no live allowlist entry, no member, no role.

-- 2a. The signed-in person's member id.
create or replace function public.current_member_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select m.id
  from public.members m
  where m.user_id = auth.uid()
    and m.household_id = public.current_household_id();
$$;

-- 2b. The signed-in person's role: owner, adult or child.
create or replace function public.current_member_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select m.role
  from public.members m
  where m.user_id = auth.uid()
    and m.household_id = public.current_household_id();
$$;

-- 2c. Owners and adults run the household; children mostly look.
create or replace function public.is_household_adult()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.current_member_role() in ('owner', 'adult'), false);
$$;

-- 2d. Shared trigger check: an assignee (or routine owner) must belong to the
--     same household as the row. The column name is the trigger argument.
create or replace function public.check_member_in_household()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member_id uuid := (to_jsonb(new) ->> tg_argv[0])::uuid;
begin
  if v_member_id is not null and not exists (
    select 1 from public.members m
    where m.id = v_member_id and m.household_id = new.household_id
  ) then
    raise exception 'member_not_in_household';
  end if;
  return new;
end;
$$;


-- -----------------------------------------------------------------------------
-- STEP 3: Tighten V1 access for children
-- -----------------------------------------------------------------------------

-- 3a. Households: adults rename and change settings; children only read.
drop policy "households: members rename own" on public.households;
create policy "households: adults update own"
  on public.households for update to authenticated
  using (id = public.current_household_id() and public.is_household_adult())
  with check (id = public.current_household_id() and public.is_household_adult());

-- 3b. Lists and items: everyone reads, adults write.
drop policy "lists: household access" on public.lists;
create policy "lists: household read"
  on public.lists for select to authenticated
  using (household_id = public.current_household_id());
create policy "lists: adults write"
  on public.lists for all to authenticated
  using (household_id = public.current_household_id() and public.is_household_adult())
  with check (household_id = public.current_household_id() and public.is_household_adult());

drop policy "items: household access" on public.items;
create policy "items: household read"
  on public.items for select to authenticated
  using (household_id = public.current_household_id());
create policy "items: adults write"
  on public.items for all to authenticated
  using (household_id = public.current_household_id() and public.is_household_adult())
  with check (household_id = public.current_household_id() and public.is_household_adult());

-- 3c. List lines: everyone reads; adults add, change and delete; children may
--     update only lines assigned to them (and step 4c limits what they change).
--     The two new to-do columns are added here because the policy uses them;
--     their index and assignee check follow in step 4b.
alter table public.list_entries
  add column due_date date,
  add column assigned_to uuid references public.members (id) on delete set null;

drop policy "list_entries: household access" on public.list_entries;
create policy "list_entries: household read"
  on public.list_entries for select to authenticated
  using (household_id = public.current_household_id());
create policy "list_entries: adults insert"
  on public.list_entries for insert to authenticated
  with check (household_id = public.current_household_id() and public.is_household_adult());
create policy "list_entries: adults delete"
  on public.list_entries for delete to authenticated
  using (household_id = public.current_household_id() and public.is_household_adult());
create policy "list_entries: adults or assignee update"
  on public.list_entries for update to authenticated
  using (
    household_id = public.current_household_id()
    and (public.is_household_adult() or assigned_to = public.current_member_id())
  )
  with check (
    household_id = public.current_household_id()
    and (public.is_household_adult() or assigned_to = public.current_member_id())
  );

-- 3d. The invite code: children can't read it. Table-level SELECT is
--     replaced with column-level SELECT that leaves invite_code out; adults
--     read it through household_invite_code().
revoke select, update on public.households from anon, authenticated;
-- (column grants for the new Phase 3 columns follow in step 4a)

-- 3e. Adults only: share or regenerate the invite code, add list lines.
create or replace function public.household_invite_code()
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_household_adult() then
    raise exception 'adults_only';
  end if;
  return (select h.invite_code from public.households h where h.id = public.current_household_id());
end;
$$;

create or replace function public.regenerate_invite_code()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
begin
  if public.current_household_id() is null then
    raise exception 'not_in_household';
  end if;
  if not public.is_household_adult() then
    raise exception 'adults_only';
  end if;

  update public.households
     set invite_code = public.generate_invite_code()
   where id = public.current_household_id()
  returning invite_code into v_code;

  return v_code;
end;
$$;


-- -----------------------------------------------------------------------------
-- STEP 4: New columns on households and list lines
-- -----------------------------------------------------------------------------

-- 4a. Households: which school holiday region, and when the zone rotation
--     started (always a Monday, so fortnights run Monday to Sunday).
alter table public.households
  add column school_region text not null default 'zuid'
    check (school_region in ('noord', 'midden', 'zuid')),
  add column zone_rotation_start date
    check (zone_rotation_start is null or extract(isodow from zone_rotation_start) = 1);

grant select (id, name, timezone, created_at, school_region, zone_rotation_start)
  on public.households to authenticated;
grant update (name, school_region, zone_rotation_start)
  on public.households to authenticated;

-- 4b. To-do lines: an optional due date and an optional person (columns
--     added in step 3c).
create index list_entries_assigned_idx on public.list_entries (assigned_to) where status = 'open';

create trigger list_entries_check_assignee
  before insert or update of assigned_to on public.list_entries
  for each row execute function public.check_member_in_household('assigned_to');

-- 4c. Children may tick their own lines on and off, nothing else. Compares
--     the whole row before and after, ignoring the columns a tick changes.
create or replace function public.list_entries_child_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_tick_columns text[] := array['status', 'completed_by', 'completed_at', 'updated_at'];
begin
  if current_user in ('authenticated', 'anon') and public.current_member_role() = 'child' then
    if (to_jsonb(new) - v_tick_columns) is distinct from (to_jsonb(old) - v_tick_columns)
       or new.status not in ('open', 'done') then
      raise exception 'children_can_only_tick';
    end if;
  end if;
  return new;
end;
$$;

create trigger list_entries_child_guard
  before update on public.list_entries
  for each row execute function public.list_entries_child_guard();

-- 4d. add_entry: adults only, and to-dos can be given a date and a person
--     straight away. The old four-argument version is replaced.
drop function public.add_entry(uuid, text, text, text);

create or replace function public.add_entry(
  p_list_id     uuid,
  p_text        text,
  p_quantity    text default null,
  p_category    text default null,
  p_due_date    date default null,
  p_assigned_to uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_household_id uuid := public.current_household_id();
  v_list_type    public.list_type;
  v_text         text := btrim(coalesce(p_text, ''));
  v_item_id      uuid;
  v_entry_id     uuid;
begin
  -- Step 4d-1: validate the caller, the list and the text.
  if v_household_id is null then
    raise exception 'not_in_household';
  end if;
  if not public.is_household_adult() then
    raise exception 'adults_only';
  end if;

  select l.type into v_list_type
  from public.lists l
  where l.id = p_list_id and l.household_id = v_household_id;

  if v_list_type is null then
    raise exception 'list_not_found';
  end if;
  if v_text = '' then
    raise exception 'empty_text';
  end if;

  -- Step 4d-2: to-do lists are plain text, with optional date and person
  --            (the assignee trigger checks the person is in the household).
  if v_list_type = 'todo' then
    insert into public.list_entries (list_id, household_id, text, quantity, added_by, due_date, assigned_to)
    values (p_list_id, v_household_id, v_text, p_quantity, auth.uid(), p_due_date, p_assigned_to)
    returning id into v_entry_id;
    return v_entry_id;
  end if;

  -- Step 4d-3: shopping lists resolve to an item. A known item keeps its
  --            category unless it was still "Other" and we now know better.
  insert into public.items (household_id, canonical_name, display_name, category)
  values (v_household_id, public.normalize_item_name(v_text), v_text,
          coalesce(nullif(btrim(p_category), ''), 'Other'))
  on conflict (household_id, canonical_name) do update
    set category = case
                     when public.items.category = 'Other' and excluded.category <> 'Other'
                       then excluded.category
                     else public.items.category
                   end
  returning id into v_item_id;

  -- Step 4d-4: reuse an open line for the same item (e.g. a suggestion).
  select e.id into v_entry_id
  from public.list_entries e
  where e.list_id = p_list_id and e.item_id = v_item_id and e.status = 'open'
  limit 1;

  if v_entry_id is not null then
    update public.list_entries
       set quantity = coalesce(nullif(btrim(coalesce(p_quantity, '')), ''), quantity)
     where id = v_entry_id;
    return v_entry_id;
  end if;

  -- Step 4d-5: otherwise add a new line.
  insert into public.list_entries (list_id, household_id, item_id, text, quantity, added_by)
  values (p_list_id, v_household_id, v_item_id, v_text, p_quantity, auth.uid())
  returning id into v_entry_id;

  return v_entry_id;
end;
$$;


-- -----------------------------------------------------------------------------
-- STEP 5: Holidays, days off and the day's mode
-- -----------------------------------------------------------------------------

-- 5a. Every date range that changes a day's mode, from any source:
--       holiday         a school holiday (imported for the household's region)
--       public_holiday  a Dutch public holiday (computed by the app each year)
--       day_off         your own extra day off (study day, a long weekend)
--       school_day      your own override: "this is a school day after all"
--     external_key is set for imported and computed rows so re-imports update
--     in place instead of duplicating; your own days leave it null.
create table public.day_overrides (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households (id) on delete cascade,
  start_date    date not null,
  end_date      date not null,
  kind          text not null check (kind in ('holiday', 'public_holiday', 'day_off', 'school_day')),
  name          text not null check (char_length(name) between 1 and 80),
  source        text not null default 'manual' check (source in ('rijksoverheid', 'computed', 'manual')),
  external_key  text,
  created_at    timestamptz not null default now(),
  check (end_date >= start_date),
  unique (household_id, external_key)
);
create index day_overrides_household_dates_idx on public.day_overrides (household_id, start_date, end_date);

-- 5b. The mode of one date for one household. Order matters:
--       1. your own "school day" override wins over everything
--       2. any holiday, public holiday or day off  -> holiday
--       3. Saturday / Sunday                       -> weekend
--       4. everything else                         -> school
create or replace function public.day_mode(p_household_id uuid, p_date date)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when exists (
      select 1 from public.day_overrides o
      where o.household_id = p_household_id and o.kind = 'school_day'
        and p_date between o.start_date and o.end_date
    ) then 'school'
    when exists (
      select 1 from public.day_overrides o
      where o.household_id = p_household_id and o.kind in ('holiday', 'public_holiday', 'day_off')
        and p_date between o.start_date and o.end_date
    ) then 'holiday'
    when extract(isodow from p_date) in (6, 7) then 'weekend'
    else 'school'
  end;
$$;

-- 5c. What the Today header shows: the mode, plus the holiday (if any) with
--     its dates so the app can say "Autumn holiday, day 3 of 9".
--     A school holiday is preferred over a public holiday inside it.
create or replace function public.day_info(p_date date)
returns table (mode text, label text, period_start date, period_end date)
language sql
stable
security definer
set search_path = public
as $$
  with mode as (
    select public.day_mode(public.current_household_id(), p_date) as mode
  ),
  reason as (
    select o.name, o.start_date, o.end_date
    from public.day_overrides o
    where o.household_id = public.current_household_id()
      and p_date between o.start_date and o.end_date
      and o.kind in ('holiday', 'public_holiday', 'day_off')
    order by case o.kind when 'holiday' then 0 when 'public_holiday' then 1 else 2 end,
             o.end_date - o.start_date desc
    limit 1
  )
  select m.mode,
         case when m.mode = 'holiday' then r.name end,
         case when m.mode = 'holiday' then r.start_date end,
         case when m.mode = 'holiday' then r.end_date end
  from mode m
  left join reason r on true
  where public.current_household_id() is not null;
$$;


-- -----------------------------------------------------------------------------
-- STEP 6: Routines
-- -----------------------------------------------------------------------------

-- 6a. A routine: an ordered checklist that resets every day.
--     owner_member null = a household routine; set = someone's own routine.
create table public.routines (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households (id) on delete cascade,
  name          text not null check (char_length(name) between 1 and 60),
  time_of_day   text not null default 'morning' check (time_of_day in ('morning', 'afternoon', 'evening')),
  owner_member  uuid references public.members (id) on delete cascade,
  sort_order    int not null default 0,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
create index routines_household_idx on public.routines (household_id);

create trigger routines_check_owner
  before insert or update of owner_member on public.routines
  for each row execute function public.check_member_in_household('owner_member');

-- 6b. A step, with its own rule for when it shows:
--       weekdays  ISO days 1 (Mon) .. 7 (Sun); null = every day
--       modes     which of school / holiday / weekend; all three = always
create table public.routine_steps (
  id            uuid primary key default gen_random_uuid(),
  routine_id    uuid not null references public.routines (id) on delete cascade,
  household_id  uuid not null references public.households (id) on delete cascade,
  title         text not null check (char_length(title) between 1 and 120),
  weekdays      smallint[] check (weekdays is null or (weekdays <@ array[1,2,3,4,5,6,7]::smallint[] and cardinality(weekdays) > 0)),
  modes         text[] not null default array['school', 'holiday', 'weekend']
                check (modes <@ array['school', 'holiday', 'weekend'] and cardinality(modes) > 0),
  assigned_to   uuid references public.members (id) on delete set null,
  sort_order    int not null default 0,
  created_at    timestamptz not null default now()
);
create index routine_steps_routine_idx on public.routine_steps (routine_id, sort_order);

-- 6c. Steps take their household from their routine and never move.
--     Runs as the caller, so a routine from another household is invisible
--     and the insert fails on the not-null household_id.
create or replace function public.routine_steps_fill_household()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    new.routine_id := old.routine_id;
    new.household_id := old.household_id;
  else
    select r.household_id into new.household_id from public.routines r where r.id = new.routine_id;
  end if;
  return new;
end;
$$;

create trigger routine_steps_a_fill_household
  before insert or update on public.routine_steps
  for each row execute function public.routine_steps_fill_household();
create trigger routine_steps_b_check_assignee
  before insert or update of assigned_to on public.routine_steps
  for each row execute function public.check_member_in_household('assigned_to');


-- -----------------------------------------------------------------------------
-- STEP 7: Zones (fortnightly rotation)
-- -----------------------------------------------------------------------------

create table public.zones (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households (id) on delete cascade,
  name          text not null check (char_length(name) between 1 and 60),
  sort_order    int not null default 0,
  created_at    timestamptz not null default now()
);
create index zones_household_idx on public.zones (household_id, sort_order);

create table public.zone_tasks (
  id            uuid primary key default gen_random_uuid(),
  zone_id       uuid not null references public.zones (id) on delete cascade,
  household_id  uuid not null references public.households (id) on delete cascade,
  title         text not null check (char_length(title) between 1 and 120),
  assigned_to   uuid references public.members (id) on delete set null,
  sort_order    int not null default 0,
  created_at    timestamptz not null default now()
);
create index zone_tasks_zone_idx on public.zone_tasks (zone_id, sort_order);

create or replace function public.zone_tasks_fill_household()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    new.zone_id := old.zone_id;
    new.household_id := old.household_id;
  else
    select z.household_id into new.household_id from public.zones z where z.id = new.zone_id;
  end if;
  return new;
end;
$$;

create trigger zone_tasks_a_fill_household
  before insert or update on public.zone_tasks
  for each row execute function public.zone_tasks_fill_household();
create trigger zone_tasks_b_check_assignee
  before insert or update of assigned_to on public.zone_tasks
  for each row execute function public.check_member_in_household('assigned_to');

-- 7a. The Monday that starts the fortnight containing p_date. Zone tasks are
--     ticked once per fortnight, so their completions are stored on this date.
--     Without a rotation start the date itself is used.
create or replace function public.zone_period_start(p_household_id uuid, p_date date)
returns date
language sql
stable
security definer
set search_path = public
as $$
  select case
    when h.zone_rotation_start is null then p_date
    else h.zone_rotation_start + (floor((p_date - h.zone_rotation_start) / 14.0) * 14)::int
  end
  from public.households h
  where h.id = p_household_id;
$$;


-- -----------------------------------------------------------------------------
-- STEP 8: Recurring chores
-- -----------------------------------------------------------------------------
-- A chore shows from next_due until ticked; ticking moves next_due on by
-- every_n units from the day it was done.
create table public.chores (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households (id) on delete cascade,
  title         text not null check (char_length(title) between 1 and 120),
  every_n       int not null default 1 check (every_n between 1 and 365),
  unit          text not null default 'week' check (unit in ('day', 'week', 'month')),
  modes         text[] not null default array['school', 'holiday', 'weekend']
                check (modes <@ array['school', 'holiday', 'weekend'] and cardinality(modes) > 0),
  assigned_to   uuid references public.members (id) on delete set null,
  next_due      date not null default current_date,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
create index chores_household_due_idx on public.chores (household_id, next_due);

create trigger chores_check_assignee
  before insert or update of assigned_to on public.chores
  for each row execute function public.check_member_in_household('assigned_to');


-- -----------------------------------------------------------------------------
-- STEP 9: Completions
-- -----------------------------------------------------------------------------
-- One row per tick. for_date is the day it counts for (zone tasks: the
-- fortnight's Monday). prev_next_due remembers a chore's due date so an
-- accidental tick can be undone exactly.
create table public.completions (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null references public.households (id) on delete cascade,
  kind           text not null check (kind in ('step', 'zone_task', 'chore')),
  item_id        uuid not null,
  for_date       date not null,
  done_by        uuid references public.members (id) on delete set null,
  done_at        timestamptz not null default now(),
  prev_next_due  date,
  unique (kind, item_id, for_date)
);
create index completions_household_date_idx on public.completions (household_id, for_date);

-- 9a. The person something is for: a step's own assignee, otherwise the
--     owner of its routine; a zone task's or chore's assignee. Null = anyone.
create or replace function public.completion_assignee(p_kind text, p_item_id uuid)
returns table (household_id uuid, assignee uuid)
language sql
stable
security definer
set search_path = public
as $$
  select s.household_id, coalesce(s.assigned_to, r.owner_member)
  from public.routine_steps s join public.routines r on r.id = s.routine_id
  where p_kind = 'step' and s.id = p_item_id
  union all
  select t.household_id, t.assigned_to
  from public.zone_tasks t
  where p_kind = 'zone_task' and t.id = p_item_id
  union all
  select c.household_id, c.assigned_to
  from public.chores c
  where p_kind = 'chore' and c.id = p_item_id;
$$;

-- 9b. Tick something on (p_done = true) or off. The only way to write
--     completions. Adults may tick anything in the household; children only
--     what is assigned to them (unassigned items count as not theirs).
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
  v_for_date     date := p_for_date;
  v_chore        public.chores;
  v_prev_due     date;
  v_inserted     uuid;
begin
  -- Step 9b-1: who is asking, and does the item exist in their household?
  if v_household_id is null then
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

  -- Step 9b-2: children tick only their own things.
  if not public.is_household_adult() and v_assignee is distinct from v_member_id then
    raise exception 'not_assigned_to_you';
  end if;

  -- Step 9b-3: zone tasks count once per fortnight.
  if p_kind = 'zone_task' then
    v_for_date := public.zone_period_start(v_household_id, p_for_date);
  end if;

  -- Step 9b-4: tick on. Chores move to their next due date.
  if p_done then
    if p_kind = 'chore' then
      select * into v_chore from public.chores c where c.id = p_item_id;
      v_prev_due := v_chore.next_due;
    end if;

    insert into public.completions (household_id, kind, item_id, for_date, done_by, prev_next_due)
    values (v_household_id, p_kind, p_item_id, v_for_date, v_member_id, v_prev_due)
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

  -- Step 9b-5: tick off. A chore goes back to the due date it had.
  delete from public.completions c
   where c.kind = p_kind and c.item_id = p_item_id and c.for_date = v_for_date
  returning c.prev_next_due into v_prev_due;

  if p_kind = 'chore' and v_prev_due is not null then
    update public.chores set next_due = v_prev_due where id = p_item_id;
  end if;
end;
$$;

-- 9c. Deleting a step, task or chore removes its ticks too.
create or replace function public.delete_item_completions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.completions c where c.kind = tg_argv[0] and c.item_id = old.id;
  return old;
end;
$$;

create trigger routine_steps_delete_completions
  after delete on public.routine_steps
  for each row execute function public.delete_item_completions('step');
create trigger zone_tasks_delete_completions
  after delete on public.zone_tasks
  for each row execute function public.delete_item_completions('zone_task');
create trigger chores_delete_completions
  after delete on public.chores
  for each row execute function public.delete_item_completions('chore');


-- -----------------------------------------------------------------------------
-- STEP 10: RLS, realtime and permissions
-- -----------------------------------------------------------------------------

alter table public.day_overrides  enable row level security;
alter table public.routines       enable row level security;
alter table public.routine_steps  enable row level security;
alter table public.zones          enable row level security;
alter table public.zone_tasks     enable row level security;
alter table public.chores         enable row level security;
alter table public.completions    enable row level security;

-- 10a. Everyone in the household reads; adults write. One pair per table.
create policy "day_overrides: household read" on public.day_overrides for select to authenticated
  using (household_id = public.current_household_id());
create policy "day_overrides: adults write" on public.day_overrides for all to authenticated
  using (household_id = public.current_household_id() and public.is_household_adult())
  with check (household_id = public.current_household_id() and public.is_household_adult());

create policy "routines: household read" on public.routines for select to authenticated
  using (household_id = public.current_household_id());
create policy "routines: adults write" on public.routines for all to authenticated
  using (household_id = public.current_household_id() and public.is_household_adult())
  with check (household_id = public.current_household_id() and public.is_household_adult());

create policy "routine_steps: household read" on public.routine_steps for select to authenticated
  using (household_id = public.current_household_id());
create policy "routine_steps: adults write" on public.routine_steps for all to authenticated
  using (household_id = public.current_household_id() and public.is_household_adult())
  with check (household_id = public.current_household_id() and public.is_household_adult());

create policy "zones: household read" on public.zones for select to authenticated
  using (household_id = public.current_household_id());
create policy "zones: adults write" on public.zones for all to authenticated
  using (household_id = public.current_household_id() and public.is_household_adult())
  with check (household_id = public.current_household_id() and public.is_household_adult());

create policy "zone_tasks: household read" on public.zone_tasks for select to authenticated
  using (household_id = public.current_household_id());
create policy "zone_tasks: adults write" on public.zone_tasks for all to authenticated
  using (household_id = public.current_household_id() and public.is_household_adult())
  with check (household_id = public.current_household_id() and public.is_household_adult());

create policy "chores: household read" on public.chores for select to authenticated
  using (household_id = public.current_household_id());
create policy "chores: adults write" on public.chores for all to authenticated
  using (household_id = public.current_household_id() and public.is_household_adult())
  with check (household_id = public.current_household_id() and public.is_household_adult());

-- 10b. Completions are read-only from the browser; set_completion() writes.
create policy "completions: household read" on public.completions for select to authenticated
  using (household_id = public.current_household_id());

-- 10c. Live updates: a tick on one phone shows on the others.
alter publication supabase_realtime add table public.routines;
alter publication supabase_realtime add table public.routine_steps;
alter publication supabase_realtime add table public.zones;
alter publication supabase_realtime add table public.zone_tasks;
alter publication supabase_realtime add table public.chores;
alter publication supabase_realtime add table public.completions;
alter publication supabase_realtime add table public.day_overrides;

-- 10d. Function permissions: lock everything new down, then open what the
--      browser and RLS need. Trigger functions stay revoked.
revoke execute on function
  public.join_household(text, text, text),
  public.current_member_id(),
  public.current_member_role(),
  public.is_household_adult(),
  public.check_member_in_household(),
  public.household_invite_code(),
  public.regenerate_invite_code(),
  public.list_entries_child_guard(),
  public.add_entry(uuid, text, text, text, date, uuid),
  public.day_mode(uuid, date),
  public.day_info(date),
  public.routine_steps_fill_household(),
  public.zone_tasks_fill_household(),
  public.zone_period_start(uuid, date),
  public.completion_assignee(text, uuid),
  public.set_completion(text, uuid, date, boolean),
  public.delete_item_completions()
from public, anon, authenticated;

grant execute on function
  public.join_household(text, text, text),
  public.current_member_id(),
  public.current_member_role(),
  public.is_household_adult(),
  public.household_invite_code(),
  public.regenerate_invite_code(),
  public.add_entry(uuid, text, text, text, date, uuid),
  public.day_info(date),
  public.set_completion(text, uuid, date, boolean)
to authenticated;

-- The holiday import runs server-side with the service role.
grant execute on function public.day_mode(uuid, date) to service_role;
