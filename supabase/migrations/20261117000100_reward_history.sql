-- =============================================================================
-- HomeHub: reward history (which ticks paid for each reward)
-- -----------------------------------------------------------------------------
-- When a parent gives a reward, the ticks that earned it are recorded with
-- that reward (reward_periods.ticks), as a snapshot: the task's title and when
-- it was done, so the history still reads right after a task is renamed or
-- removed.
--
-- Which ticks:
--   * Star goals that carry over (and savings goals): oldest first. The
--     earliest counting ticks not already used by an earlier reward, as many
--     as the reward cost. Leftover ticks stay for the next reward. Stars a
--     child had saved before reward plans existed (start_stars) are used up
--     first and recorded as one "saved stars" line.
--   * Star goals that start fresh each day/week: every counting tick in
--     that day/week.
--   * "All tasks" goals: each linked task's tick in that day/week.
--
-- "Counting" follows the plan: only confirmed ticks (not waiting for a
-- grown-up); only the linked tasks when the plan says so; to-dos only when
-- the plan counts everything.
--
-- Rewards given before this migration get their history filled in the same
-- way, up to the moment they were given.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- STEP 1: where the history lives
-- -----------------------------------------------------------------------------
alter table public.reward_periods
  add column ticks jsonb not null default '[]'::jsonb;

comment on column public.reward_periods.ticks is
  'What earned this reward: [{id, kind, title, done_at}] oldest first, plus {saved: n} for stars saved before reward plans.';


-- -----------------------------------------------------------------------------
-- STEP 2: a plan's counting ticks since a moment (internal)
-- -----------------------------------------------------------------------------
create or replace function public.reward_plan_ticks(p_plan_id uuid, p_from timestamptz, p_upto timestamptz)
returns table (id uuid, kind text, item_id uuid, title text, done_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  -- 2a. Routine steps, chores and zone tasks.
  select c.id, c.kind, c.item_id,
         coalesce(s.title, ch.title, z.title, 'A task that was removed'), c.done_at
  from public.reward_plans p
  join public.completions c on c.done_for = p.member_id and not c.pending
  left join public.routine_steps s on c.kind = 'step' and s.id = c.item_id
  left join public.chores ch on c.kind = 'chore' and ch.id = c.item_id
  left join public.zone_tasks z on c.kind = 'zone_task' and z.id = c.item_id
  where p.id = p_plan_id
    and c.done_at >= p_from and c.done_at <= p_upto
    and (p.counts = 'all' or exists (
      select 1 from public.reward_plan_tasks t where t.plan_id = p.id and t.kind = c.kind and t.task_id = c.item_id))
  union all
  -- 2b. To-dos (only when the plan counts everything).
  select e.id, 'todo', e.id, e.text, e.completed_at
  from public.reward_plans p
  join public.list_entries e on coalesce(e.done_for, e.assigned_to) = p.member_id
  join public.lists l on l.id = e.list_id and l.type = 'todo'
  where p.id = p_plan_id and p.counts = 'all'
    and e.status in ('done', 'cleared') and not e.pending
    and e.completed_at >= p_from and e.completed_at <= p_upto;
$$;


-- -----------------------------------------------------------------------------
-- STEP 3: the snapshot for one reward (internal)
-- -----------------------------------------------------------------------------
create or replace function public.reward_snapshot(
  p_plan_id      uuid,
  p_period_start date,
  p_upto         timestamptz,
  p_cost         int,          -- stars the reward used (carry-over / savings goals)
  p_exclude      uuid          -- this reward's own row (left out of "already used")
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_plan       public.reward_plans;
  v_tz         text;
  v_used       int;
  v_from_saved int;
  v_needed     int;
  v_ticks      jsonb;
begin
  select * into v_plan from public.reward_plans where id = p_plan_id;
  select h.timezone into v_tz from public.households h where h.id = v_plan.household_id;

  -- 3a. Carry-over star goals and savings goals: oldest unused ticks first.
  if v_plan.goal = 'stars' and (v_plan.carry_over or v_plan.period = 'once') then
    -- Stars used by earlier rewards; saved stars (start_stars) go first.
    select coalesce(sum(r.stars_used), 0) into v_used
    from public.reward_periods r
    where r.plan_id = p_plan_id and r.given_at < p_upto and r.id is distinct from p_exclude;
    v_from_saved := least(greatest(v_plan.start_stars - v_used, 0), p_cost);
    v_needed := greatest(p_cost - v_from_saved, 0);

    select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'kind', t.kind, 'title', t.title, 'done_at', t.done_at) order by t.done_at), '[]'::jsonb)
      into v_ticks
    from (
      select * from public.reward_plan_ticks(p_plan_id, v_plan.counts_from::timestamp at time zone v_tz, p_upto) t
      where not exists (
        select 1 from public.reward_periods r, jsonb_array_elements(r.ticks) x
        where r.plan_id = p_plan_id and r.id is distinct from p_exclude and x ->> 'id' = t.id::text)
      order by t.done_at
      limit v_needed
    ) t;

    if v_from_saved > 0 then
      v_ticks := jsonb_build_array(jsonb_build_object('saved', v_from_saved)) || v_ticks;
    end if;
    return v_ticks;
  end if;

  -- 3b. Star goals that start fresh: every counting tick that day/week.
  if v_plan.goal = 'stars' then
    select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'kind', t.kind, 'title', t.title, 'done_at', t.done_at) order by t.done_at), '[]'::jsonb)
      into v_ticks
    from public.reward_plan_ticks(p_plan_id, p_period_start::timestamp at time zone v_tz, p_upto) t;
    return v_ticks;
  end if;

  -- 3c. "All tasks": each linked task's first tick that day/week.
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'kind', t.kind, 'title', t.title, 'done_at', t.done_at) order by t.done_at), '[]'::jsonb)
    into v_ticks
  from (
    select distinct on (t.kind, t.item_id) t.*
    from public.reward_plan_ticks(p_plan_id, p_period_start::timestamp at time zone v_tz, p_upto) t
    order by t.kind, t.item_id, t.done_at
  ) t;
  return v_ticks;
