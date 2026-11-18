-- =============================================================================
-- HomeHub: the week grid, paying out stars, and "missed, not late" for kids
-- -----------------------------------------------------------------------------
-- 1. Board view per child (members.board_style / board_days / board_plan_id):
--    "list" (as before) or "week_grid": a table of a reward's tasks by day,
--    for the days chosen (default Monday to Friday). Parents set it
--    (set_board_view). Lennon starts on the week grid.
--
-- 2. Paying out stars (reward_payouts): a parent can pay out single stars, or
--    a whole day's, instead of (or as well as) giving a whole reward. Paid
--    stars are recorded with the ticks they were, are struck through in the
--    grid, and are used up: they no longer count towards the reward.
--
-- 3. Crediting a past day (credit_completion): a parent fills in a day the
--    child forgot (e.g. Monday, on Wednesday). It counts for the child at
--    once, and doesn't move the chore's due date backwards.
--
-- 4. Missed, not late (roll_missed_chores): a child's repeating chore that
--    wasn't done moves on to its next day instead of hanging around as
--    "Late". The background job runs it every few minutes.
--
-- Board versions (board_credit_completion, board_pay_out_stars) run as the
-- parent who unlocked the board, like board_add_entry.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- STEP 1: board view per child
-- -----------------------------------------------------------------------------
alter table public.members
  add column board_style   text not null default 'list' check (board_style in ('list', 'week_grid')),
  add column board_days    smallint[] not null default '{1,2,3,4,5}',
  add column board_plan_id uuid references public.reward_plans (id) on delete set null;

comment on column public.members.board_style is 'How a child''s column opens on the board: list, or week_grid (a reward''s tasks by day).';
comment on column public.members.board_days is 'Week grid days, ISO weekday numbers (1 = Monday).';
comment on column public.members.board_plan_id is 'Week grid rows: this reward''s linked tasks (null: the child''s first active reward).';

-- 1a. Only through set_board_view (parents).
create or replace function public.members_protect_board_view()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (new.board_style is distinct from old.board_style
      or new.board_days is distinct from old.board_days
      or new.board_plan_id is distinct from old.board_plan_id)
     and current_user in ('authenticated', 'anon') then
    raise exception 'parents_only';
  end if;
  return new;
end;
$$;

create trigger members_protect_board_view
  before update of board_style, board_days, board_plan_id on public.members
  for each row execute function public.members_protect_board_view();

