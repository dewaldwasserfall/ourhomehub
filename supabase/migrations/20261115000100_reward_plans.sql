-- =============================================================================
-- HomeHub: reward plans (repeating rewards per child)
-- -----------------------------------------------------------------------------
-- Replaces one-off rewards with plans parents set up per child:
--
--   repeats   day | week (Mon–Sun) | once (a savings goal)
--   goal      stars (N stars) | all_tasks (every linked task done)
--   counts    all (everything the child does) | linked (only the tasks
--             linked to the plan: its "child objects")
--   carry     carry_over: unspent stars roll into the next day/week
--             (default on); off: every day/week starts at zero
--
-- Progress is worked out live from confirmed ticks (a tick still waiting for
-- a grown-up doesn't count). When a child reaches the goal, parents get a
-- push (the notification job) and mark it Given; reward_periods keeps that
-- history. One tick can count towards several plans.
--
-- Parents (the owner, and adults the owner marks as a parent) set plans up
-- and give rewards. Everyone in the household can see them.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- STEP 1: parents
-- -----------------------------------------------------------------------------
alter table public.members
  add column is_parent boolean not null default false;

comment on column public.members.is_parent is
  'Sets up reward plans and gives rewards (besides the owner). Owner-controlled; adults only.';

-- 1a. Owner, or an adult marked as a parent.
create or replace function public.is_parent()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select m.role = 'owner' or (m.role = 'adult' and m.is_parent)
    from public.members m
    where m.user_id = auth.uid() and m.household_id = public.current_household_id()
  ), false);
$$;

-- 1b. Only the owner changes the flag (through 1c).
create or replace function public.members_protect_parent()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.is_parent is distinct from old.is_parent and current_user in ('authenticated', 'anon') then
    raise exception 'owner_only';
  end if;
  return new;
end;
$$;

create trigger members_protect_parent
  before update of is_parent on public.members
  for each row execute function public.members_protect_parent();

-- 1c. The owner marks an adult as a parent (or not).
create or replace function public.set_parent(p_member_id uuid, p_on boolean)
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
  update public.members set is_parent = p_on where id = p_member_id;
end;
$$;

-- 1d. Today: the adults who already share the private parts of HomeHub
--     (Trips access) are parents.
update public.members set is_parent = true where role = 'adult' and can_see_trips;


-- -----------------------------------------------------------------------------
-- STEP 2: plans, their tasks and their history
-- -----------------------------------------------------------------------------
create table public.reward_plans (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households (id) on delete cascade,
  member_id     uuid not null references public.members (id) on delete cascade,
  title         text not null check (char_length(title) between 1 and 80),
  period        text not null check (period in ('day', 'week', 'once')),
  goal          text not null default 'stars' check (goal in ('stars', 'all_tasks')),
  stars_needed  int check (stars_needed between 1 and 1000),
  counts        text not null default 'all' check (counts in ('all', 'linked')),
  carry_over    boolean not null default true,
  -- Stars count from this day on, plus start_stars (stars already saved when
  -- the plan began, e.g. carried over from the old rewards).
  counts_from   date not null default current_date,
  start_stars   int not null default 0 check (start_stars >= 0),
  active        boolean not null default true,
  sort_order    int not null default 0,
  created_by    uuid references public.members (id) on delete set null,
  created_at    timestamptz not null default now(),
  -- A star goal needs a number; "all tasks" needs tasks to be linked.
  constraint reward_plans_goal_shape check (
    (goal = 'stars' and stars_needed is not null) or (goal = 'all_tasks' and counts = 'linked')
  )
);
create index reward_plans_member_idx on public.reward_plans (member_id) where active;

-- 2a. The child objects: tasks that count towards a plan.
create table public.reward_plan_tasks (
  plan_id       uuid not null references public.reward_plans (id) on delete cascade,
  household_id  uuid not null references public.households (id) on delete cascade,
  kind          text not null check (kind in ('step', 'chore', 'zone_task')),
  task_id       uuid not null,
  primary key (plan_id, kind, task_id)
);

-- 2b. Given rewards, one row per plan and day/week (or once).
create table public.reward_periods (
  id            uuid primary key default gen_random_uuid(),
  plan_id       uuid not null references public.reward_plans (id) on delete cascade,
  household_id  uuid not null references public.households (id) on delete cascade,
  period_start  date not null,
  given_at      timestamptz not null default now(),
  given_by      uuid references public.members (id) on delete set null,
  -- Stars this reward used up (carried-over plans subtract them later).
  stars_used    int not null default 0,
  unique (plan_id, period_start)
);

-- 2c. A plan is for a child in the same household.
create or replace function public.reward_plans_check()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.members m where m.id = new.member_id and m.household_id = new.household_id and m.role = 'child'
  ) then
    raise exception 'reward_for_children_only';
  end if;
  return new;
end;
$$;

create trigger reward_plans_check
  before insert or update of member_id, household_id on public.reward_plans
  for each row execute function public.reward_plans_check();