end;
$$;


-- -----------------------------------------------------------------------------
-- STEP 4: give_reward records the snapshot
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
  v_cost  int;
  v_id    uuid;
begin
  -- Step 4a: parents only; the plan must be in this household.
  if not public.is_parent() then
    raise exception 'parents_only';
  end if;
  select * into v_plan from public.reward_plans p where p.id = p_plan_id and p.household_id = public.current_household_id();
  if v_plan.id is null then
    raise exception 'plan_not_found';
  end if;

  -- Step 4b: earned, and not given yet this period?
  select (now() at time zone h.timezone)::date into v_today from public.households h where h.id = v_plan.household_id;
  select * into v_row from public.reward_progress_core(v_plan.member_id, v_today) r where r.plan_id = p_plan_id;
  if v_row.plan_id is null or v_row.given then
    raise exception 'already_given';
  end if;
  if v_row.target is null or v_row.target = 0 or v_row.progress < v_row.target then
    raise exception 'not_earned_yet';
  end if;

  -- Step 4c: record it, with what earned it.
  v_cost := case when v_plan.goal = 'stars' and (v_plan.carry_over or v_plan.period = 'once') then v_row.target else 0 end;
  insert into public.reward_periods (plan_id, household_id, period_start, given_by, stars_used)
  values (p_plan_id, v_plan.household_id, v_row.period_start, public.current_member_id(), v_cost)
  returning id into v_id;
  update public.reward_periods
     set ticks = public.reward_snapshot(p_plan_id, v_row.period_start, now(), coalesce(nullif(v_cost, 0), v_row.target), v_id)
   where id = v_id;

  if v_plan.period = 'once' then
    update public.reward_plans set active = false where id = p_plan_id;
  end if;
end;
$$;


-- -----------------------------------------------------------------------------
-- STEP 5: fill in the history of rewards already given (oldest first, so
--         each one sees what earlier ones used)
-- -----------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select rp.id, rp.plan_id, rp.period_start, rp.given_at, rp.stars_used, p.stars_needed
    from public.reward_periods rp join public.reward_plans p on p.id = rp.plan_id
    order by rp.given_at
  loop
    update public.reward_periods
       set ticks = public.reward_snapshot(r.plan_id, r.period_start, r.given_at, coalesce(nullif(r.stars_used, 0), r.stars_needed, 0), r.id)
     where id = r.id;
  end loop;
end;
$$;


-- -----------------------------------------------------------------------------
-- STEP 6: permissions (internal helpers: not callable from the app)
-- -----------------------------------------------------------------------------
revoke execute on function
  public.reward_plan_ticks(uuid, timestamptz, timestamptz),
  public.reward_snapshot(uuid, date, timestamptz, int, uuid)
from public, anon, authenticated;
