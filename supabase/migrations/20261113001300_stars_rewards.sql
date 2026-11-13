-- =============================================================================
-- HomeHub: kids' stars, streaks and rewards
-- -----------------------------------------------------------------------------
-- Stars are not stored: they are counted from what a child ticked off, so
-- unticking takes the star away again and nothing can drift out of step.
--   * every routine step, chore or zone task they ticked (completions.done_by)
--   * every to-do assigned to them that they ticked (list_entries.completed_by)
-- Rewards are set by adults ("15 stars: choose Friday's dinner"); marking one
-- as given spends its stars.
-- A streak counts days in a row on which the child did all their routine
-- steps. Days with no steps for them don't break it; today only counts once
-- it's complete.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- STEP 1: Rewards
-- -----------------------------------------------------------------------------
create table public.rewards (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households (id) on delete cascade,
  member_id     uuid not null references public.members (id) on delete cascade,
  title         text not null check (char_length(title) between 1 and 80),
  stars_needed  int not null check (stars_needed between 1 and 1000),
  given_at      timestamptz,
  created_at    timestamptz not null default now()
);
create index rewards_member_idx on public.rewards (member_id);

create trigger rewards_check_member
  before insert or update of member_id on public.rewards
  for each row execute function public.check_member_in_household('member_id');


-- -----------------------------------------------------------------------------
-- STEP 2: Stars and streak for one person
-- -----------------------------------------------------------------------------

-- 2a. The streak (see the header for the rule).
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

    -- Their steps that applied that day (current routines).
    select count(*), count(c.id) into v_due, v_done
    from public.routine_steps s
    join public.routines r on r.id = s.routine_id and r.active
    left join public.completions c on c.kind = 'step' and c.item_id = s.id and c.for_date = v_day
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

-- 2b. Earned, spent, balance and streak. Children may ask about themselves;
--     adults about anyone in the household.
create or replace function public.member_stars(p_member_id uuid, p_today date)
returns table (earned int, spent int, balance int, streak int)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_earned  int;
  v_spent   int;
begin
  -- Step 2b-1: same household, and children only see their own.
  if not exists (
    select 1 from public.members m
    where m.id = p_member_id and m.household_id = public.current_household_id()
  ) then
    raise exception 'member_not_in_household';
  end if;
  if not public.is_household_adult() and p_member_id is distinct from public.current_member_id() then
    raise exception 'not_assigned_to_you';
  end if;

  -- Step 2b-2: count.
  select m.user_id into v_user_id from public.members m where m.id = p_member_id;

  select
    (select count(*) from public.completions c where c.done_by = p_member_id)
    + (select count(*) from public.list_entries e
       where e.assigned_to = p_member_id and e.status = 'done' and e.completed_by = v_user_id)
  into v_earned;

  select coalesce(sum(r.stars_needed), 0) into v_spent
  from public.rewards r where r.member_id = p_member_id and r.given_at is not null;

  return query select v_earned, v_spent, v_earned - v_spent, public.member_streak(p_member_id, p_today);
end;
$$;


-- -----------------------------------------------------------------------------
-- STEP 3: RLS, realtime and permissions
-- -----------------------------------------------------------------------------
alter table public.rewards enable row level security;

create policy "rewards: household read" on public.rewards for select to authenticated
  using (household_id = public.current_household_id());
create policy "rewards: adults write" on public.rewards for all to authenticated
  using (household_id = public.current_household_id() and public.is_household_adult())
  with check (household_id = public.current_household_id() and public.is_household_adult());

alter publication supabase_realtime add table public.rewards;

revoke execute on function
  public.member_streak(uuid, date),
  public.member_stars(uuid, date)
from public, anon, authenticated;

grant execute on function public.member_stars(uuid, date) to authenticated;