-- 2d. A linked task takes the plan's household and must live in it.
create or replace function public.reward_plan_tasks_check()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select p.household_id into new.household_id from public.reward_plans p where p.id = new.plan_id;
  if (select a.household_id from public.completion_assignee(new.kind, new.task_id) a) is distinct from new.household_id then
    raise exception 'task_not_found';
  end if;
  return new;
end;
$$;

create trigger reward_plan_tasks_check
  before insert or update on public.reward_plan_tasks
  for each row execute function public.reward_plan_tasks_check();


-- -----------------------------------------------------------------------------
-- STEP 3: progress
-- -----------------------------------------------------------------------------
-- One row per active plan of a child, for the day/week that holds p_today:
-- progress towards target, and whether this period's reward was given.
-- Internal (no permission checks): reward_progress() below and the
-- notification job use it.
create or replace function public.reward_progress_core(p_member_id uuid, p_today date)
returns table (plan_id uuid, period_start date, period_end date, progress int, target int, given boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tz      text;
  v_mode    text;
  v_plan    public.reward_plans;
  v_start   date;
  v_end     date;
  v_from    date;
  v_ticks   int;
  v_used    int;
begin
  select h.timezone, public.day_mode(h.id, p_today) into v_tz, v_mode
  from public.members m join public.households h on h.id = m.household_id
  where m.id = p_member_id;
  if v_tz is null then
    return;
  end if;

  for v_plan in
    select * from public.reward_plans p where p.member_id = p_member_id and p.active order by p.sort_order, p.created_at
  loop
    -- Step 3a: this period's bounds.
    v_start := case v_plan.period
                 when 'day'  then p_today
                 when 'week' then p_today - (extract(isodow from p_today)::int - 1)
                 else v_plan.counts_from
               end;
    v_end := case v_plan.period when 'day' then p_today when 'week' then v_start + 6 else null end;

    if v_plan.goal = 'stars' then
      -- Step 3b: stars. Carried over (or once): everything since the plan
      -- began, plus start_stars, minus what earlier rewards used up.
      -- Otherwise: only this day/week.
      v_from := case when v_plan.carry_over or v_plan.period = 'once' then v_plan.counts_from else v_start end;

      select
        (select count(*) from public.completions c
          where c.done_for = p_member_id and not c.pending
            and c.done_at >= (v_from::timestamp at time zone v_tz)
            and (v_plan.counts = 'all' or exists (
              select 1 from public.reward_plan_tasks t where t.plan_id = v_plan.id and t.kind = c.kind and t.task_id = c.item_id)))
        + (case when v_plan.counts = 'all' then
            (select count(*) from public.list_entries e join public.lists l on l.id = e.list_id and l.type = 'todo'
              where coalesce(e.done_for, e.assigned_to) = p_member_id
                and e.status in ('done', 'cleared') and not e.pending
                and e.completed_at >= (v_from::timestamp at time zone v_tz))
           else 0 end)
      into v_ticks;

      v_used := 0;
      if v_plan.carry_over or v_plan.period = 'once' then
        select coalesce(sum(r.stars_used), 0) into v_used from public.reward_periods r where r.plan_id = v_plan.id;
        v_ticks := v_ticks + v_plan.start_stars;
      end if;

      plan_id := v_plan.id;
      period_start := v_start;
      period_end := v_end;
      progress := greatest(0, v_ticks - v_used);
      target := v_plan.stars_needed;
    else
      -- Step 3c: all linked tasks done this day/week. A daily plan skips
      -- routine steps that don't apply today and chores not due yet.
      select count(*), count(*) filter (where exists (
               select 1 from public.completions c
               where c.kind = t.kind and c.item_id = t.task_id and c.done_for = p_member_id and not c.pending
                 and c.done_at >= (v_start::timestamp at time zone v_tz)))
        into target, progress
      from public.reward_plan_tasks t
      left join public.routine_steps s on t.kind = 'step' and s.id = t.task_id
      left join public.chores ch on t.kind = 'chore' and ch.id = t.task_id
      where t.plan_id = v_plan.id
        and (v_plan.period <> 'day' or t.kind <> 'step'
             or ((s.weekdays is null or extract(isodow from p_today)::smallint = any (s.weekdays)) and v_mode = any (s.modes)))
        and (v_plan.period <> 'day' or t.kind <> 'chore' or ch.next_due <= p_today or exists (
               select 1 from public.completions c
               where c.kind = 'chore' and c.item_id = t.task_id and c.done_at >= (v_start::timestamp at time zone v_tz)));
      plan_id := v_plan.id;
      period_start := v_start;
      period_end := v_end;
    end if;

    -- Step 3d: already given for this period?
    given := exists (select 1 from public.reward_periods r where r.plan_id = v_plan.id and r.period_start = v_start);
    return next;
  end loop;
end;
$$;

-- 3e. The public version: the household's adults and board see every child;
--     a child sees their own.
create or replace function public.reward_progress(p_member_id uuid, p_today date)
returns table (plan_id uuid, period_start date, period_end date, progress int, target int, given boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.members m where m.id = p_member_id and m.household_id = public.current_household_id()) then
    raise exception 'member_not_in_household';
  end if;
  if not public.is_household_adult() and public.current_board_id() is null
     and p_member_id is distinct from public.current_member_id() then
    raise exception 'not_assigned_to_you';
  end if;
  return query select * from public.reward_progress_core(p_member_id, p_today);
end;
$$;


-- -----------------------------------------------------------------------------
-- STEP 4: giving a reward
-- -----------------------------------------------------------------------------
create or replace function public.give_reward(p_plan_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan  public.reward_plans;
  v_today date;
  v_row   record;
begin
  -- Step 4a: parents only, a plan in their household.
  if not public.is_parent() then
    raise exception 'parents_only';
  end if;
  select * into v_plan from public.reward_plans p where p.id = p_plan_id and p.household_id = public.current_household_id();
  if v_plan.id is null then
    raise exception 'plan_not_found';
  end if;

  -- Step 4b: this period's progress must have reached the goal.
  select (now() at time zone h.timezone)::date into v_today from public.households h where h.id = v_plan.household_id;
  select * into v_row from public.reward_progress_core(v_plan.member_id, v_today) r where r.plan_id = p_plan_id;
  if v_row.plan_id is null or v_row.given then
    raise exception 'already_given';
  end if;
  if v_row.target is null or v_row.target = 0 or v_row.progress < v_row.target then
    raise exception 'not_earned_yet';
  end if;

  -- Step 4c: record it; a carried-over star goal uses its stars up; a
  --          once-only reward is finished.
  insert into public.reward_periods (plan_id, household_id, period_start, given_by, stars_used)
  values (p_plan_id, v_plan.household_id, v_row.period_start, public.current_member_id(),
          case when v_plan.goal = 'stars' and (v_plan.carry_over or v_plan.period = 'once') then v_row.target else 0 end);
  if v_plan.period = 'once' then
    update public.reward_plans set active = false where id = p_plan_id;
  end if;
end;
$$;


-- -----------------------------------------------------------------------------
-- STEP 5: the old one-off rewards become "once" plans
-- -----------------------------------------------------------------------------
-- Open rewards keep the child's saved stars as start_stars (earned minus what
-- given rewards spent); given ones become finished plans with their history.
with balances as (
  select m.id as member_id,
         (select count(*) from public.completions c where c.done_for = m.id and not c.pending)
         + (select count(*) from public.list_entries e where coalesce(e.done_for, e.assigned_to) = m.id and e.status in ('done', 'cleared') and not e.pending)
         - (select coalesce(sum(r.stars_needed), 0) from public.rewards r where r.member_id = m.id and r.given_at is not null) as saved
  from public.members m where m.role = 'child'
)
insert into public.reward_plans (household_id, member_id, title, period, goal, stars_needed, counts, carry_over, counts_from, start_stars, active, created_at)
select r.household_id, r.member_id, r.title, 'once', 'stars', r.stars_needed, 'all', true,
       current_date, greatest(0, coalesce(b.saved, 0)), r.given_at is null, r.created_at
from public.rewards r left join balances b on b.member_id = r.member_id;

insert into public.reward_periods (plan_id, household_id, period_start, given_at, stars_used)
select p.id, p.household_id, p.counts_from, r.given_at, 0
from public.rewards r
join public.reward_plans p on p.member_id = r.member_id and p.title = r.title and p.created_at = r.created_at and p.period = 'once'
where r.given_at is not null;


-- -----------------------------------------------------------------------------
-- STEP 6: RLS and permissions
-- -----------------------------------------------------------------------------
alter table public.reward_plans      enable row level security;
alter table public.reward_plan_tasks enable row level security;
alter table public.reward_periods    enable row level security;

create policy "reward_plans: household read" on public.reward_plans for select to authenticated
  using (household_id = public.current_household_id());
create policy "reward_plans: parents write" on public.reward_plans for all to authenticated
  using (household_id = public.current_household_id() and public.is_parent())
  with check (household_id = public.current_household_id() and public.is_parent());

create policy "reward_plan_tasks: household read" on public.reward_plan_tasks for select to authenticated
  using (household_id = public.current_household_id());
create policy "reward_plan_tasks: parents write" on public.reward_plan_tasks for all to authenticated
  using (household_id = public.current_household_id() and public.is_parent())
  with check (public.is_parent());

create policy "reward_periods: household read" on public.reward_periods for select to authenticated
  using (household_id = public.current_household_id());

revoke execute on function
  public.is_parent(),
  public.members_protect_parent(),
  public.set_parent(uuid, boolean),
  public.reward_plans_check(),
  public.reward_plan_tasks_check(),
  public.reward_progress_core(uuid, date),
  public.reward_progress(uuid, date),
  public.give_reward(uuid)
from public, anon, authenticated;

grant execute on function
  public.is_parent(),
  public.set_parent(uuid, boolean),
  public.reward_progress(uuid, date),
  public.give_reward(uuid)
to authenticated;
grant execute on function public.reward_progress_core(uuid, date) to service_role;

-- Live updates for the Stars screen and the board.
alter publication supabase_realtime add table public.reward_plans;
alter publication supabase_realtime add table public.reward_periods;