-- 1b. Set a child's board view.
create or replace function public.set_board_view(p_member_id uuid, p_style text, p_days smallint[], p_plan_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_household_id uuid := public.current_household_id();
begin
  if not public.is_parent() then
    raise exception 'parents_only';
  end if;
  if not exists (select 1 from public.members m where m.id = p_member_id and m.household_id = v_household_id and m.role = 'child') then
    raise exception 'member_not_in_household';
  end if;
  if p_style not in ('list', 'week_grid') then
    raise exception 'invalid_style';
  end if;
  if p_days is null or cardinality(p_days) = 0 or exists (select 1 from unnest(p_days) d where d not between 1 and 7) then
    raise exception 'invalid_days';
  end if;
  if p_plan_id is not null and not exists (select 1 from public.reward_plans p where p.id = p_plan_id and p.member_id = p_member_id) then
    raise exception 'plan_not_found';
  end if;
  update public.members
     set board_style = p_style,
         board_days = (select array_agg(distinct d order by d) from unnest(p_days) d),
         board_plan_id = p_plan_id
   where id = p_member_id;
end;
$$;

-- 1c. Lennon starts on the week grid (Monday to Friday, his first active reward).
update public.members m
   set board_style = 'week_grid',
       board_plan_id = (select p.id from public.reward_plans p where p.member_id = m.id and p.active order by p.sort_order, p.created_at limit 1)
 where m.role = 'child' and m.display_name = 'Lennon';


-- -----------------------------------------------------------------------------
-- STEP 2: paid-out stars
-- -----------------------------------------------------------------------------
create table public.reward_payouts (
  id            uuid primary key default gen_random_uuid(),
  plan_id       uuid not null references public.reward_plans (id) on delete cascade,
  household_id  uuid not null references public.households (id) on delete cascade,
  paid_at       timestamptz not null default now(),
  paid_by       uuid references public.members (id) on delete set null,
  -- The ticks paid out: [{id, kind, title, done_at, for_date}].
  ticks         jsonb not null default '[]'::jsonb
);
create index reward_payouts_plan_idx on public.reward_payouts (plan_id);

alter table public.reward_payouts enable row level security;
create policy "reward_payouts: household read" on public.reward_payouts for select to authenticated
  using (household_id = public.current_household_id());
alter publication supabase_realtime add table public.reward_payouts;

-- 2a. Is this tick already used (paid out, or used by a given reward)?
create or replace function public.reward_tick_used(p_plan_id uuid, p_tick_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
           select 1 from public.reward_payouts r, jsonb_array_elements(r.ticks) x
           where r.plan_id = p_plan_id and x ->> 'id' = p_tick_id::text)
      or exists (
           select 1 from public.reward_periods r, jsonb_array_elements(r.ticks) x
           where r.plan_id = p_plan_id and x ->> 'id' = p_tick_id::text);
$$;

-- 2b. Pay out stars: the given ticks (steps, chores, zone tasks) of the plan's
--     child. Waiting ticks are confirmed first. Ticks that don't count for
--     this plan, or are already used, are skipped. Returns how many were paid.
create or replace function public.pay_out_stars(p_plan_id uuid, p_completion_ids uuid[])
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan    public.reward_plans;
  v_pending uuid[];
  v_ticks   jsonb;
  v_count   int;
begin
  -- Step 2b-1: parents only; this household's plan.
  if not public.is_parent() then
    raise exception 'parents_only';
  end if;
  select * into v_plan from public.reward_plans p where p.id = p_plan_id and p.household_id = public.current_household_id();
  if v_plan.id is null then
    raise exception 'plan_not_found';
  end if;
  if p_completion_ids is null or cardinality(p_completion_ids) = 0 then
    return 0;
  end if;

  -- Step 2b-2: confirm any still waiting (paying out says "yes, done").
  select array_agg(c.id) into v_pending
  from public.completions c
  where c.id = any (p_completion_ids) and c.pending and c.done_for = v_plan.member_id;
  if v_pending is not null then
    perform public.confirm_ticks(v_pending, null);
  end if;

  -- Step 2b-3: the ones that count for this plan and aren't used yet.
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'kind', t.kind, 'title', t.title, 'done_at', t.done_at, 'for_date', c.for_date) order by c.for_date, t.done_at), '[]'::jsonb),
         count(*)
    into v_ticks, v_count
  from public.reward_plan_ticks(p_plan_id, '-infinity', now()) t
  join public.completions c on c.id = t.id
  where t.id = any (p_completion_ids)
    and not public.reward_tick_used(p_plan_id, t.id);

  if v_count = 0 then
    return 0;
  end if;
  insert into public.reward_payouts (plan_id, household_id, paid_by, ticks)
  values (p_plan_id, v_plan.household_id, public.current_member_id(), v_ticks);
  return v_count;
end;
$$;


-- -----------------------------------------------------------------------------
-- STEP 3: progress and reward history leave paid-out stars out
-- -----------------------------------------------------------------------------
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
      -- Otherwise: only this day/week. Either way, minus stars paid out.
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

      -- Paid-out stars from the same window are used up too.
      v_used := v_used + (
        select count(*) from public.reward_payouts r, jsonb_array_elements(r.ticks) x
        where r.plan_id = v_plan.id and (x ->> 'done_at')::timestamptz >= (v_from::timestamp at time zone v_tz));

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

-- 3e. A given reward's history never uses a paid-out star (same as before,
--     plus the reward_payouts check).
create or replace function public.reward_snapshot(
  p_plan_id      uuid,
  p_period_start date,
  p_upto         timestamptz,
  p_cost         int,
  p_exclude      uuid
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

  if v_plan.goal = 'stars' and (v_plan.carry_over or v_plan.period = 'once') then
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
        and not exists (
              select 1 from public.reward_payouts r, jsonb_array_elements(r.ticks) x
              where r.plan_id = p_plan_id and x ->> 'id' = t.id::text)
      order by t.done_at
      limit v_needed
    ) t;

    if v_from_saved > 0 then
      v_ticks := jsonb_build_array(jsonb_build_object('saved', v_from_saved)) || v_ticks;
    end if;
    return v_ticks;
  end if;

  if v_plan.goal = 'stars' then
    select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'kind', t.kind, 'title', t.title, 'done_at', t.done_at) order by t.done_at), '[]'::jsonb)
      into v_ticks
    from public.reward_plan_ticks(p_plan_id, p_period_start::timestamp at time zone v_tz, p_upto) t
    where not exists (
      select 1 from public.reward_payouts r, jsonb_array_elements(r.ticks) x
      where r.plan_id = p_plan_id and x ->> 'id' = t.id::text);
    return v_ticks;
  end if;

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
-- STEP 4: ticking a past day
-- -----------------------------------------------------------------------------

-- 4a. apply_completion (as before), except: filling in a day before today
--     that's earlier than the chore's due date leaves the due date alone
--     (ticking Monday on Wednesday mustn't make the chore due Tuesday).
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
  v_today    date;
begin
  -- Zone tasks are done once per rotation period: key them on its start.
  if p_kind = 'zone_task' then
    v_for_date := public.zone_period_start(p_household_id, p_for_date);
  end if;

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
      select (now() at time zone h.timezone)::date into v_today from public.households h where h.id = p_household_id;
      -- A past day filled in: the chore's schedule stays as it is.
      if v_for_date < v_today and v_for_date < v_chore.next_due then
        return;
      end if;
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

  delete from public.completions c
   where c.kind = p_kind and c.item_id = p_item_id and c.for_date = v_for_date
  returning c.prev_next_due into v_prev_due;

  if p_kind = 'chore' and v_prev_due is not null then
    update public.chores set next_due = v_prev_due where id = p_item_id;
  end if;
end;
$$;

-- 4b. A parent credits (or takes back) a child's tick for a day, today or
--     earlier. Counts at once: no waiting for confirmation.
create or replace function public.credit_completion(p_kind text, p_item_id uuid, p_for_date date, p_member_id uuid, p_done boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_household_id uuid := public.current_household_id();
  v_parent       uuid := public.current_member_id();
  v_item_house   uuid;
  v_assignee     uuid;
  v_today        date;
begin
  if not public.is_parent() then
    raise exception 'parents_only';
  end if;
  if p_kind not in ('step', 'zone_task', 'chore') or p_for_date is null then
    raise exception 'invalid_completion';
  end if;
  select (now() at time zone h.timezone)::date into v_today from public.households h where h.id = v_household_id;
  if p_for_date > v_today then
    raise exception 'not_yet';
  end if;
  select a.household_id, a.assignee into v_item_house, v_assignee from public.completion_assignee(p_kind, p_item_id) a;
  if v_item_house is distinct from v_household_id then
    raise exception 'item_not_found';
  end if;
  if not exists (select 1 from public.members m where m.id = p_member_id and m.household_id = v_household_id and m.role = 'child') then
    raise exception 'member_not_in_household';
  end if;
  if v_assignee is not null and v_assignee <> p_member_id then
    raise exception 'assigned_to_someone_else';
  end if;

  perform public.apply_completion(v_household_id, p_kind, p_item_id, p_for_date, p_done, v_parent, p_member_id, false, false);
  if p_done then
    update public.completions
       set confirmed_by = v_parent, confirmed_at = now()
     where kind = p_kind and item_id = p_item_id and for_date = p_for_date and confirmed_by is null and done_for = p_member_id;
  end if;
end;
$$;


-- -----------------------------------------------------------------------------
-- STEP 5: the same from an unlocked board (as the parent who unlocked it)
-- -----------------------------------------------------------------------------
create or replace function public.board_credit_completion(p_kind text, p_item_id uuid, p_for_date date, p_member_id uuid, p_done boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev text;
begin
  v_prev := public.board_act_as(public.board_admin_member());
  perform public.credit_completion(p_kind, p_item_id, p_for_date, p_member_id, p_done);
  perform set_config('request.jwt.claim.sub', v_prev, true);
end;
$$;

create or replace function public.board_pay_out_stars(p_plan_id uuid, p_completion_ids uuid[])
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev  text;
  v_count int;
begin
  v_prev := public.board_act_as(public.board_admin_member());
  v_count := public.pay_out_stars(p_plan_id, p_completion_ids);
  perform set_config('request.jwt.claim.sub', v_prev, true);
  return v_count;
end;
$$;

-- 5b. Confirm (or reject) specific waiting ticks from an unlocked board.
create or replace function public.board_review_ticks(p_completion_ids uuid[], p_confirm boolean)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev  text;
  v_count int;
begin
  v_prev := public.board_act_as(public.board_admin_member());
  if p_confirm then
    v_count := public.confirm_ticks(p_completion_ids, null);
  else
    v_count := public.reject_ticks(p_completion_ids, null);
  end if;
  perform set_config('request.jwt.claim.sub', v_prev, true);
  return v_count;
end;
$$;


-- -----------------------------------------------------------------------------
-- STEP 6: missed, not late (children's repeating chores move on)
-- -----------------------------------------------------------------------------
-- Run by the background job for each household. A child's active chore that
-- is past due jumps to its first scheduled day from today (every N days,
-- weeks or months from where it was). Returns how many moved.
create or replace function public.roll_missed_chores(p_household_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date;
  v_chore public.chores;
  v_due   date;
  v_count int := 0;
  v_step  interval;
begin
  select (now() at time zone h.timezone)::date into v_today from public.households h where h.id = p_household_id;
  if v_today is null then
    return 0;
  end if;

  for v_chore in
    select c.* from public.chores c
    join public.members m on m.id = c.assigned_to and m.role = 'child'
    where c.household_id = p_household_id and c.active and c.next_due < v_today
  loop
    v_step := case v_chore.unit
                when 'day'  then make_interval(days => greatest(v_chore.every_n, 1))
                when 'week' then make_interval(weeks => greatest(v_chore.every_n, 1))
                else             make_interval(months => greatest(v_chore.every_n, 1))
              end;
    v_due := v_chore.next_due;
    while v_due < v_today loop
      v_due := (v_due + v_step)::date;
    end loop;
    update public.chores set next_due = v_due where id = v_chore.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;


-- -----------------------------------------------------------------------------
-- STEP 7: permissions
-- -----------------------------------------------------------------------------
revoke execute on function
  public.members_protect_board_view(),
  public.set_board_view(uuid, text, smallint[], uuid),
  public.reward_tick_used(uuid, uuid),
  public.pay_out_stars(uuid, uuid[]),
  public.credit_completion(text, uuid, date, uuid, boolean),
  public.board_credit_completion(text, uuid, date, uuid, boolean),
  public.board_pay_out_stars(uuid, uuid[]),
  public.board_review_ticks(uuid[], boolean),
  public.roll_missed_chores(uuid)
from public, anon, authenticated;

grant execute on function
  public.set_board_view(uuid, text, smallint[], uuid),
  public.pay_out_stars(uuid, uuid[]),
  public.credit_completion(text, uuid, date, uuid, boolean),
  public.board_credit_completion(text, uuid, date, uuid, boolean),
  public.board_pay_out_stars(uuid, uuid[]),
  public.board_review_ticks(uuid[], boolean)
to authenticated;
grant execute on function public.roll_missed_chores(uuid) to service_role;
